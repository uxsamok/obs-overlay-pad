import { ObsClient } from './obs.js';
import { Actions } from './actions.js';
import { load, save, normalize, resizeCells, defaultState } from './store.js';

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
  if (st === 'connected') { try { await act.rebuildIndex(); await poll(); } catch (err) { toast(err.message, true); } }
  renderGrid();
});
for (const ev of ['SceneItemCreated', 'SceneItemRemoved', 'InputNameChanged', 'SceneCreated', 'SceneRemoved', 'SceneNameChanged'])
  obs.addEventListener(ev, () => { clearTimeout(act.rb); act.rb = setTimeout(() => act.rebuildIndex().then(renderGrid).catch(() => {}), 500); });
obs.addEventListener('StreamStateChanged', (e) => { if (e.detail.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') newStream(); poll(); });
obs.addEventListener('RecordStateChanged', () => poll());
obs.addEventListener('ReplayBufferSaved', (e) => { act.lastReplay = e.detail.savedReplayPath; toast('Повтор сохранён'); });
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
function newStream() { const d = new Date(); S.streams.push({ id: d.getTime(), title: 'Стрим ' + d.toLocaleString('ru-RU'), marks: [] }); persist(); }
function addMark(label) {
  const t = elapsed(); if (t == null) { toast('Стрим и запись не идут — таймкод не поставлен', true); return; }
  curStream().marks.push({ t, label }); persist(); toast(`★ ${fmt(t, t >= 3600e3)} ${label}`);
}
function youtubeText(st) {
  const marks = [...st.marks].sort((a, b) => a.t - b.t); const long = marks.some((m) => m.t >= 3600e3);
  if (!marks.length || Math.floor(marks[0].t / 1000) > 0) marks.unshift({ t: 0, label: 'Начало' });
  return marks.map((m) => `${fmt(m.t, long)} ${m.label}`).join('\n');
}

// ---------- Ячейки ----------
async function press(i, e) {
  const c = S.cells[i];
  try {
    if (c.type === 'counter') {
      const r = e.currentTarget.getBoundingClientRect(); const dir = (e.clientX - r.left) < r.width / 2 ? -1 : 1;
      c.counterValue = (+c.counterValue || 0) + dir; persist(); updateCell(i);
      if (c.source) await act.setText(c.source, c.counterTemplate.replace('{n}', c.counterValue));
    } else if (c.type === 'replay') {
      if (!S.replay.mediaSource) throw new Error('Не указан Media Source для повтора в настройках');
      if (active.has(i)) return stopCell(i);
      await act.playLastReplay(S.replay.mediaSource); startActive(i, S.replay.mediaSource);
    } else {
      if (!c.source) throw new Error('Не указан источник OBS для ячейки ' + (i + 1));
      if (active.has(i)) return stopCell(i);
      await act.show(c.source); startActive(i, c.source);
    }
    if (c.timecode) addMark(c.label);
    if (c.startGameTimer) startGameTimer();
  } catch (err) { toast(err.message, true); }
}
function startActive(i, source) {
  const c = S.cells[i]; const st = { source };
  if (c.mode === 'timer' || c.type === 'replay' && c.mode === 'timer') {
    st.until = Date.now() + c.duration * 1000; st.timer = setTimeout(() => stopCell(i), c.duration * 1000);
  }
  active.set(i, st); updateCell(i);
}
async function stopCell(i) {
  const st = active.get(i); if (!st) return; clearTimeout(st.timer); active.delete(i); updateCell(i);
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
  const st = active.get(i); const warn = c.source && obs.identified && c.type !== 'replay' && (!act.index.has(c.source) ? '⚠ нет в OBS' : act.duplicates(c.source) ? '⚠ дубль имени' : '');
  let sub = '';
  if (c.type === 'counter') sub = `<div class="ctr"><span>−</span><b>${esc(c.counterValue)}</b><span>+</span></div>`;
  if (st && st.until) sub += `<div class="cd">${Math.ceil((st.until - Date.now()) / 1000)}</div>`;
  else if (st) sub += `<div class="cd">В ЭФИРЕ</div>`;
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
}
// тап vs прокрутка: активация, только если палец сдвинулся < 10px
let down = null;
document.addEventListener('pointerdown', (e) => { const c = e.target.closest('.cell'); down = c ? { c, x: e.clientX, y: e.clientY, id: e.pointerId } : null; });
document.addEventListener('pointermove', (e) => { if (down && e.pointerId === down.id && Math.hypot(e.clientX - down.x, e.clientY - down.y) >= 10) down = null; });
document.addEventListener('pointercancel', () => down = null);
document.addEventListener('pointerup', (e) => {
  if (!down || e.pointerId !== down.id) return; const c = down.c; down = null;
  if (e.target.closest('.cell') !== c) return;
  c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 150);
  press(+c.dataset.i, { currentTarget: c, clientX: e.clientX });
});
$('#pages').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) $(`.page[data-p="${b.dataset.p}"]`).scrollIntoView({ behavior: 'smooth' }); });
$('#grid').addEventListener('scroll', () => {
  const g = $('#grid'); const p = Math.round(g.scrollTop / g.clientHeight);
  document.querySelectorAll('#pages button').forEach((b) => b.classList.toggle('cur', +b.dataset.p === p));
}, { passive: true });

$('#btnMark').onclick = () => { const n = curStream().marks.filter((m) => m.label.startsWith('Момент')).length + 1; addMark('Момент ' + n); };
$('#btnHide').onclick = async () => { try { const on = await act.toggleOverlaysScene(); $('#btnHide').classList.toggle('alert', !on); toast(on ? 'Оверлеи показаны' : 'Все оверлеи скрыты');
  if (!on) for (const i of [...active.keys()]) { clearTimeout(active.get(i).timer); } } catch (err) { toast(err.message, true); } };
$('#btnReplay').onclick = () => act.saveReplay().catch((err) => toast(err.message.includes('604') || /not active/i.test(err.message) ? 'Replay Buffer не запущен в OBS' : err.message, true));
$('#gtimer').onclick = () => { if (gameTimer && confirm('Остановить таймер игры?')) { gameTimer = null; tickGameTimer(); } };

setInterval(() => {
  $('#clock').textContent = new Date().toLocaleTimeString('ru-RU');
  const ind = $('#live'); const el = elapsed();
  ind.className = 'live' + (live.streaming ? ' on' : '') + (live.recording && !live.streaming ? ' warn' : '');
  ind.textContent = (live.streaming ? '● LIVE' : '○ OFF') + (live.recording ? ' · REC' : '');
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

const typeOpts = [['overlay', 'Оверлей'], ['counter', 'Счётчик'], ['replay', 'Последний повтор']];
const modeOpts = [['timer', 'По таймеру'], ['toggle', 'Переключатель']];
const sel = (k, opts, v) => `<select data-k="${k}">${opts.map(([a, b]) => `<option value="${a}"${a === v ? ' selected' : ''}>${b}</option>`).join('')}</select>`;
function renderSettings() {
  const v = $('#v-settings');
  const names = [...act.index.keys()].sort();
  $('#srcList').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
  v.querySelector('#g').innerHTML = `
    <label>Хост OBS <input data-g="obs.host" value="${esc(S.obs.host)}"></label>
    <label>Порт <input data-g="obs.port" type="number" value="${S.obs.port}"></label>
    <label>Пароль <input data-g="obs.password" type="password" value="${esc(S.obs.password)}"></label>
    <label>Колонок <input data-g="grid.cols" type="number" min="1" max="12" value="${S.grid.cols}"></label>
    <label>Рядов на экране <input data-g="grid.rows" type="number" min="1" max="12" value="${S.grid.rows}"></label>
    <label>Всего ячеек <input data-g="grid.total" type="number" min="1" max="500" value="${S.grid.total}"></label>
    <label>Сцена с оверлеями («Скрыть всё») <input data-g="overlaysScene" value="${esc(S.overlaysScene)}" list="srcList"></label>
    <label>Текст. источник таймера игры <input data-g="gameTimer.source" value="${esc(S.gameTimer.source)}" list="srcList"></label>
    <label>Media Source для повтора <input data-g="replay.mediaSource" value="${esc(S.replay.mediaSource)}" list="srcList"></label>`;
  v.querySelector('tbody').innerHTML = S.cells.map((c, i) => `<tr data-i="${i}">
    <td>${i + 1}</td><td><input data-k="label" value="${esc(c.label)}"></td>
    <td><input data-k="color" type="color" value="${esc(c.color)}"></td>
    <td>${sel('type', typeOpts, c.type)}</td>
    <td><input data-k="source" value="${esc(c.source)}" list="srcList" placeholder="${c.type === 'counter' ? 'Текстовый источник' : c.type === 'replay' ? '(из общих настроек)' : 'Имя источника'}"></td>
    <td>${c.type === 'counter' ? `<input data-k="counterTemplate" value="${esc(c.counterTemplate)}" title="Шаблон, {n} — число">` : sel('mode', modeOpts, c.mode)}</td>
    <td><input data-k="duration" type="number" min="0.5" step="0.5" value="${c.duration}"></td>
    <td><input data-k="outDuration" type="number" min="0" step="0.1" value="${c.outDuration}"></td>
    <td><input data-k="timecode" type="checkbox"${c.timecode ? ' checked' : ''}></td>
    <td><input data-k="startGameTimer" type="checkbox"${c.startGameTimer ? ' checked' : ''}></td></tr>`).join('');
}
$('#v-settings').addEventListener('change', (e) => {
  const t = e.target; const val = t.type === 'checkbox' ? t.checked : t.type === 'number' ? +t.value : t.value;
  if (t.dataset.g) {
    const [a, b] = t.dataset.g.split('.'); if (b) S[a][b] = val; else S[a] = val;
    if (a === 'grid') resizeCells(S);
    if (a === 'obs') connect();
  } else if (t.dataset.k) { const i = +t.closest('tr').dataset.i; S.cells[i][t.dataset.k] = val; }
  persist(); if (t.dataset.k === 'type' || t.dataset.g?.startsWith('grid')) renderSettings();
});
$('#btnExport').onclick = () => {
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' }); const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `obs-overlay-pad-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#fileImport').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { S = normalize(JSON.parse(await f.text())); persist(); connect(); renderSettings(); toast('Настройки загружены'); } catch (err) { toast('Ошибка файла: ' + err.message, true); }
  e.target.value = '';
};
$('#btnReset').onclick = () => { if (confirm('Сбросить все настройки?')) { S = defaultState(); persist(); renderSettings(); } };
$('#btnRescan').onclick = () => act.rebuildIndex().then(() => { renderSettings(); toast(`Найдено источников: ${act.index.size}`); }).catch((e) => toast(e.message, true));

function renderTimecodes() {
  const v = $('#tc');
  v.innerHTML = [...S.streams].reverse().map((st) => `<div class="stream" data-id="${st.id}">
    <h3><input data-f="title" value="${esc(st.title)}"> <button data-a="copy">Скопировать для YouTube</button> <button data-a="del" class="danger">Удалить</button></h3>
    ${st.marks.map((m, j) => `<div class="mark" data-j="${j}"><code>${fmt(m.t, true)}</code><input data-f="label" value="${esc(m.label)}"><button data-a="rm">✕</button></div>`).join('') || '<p>Нет таймкодов</p>'}
    <pre>${esc(youtubeText(st))}</pre></div>`).join('') || '<p>Пока нет стримов с таймкодами.</p>';
}
$('#tc').addEventListener('change', (e) => {
  const sEl = e.target.closest('.stream'); const st = S.streams.find((x) => x.id == sEl.dataset.id);
  if (e.target.dataset.f === 'title') st.title = e.target.value; else st.marks[+e.target.closest('.mark').dataset.j].label = e.target.value;
  persist(); renderTimecodes();
});
$('#tc').addEventListener('click', async (e) => {
  const a = e.target.dataset.a; if (!a) return; const sEl = e.target.closest('.stream'); const st = S.streams.find((x) => x.id == sEl.dataset.id);
  if (a === 'copy') { const txt = youtubeText(st); try { await navigator.clipboard.writeText(txt); toast('Скопировано'); } catch { prompt('Скопируйте вручную:', txt); } }
  if (a === 'del' && confirm('Удалить стрим и его таймкоды?')) { S.streams = S.streams.filter((x) => x !== st); }
  if (a === 'rm') st.marks.splice(+e.target.closest('.mark').dataset.j, 1);
  persist(); renderTimecodes();
});
$('#btnNewStream').onclick = () => { newStream(); renderTimecodes(); };

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.wakeLock) { const wl = () => navigator.wakeLock.request('screen').catch(() => {}); wl(); document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && wl()); }
route(); connect();
