import { t } from './i18n.js';
// Слой действий: UI вызывает только эти функции, а не OBS напрямую.
// В v2 сюда добавятся действия для локальных Browser Source (obs.broadcast).
export class Actions extends EventTarget {
  constructor(obs, getState) { super(); this.obs = obs; this.getState = getState; this.index = new Map(); this.active = new Map(); this.lastReplay = null; this.scenes = []; this.sceneOrder = []; this.inputs = []; this.kinds = new Map(); }
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
  // dimsFrom: чьи пропорции брать (для временной копии — оригинал). Не прочитались -> полный размер, масштабирует планшет
  async screenshot(name, dimsFrom = name) {
    const req = { sourceName: name, imageFormat: 'png' }; const w = 320;
    try { const { sceneItemTransform: tr } = await this.obs.call('GetSceneItemTransform', this.lookup(dimsFrom));
      if (tr.sourceWidth > 0 && tr.sourceHeight > 0) { req.imageWidth = w; req.imageHeight = Math.max(8, Math.min(4096, Math.round(w * tr.sourceHeight / tr.sourceWidth))); } } catch {}
    const r = await this.obs.call('GetSourceScreenshot', req);
    return r.imageData;
  }
  // Кадр из середины видео (ffmpeg_source / vlc_source). Видимость не трогаем:
  // источник в программе (videoActive) снимаем как есть; иначе PLAY -> ждём PLAYING и длительность ->
  // перемотка на середину -> скриншот -> STOP всегда (в finally). Позицию не восстанавливаем.
  // 1.11.1 (диагностика): скрытое видео — PLAY, без перемотки, первый кадр, STOP. Возвращает { uri, log }
  // v1.12.0: скрытые видео OBS не рендерит -> временная копия в служебной сцене (оригинал не трогаем)
  // v1.13.0: опрос скриншота вместо фиксированных пауз; служебная сцена удаляется надёжно
  async thumbClean() {
    try { const { inputs } = await this.obs.call('GetInputList');
      for (const x of inputs) if (x.inputName.startsWith('__pad_thumb_')) { try { await this.obs.call('RemoveInput', { inputName: x.inputName }); } catch {} } } catch {}
  }
  async thumbBegin() {
    const SC = 'Overlay Pad (thumbnails)'; this.thumbScene = SC; this.thumbN = 0; this.thumbErr = '';
    await this.thumbClean();
    let { scenes } = await this.obs.call('GetSceneList');
    if (scenes.some((x) => x.sceneName === SC)) { try { await this.obs.call('RemoveScene', { sceneName: SC }); } catch {} ({ scenes } = await this.obs.call('GetSceneList')); }
    if (!scenes.some((x) => x.sceneName === SC)) await this.obs.call('CreateScene', { sceneName: SC });
  }
  async thumbEnd() {
    if (!this.thumbScene) return ''; const SC = this.thumbScene; this.thumbScene = null;
    await this.thumbClean();
    let err = '';
    for (let i = 0; i < 2; i++) {
      try { await this.obs.call('RemoveScene', { sceneName: SC }); err = ''; break; }
      catch (e) { err = e.message; if (i === 0) await new Promise((r) => setTimeout(r, 300)); }
    }
    this.thumbErr = err; return err;
  }
  async videoFrame(name, durSec, blank) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now();
    const log = { name, live: false, copy: false, played: false, state: '', err: '', blank: null, ms: 0 };
    const done = (uri) => { log.ms = Date.now() - t0; return { uri, log }; };
    let live = null; try { live = await this.obs.call('GetSourceActive', { sourceName: name }); } catch {}
    if (live && live.videoActive) { log.live = true; const uri = await this.screenshot(name); log.blank = blank ? await blank(uri) : null; return done(uri); }
    if (!this.thumbScene) await this.thumbBegin();
    const vlc = this.kinds && this.kinds.get(name) === 'vlc_source';
    const maxMs = vlc ? 4000 : 1500;
    const A = 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_';
    const tmp = '__pad_thumb_' + (++this.thumbN) + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let uri = null, made = false;
    try {
      const orig = await this.obs.call('GetInputSettings', { inputName: name });
      const inputSettings = { ...(orig.inputSettings || {}) };
      if (!vlc) Object.assign(inputSettings, { close_when_inactive: false, restart_on_activate: false, looping: false });
      await this.obs.call('CreateInput', { sceneName: this.thumbScene, inputName: tmp, inputKind: orig.inputKind, inputSettings, sceneItemEnabled: true });
      made = true; log.copy = true;
      try { await this.obs.call('SetInputMute', { inputName: tmp, inputMuted: true }); } catch {}
      try { await this.obs.call('SetInputAudioMonitorType', { inputName: tmp, monitorType: 'OBS_MONITORING_TYPE_NONE' }); } catch {}
      // фильтры оригинала (хромакей и т.п.) — на копию, в том же порядке и с тем же вкл/выкл
      try { const { filters } = await this.obs.call('GetSourceFilterList', { sourceName: name }); log.filters = 0;
        for (const f of filters || []) { try {
          await this.obs.call('CreateSourceFilter', { sourceName: tmp, filterName: f.filterName, filterKind: f.filterKind, filterSettings: f.filterSettings || {} });
          if (f.filterEnabled === false) await this.obs.call('SetSourceFilterEnabled', { sourceName: tmp, filterName: f.filterName, filterEnabled: false });
          log.filters++; } catch (e) { log.err = (log.err ? log.err + '; ' : '') + 'filter ' + f.filterName + ': ' + e.message; } } } catch {}
      await this.obs.call('TriggerMediaInputAction', { inputName: tmp, mediaAction: A + 'PLAY' }); log.played = true;
      // опрос кадра каждые ~120 мс, пока не перестанет быть пустым
      // ошибка отдельной попытки (копия ещё не отрисована) — не ошибка, если потом кадр получен
      let pollErr = '';
      for (const end = Date.now() + maxMs; ;) {
        try { uri = await this.screenshot(tmp, name); log.blank = blank ? await blank(uri) : false; pollErr = ''; } catch (e) { pollErr = e.message; }
        if (log.blank === false || Date.now() >= end) break;
        // копия не стартовала (STOPPED/NONE): один раз пробуем RESTART
        if (!log.restarted && Date.now() > end - maxMs + 400) { try {
          const { mediaState: ms } = await this.obs.call('GetMediaInputStatus', { inputName: tmp });
          if (/STOPPED|NONE/.test(ms || '')) { await this.obs.call('TriggerMediaInputAction', { inputName: tmp, mediaAction: A + 'RESTART' }); log.restarted = true; } } catch {} }
        await sleep(120);
      }
      if (pollErr && log.blank !== false) log.err = (log.err ? log.err + '; ' : '') + 'frame: ' + pollErr;
      try { const st = await this.obs.call('GetMediaInputStatus', { inputName: tmp }); log.state = (st.mediaState || '').replace('OBS_MEDIA_STATE_', ''); } catch {}
      if (log.blank !== false && /STOPPED|NONE/.test(log.state)) log.err = 'file did not start (check path / file in OBS)' + (log.err ? '; ' + log.err : '');
    } catch (e) { log.err = e.message; }
    finally { if (made) { try { await this.obs.call('RemoveInput', { inputName: tmp }); } catch (e) { log.err = (log.err ? log.err + '; ' : '') + 'remove: ' + e.message; } } }
    return done(uri);
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
