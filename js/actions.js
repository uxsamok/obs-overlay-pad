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
    this.inputs = inputs.map((x) => x.inputName).sort((a, b) => a.localeCompare(b));
    this.dispatchEvent(new Event('index'));
    return idx;
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
