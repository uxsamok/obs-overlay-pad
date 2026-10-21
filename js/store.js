const KEY = 'obs-overlay-pad-v1';
export function defaultCell(i) {
  return { label: `Оверлей ${i + 1}`, color: '#2b3a55', type: 'overlay', source: '', mode: 'timer', duration: 8, outDuration: 0.5,
    timecode: false, startGameTimer: false, counterTemplate: 'Матч {n}', counterValue: 1 };
}
export function defaultState() {
  return {
    version: 1,
    obs: { host: location.hostname || '192.168.1.50', port: 4455, password: '' },
    grid: { cols: 4, rows: 3, total: 12 },
    overlaysScene: 'Overlays',
    gameTimer: { source: '', format: 'mm:ss' },
    replay: { mediaSource: '' },
    cells: Array.from({ length: 12 }, (_, i) => defaultCell(i)),
    streams: [], // {id, title, startedAt, marks:[{t, label}]}
  };
}
export function normalize(s) {
  const d = defaultState();
  s = Object.assign(d, s || {});
  s.obs = Object.assign(defaultState().obs, s.obs); s.grid = Object.assign(defaultState().grid, s.grid);
  s.gameTimer = Object.assign(defaultState().gameTimer, s.gameTimer); s.replay = Object.assign(defaultState().replay, s.replay);
  resizeCells(s);
  return s;
}
export function resizeCells(s) {
  const n = Math.max(1, Math.min(500, +s.grid.total || 1));
  s.grid.total = n;
  s.cells = (s.cells || []).slice(0, n).map((c, i) => Object.assign(defaultCell(i), c));
  while (s.cells.length < n) s.cells.push(defaultCell(s.cells.length));
}
export function load() { try { return normalize(JSON.parse(localStorage.getItem(KEY))); } catch { return defaultState(); } }
export function save(s) { localStorage.setItem(KEY, JSON.stringify(s)); }
