import { t } from './i18n.js';
const KEY = 'obs-overlay-pad-v1'; // ключ хранилища, НЕ версия приложения (не менять — потеряются настройки)
export function defaultCell(i) {
  return { label: t('defaults.cellLabel', { n: i + 1 }), color: '#2b3a55', type: 'overlay', source: '', mode: 'timer', duration: 8,
    timecode: false, startGameTimer: false, counterTemplate: t('defaults.counterTemplate'), counterValue: 1 };
}
export function defaultState() {
  return {
    version: 2,
    obs: { host: location.hostname || '192.168.1.50', port: 4455, password: '' },
    grid: { cols: 4, rows: 3, total: 12 },
    overlaysScene: 'Overlays',
    gameTimer: { source: '', format: 'mm:ss' },
    replay: { mediaSource: '' },
    match: { source: '', template: t('defaults.counterTemplate'), value: 1 }, // номер матча (− N + в шапке)
    sceneButtons: [], // имена сцен OBS, показанных кнопками слева на главном экране
    mic: { source: '' }, // аудиовход OBS для кнопки «Мик»
    cells: Array.from({ length: 12 }, (_, i) => defaultCell(i)),
    streams: [], // {id, title, startedAt, marks:[{t, label}]}
  };
}
export function normalize(s) {
  const d = defaultState();
  s = Object.assign(d, s || {});
  s.obs = Object.assign(defaultState().obs, s.obs); s.grid = Object.assign(defaultState().grid, s.grid);
  s.gameTimer = Object.assign(defaultState().gameTimer, s.gameTimer); s.replay = Object.assign(defaultState().replay, s.replay);
  s.mic = Object.assign(defaultState().mic, s.mic); s.match = Object.assign(defaultState().match, s.match); s.match.value = +s.match.value || 0; if (!Array.isArray(s.sceneButtons)) s.sceneButtons = []; s.version = 2;
  resizeCells(s);
  return s;
}
export function resizeCells(s) {
  const n = Math.max(1, Math.min(500, +s.grid.total || 1));
  s.grid.total = n;
  // объекты ячеек сохраняются (на них ссылаются таймеры активных ячеек), недостающие поля — по умолчанию
  s.cells = (s.cells || []).slice(0, n).map((c, i) => {
    const d = defaultCell(i); for (const k in d) if (!(k in c)) c[k] = d[k];
    delete c.outDuration; // v1: поле «Out, с» убрано
    if (!(+c.duration >= 0.5)) c.duration = 8; // пустая/0 длительность -> 8 с
    if (!/^#[0-9a-f]{3,8}$/i.test(c.color)) c.color = d.color;
    return c;
  });
  while (s.cells.length < n) s.cells.push(defaultCell(s.cells.length));
}
export function load() { try { return normalize(JSON.parse(localStorage.getItem(KEY))); } catch { return defaultState(); } }
export function save(s) { localStorage.setItem(KEY, JSON.stringify(s)); }
