// Переводы интерфейса. Строки — в i18n/<код>.json (плоские ключи), список языков — i18n/languages.json.
// t('ключ', {n: 5}) подставляет {n}. Нет ключа в выбранном языке -> английский -> сам ключ.
const LKEY = 'obs-overlay-pad-lang';
let lang = 'en', en = {}, dict = {};
const get = (c) => fetch(`i18n/${c}.json`).then((r) => { if (!r.ok) throw new Error(c); return r.json(); });
export async function initI18n(code) {
  lang = code || localStorage.getItem(LKEY) || 'en';
  try { en = await get('en'); } catch { en = {}; }
  try { dict = lang === 'en' ? en : await get(lang); } catch { dict = {}; }
  document.documentElement.lang = lang;
}
export async function setLang(code) { localStorage.setItem(LKEY, code); await initI18n(code); }
export const getLang = () => lang;
export const languages = () => fetch('i18n/languages.json').then((r) => r.json()).catch(() => [{ code: 'en', name: 'English' }]);
export function t(key, params) {
  const s = dict[key] ?? en[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (m, n) => (n in params ? params[n] : m)) : s;
}
// Статичный HTML: data-i18n (текст), data-i18n-aria (aria-label), data-i18n-title (title)
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((e) => { e.textContent = t(e.dataset.i18n); });
  root.querySelectorAll('[data-i18n-aria]').forEach((e) => e.setAttribute('aria-label', t(e.dataset.i18nAria)));
  root.querySelectorAll('[data-i18n-title]').forEach((e) => { e.title = t(e.dataset.i18nTitle); });
  document.title = t('app.title');
}
