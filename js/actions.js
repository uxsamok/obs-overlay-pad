// Слой действий: UI вызывает только эти функции, а не OBS напрямую.
// В v2 сюда добавятся действия для локальных Browser Source (obs.broadcast).
export class Actions extends EventTarget {
  constructor(obs, getState) { super(); this.obs = obs; this.getState = getState; this.index = new Map(); this.active = new Map(); this.lastReplay = null; }
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
    this.dispatchEvent(new Event('index'));
    return idx;
  }
  lookup(name) {
    const refs = this.index.get(name) || [];
    if (!refs.length) throw new Error(`Источник «${name}» не найден в OBS`);
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
  async getLastReplay() {
    if (this.lastReplay) return this.lastReplay;
    const r = await this.obs.call('GetLastReplayBufferReplay'); return r.savedReplayPath;
  }
  async playLastReplay(mediaSource) {
    const path = await this.getLastReplay();
    if (!path) throw new Error('Повторов пока нет');
    await this.obs.call('SetInputSettings', { inputName: mediaSource, inputSettings: { local_file: path, is_local_file: true } });
    await this.show(mediaSource);
    try { await this.obs.call('TriggerMediaInputAction', { inputName: mediaSource, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' }); } catch {}
  }
  stopMedia(mediaSource) { return this.obs.call('TriggerMediaInputAction', { inputName: mediaSource, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); }
  async replayBufferActive() { return (await this.obs.call('GetReplayBufferStatus')).outputActive; }
  startReplayBuffer() { return this.obs.call('StartReplayBuffer'); }
  stopReplayBuffer() { return this.obs.call('StopReplayBuffer'); }
  async status() {
    const [s, r] = await Promise.all([this.obs.call('GetStreamStatus'), this.obs.call('GetRecordStatus')]);
    return { streaming: s.outputActive, streamMs: s.outputDuration || 0, recording: r.outputActive, recordMs: r.outputDuration || 0 };
  }
}
