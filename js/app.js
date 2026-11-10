import { ObsClient } from './obs.js';
import { Actions } from './actions.js';
import { openColorPicker } from './colorpicker.js';
import { initI18n, setLang, getLang, languages, t, applyI18n } from './i18n.js';
import { images, loadImages, putImage, deleteImage, imgKey } from './imgcache.js';
import { load, save, normalize, resizeCells, defaultState, defaultPreset, normalizePreset, curPreset, parseBackup } from './store.js';

await initI18n(); // язык — до загрузки состояния (тексты по умолчанию берутся из перевода)
let S = load();
await loadImages();
// до 1.19 ключом было только имя источника -> раздаём старые снимки всем пресетам
for (const [k, v] of [...images]) if (!k.includes('|')) { for (const p of S.presets) if (!images.has(imgKey(p.id, k))) await putImage(imgKey(p.id, k), v); await deleteImage(k); }
const img = (name) => images.get(imgKey(S.activePreset, name));
let connKey = '';
const obs = new ObsClient();
const act = new Actions(obs, () => S);
const $ = (q, r = document) => r.querySelector(q);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const persist = () => save(S);
const fmt = (ms, forceH = false) => { const sec = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0'); return (h || forceH ? h + ':' + p(m) : p(m)) + ':' + p(s); };
let live = { streaming: false, recording: false, streamMs: 0, recordMs: 0, at: 0 };
const active = new Map(); // idx -> {until, timer}
let gameTimer = null; // {start}

function toast(msg, err) { const el = $('#toast'); el.textContent = msg; el.className = 'show' + (err ? ' err' : ''); clearTimeout(toast.h); toast.h = setTimeout(() => el.className = '', 2500); }

// ---------- OBS ----------
obs.addEventListener('status', async (e) => {
  const st = e.detail.status; const el = $('#conn');
  el.className = 'conn ' + st; el.textContent = { connected: 'OBS ✓', connecting: 'OBS …', disconnected: 'OBS ✕', error: 'OBS ✕' }[st];
  if (st === 'connected') { renderSettings.mic = null; try { await act.rebuildIndex(); await detectAudio(); await poll(); await refreshScene(); await syncActive(); await refreshReplayBtn(); await ensureBuffer(); refreshMic(); pushMatch(); } catch (err) { toast(err.message, true); } }
  else { setBuffer(null); setMic(null); curScene = null; }
  renderGrid();
});
for (const ev of ['SceneItemCreated', 'SceneItemRemoved', 'InputNameChanged', 'SceneCreated', 'SceneRemoved', 'SceneNameChanged'])
  obs.addEventListener(ev, () => { clearTimeout(act.rb); act.rb = setTimeout(() => act.rebuildIndex().then(() => { renderGrid(); if (location.hash === '#settings') renderSettings(); }).catch(() => {}), 500); });
obs.addEventListener('StreamStateChanged', (e) => { if (e.detail.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') newStream(); poll(); });
obs.addEventListener('RecordStateChanged', () => poll());
obs.addEventListener('ReplayBufferSaved', (e) => {
  act.lastReplay = e.detail.savedReplayPath; savePending = null; saveWaiters.splice(0).forEach((f) => f());
  toast(t('toast.replaySaved'));
});
// Сохранение асинхронное: файл появляется через секунду-две (событие ReplayBufferSaved).
// «Показать» сразу после «Сохранить» ждёт это событие (до 6 с), чтобы не показать старый файл.
let savePending = null; const saveWaiters = [];
const waitSave = () => !savePending || Date.now() - savePending > 6000 ? Promise.resolve()
  : new Promise((res) => { saveWaiters.push(res); setTimeout(res, 6000 - (Date.now() - savePending)); });
// Replay Buffer: индикатор на кнопке «Буфер»
// Буфер повтора запускается автоматически: при подключении к OBS и если он остановился.
// В шапке — только маленький индикатор (тап по нему = попробовать запустить ещё раз).
let bufferOn = null; // true / false / null (неизвестно — нет связи с OBS)
function setBuffer(on, why) { bufferOn = on; const b = $('#buf'); b.className = 'buf' + (on ? ' on' : on === false ? ' off' : '');
  b.textContent = t(on ? 'hdr.buf.on' : on === false ? 'hdr.buf.off' : 'hdr.buf.unknown'); b.title = why || ''; }
async function ensureBuffer(quiet) {
  if (!obs.identified) return setBuffer(null);
  try {
    if (await act.replayBufferActive()) return setBuffer(true);
    await act.startReplayBuffer(); setBuffer(true); if (!quiet) toast(t('toast.bufferStarted'));
  } catch (err) { setBuffer(false, err.message); toast(t('toast.bufferFailed'), true); }
}
obs.addEventListener('ReplayBufferStateChanged', (e) => {
  const st = e.detail.outputState; setBuffer(e.detail.outputActive);
  if (st === 'OBS_WEBSOCKET_OUTPUT_STOPPED') setTimeout(() => ensureBuffer(), 3000); // кто-то/что-то остановил — запускаем снова
});
// Повтор доиграл до конца — прячем Media Source и гасим подсветку ячеек повтора
obs.addEventListener('MediaInputPlaybackEnded', (e) => {
  if (!S.replay.mediaSource || e.detail.inputName !== S.replay.mediaSource) return;
  if (replayShown()) stopReplay(false);
});
// Повтор на экране: кнопка «▶ Показать повтор» и/или ячейки «Последний повтор»
let replayOn = false;
const replayShown = () => replayOn || [...active.keys()].some((i) => S.cells[i]?.type === 'replay');
function setPlayBtn() { const b = $('#btnPlay'); b.classList.toggle('on', replayOn); b.textContent = t(replayOn ? 'hdr.hideReplay' : 'hdr.showReplay'); }
// Кнопка повтора отражает реальную видимость Media Source повтора в OBS, кто бы его ни включил
function replayRef() { try { return S.replay.mediaSource ? act.lookup(S.replay.mediaSource) : null; } catch { return null; } }
function syncReplayBtn(sceneName, sceneItemId, on) {
  const r = replayRef(); if (!r || r.sceneName !== sceneName || r.sceneItemId !== sceneItemId) return;
  replayOn = on; setPlayBtn();
  if (!on) for (const [i, st] of [...active]) if (S.cells[i]?.type === 'replay') { clearTimeout(st.timer); active.delete(i); updateCell(i); }
}
async function refreshReplayBtn() { if (!obs.identified || !replayRef()) return; try { replayOn = await act.isVisible(S.replay.mediaSource); setPlayBtn(); } catch {} }
async function playReplay() {
  if (!obs.identified) throw new Error(t('err.noObs'));
  if (!S.replay.mediaSource) throw new Error(t('err.noReplaySource'));
  await waitSave();
  await act.playLastReplay(S.replay.mediaSource);
}
let replayTimer = null; // автоскрытие повтора по кнопке в шапке (S.replay.duration)
async function stopReplay(stopMedia = true) { // скрыть источник, остановить видео, погасить ячейки
  clearTimeout(replayTimer); replayTimer = null;
  replayOn = false; setPlayBtn();
  for (const [i, st] of [...active]) if (S.cells[i]?.type === 'replay') { clearTimeout(st.timer); active.delete(i); updateCell(i); }
  try { await act.hide(S.replay.mediaSource); } catch (err) { toast(err.message, true); }
  if (stopMedia) act.stopMedia(S.replay.mediaSource).catch(() => {});
}
// Номер матча (− N + в шапке): пишет текст по шаблону в текстовый источник OBS
function renderMatch() { $('#matchN').textContent = S.match.template.replace('{n}', S.match.value); }
function pushMatch() { renderMatch(); if (S.match.source && obs.identified) act.setText(S.match.source, S.match.template.replace('{n}', S.match.value)).catch((err) => toast(err.message, true)); }
document.querySelectorAll('#match [data-md]').forEach((b) => b.onclick = () => {
  S.match.value = Math.max(0, (+S.match.value || 0) + +b.dataset.md); persist(); pushMatch();
  if (!S.match.source) toast(t('toast.matchNoSource'), true);
});
// Микрофон
let micMuted = null; // true / false / null (не настроен или нет связи)
let micRevision = 0, micBusy = false;
function setMic(m) {
  micRevision++;
  micMuted = typeof m === 'boolean' ? m : null;
  const b = $('#btnMic');
  b.classList.toggle('alert', micMuted === true);
  b.classList.toggle('dim', micMuted == null);
  b.classList.toggle('micon', micMuted === false);
  b.textContent = t(micMuted === true ? 'hdr.micMuted' : 'hdr.mic');
}
// Ignore replies from an old preset/connection, or superseded by a newer OBS event.
function micReplyGuard() {
  const revision = micRevision, source = S.mic.source, preset = S.activePreset, socket = obs.ws;
  return () => obs.identified && obs.ws === socket && S.activePreset === preset && S.mic.source === source && micRevision === revision;
}
async function refreshMic(clear = true) {
  if (clear || !obs.identified || !S.mic.source) setMic(null);
  if (!obs.identified || !S.mic.source) return;
  const current = micReplyGuard();
  try { const muted = await act.getMute(S.mic.source); if (current()) setMic(muted); }
  catch { if (current()) setMic(null); }
}
obs.addEventListener('InputMuteStateChanged', (e) => {
  if (obs.identified && S.mic.source && e.detail.inputName === S.mic.source) setMic(e.detail.inputMuted);
});
// Оверлеи, видимые в OBS -> подсветка ячеек. Источник ячейки = первая запись индекса (как в act.show/hide).
const cellRef = (c) => c.type === 'overlay' && c.source ? (act.index.get(c.source) || [])[0] : null;
// При подключении / смене пресета: включённые в OBS — «в эфире» (без отсчёта: сколько осталось, неизвестно).
async function syncActive() {
  if (!obs.identified) return;
  const seen = new Map(); // ref -> enabled (одинаковый источник в нескольких ячейках — один запрос)
  for (let i = 0; i < S.cells.length; i++) {
    const c = S.cells[i]; const ref = cellRef(c); if (!ref) continue;
    const key = ref.sceneName + '\n' + ref.sceneItemId;
    if (!seen.has(key)) { try { seen.set(key, (await obs.call('GetSceneItemEnabled', ref)).sceneItemEnabled); } catch { seen.set(key, null); } }
    const on = seen.get(key); if (on == null) continue;
    if (on && !active.has(i)) active.set(i, { source: c.source });
    else if (!on && active.has(i)) { clearTimeout(active.get(i).timer); active.delete(i); }
  }
  renderGrid();
}
// Включили/выключили в самом OBS. Свои show/hide петли не дают: show() сначала выключает
// (ячейка ещё не активна), потом включает (startActive перезапишет состояние с таймером);
// stopCell убирает подсветку до hide().
obs.addEventListener('SceneItemEnableStateChanged', (e) => {
  const { sceneName, sceneItemId, sceneItemEnabled: on } = e.detail;
  syncReplayBtn(sceneName, sceneItemId, on);
  S.cells.forEach((c, i) => { const ref = cellRef(c);
    if (!ref || ref.sceneName !== sceneName || ref.sceneItemId !== sceneItemId) return;
    if (on && !active.has(i)) { active.set(i, { source: c.source }); updateCell(i); }
    else if (!on && active.has(i)) { clearTimeout(active.get(i).timer); active.delete(i); updateCell(i); } });
});
// Пресеты: переключение меняет ячейки, сетку, сцены, микрофон, матч, «Скрыть всё»
function clearActive() { for (const st of active.values()) clearTimeout(st.timer); active.clear(); }
function renderPresetName() { $('#preset').textContent = S.presets.length > 1 ? curPreset(S).name : ''; }
function applyPreset() {
  setMic(null);
  if (JSON.stringify(S.obs) !== connKey) connect(); // у пресета своё подключение
  clearTimeout(replayTimer); replayTimer = null;
  clearActive(); replayOn = false; setPlayBtn(); refreshReplayBtn(); persist();
  renderMatch(); renderPresetName(); refreshMic(); pushMatch(); renderGrid(); syncActive();
  if (location.hash === '#settings') renderSettings();
}
// Сцены: кнопки слева; подсветка текущей программной сцены
let curScene = null;
async function refreshScene() { if (!obs.identified) return; try { curScene = await act.currentScene(); } catch {} renderScenes(); }
obs.addEventListener('CurrentProgramSceneChanged', (e) => { curScene = e.detail.sceneName; renderScenes(); });
function renderScenes() {
  const nav = $('#scenes'); const list = S.sceneButtons;
  nav.innerHTML = list.map((n) => `<button data-scene="${esc(n)}" class="${n === curScene ? 'cur' : ''}${obs.identified && act.sceneOrder.length && !act.sceneOrder.includes(n) ? ' miss' : ''}">${esc(n)}</button>`).join('');
  nav.hidden = !list.length;
}
async function poll() { if (!obs.identified) return; try { live = { ...(await act.status()), at: Date.now() }; } catch {} }
setInterval(poll, 5000);
// Здоровье стрима: полоска растёт с проблемами (зелёная → жёлтая → красная), по нажатию — подробности.
// Тихо, когда всё хорошо; сигнал при риске; полный отчёт по запросу. Кадры считаем приростом за опрос.
let health = { score: 0, prev: null, data: null, fps: null };
async function pollHealth() {
  if (!obs.identified) return renderHealth();
  try {
    if (!health.fps) { const v = await obs.call('GetVideoSettings'); health.fps = v.fpsNumerator / v.fpsDenominator; }
    const [ss, st] = await Promise.all([obs.call('GetStreamStatus'), obs.call('GetStats')]);
    const p = health.prev; const d = (k, o) => p ? Math.max(0, o[k] - p[o === ss ? 's' : 'g'][k]) : 0;
    const netDrop = d('outputTotalFrames', ss) ? d('outputSkippedFrames', ss) / d('outputTotalFrames', ss) : 0;
    const encDrop = d('outputTotalFrames', st) ? d('outputSkippedFrames', st) / d('outputTotalFrames', st) : 0;
    const rndDrop = d('renderTotalFrames', st) ? d('renderSkippedFrames', st) / d('renderTotalFrames', st) : 0;
    const fpsDef = health.fps ? Math.max(0, 1 - st.activeFps / health.fps) : 0;
    const cong = ss.outputActive ? (ss.outputCongestion || 0) : 0;
    // 5% потерь или 20% недобора FPS — уже полная красная
    health.score = Math.min(1, Math.max(cong, (ss.outputActive ? netDrop : 0) * 20, encDrop * 20, rndDrop * 20, fpsDef * 5, ss.outputReconnecting ? 1 : 0));
    health.prev = { s: ss, g: st }; health.data = { ss, st, netDrop, encDrop, rndDrop, cong };
  } catch { health.data = null; }
  renderHealth();
}
function renderHealth() {
  const el = $('#health'); if (!el) return; const s = obs.identified && health.data ? health.score : null;
  el.className = 'health' + (s == null ? ' na' : s >= 0.5 ? ' bad' : s >= 0.1 ? ' warn' : ' ok');
  el.firstChild.style.width = (s == null ? 15 : 15 + 85 * s) + '%';
  el.title = t('health.title');
}
function healthReport() {
  const h = health.data; if (!h) return t('health.noData');
  const pc = (x) => (x * 100).toFixed(1) + '%'; const { ss, st } = h; const L = [];
  L.push(t('health.stream') + ': ' + (ss.outputActive ? (ss.outputReconnecting ? t('health.reconnecting') : t('health.on')) : t('health.off')));
  if (ss.outputActive) { L.push(t('health.congestion') + ': ' + pc(h.cong)); L.push(t('health.netDrop') + ': ' + pc(h.netDrop) + ` (${ss.outputSkippedFrames} / ${ss.outputTotalFrames})`); }
  L.push(t('health.encDrop') + ': ' + pc(h.encDrop) + ` (${st.outputSkippedFrames} / ${st.outputTotalFrames})`);
  L.push(t('health.rndDrop') + ': ' + pc(h.rndDrop) + ` (${st.renderSkippedFrames} / ${st.renderTotalFrames})`);
  L.push(`FPS: ${st.activeFps.toFixed(1)}${health.fps ? ' / ' + Math.round(health.fps) : ''} · CPU: ${st.cpuUsage.toFixed(0)}%`);
  const hints = [];
  if (ss.outputReconnecting || h.cong >= 0.1 || h.netDrop >= 0.005) hints.push(t('health.hintNet'));
  if (h.encDrop >= 0.005) hints.push(t('health.hintEnc'));
  if (h.rndDrop >= 0.005 || (health.fps && st.activeFps < health.fps * 0.95)) hints.push(t('health.hintRender'));
  L.push('', hints.length ? hints.join('\n') : t('health.allOk'));
  return L.join('\n');
}
$('#health').onclick = () => { $('#healthTxt').textContent = healthReport(); $('#healthDlg').showModal(); };
$('#healthClose').onclick = () => $('#healthDlg').close();
setInterval(pollHealth, 5000);
function connect() { setMic(null); connKey = JSON.stringify(S.obs); obs.connect(S.obs.host, S.obs.port, S.obs.password); }

// ---------- Таймкоды ----------
// Отсчёт — от старта трансляции в OBS (outputDuration из GetStreamStatus): 00:00 записи на YouTube
// = начало приёма потока (при включённом автостарте). Время записи (REC) не используется.
const elapsed = () => live.streaming ? live.streamMs + (Date.now() - live.at) : null;
function curStream() { if (!S.streams.length) newStream(); return S.streams[S.streams.length - 1]; }
function newStream() { const d = new Date(); S.streams.push({ id: d.getTime(), title: t('tc.streamTitle', { date: d.toLocaleString(getLang()) }), marks: [] }); persist(); }
function addMark(label) {
  const ms = elapsed(); if (ms == null) { toast(t('toast.noTimecode'), true); return; }
  curStream().marks.push({ t: ms, label }); persist(); toast(`★ ${fmt(ms, ms >= 3600e3)} ${label}`);
}
function youtubeText(st) {
  const marks = [...st.marks].sort((a, b) => a.t - b.t); const long = marks.some((m) => m.t >= 3600e3);
  if (!marks.length || Math.floor(marks[0].t / 1000) > 0) marks.unshift({ t: 0, label: t('tc.start') });
  return marks.map((m) => `${fmt(m.t, long)} ${m.label}`).join('\n');
}

// ---------- Ячейки ----------
async function press(i, e) {
  const c = S.cells[i];
  try {
    if (c.type === 'counter') {
      const d = e.target?.closest?.('[data-d]'); if (!d) return; // меняют только кнопки − / +
      const dir = +d.dataset.d;
      c.counterValue = (+c.counterValue || 0) + dir; persist(); updateCell(i);
      if (c.source) await act.setText(c.source, c.counterTemplate.replace('{n}', c.counterValue));
    } else if (c.type === 'replay') {
      if (!S.replay.mediaSource) throw new Error(t('err.noReplaySource'));
      if (active.has(i) || replayOn) return stopReplay();
      await playReplay(); startActive(i, S.replay.mediaSource);
    } else {
      if (!c.source) throw new Error(t('err.cellNoSource', { n: i + 1 }));
      if (active.has(i)) return stopCell(i);
      await act.show(c.source); startActive(i, c.source);
    }
    if (c.timecode) addMark(c.label);
    if (c.startGameTimer) startGameTimer();
  } catch (err) { toast(err.message, true); }
}
function startActive(i, source) {
  const c = S.cells[i]; const st = { source };
  if (c.mode === 'timer') {
    const sec = +c.duration >= 0.5 ? +c.duration : 8; // пустое/0 -> 8 с
    // по объекту ячейки, а не по номеру: номер может смениться при перестановке
    st.until = Date.now() + sec * 1000; st.timer = setTimeout(() => stopCell(S.cells.indexOf(c)), sec * 1000);
  }
  active.set(i, st); updateCell(i);
}
async function stopCell(i) {
  const st = active.get(i); if (!st) return;
  if (S.cells[i].type === 'replay') return stopReplay(); // скрыть + остановить видео
  clearTimeout(st.timer); active.delete(i); updateCell(i);
  try { await act.hide(st.source || S.cells[i].source); } catch (err) { toast(err.message, true); }
}
function startGameTimer() { gameTimer = { start: Date.now() }; }
function tickGameTimer() {
  if (!gameTimer) { $('#gtimer').textContent = ''; return; }
  const txt = fmt(Date.now() - gameTimer.start); $('#gtimer').textContent = '⏱ ' + txt;
  if (S.gameTimer.source && obs.identified && txt !== gameTimer.last) { gameTimer.last = txt; act.setText(S.gameTimer.source, txt).catch(() => {}); }
}

// ---------- Рендер ----------
function cellHTML(c, i) {
  const st = active.get(i); const warn = c.source && obs.identified && c.type !== 'replay' && (!act.index.has(c.source) ? t('cell.missing') : act.duplicates(c.source) ? t('cell.dup') : '');
  let sub = '';
  if (c.type === 'counter') sub = `<div class="ctr"><button class="cbtn" data-d="-1" aria-label="${t('cell.minus')}">−</button><b>${esc(c.counterValue)}</b><button class="cbtn" data-d="1" aria-label="${t('cell.plus')}">+</button></div>`;
  if (st && st.until) sub += `<div class="cd">${Math.ceil((st.until - Date.now()) / 1000)}</div>`;
  else if (st) sub += `<div class="cd">${t('cell.onAir')}</div>`;
  return `<div class="lbl">${esc(c.label)}</div>${sub}${warn ? `<div class="warn">${warn}</div>` : ''}<div class="num">${i + 1}${c.source && VIDEO_KINDS.has(act.kinds?.get(c.source)) ? (audioSrc.has(c.source) ? ICON_NOTE : ICON_PLAY) : ''}</div>`;
}
// Картинка кнопки: только если галочка стоит, источник есть в OBS и это картинка или видео
const IMG_KINDS = new Set(['image_source', 'ffmpeg_source', 'vlc_source']);
const VIDEO_KINDS = new Set(['ffmpeg_source', 'vlc_source']);
const ICON_PLAY = '<svg class="vid" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
const ICON_NOTE = '<svg class="vid" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';
// аудио (mp3, wav…) — по расширению файла в настройках медиаисточника: кадра нет, значок ноты
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|opus|flac|m4a|aac|wma|aif|aiff)$/i;
const audioSrc = new Set();
async function isAudio(n) { try { const { inputSettings: st } = await obs.call('GetInputSettings', { inputName: n });
  const files = [st.local_file, ...(st.playlist || []).map((p) => p.value)].filter(Boolean);
  const a = files.length > 0 && files.every((f) => AUDIO_EXT.test(f)); if (a) audioSrc.add(n); else audioSrc.delete(n); return a; } catch { return false; } }
async function detectAudio() { for (const n of new Set(S.cells.filter((c) => c.source && VIDEO_KINDS.has(act.kinds.get(c.source))).map((c) => c.source))) await isAudio(n); }
function cellImg(c) {
  if (!c.image || c.type === 'counter' || c.type === 'replay' || !c.source) return '';
  if (obs.identified && act.kinds && !IMG_KINDS.has(act.kinds.get(c.source))) return '';
  return img(c.source) || '';
}
function cellStyle(c) { const img = cellImg(c);
  return `background:${esc(c.color)}${img ? `;background-image:url('${img}')` : ''}`; }
function updateCell(i) { const el = document.querySelector(`.cell[data-i="${i}"]`); if (!el) return; el.innerHTML = cellHTML(S.cells[i], i); el.classList.toggle('on', active.has(i)); el.classList.toggle('img', !!cellImg(S.cells[i])); el.setAttribute('style', cellStyle(S.cells[i])); }
function renderGrid() {
  const g = $('#grid'); const { cols, rows } = S.grid; const per = cols * rows; const pages = Math.ceil(S.cells.length / per);
  g.style.setProperty('--cols', cols); g.style.setProperty('--rows', rows);
  let h = '';
  for (let p = 0; p < pages; p++) {
    h += `<section class="page" data-p="${p}">`;
    for (let i = p * per; i < Math.min(S.cells.length, (p + 1) * per); i++)
      h += `<div class="cell t-${S.cells[i].type}${active.has(i) ? ' on' : ''}${cellImg(S.cells[i]) ? ' img' : ''}" data-i="${i}" style="${cellStyle(S.cells[i])}">${cellHTML(S.cells[i], i)}</div>`;
    h += '</section>';
  }
  g.innerHTML = h;
  $('#pages').innerHTML = pages > 1 ? Array.from({ length: pages }, (_, p) => `<button data-p="${p}">${p + 1}</button>`).join('') : '';
  $('#pages').style.display = pages > 1 ? '' : 'none';
  document.body.classList.toggle('reorder', reorder);
  renderScenes();
}
// тап vs прокрутка: активация, только если палец сдвинулся < 10px
let down = null;
// ---------- Перестановка ячеек (режим ⇅) ----------
let reorder = false, drag = null;
$('#btnReorder').onclick = () => { reorder = !reorder; $('#btnReorder').classList.toggle('on', reorder); renderGrid();
  if (reorder) toast(t('toast.reorder')); };
function moveCell(i, j) { // ячейку i поставить на место j; подсветка/таймеры едут вместе с ячейкой
  const byObj = new Map([...active].map(([k, v]) => [S.cells[k], v]));
  const [c] = S.cells.splice(i, 1); S.cells.splice(j, 0, c);
  active.clear(); S.cells.forEach((x, k) => { if (byObj.has(x)) active.set(k, byObj.get(x)); });
  persist(); renderGrid();
}
// Живая перестановка: при перетаскивании остальные ячейки плавно сдвигаются (transform),
// показывая будущий порядок; отпустили — порядок сохраняется.
function slotAt(x, y) { // номер места под пальцем (координаты места — снятые в начале перетаскивания)
  const dy = $('#grid').scrollTop - drag.st;
  return drag.rects.findIndex((r) => x >= r.left && x <= r.right && y + dy >= r.top && y + dy <= r.bottom);
}
function preview(j) {
  if (j === drag.j) return; drag.j = j;
  const order = drag.rects.map((_, k) => k).filter((k) => k !== drag.i); order.splice(j, 0, drag.i);
  drag.cells.forEach((el, k) => { if (k === drag.i) return; const p = order.indexOf(k); const a = drag.rects[k], b = drag.rects[p];
    el.style.transform = p === k ? '' : `translate(${b.left - a.left}px,${b.top - a.top}px)`; });
}
document.addEventListener('pointerdown', (e) => {
  if (!reorder) return; const c = e.target.closest('.cell'); if (!c) return;
  e.preventDefault(); c.setPointerCapture(e.pointerId);
  const cells = [...document.querySelectorAll('#grid .cell')];
  drag = { el: c, i: +c.dataset.i, j: +c.dataset.i, x: e.clientX, y: e.clientY, id: e.pointerId, st: $('#grid').scrollTop, cells, rects: cells.map((x) => x.getBoundingClientRect()) };
  c.classList.add('dragging');
});
document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return; const g = $('#grid'); const r = g.getBoundingClientRect();
  if (e.clientY < r.top + 40) g.scrollTop -= 12; else if (e.clientY > r.bottom - 40) g.scrollTop += 12; // к другим страницам
  drag.el.style.transform = `translate(${e.clientX - drag.x}px,${e.clientY - drag.y + g.scrollTop - drag.st}px)`;
  const j = slotAt(e.clientX, e.clientY); if (j >= 0) preview(j);
});
const endDrag = (e) => {
  if (!drag || e.pointerId !== drag.id) return; const { i, j } = drag; const ok = e.type === 'pointerup';
  drag.cells.forEach((el) => { el.style.transform = ''; }); drag.el.classList.remove('dragging'); drag = null;
  if (ok && j !== i) moveCell(i, j); else renderGrid();
};
document.addEventListener('pointerup', endDrag); document.addEventListener('pointercancel', endDrag);
document.addEventListener('pointerdown', (e) => { if (reorder) return; const c = e.target.closest('.cell'); down = c ? { c, x: e.clientX, y: e.clientY, id: e.pointerId } : null; });
document.addEventListener('pointermove', (e) => { if (down && e.pointerId === down.id && Math.hypot(e.clientX - down.x, e.clientY - down.y) >= 10) down = null; });
document.addEventListener('pointercancel', () => down = null);
document.addEventListener('pointerup', (e) => {
  if (reorder || !down || e.pointerId !== down.id) return; const c = down.c; down = null;
  if (e.target.closest('.cell') !== c) return;
  c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 150);
  press(+c.dataset.i, { currentTarget: c, target: e.target });
});
let sdown = null; // сцены: тап vs прокрутка, как у ячеек
$('#scenes').addEventListener('pointerdown', (e) => { const b = e.target.closest('button'); sdown = b ? { b, x: e.clientX, y: e.clientY, id: e.pointerId } : null; });
$('#scenes').addEventListener('pointermove', (e) => { if (sdown && e.pointerId === sdown.id && Math.hypot(e.clientX - sdown.x, e.clientY - sdown.y) >= 10) sdown = null; });
$('#scenes').addEventListener('pointercancel', () => sdown = null);
$('#scenes').addEventListener('pointerup', async (e) => {
  if (!sdown || e.pointerId !== sdown.id) return; const b = sdown.b; sdown = null;
  if (e.target.closest('button') !== b) return;
  if (!obs.identified) return toast(t('err.noObs'), true);
  try { await act.setScene(b.dataset.scene); curScene = b.dataset.scene; renderScenes(); } catch (err) { toast(err.message, true); }
});
$('#pages').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) $(`.page[data-p="${b.dataset.p}"]`).scrollIntoView({ behavior: 'smooth' }); });
$('#grid').addEventListener('scroll', () => {
  const g = $('#grid'); const p = Math.round(g.scrollTop / g.clientHeight);
  document.querySelectorAll('#pages button').forEach((b) => b.classList.toggle('cur', +b.dataset.p === p));
}, { passive: true });

$('#btnHide').onclick = async () => { try { const on = await act.toggleOverlaysScene(); $('#btnHide').classList.toggle('alert', !on); toast(t(on ? 'toast.overlaysShown' : 'toast.overlaysHidden'));
  if (!on) for (const i of [...active.keys()]) { clearTimeout(active.get(i).timer); } } catch (err) { toast(err.message, true); } };
$('#btnReplay').onclick = async () => {
  if (!obs.identified) return toast(t('err.noObs'), true);
  try { savePending = Date.now(); await act.saveReplay(); }
  catch (err) {
    savePending = null;
    if (!(await act.replayBufferActive().catch(() => true))) { // буфер был выключен — запускаем
      await ensureBuffer(true);
      if (bufferOn) toast(t('toast.bufferWasOff'), true);
    } else toast(err.message, true);
  }
};
$('#buf').onclick = () => obs.identified ? ensureBuffer() : toast(t('err.noObs'), true);
$('#btnPlay').onclick = async () => {
  try { if (replayOn || replayShown()) await stopReplay(); else {
    await playReplay(); replayOn = true; setPlayBtn();
    const sec = +S.replay.duration || 0; clearTimeout(replayTimer);
    if (sec > 0) replayTimer = setTimeout(() => { replayTimer = null; if (replayOn) stopReplay(); }, sec * 1000);
  } } catch (err) { toast(err.message, true); }
};
$('#btnMic').onclick = async () => {
  if (!S.mic.source) return toast(t('toast.micNoSource'), true);
  if (!obs.identified) return toast(t('err.noObs'), true);
  if (micBusy) return; // a double tap must not immediately undo the first toggle
  micBusy = true;
  const current = micReplyGuard();
  try { const muted = await act.toggleMute(S.mic.source); if (current()) setMic(muted); }
  catch (err) { toast(err.message, true); if (current()) await refreshMic(false); }
  finally { micBusy = false; }
};
$('#gtimer').onclick = () => { if (gameTimer && confirm(t('confirm.stopGameTimer'))) { gameTimer = null; tickGameTimer(); } };

setInterval(() => {
  $('#clock').textContent = new Date().toLocaleTimeString('ru-RU');
  const ind = $('#live'); const el = elapsed();
  ind.className = 'live' + (live.streaming ? ' on' : '');
  ind.textContent = t(live.streaming ? 'hdr.live' : 'hdr.notLive');
  const rec = $('#rec'); rec.className = 'rec' + (live.recording ? ' on' : ''); rec.textContent = (live.recording ? '● ' : '○ ') + 'REC';
  $('#elapsed').textContent = live.streaming ? fmt(el, true) : '';
  for (const [i, st] of active) if (st.until) updateCell(i);
  tickGameTimer();
}, 250);

// ---------- Страницы ----------
function route() {
  const r = location.hash.replace('#', '') || 'main';
  document.querySelectorAll('.view').forEach((v) => v.hidden = v.id !== 'v-' + r);
  if (r === 'settings') renderSettings(); if (r === 'timecodes') renderTimecodes(); if (r === 'main') renderGrid();
}
window.addEventListener('hashchange', route);

const typeOpts = () => ['overlay', 'counter', 'replay'].map((k) => [k, t('type.' + k)]);
const modeOpts = () => ['timer', 'toggle'].map((k) => [k, t('mode.' + k)]);
const sel = (k, opts, v) => `<select data-k="${k}">${opts.map(([a, b]) => `<option value="${a}"${a === v ? ' selected' : ''}>${b}</option>`).join('')}</select>`;
const box = (title, inner) => `<section class="box"><h3>${title}</h3>${inner}</section>`;
function renderSettings() {
  if (document.activeElement?.classList.contains('pick')) { clearTimeout(renderSettings.t2); renderSettings.t2 = setTimeout(renderSettings, 800); return; }
  const v = $('#v-settings');
  const items = [...act.index.keys()].sort((a, b) => a.localeCompare(b)); // всё, что стоит в сценах
  if (obs.identified && !renderSettings.mic) act.audioInputs().then((l) => { renderSettings.mic = l; renderSettings(); }).catch(() => {});
  v.querySelector('#g0').innerHTML =
    box(t('settings.preset.title'), `<div class="gset prow"><select id="presetSel">${S.presets.map((p) => `<option value="${esc(p.id)}"${p.id === S.activePreset ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <button type="button" data-pa="new">${t('settings.preset.new')}</button><button type="button" data-pa="dup">${t('settings.preset.dup')}</button>
      <button type="button" data-pa="ren">${t('settings.preset.rename')}</button><button type="button" data-pa="del" class="danger${S.presets.length < 2 ? ' off' : ''}"${S.presets.length < 2 ? ` aria-disabled="true" title="${t('toast.onlyPreset')}"` : ''}>${t('settings.preset.delete')}</button></div>`);
  const sc = [...new Set([...act.sceneOrder, ...S.sceneButtons])]; // сцены OBS + отмеченные, которых сейчас нет
  v.querySelector('#g').innerHTML =
    box(t('settings.scenes.title'), sc.length ? `<div class="chk">${sc.map((n) => { const miss = obs.identified && !act.sceneOrder.includes(n);
      return `<label${miss ? ` class="missl" title="${t('settings.missingTitle')}"` : ''}><input type="checkbox" data-scn="${esc(n)}"${S.sceneButtons.includes(n) ? ' checked' : ''}> ${esc(n)}</label>`; }).join('')}</div>` : `<p class="hint">${t('settings.scenes.empty')}</p>`) +
    box(t('settings.lang.title'), `<div class="gset"><label>${t('settings.lang.label')} <select id="langSel">${(renderSettings.langs || []).map((l) => `<option value="${esc(l.code)}"${l.code === getLang() ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label></div>`) +
    box(t('settings.obs.title'), `<div class="gset">
      <label>${t('settings.obs.host')} <input data-g="obs.host" value="${esc(S.obs.host)}"></label>
      <label>${t('settings.obs.port')} <input data-g="obs.port" type="number" value="${S.obs.port}"></label>
      <label>${t('settings.obs.password')} <span class="pwdw"><input data-g="obs.password" type="password" autocomplete="off" value="${esc(S.obs.password)}"><button type="button" class="pwdeye" data-pwdeye aria-label="${t('settings.obs.showPwd')}" title="${t('settings.obs.showPwd')}">👁</button></span></label></div>`) +
    box(t('settings.grid.title'), `<div class="gset">
      <label>${t('settings.grid.cols')} <input data-g="grid.cols" type="number" min="1" max="12" value="${S.grid.cols}"></label>
      <label>${t('settings.grid.rows')} <input data-g="grid.rows" type="number" min="1" max="12" value="${S.grid.rows}"></label>
      <label>${t('settings.grid.total')} <input data-g="grid.total" type="number" min="1" max="500" value="${S.grid.total}"></label></div>`) +
    box(t('settings.hideAll.title'), `<div class="gset"><label>${t('settings.hideAll.scene')} ${pick('data-g="overlaysScene"', S.overlaysScene, act.scenes)}</label></div>
      <p class="hint">${t('settings.hideAll.hint')}</p>`) +
    box(t('settings.replay.title'), `<p class="hint">${t('settings.replay.hint')} <details><summary>${t('settings.replay.more')}</summary>${t('settings.replay.details')}</details></p>
      <div class="gset"><label>${t('settings.replay.source')} ${pick('data-g="replay.mediaSource"', S.replay.mediaSource, act.inputs)}</label>
      <label>${t('settings.replay.duration')} <input data-g="replay.duration" type="number" min="0" step="0.5" value="${+S.replay.duration || 0}" title="${esc(t('settings.replay.durationTitle'))}"></label></div>`) +
    box(t('settings.timer.title'), `<div class="gset"><label>${t('settings.timer.source')} ${pick('data-g="gameTimer.source"', S.gameTimer.source, act.inputs)}</label></div>
      <p class="hint">${t('settings.timer.cells')}</p>
      <div class="chk">${S.cells.map((c, i) => `<label><input type="checkbox" data-gt="${i}"${c.startGameTimer ? ' checked' : ''}> ${i + 1}. ${esc(c.label)}</label>`).join('')}</div>`) +
    box(t('settings.match.title'), `<p class="hint">${t('settings.match.hint')}</p><div class="gset">
      <label>${t('settings.match.source')} ${pick('data-g="match.source"', S.match.source, act.inputs)}</label>
      <label>${t('settings.match.template')} <input data-g="match.template" value="${esc(S.match.template)}"><span class="hint">${t('settings.match.templateHint')}</span></label>
      <label>${t('settings.match.value')} <input data-g="match.value" type="number" min="0" value="${S.match.value}"></label></div>`) +
    box(t('settings.mic.title'), `<div class="gset"><label>${t('settings.mic.source')} ${pick('data-g="mic.source"', S.mic.source, renderSettings.mic || act.inputs)}</label></div>`);
  v.querySelector('tbody').innerHTML = S.cells.map((c, i) => `<tr data-i="${i}">
    <td>${i + 1}</td><td><input data-k="label" value="${esc(c.label)}"></td>
    <td><button type="button" class="swbtn" data-color="${i}" style="background:${esc(c.color)}" aria-label="${esc(t('settings.cells.color', { c: c.color }))}"></button></td>
    <td>${sel('type', typeOpts(), c.type)}</td>
    <td>${c.type === 'replay' ? `<span class="hint">${t('settings.cells.fromReplay')}</span>` : (() => { const l = c.type === 'counter' ? act.inputs : items;
      return pick('data-k="source"', c.source, l); })()}</td>
    <td>${c.type === 'counter' ? `<input data-k="counterTemplate" value="${esc(c.counterTemplate)}" title="${t('settings.cells.templateTitle')}"> № <input data-k="counterValue" type="number" value="${esc(c.counterValue)}">` : sel('mode', modeOpts(), c.mode)}</td>
    <td>${c.type === 'counter' ? '' : `<input data-k="duration" type="number" min="0.5" step="0.5" value="${c.duration}">`}</td>
    <td><input data-k="timecode" type="checkbox"${c.timecode ? ' checked' : ''}></td>
    <td>${c.type === 'counter' || c.type === 'replay' ? '' : `<input data-k="image" type="checkbox"${c.image ? ' checked' : ''} title="${esc(t('settings.cells.imageTitle'))}">`}</td></tr>`).join('');
}
// Выбор источника: поле ввода + собственный список подсказок (не <datalist>: в нём браузер
// уводит фокус из поля). Набор текста сужает список, фокус всегда остаётся в поле.
function pick(attr, val, list) {
  const opts = [...new Set(list || [])].sort((a, b) => a.localeCompare(b));
  const miss = val && obs.identified && !opts.includes(val);
  return `<span class="pickw"><input ${attr} value="${esc(val || '')}" data-opts="${esc(JSON.stringify(opts))}" placeholder="${t('settings.typeName')}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" class="pick${miss ? ' miss' : ''}"${miss ? ` title="${t('settings.missingTitle')}"` : ''}><div class="sugg" hidden></div></span>${miss ? `<div class="warnsm">${t('settings.missing')}</div>` : ''}`;
}
function showSugg(inp) {
  const box = inp.nextElementSibling, q = inp.value.trim().toLowerCase(), all = JSON.parse(inp.dataset.opts || '[]');
  const l = q ? [...all.filter((n) => n.toLowerCase().startsWith(q)), ...all.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q))] : all;
  box.innerHTML = l.map((n) => `<button type="button" data-sg="${esc(n)}">${esc(n)}</button>`).join(''); box.hidden = !l.length;
}
$('#v-settings').addEventListener('input', (e) => { if (e.target.classList.contains('pick')) showSugg(e.target); });
$('#v-settings').addEventListener('focusin', (e) => { if (e.target.classList.contains('pick')) showSugg(e.target); });
$('#v-settings').addEventListener('focusout', (e) => { if (e.target.classList.contains('pick')) setTimeout(() => { const b = e.target.nextElementSibling; if (b) b.hidden = true; }, 150); });
$('#v-settings').addEventListener('pointerdown', (e) => { if (e.target.closest('[data-sg]')) e.preventDefault(); }); // фокус не уходит из поля
$('#v-settings').addEventListener('click', (e) => { const b = e.target.closest('[data-sg]'); if (!b) return;
  const inp = b.parentElement.previousElementSibling; inp.value = b.dataset.sg; b.parentElement.hidden = true; inp.blur(); inp.dispatchEvent(new Event('change', { bubbles: true })); });
$('#v-settings').addEventListener('click', (e) => { // пресеты: новый / копия / переименовать / удалить
  const a = e.target.closest('[data-pa]')?.dataset.pa; if (!a) return; const cur = curPreset(S);
  const ask = (def) => { const v = prompt(t('prompt.presetName'), def); return v == null || !v.trim() ? null : v.trim(); };
  if (a === 'del' && S.presets.length < 2) { toast(t('toast.onlyPreset')); return; }
  if (a === 'new' || a === 'dup') {
    const name = ask(a === 'dup' ? cur.name + ' 2' : t('defaults.newPreset', { n: S.presets.length + 1 })); if (!name) return;
    const p = a === 'dup' ? normalizePreset({ ...JSON.parse(JSON.stringify(cur)), id: defaultPreset().id, name }) : defaultPreset(name);
    if (a === 'dup') for (const [k, v] of [...images]) if (k.startsWith(cur.id + '|')) putImage(imgKey(p.id, k.slice(cur.id.length + 1)), v);
    S.presets.push(p); S.activePreset = p.id; applyPreset();
  } else if (a === 'ren') { const name = ask(cur.name); if (!name) return; cur.name = name; persist(); renderPresetName(); renderSettings(); }
  else if (a === 'del' && S.presets.length > 1 && confirm(t('confirm.deletePreset', { name: cur.name }))) {
    for (const k of [...images.keys()]) if (k.startsWith(cur.id + '|')) deleteImage(k);
    S.presets = S.presets.filter((p) => p !== cur); S.activePreset = S.presets[0].id; applyPreset();
  }
});
$('#v-settings').addEventListener('click', (e) => { // цвет ячейки -> всплывающий выбор
  const b = e.target.closest('[data-color]'); if (!b) return; const i = +b.dataset.color;
  openColorPicker(S.cells[i].color, (hex) => { S.cells[i].color = hex; persist(); renderSettings(); });
});
$('#v-settings').addEventListener('change', (e) => {
  const el = e.target; let val = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value;
  if (el.id === 'presetSel') { S.activePreset = val; applyPreset(); return; }
  if (val === '__manual') { const v = prompt(t('prompt.manualName')); if (v == null) { renderSettings(); return; } val = v.trim(); }
  if (el.dataset.scn != null) { const n = el.dataset.scn; const set = new Set(S.sceneButtons); val ? set.add(n) : set.delete(n);
    const order = [...act.sceneOrder, ...S.sceneButtons]; S.sceneButtons = [...new Set(order)].filter((x) => set.has(x)); persist(); renderScenes(); return; }
  if (el.dataset.gt) { S.cells[+el.dataset.gt].startGameTimer = val; persist(); return; }
  if (el.dataset.g) {
    const [a, b] = el.dataset.g.split('.'); if (b) S[a][b] = val; else S[a] = val;
    if (a === 'grid') resizeCells(S);
    if (a === 'obs') connect();
    if (a === 'mic') refreshMic();
    if (a === 'match') pushMatch();
  } else if (el.dataset.k) {
    const i = +el.closest('tr').dataset.i; const k = el.dataset.k;
    if (k === 'duration' && !(val >= 0.5)) { val = 8; toast(t('toast.durationFixed')); }
    S.cells[i][k] = val;
    if (k === 'counterValue' && S.cells[i].source && obs.identified) act.setText(S.cells[i].source, S.cells[i].counterTemplate.replace('{n}', val)).catch((err) => toast(err.message, true));
  }
  persist(); if (['type', 'label', 'duration', 'source'].includes(el.dataset.k) || el.dataset.g) renderSettings();
});
// Keep text dialogs inside the visible viewport as the software keyboard opens.
function showBackupDialog(d) {
  d.classList.add('backup-editor');
  const viewport = window.visualViewport;
  const fit = () => {
    d.style.setProperty('--backup-height', (viewport ? viewport.height : window.innerHeight) + 'px');
    d.style.setProperty('--backup-top', (viewport ? viewport.offsetTop : 0) + 'px');
  };
  viewport?.addEventListener('resize', fit); viewport?.addEventListener('scroll', fit);
  window.addEventListener('resize', fit);
  d.addEventListener('close', () => {
    viewport?.removeEventListener('resize', fit); viewport?.removeEventListener('scroll', fit);
    window.removeEventListener('resize', fit); d.remove();
  }, { once: true });
  document.body.appendChild(d); fit(); d.showModal();
}
function backupJson() {
  const out = JSON.parse(JSON.stringify(S)); // embedded thumbnails make either export portable
  for (const p of out.presets) { const m = {}; for (const [k, v] of images) if (k.startsWith(p.id + '|')) m[k.slice(p.id.length + 1)] = v; p.images = m; }
  return JSON.stringify(out, null, 2);
}
$('#btnExportFile').onclick = () => {
  const json = backupJson(), fname = `obs-overlay-pad-${new Date().toISOString().slice(0, 10)}.json`;
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = fname; a.style.display = 'none';
  document.body.appendChild(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
};
$('#btnExportText').onclick = () => {
  const json = backupJson();
  const d = document.createElement('dialog'); d.className = 'backup';
  d.setAttribute('aria-labelledby', 'exportTitle');
  d.innerHTML = `<h3 id="exportTitle">${t('backup.exportTitle')}</h3><label for="exportJson">${t('backup.exportHint')}</label><textarea id="exportJson" readonly></textarea>
    <div class="row"><button data-b="copy">${t('backup.copy')}</button><button data-b="close" autofocus>${t('backup.close')}</button></div>`;
  const ta = d.querySelector('textarea'); ta.value = json;
  d.onclick = (e) => { const b = e.target.dataset && e.target.dataset.b; if (!b) return;
    if (b === 'close') d.close();
    if (b === 'copy') { ta.focus(); ta.select(); ta.setSelectionRange(0, json.length); let ok = false; try { ok = document.execCommand('copy'); } catch {} toast(t(ok ? 'backup.copied' : 'backup.copyFail'), !ok); }
  };
  showBackupDialog(d);
};
$('#btnImportFile').onclick = () => $('#fileImport').click();
async function importSettings(text) {
  const { state, thumbnails } = parseBackup(text);
  for (const [id, name, value] of thumbnails) await putImage(imgKey(id, name), value);
  // Persist only normalized settings, never embedded images.
  save(state); S = state;
  connect(); applyPreset(); renderSettings(); toast(t('toast.importOk'));
}
$('#fileImport').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { await importSettings(await f.text()); }
  catch (err) { toast(t('toast.importErr', { msg: err.message }), true); }
  finally { e.target.value = ''; }
};
$('#btnImportText').onclick = () => {
  const d = document.createElement('dialog'); d.className = 'backup';
  d.setAttribute('aria-labelledby', 'importTitle');
  d.innerHTML = `<h3 id="importTitle">${t('backup.importTitle')}</h3>
    <label for="importJson">${t('backup.paste')}</label>
    <textarea id="importJson" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="importError"></textarea>
    <p id="importError" role="alert"></p>
    <div class="row"><button data-b="close">${t('backup.close')}</button><button data-b="import">${t('settings.backup.import')}</button></div>`;
  const ta = d.querySelector('textarea'), submit = d.querySelector('[data-b="import"]');
  let busy = false;
  d.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
  d.onclick = async (e) => {
    if (busy) return;
    if (e.target.dataset.b === 'close') return d.close();
    if (e.target.dataset.b !== 'import') return;
    busy = true; submit.disabled = true; d.setAttribute('aria-busy', 'true');
    d.querySelector('#importError').textContent = '';
    try { await importSettings(ta.value); d.close(); }
    catch (err) { d.querySelector('#importError').textContent = t('toast.importErr', { msg: err.message }); }
    finally { busy = false; submit.disabled = false; d.removeAttribute('aria-busy'); }
  };
  showBackupDialog(d); ta.focus();
};
$('#btnReset').onclick = () => { if (confirm(t('confirm.reset'))) { S = defaultState(); applyPreset(); renderSettings(); location.hash = '#settings'; window.scrollTo(0, 0); } };
// Пустой кадр (весь прозрачный или одноцветный, например чёрный) — не сохраняем
function isBlank(uri) {
  return new Promise((res) => { const im = new Image();
    im.onload = () => { try { const cv = document.createElement('canvas'); cv.width = 32; cv.height = 32; const x = cv.getContext('2d');
      x.drawImage(im, 0, 0, 32, 32); const d = x.getImageData(0, 0, 32, 32).data; let mn = 255, mx = 0, a = 0;
      for (let i = 0; i < d.length; i += 4) { const v = d[i] + d[i + 1] + d[i + 2]; mn = Math.min(mn, v); mx = Math.max(mx, v); a = Math.max(a, d[i + 3]); }
      res(a < 8 || mx - mn < 12); } catch { res(false); } };
    im.onerror = () => res(true); im.src = uri; });
}
// Скриншоты картинок для кнопок: по одному, ошибка одного источника не мешает остальным
async function refreshImages() {
  const names = [...new Set(S.cells.filter((c) => c.image && c.source && c.type !== 'counter' && c.type !== 'replay'
    && IMG_KINDS.has(act.kinds.get(c.source))).map((c) => c.source))];
  const dur = new Map(S.cells.filter((c) => c.source).map((c) => [c.source, +c.duration || 0]));
  let ok = 0; const diag = []; const t0 = Date.now(); let sceneErr = '';
  const line = (name, L) => `${name}: ${L.live ? 'LIVE' : (L.copy ? 'copy ok' + (L.filters ? ' +' + L.filters + ' filters' : '') + ' · ' : 'copy NO · ') + (L.played ? 'PLAY ok' : 'PLAY no') + (L.restarted ? ' +RESTART' : '')}${L.state ? ' [' + L.state + ']' : ''} · ${L.blank === null ? 'no frame' : L.blank ? 'BLANK' : 'frame ok'}${L.err ? ' · ERR ' + L.err : ''} · ${L.ms} ms`;
  // Звуковые файлы пропускаем молча и не считаем в общем числе картинок
  const vidNames = [];
  for (const n of names.filter((x) => VIDEO_KINDS.has(act.kinds.get(x)))) if (!(await isAudio(n))) vidNames.push(n);
  let doneN = 0; const total = names.filter((n) => !VIDEO_KINDS.has(act.kinds.get(n))).length + vidNames.length;
  const prog = () => { const el = $('#toast'); clearTimeout(toast.h); el.className = 'show'; el.textContent = t('rescan.progress', { n: doneN, total }); };
  if (total) prog();
  const grab = async (name) => { // один снимок: видео через временную копию, картинка напрямую (+1 попытка при сбое)
    if (VIDEO_KINDS.has(act.kinds.get(name))) { const r = await act.videoFrame(name, dur.get(name), isBlank); return { uri: r.uri, log: r.log }; }
    try { return { uri: await act.screenshot(name) }; } catch { await new Promise((r) => setTimeout(r, 300)); return { uri: await act.screenshot(name) }; } };
  const one = async (name) => { try {
    let g = await grab(name); let blank = !g.uri || await isBlank(g.uri);
    if (blank) { await new Promise((r) => setTimeout(r, 300)); g = await grab(name); blank = !g.uri || await isBlank(g.uri); } // пустой кадр — ещё одна попытка
    if (!blank) { await putImage(imgKey(S.activePreset, name), g.uri); ok++; }
    else diag.push(g.log ? line(name, g.log) + ' (after retry)' : `${name}: empty frame (BLANK, after retry)`); }
    catch (e) { diag.push(`${name} [${act.kinds.get(name) || '?'}]: direct screenshot failed (after retry) · ${e.message}`); }
    finally { doneN++; prog(); } };
  const other = names.filter((n) => !VIDEO_KINDS.has(act.kinds.get(n)));
  try {
    for (const name of other) await one(name);
    if (vidNames.length) { try { await act.thumbBegin(); } catch (e) { diag.push('service scene: ERR ' + e.message); } }
    const queue = [...vidNames];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { while (queue.length) await one(queue.shift()); }));
  } finally { try { sceneErr = await act.thumbEnd(); } catch (e) { sceneErr = e.message; } }
  if (sceneErr) diag.push('service scene not removed: ' + sceneErr);
  // Отчёт: только источники с ошибками, внизу — общее время синхронизации
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  alert((diag.length ? `Errors (${diag.length}):\n\n` + diag.join('\n') : `No errors · ${ok} of ${total} images updated`) + `\n\nTotal time: ${secs} s`);
  return ok;
}
$('#btnRescan').onclick = () => act.rebuildIndex().then(async () => { renderSettings(); let n = 0; try { n = await refreshImages(); } catch (e) { alert('Image refresh error: ' + e.message); } renderGrid();
  toast(t('toast.rescan', { n: act.index.size }) + (n ? ' · ' + t('toast.images', { n }) : '')); }).catch((e) => toast(e.message, true));

function renderTimecodes() {
  const v = $('#tc');
  v.innerHTML = [...S.streams].reverse().map((st) => `<div class="stream" data-id="${st.id}">
    <h3><input data-f="title" value="${esc(st.title)}"> <button data-a="copy">${t('tc.copy')}</button> <button data-a="del" class="danger">${t('tc.delete')}</button></h3>
    ${st.marks.map((m, j) => `<div class="mark" data-j="${j}"><code>${fmt(m.t, true)}</code><input data-f="label" value="${esc(m.label)}"><button data-a="rm" aria-label="${t('tc.removeMark')}">✕</button></div>`).join('') || `<p>${t('tc.noMarks')}</p>`}
    <pre>${esc(youtubeText(st))}</pre></div>`).join('') || `<p>${t('tc.noStreams')}</p>`;
}
$('#tc').addEventListener('change', (e) => {
  const sEl = e.target.closest('.stream'); const st = S.streams.find((x) => x.id == sEl.dataset.id);
  if (e.target.dataset.f === 'title') st.title = e.target.value; else st.marks[+e.target.closest('.mark').dataset.j].label = e.target.value;
  persist(); renderTimecodes();
});
$('#tc').addEventListener('click', async (e) => {
  const a = e.target.dataset.a; if (!a) return; const sEl = e.target.closest('.stream'); const st = S.streams.find((x) => x.id == sEl.dataset.id);
  if (a === 'copy') { const txt = youtubeText(st); try { await navigator.clipboard.writeText(txt); toast(t('toast.copied')); } catch { prompt(t('prompt.copyManual'), txt); } }
  if (a === 'del' && confirm(t('confirm.deleteStream'))) { S.streams = S.streams.filter((x) => x !== st); }
  if (a === 'rm') st.marks.splice(+e.target.closest('.mark').dataset.j, 1);
  persist(); renderTimecodes();
});
$('#btnNewStream').onclick = () => { newStream(); renderTimecodes(); };

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.wakeLock) { const wl = () => navigator.wakeLock.request('screen').catch(() => {}); wl(); document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && wl()); }
// Язык: список языков, смена -> перерисовать всё
$('#v-settings').addEventListener('change', async (e) => {
  if (e.target.id !== 'langSel') return; e.stopImmediatePropagation();
  await setLang(e.target.value); applyI18n(); refreshTexts(); renderSettings(); renderGrid();
}, true);
function refreshTexts() { setPlayBtn(); setMic(micMuted); setBuffer(bufferOn); }
languages().then((l) => { renderSettings.langs = l; if (location.hash === '#settings') renderSettings(); });
applyI18n(); refreshTexts();
connect(); // сначала соединение: ошибка отрисовки не должна его блокировать
try { renderMatch(); renderPresetName(); route(); } catch (e) { console.error(e); toast(e.message, true); }
// версия — из файла VERSION (единственный источник)
fetch('VERSION').then((r) => r.ok ? r.text() : '').then((v) => { $('#ver').textContent = v.trim() ? 'v' + v.trim() : ''; }).catch(() => {});

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pwdeye]'); if (!b) return;
  e.preventDefault();
  const inp = b.parentElement.querySelector('input'); const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password'; b.classList.toggle('on', show);
  const l = t(show ? 'settings.obs.hidePwd' : 'settings.obs.showPwd'); b.setAttribute('aria-label', l); b.title = l;
});
