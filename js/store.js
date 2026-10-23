import { t } from './i18n.js';
const KEY = 'obs-overlay-pad-v1'; // ключ хранилища, НЕ версия приложения (не менять — потеряются настройки)
export function defaultCell(i) {
  return { label: t('defaults.cellLabel', { n: i + 1 }), color: '#2b3a55', type: 'overlay', source: '', mode: 'timer', duration: 8,
    timecode: false, startGameTimer: false, counterTemplate: t('defaults.counterTemplate'), counterValue: 1 };
}
// Пресеты (v3): поля из PKEYS живут в каждом пресете, остальное — общее.
// Код читает S.cells / S.grid / ... как раньше: это геттеры/сеттеры на активный пресет (в JSON не попадают).
export const PKEYS = ['cells', 'grid', 'overlaysScene', 'gameTimer', 'match', 'sceneButtons', 'mic'];
export function defaultPreset(name, id) {
  return {
    id: id || 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name || t('defaults.presetName'),
    grid: { cols: 4, rows: 3, total: 12 },
    overlaysScene: 'Overlays',
    gameTimer: { source: '', format: 'mm:ss' },
    match: { source: '', template: t('defaults.counterTemplate'), value: 1 }, // номер матча (− N + в шапке)
    sceneButtons: [], // имена сцен OBS, показанных кнопками слева на главном экране
    mic: { source: '' }, // аудиовход OBS для кнопки «Мик»
    cells: Array.from({ length: 12 }, (_, i) => defaultCell(i)),
  };
}
export function defaultState() {
  const p = defaultPreset();
  return attach({
    version: 3,
    obs: { host: location.hostname || '192.168.1.50', port: 4455, password: '' },
    replay: { mediaSource: '' },
    streams: [], // {id, title, startedAt, marks:[{t, label}]}
    presets: [p], activePreset: p.id,
  });
}
export function normalizePreset(p) {
  const d = defaultPreset(p && p.name, p && p.id); p = Object.assign(d, p || {});
  for (const k of ['grid', 'gameTimer', 'match', 'mic']) p[k] = Object.assign(defaultPreset()[k], p[k]);
  p.match.value = +p.match.value || 0; if (!Array.isArray(p.sceneButtons)) p.sceneButtons = [];
  p.name = String(p.name || '').trim() || t('defaults.presetName'); p.id = String(p.id);
  resizeCells(p);
  return p;
}
export function normalize(s) {
  s = s || {};
  const d = defaultState();
  let presets = Array.isArray(s.presets) && s.presets.length ? s.presets : null;
  if (!presets) { // старый формат (v1/v2): настройки целиком -> первый пресет «Default»
    const p = { name: t('defaults.presetName') }; for (const k of PKEYS) if (k in s) p[k] = s[k];
    presets = [p];
  }
  const out = { version: 3, obs: Object.assign(d.obs, s.obs), replay: Object.assign(d.replay, s.replay),
    streams: Array.isArray(s.streams) ? s.streams : [], presets: presets.map(normalizePreset) };
  const ids = new Set(); out.presets.forEach((p) => { if (ids.has(p.id)) p.id = defaultPreset().id; ids.add(p.id); });
  out.activePreset = ids.has(String(s.activePreset)) ? String(s.activePreset) : out.presets[0].id;
  return attach(out);
}
export const curPreset = (s) => s.presets.find((p) => p.id === s.activePreset) || s.presets[0];
function attach(s) {
  for (const k of PKEYS) Object.defineProperty(s, k, { enumerable: false, configurable: true,
    get: () => curPreset(s)[k], set: (v) => { curPreset(s)[k] = v; } });
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
