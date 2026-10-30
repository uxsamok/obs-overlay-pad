import { t } from './i18n.js';
// Слой действий: UI вызывает только эти функции, а не OBS напрямую.
// В v2 сюда добавятся действия для локальных Browser Source (obs.broadcast).
export class Actions extends EventTarget {
  constructor(obs, getState) { super(); this.obs = obs; this.getState = getState; this.index = new Map(); this.active = new Map(); this.lastReplay = null; this.scenes = []; this.sceneOrder = []; this.inputs = []; }
  async rebuildIndex() {
    const idx = new Map();
    const add = (name, ref) => { if (!idx.has(name)) idx.set(name, []); idx.get(name).push(ref); };
    const { scenes } = await this.obs.call('GetSceneList');
    for (const sc of scenes) {
      const { sceneItems } = await this.obs.call('GetSceneItemList', { sceneName: sc.sceneName });
      for (const it of sceneItems) {
        add(it.sourceName, { sceneName: sc.sceneName, sceneItemId: it.sceneItemId });
        if (it.isGroup) {
          const g = await this.obs.call('GetGroupSceneItemList', { sceneName: it.sourceName });
          for (const gi of g.sceneItems) add(gi.sourceName, { sceneName: it.sourceName, sceneItemId: gi.sceneItemId });
        }
      }
    }
    this.index = idx;
    // порядок как в списке сцен OBS (GetSceneList отдаёт снизу вверх)
    this.sceneOrder = scenes.map((x) => x.sceneName).reverse();
    this.scenes = scenes.map((x) => x.sceneName).sort((a, b) => a.localeCompare(b));
    const { inputs } = await this.obs.call('GetInputList');
    this.kinds = new Map(inputs.map((x) => [x.inputName, x.unversionedInputKind || x.inputKind || '']));
    this.inputs = inputs.map((x) => x.inputName).sort((a, b) => a.localeCompare(b));
    this.dispatchEvent(new Event('index'));
    return idx;
  }
  // Скриншот источника-картинки (PNG, ширина ~320, пропорции по размеру источника)
  async screenshot(name) {
    let w = 320, h = 180;
    try { const { sceneItemTransform: tr } = await this.obs.call('GetSceneItemTransform', this.lookup(name));
      if (tr.sourceWidth > 0 && tr.sourceHeight > 0) h = Math.max(8, Math.min(4096, Math.round(w * tr.sourceHeight / tr.sourceWidth))); } catch {}
    const r = await this.obs.call('GetSourceScreenshot', { sourceName: name, imageFormat: 'png', imageWidth: w, imageHeight: h });
    return r.imageData;
  }
  // Кадр из середины видео (ffmpeg_source / vlc_source). Видимость не трогаем:
  // источник в программе (videoActive) снимаем как есть; иначе PLAY -> ждём PLAYING и длительность ->
  // перемотка на середину -> скриншот -> STOP всегда (в finally). Позицию не восстанавливаем.
  // 1.11.1 (диагностика): скрытое видео — PLAY, без перемотки, первый кадр, STOP. Возвращает { uri, log }
  // v1.12.0: скрытые видео OBS не рендерит -> временная копия в служебной сцене (оригинал не трогаем)
  async thumbBegin() {
    const SC = 'Overlay Pad (thumbnails)'; this.thumbScene = SC; this.thumbN = 0;
    try { const { inputs } = await this.obs.call('GetInputList');
      for (const x of inputs) if (x.inputName.startsWith('__pad_thumb_')) { try { await this.obs.call('RemoveInput', { inputName: x.inputName }); } catch {} } } catch {}
    const { scenes } = await this.obs.call('GetSceneList');
    if (!scenes.some((x) => x.sceneName === SC)) await this.obs.call('CreateScene', { sceneName: SC });
  }
  async thumbEnd() { if (!this.thumbScene) return; try { await this.obs.call('RemoveScene', { sceneName: this.thumbScene }); } catch {} this.thumbScene = null; }
  async videoFrame(name, durSec, blank) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const log = { name, live: false, copy: false, played: false, state: '', err: '', blank: null };
    let live = null; try { live = await this.obs.call('GetSourceActive', { sourceName: name }); } catch {}
    if (live && live.videoActive) { log.live = true; const uri = await this.screenshot(name); log.blank = blank ? await blank(uri) : null; return { uri, log }; }
    if (!this.thumbScene) await this.thumbBegin();
    const vlc = this.kinds && this.kinds.get(name) === 'vlc_source';
    const openMs = vlc ? 4000 : 1500, settleMs = vlc ? 800 : 300;
    const A = 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_';
    const tmp = '__pad_thumb_' + (++this.thumbN) + '_' + Date.now().toString(36);
    let uri = null, made = false;
    try {
      const orig = await this.obs.call('GetInputSettings', { inputName: name });
      const inputSettings = { ...(orig.inputSettings || {}) };
      if (!vlc) Object.assign(inputSettings, { close_when_inactive: false, restart_on_activate: false, looping: false });
      await this.obs.call('CreateInput', { sceneName: this.thumbScene, inputName: tmp, inputKind: orig.inputKind, inputSettings, sceneItemEnabled: true });
      made = true; log.copy = true;
      try { await this.obs.call('SetInputMute', { inputName: tmp, inputMuted: true }); } catch {}
      try { await this.obs.call('SetInputAudioMonitorType', { inputName: tmp, monitorType: 'OBS_MONITORING_TYPE_NONE' }); } catch {}
      await this.obs.call('TriggerMediaInputAction', { inputName: tmp, mediaAction: A + 'PLAY' });
      for (const end = Date.now() + openMs; Date.now() < end;) {
        await sleep(100);
        try { const st = await this.obs.call('GetMediaInputStatus', { inputName: tmp }); log.state = (st.mediaState || '').replace('OBS_MEDIA_STATE_', '');
          if (/PLAYING/.test(st.mediaState || '')) { log.played = true; break; } } catch (e) { log.err = e.message; }
      }
      await sleep(settleMs);
      uri = await this.screenshot(tmp);
      log.blank = blank ? await blank(uri) : null;
      if (log.blank) { await sleep(settleMs); uri = await this.screenshot(tmp); log.blank = blank ? await blank(uri) : null; }
    } catch (e) { log.err = e.message; }
    finally { if (made) { try { await this.obs.call('RemoveInput', { inputName: tmp }); } catch (e) { log.err = (log.err ? log.err + '; ' : '') + 'remove: ' + e.message; } } }
    return { uri, log };
  }
  lookup(name) {
    const refs = this.index.get(name) || [];
    if (!refs.length) throw new Error(t('err.notFound', { name }));
    return refs[0];
  }
  duplicates(name) { return (this.index.get(name) || []).length > 1; }
  setVisible(ref, on) { return this.obs.call('SetSceneItemEnabled', { ...ref, sceneItemEnabled: on }); }
  async show(name) {
    const ref = this.lookup(name);
    await this.setVisible(ref, false); // гарантируем, что Show transition сыграет
    await this.setVisible(ref, true);
  }
  async hide(name) { await this.setVisible(this.lookup(name), false); }
  async isVisible(name) { const r = await this.obs.call('GetSceneItemEnabled', this.lookup(name)); return r.sceneItemEnabled; }
  async setText(source, text) { await this.obs.call('SetInputSettings', { inputName: source, inputSettings: { text } }); }
  async toggleOverlaysScene() {
    const st = this.getState(); const { currentProgramSceneName: sceneName } = await this.obs.call('GetCurrentProgramScene');
    const { sceneItemId } = await this.obs.call('GetSceneItemId', { sceneName, sourceName: st.overlaysScene });
    const { sceneItemEnabled } = await this.obs.call('GetSceneItemEnabled', { sceneName, sceneItemId });
    await this.obs.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: !sceneItemEnabled });
    return !sceneItemEnabled;
  }
  saveReplay() { return this.obs.call('SaveReplayBuffer'); }
  // Путь к последнему повтору: всегда свежий запрос в OBS (кэш — только запасной вариант)
  async getLastReplay() {
    try { const r = await this.obs.call('GetLastReplayBufferReplay'); if (r.savedReplayPath) return r.savedReplayPath; } catch {}
    return this.lastReplay;
  }
  async playLastReplay(mediaSource) {
    const path = await this.getLastReplay();
    if (!path) throw new Error(t('err.noReplays'));
    const ref = this.lookup(mediaSource);
    await this.setVisible(ref, false);
    // Сбрасываем файл и ставим новый: так Media Source гарантированно перечитывает видео,
    // а не играет старое из памяти.
    await this.obs.call('SetInputSettings', { inputName: mediaSource, inputSettings: { local_file: '' } });
    await this.obs.call('SetInputSettings', { inputName: mediaSource, inputSettings: { local_file: path, is_local_file: true, looping: false } });
    await this.setVisible(ref, true);
    try { await this.obs.call('TriggerMediaInputAction', { inputName: mediaSource, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' }); } catch {}
  }
  setScene(sceneName) { return this.obs.call('SetCurrentProgramScene', { sceneName }); }
  async currentScene() { return (await this.obs.call('GetCurrentProgramScene')).currentProgramSceneName; }
  stopMedia(mediaSource) { return this.obs.call('TriggerMediaInputAction', { inputName: mediaSource, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); }
  async replayBufferActive() { return (await this.obs.call('GetReplayBufferStatus')).outputActive; }
  startReplayBuffer() { return this.obs.call('StartReplayBuffer'); }
  stopReplayBuffer() { return this.obs.call('StopReplayBuffer'); }
  async getMute(input) { return (await this.obs.call('GetInputMute', { inputName: input })).inputMuted; }
  async toggleMute(input) { return (await this.obs.call('ToggleInputMute', { inputName: input })).inputMuted; }
  async audioInputs() { // имена аудиовходов для подсказки в настройках
    const { inputs } = await this.obs.call('GetInputList');
    const audio = inputs.filter((x) => /audio|wasapi|pulse|alsa|coreaudio|jack|sndio|oss/i.test(x.unversionedInputKind || x.inputKind || ''));
    return (audio.length ? audio : inputs).map((x) => x.inputName).sort();
  }
  async status() {
    const [s, r] = await Promise.all([this.obs.call('GetStreamStatus'), this.obs.call('GetRecordStatus')]);
    return { streaming: s.outputActive, streamMs: s.outputDuration || 0, recording: r.outputActive, recordMs: r.outputDuration || 0 };
  }
}
