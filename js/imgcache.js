// Кэш картинок кнопок (скриншоты источников) — отдельно от настроек: IndexedDB, ключ = имя источника.
// В экспорт настроек не попадает. В памяти — Map для синхронного рендера.
const DB = 'obs-overlay-pad-images', ST = 'img';
export const images = new Map();
function open() {
  return new Promise((res, rej) => { const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => { const x = db.transaction(ST, mode); const out = fn(x.objectStore(ST));
    x.oncomplete = () => res(out && out.result); x.onerror = () => rej(x.error); });
}
export async function loadImages() {
  try { const db = await open(); await new Promise((res) => { const r = db.transaction(ST).objectStore(ST).openCursor();
    r.onsuccess = () => { const c = r.result; if (!c) return res(); images.set(c.key, c.value); c.continue(); }; r.onerror = () => res(); }); } catch {}
}
export async function putImage(name, uri) { images.set(name, uri); try { await tx('readwrite', (s) => s.put(uri, name)); } catch {} }
export async function deleteImage(name) { images.delete(name); try { await tx('readwrite', (s) => s.delete(name)); } catch {} }
