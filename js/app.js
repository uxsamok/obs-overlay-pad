import { ObsClient } from './obs.js';
import { Actions } from './actions.js';
import { openColorPicker } from './colorpicker.js';
import { initI18n, setLang, getLang, languages, t, applyI18n } from './i18n.js';
import { load, save, normalize, resizeCells, defaultState } from './store.js';

await initI18n(); // язык — до загрузки состояния (тексты по умолчанию берутся из перевода)
let S = load();
const obs = new ObsClient();
const act = new Actions(obs, () => S);
const $ = (q, r = document) => r.querySelector(q);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const persist = () => save(S);
const fmt = (ms, forceH = false) => { const t = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
  const p = (n) => String(n).padStart(2, '0'); return (h || forceH ? h + ':' + p(m) : p(m)) + ':' + p(s); };
let live = { streaming: false, recording: false, streamMs: 0, recordMs: 0, at: 0 };
const active = new Map(); // idx -> {until, timer}
let gameTimer = null; // {start}

function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : ''); clearTimeout(toast.h); toast.h = setTimeout(() => t.className = '', 2500); }

// ---------- OBS ----------
obs.addEventListener('status', async (e) => {
  const st = e.detail.status; const el = $('#conn');
  el.className = 'conn ' + st; el.textContent = { connected: 'OBS ✓', connecting: 'OBS …', disconnected: 'OBS ✕', error: 'OBS ✕' }[st];
  if (st === 'connected') { renderSettings.mic = null; try { await act.rebuildIndex(); await poll(); await ensureBuffer(); refreshMic(); pushMatch(); } catch (err) { toast(err.message, true); } }
  else { setBuffer(null); setMic(null); }
  renderGrid();
});
for (const ev of ['SceneItemCreated', 'SceneItemRemoved', 'InputNameChanged', 'SceneCreated', 'SceneRemoved', 'SceneNameChanged'])
  obs.addEventListener(ev, () => { clearTimeout(act.rb); act.rb = setTimeout(() => act.rebuildIndex().then(renderGrid).catch(() => {}), 500); });
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
async function playReplay() {
  if (!obs.identified) throw new Error(t('err.noObs'));
  if (!S.replay.mediaSource) throw new Error(t('err.noReplaySource'));
  await waitSave();
  await act.playLastReplay(S.replay.mediaSource);
}
async function stopReplay(stopMedia = true) { // скрыть источник, остановить видео, погасить ячейки
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
function setMic(m) { micMuted = m; const b = $('#btnMic'); b.classList.toggle('alert', m === true); b.classList.toggle('dim', m == null); b.textContent = t(m === true ? 'hdr.micMuted' : 'hdr.mic'); }
async function refreshMic() { if (!obs.identified || !S.mic.source) return setMic(null); try { setMic(await act.getMute(S.mic.source)); } catch { setMic(null); } }
obs.addEventListener('InputMuteStateChanged', (e) => { if (e.detail.inputName === S.mic.source) setMic(e.detail.inputMuted); });
obs.addEventListener('SceneItemEnableStateChanged', (e) => {
  // синхронизация подсветки переключателей, если оверлей выключили в самом OBS
  S.cells.forEach((c, i) => { if (c.type === 'overlay' && c.mode === 'toggle' && c.source) {
    const ref = (act.index.get(c.source) || [])[0];
    if (ref && ref.sceneName === e.detail.sceneName && ref.sceneItemId === e.detail.sceneItemId) { e.detail.sceneItemEnabled ? active.set(i, {}) : active.delete(i); updateCell(i); } } });
});
async function poll() { if (!obs.identified) return; try { live = { ...(await act.status()), at: Date.now() }; } catch {} }
setInterval(poll, 5000);
function connect() { obs.connect(S.obs.host, S.obs.port, S.obs.password); }

// ---------- Таймкоды ----------
const elapsed = () => live.streaming ? live.streamMs + (Date.now() - live.at) : live.recording ? live.recordMs + (Date.now() - live.at) : null;
function curStream() { if (!S.streams.length) newStream(); return S.streams[S.streams.length - 1]; }
function newStream() { const d = new Date(); S.streams.push({ id: d.getTime(), title: t('tc.streamTitle', { date: d.toLocaleString(getLang()) }), marks: [] }); persist(); }
function addMark(label) {
  const t = elapsed(); if (t == null) { toast(t('toast.noTimecode'), true); return; }
  curStream().marks.push({ t, label }); persist(); toast(`★ ${fmt(t, t >= 3600e3)} ${label}`);
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
  return `<div class="lbl">${esc(c.label)}</div>${sub}${warn ? `<div class="warn">${warn}</div>` : ''}<div class="num">${i + 1}</div>`;
}
function updateCell(i) { const el = document.querySelector(`.cell[data-i="${i}"]`); if (!el) return; el.innerHTML = cellHTML(S.cells[i], i); el.classList.toggle('on', active.has(i)); }
function renderGrid() {
  const g = $('#grid'); const { cols, rows } = S.grid; const per = cols * rows; const pages = Math.ceil(S.cells.length / per);
  g.style.setProperty('--cols', cols); g.style.setProperty('--rows', rows);
  let h = '';
  for (let p = 0; p < pages; p++) {
    h += `<section class="page" data-p="${p}">`;
    for (let i = p * per; i < Math.min(S.cells.length, (p + 1) * per); i++)
      h += `<div class="cell t-${S.cells[i].type}${active.has(i) ? ' on' : ''}" data-i="${i}" style="background:${esc(S.cells[i].color)}">${cellHTML(S.cells[i], i)}</div>`;
    h += '</section>';
  }
  g.innerHTML = h;
  $('#pages').innerHTML = pages > 1 ? Array.from({ length: pages }, (_, p) => `<button data-p="${p}">${p + 1}</button>`).join('') : '';
  $('#pages').style.display = pages > 1 ? '' : 'none';
  document.body.classList.toggle('reorder', reorder);
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
  try { if (replayOn || replayShown()) await stopReplay(); else { await playReplay(); replayOn = true; setPlayBtn(); } } catch (err) { toast(err.message, true); }
};
$('#btnMic').onclick = async () => {
  if (!S.mic.source) return toast(t('toast.micNoSource'), true);
  if (!obs.identified) return toast(t('err.noObs'), true);
  try { setMic(await act.toggleMute(S.mic.source)); } catch (err) { toast(err.message, true); }
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
  const v = $('#v-settings');
  const items = [...act.index.keys()].sort((a, b) => a.localeCompare(b)); // всё, что стоит в сценах
  // Ячейки: <input list> — набор текста фильтрует варианты (удобно при многих источниках)
  const dl = (l) => l.map((n) => `<option value="${esc(n)}">`).join('');
  $('#srcList').innerHTML = dl(items); $('#inpList').innerHTML = dl(act.inputs); $('#sceneList').innerHTML = dl(act.scenes);
  if (obs.identified && !renderSettings.mic) act.audioInputs().then((l) => { renderSettings.mic = l; renderSettings(); }).catch(() => {});
  v.querySelector('#g').innerHTML =
    box(t('settings.lang.title'), `<div class="gset"><label>${t('settings.lang.label')} <select id="langSel">${(renderSettings.langs || []).map((l) => `<option value="${esc(l.code)}"${l.code === getLang() ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label></div>`) +
    box(t('settings.obs.title'), `<div class="gset">
      <label>${t('settings.obs.host')} <input data-g="obs.host" value="${esc(S.obs.host)}"></label>
      <label>${t('settings.obs.port')} <input data-g="obs.port" type="number" value="${S.obs.port}"></label>
      <label>${t('settings.obs.password')} <input data-g="obs.password" type="password" value="${esc(S.obs.password)}"></label></div>`) +
    box(t('settings.grid.title'), `<div class="gset">
      <label>${t('settings.grid.cols')} <input data-g="grid.cols" type="number" min="1" max="12" value="${S.grid.cols}"></label>
      <label>${t('settings.grid.rows')} <input data-g="grid.rows" type="number" min="1" max="12" value="${S.grid.rows}"></label>
      <label>${t('settings.grid.total')} <input data-g="grid.total" type="number" min="1" max="500" value="${S.grid.total}"></label></div>`) +
    box(t('settings.hideAll.title'), `<div class="gset"><label>${t('settings.hideAll.scene')} ${(() => { const miss = S.overlaysScene && obs.identified && !act.scenes.includes(S.overlaysScene);
        return `<input data-g="overlaysScene" value="${esc(S.overlaysScene)}" list="sceneList" placeholder="${t('settings.typeName')}" autocomplete="off"${miss ? ` class="miss" title="${t('settings.missingTitle')}"` : ''}>${miss ? `<div class="warnsm">${t('settings.missing')}</div>` : ''}`; })()}</label></div>
      <p class="hint">${t('settings.hideAll.hint')}</p>`) +
    box(t('settings.replay.title'), `<p class="hint">${t('settings.replay.hint')} <details><summary>${t('settings.replay.more')}</summary>${t('settings.replay.details')}</details></p>
      <div class="gset"><label>${t('settings.replay.source')} ${pick('data-g="replay.mediaSource"', S.replay.mediaSource, act.inputs)}</label></div>`) +
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
      const miss = c.source && obs.identified && !l.includes(c.source);
      return `<input data-k="source" value="${esc(c.source)}" list="${c.type === 'counter' ? 'inpList' : 'srcList'}" placeholder="${t('settings.typeName')}" autocomplete="off"${miss ? ` class="miss" title="${t('settings.missingTitle')}"` : ''}>${miss ? `<div class="warnsm">${t('settings.missing')}</div>` : ''}`; })()}</td>
    <td>${c.type === 'counter' ? `<input data-k="counterTemplate" value="${esc(c.counterTemplate)}" title="${t('settings.cells.templateTitle')}"> № <input data-k="counterValue" type="number" value="${esc(c.counterValue)}">` : sel('mode', modeOpts(), c.mode)}</td>
    <td>${c.type === 'counter' ? '' : `<input data-k="duration" type="number" min="0.5" step="0.5" value="${c.duration}">`}</td>
    <td><input data-k="timecode" type="checkbox"${c.timecode ? ' checked' : ''}></td></tr>`).join('');
}
// Выбор источника: обычный <select> со ВСЕМИ вариантами из OBS (у <datalist> Chrome прячет
// варианты, не содержащие уже введённый текст). Плюс текущее значение и ручной ввод.
function pick(attr, val, list) {
  const opts = [...new Set(list || [])];
  return `<select ${attr} class="pick"><option value="">${t('pick.none')}</option>
    ${val && !opts.includes(val) ? `<option value="${esc(val)}" selected>${esc(val)}${obs.identified ? ' ' + t('pick.missing') : ''}</option>` : ''}
    ${opts.map((n) => `<option value="${esc(n)}"${n === val ? ' selected' : ''}>${esc(n)}</option>`).join('')}
    <option value="__manual">${t('pick.manual')}</option></select>`;
}
$('#v-settings').addEventListener('click', (e) => { // цвет ячейки -> всплывающий выбор
  const b = e.target.closest('[data-color]'); if (!b) return; const i = +b.dataset.color;
  openColorPicker(S.cells[i].color, (hex) => { S.cells[i].color = hex; persist(); renderSettings(); });
});
$('#v-settings').addEventListener('change', (e) => {
  const t = e.target; let val = t.type === 'checkbox' ? t.checked : t.type === 'number' ? +t.value : t.value;
  if (val === '__manual') { const v = prompt(t('prompt.manualName')); if (v == null) { renderSettings(); return; } val = v.trim(); }
  if (t.dataset.gt) { S.cells[+t.dataset.gt].startGameTimer = val; persist(); return; }
  if (t.dataset.g) {
    const [a, b] = t.dataset.g.split('.'); if (b) S[a][b] = val; else S[a] = val;
    if (a === 'grid') resizeCells(S);
    if (a === 'obs') connect();
    if (a === 'mic') refreshMic();
    if (a === 'match') pushMatch();
  } else if (t.dataset.k) {
    const i = +t.closest('tr').dataset.i; const k = t.dataset.k;
    if (k === 'duration' && !(val >= 0.5)) { val = 8; toast(t('toast.durationFixed')); }
    S.cells[i][k] = val;
    if (k === 'counterValue' && S.cells[i].source && obs.identified) act.setText(S.cells[i].source, S.cells[i].counterTemplate.replace('{n}', val)).catch((err) => toast(err.message, true));
  }
  persist(); if (['type', 'label', 'duration', 'source'].includes(t.dataset.k) || t.dataset.g) renderSettings();
});
$('#btnExport').onclick = () => {
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' }); const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `obs-overlay-pad-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#fileImport').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { S = normalize(JSON.parse(await f.text())); active.clear(); persist(); connect(); renderSettings(); toast(t('toast.importOk')); } catch (err) { toast(t('toast.importErr', { msg: err.message }), true); }
  e.target.value = '';
};
$('#btnReset').onclick = () => { if (confirm(t('confirm.reset'))) { S = defaultState(); active.clear(); persist(); renderSettings(); location.hash = '#settings'; window.scrollTo(0, 0); } };
$('#btnRescan').onclick = () => act.rebuildIndex().then(() => { renderSettings(); toast(t('toast.rescan', { n: act.index.size })); }).catch((e) => toast(e.message, true));

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
renderMatch(); route(); connect();
// версия — из файла VERSION (единственный источник)
fetch('VERSION').then((r) => r.ok ? r.text() : '').then((v) => { $('#ver').textContent = v.trim() ? 'v' + v.trim() : ''; }).catch(() => {});
