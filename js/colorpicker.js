import { t } from './i18n.js';
// Лёгкий выбор цвета (вместо системного: на Android он показывает 3 поля).
// Окно поверх страницы: превью, поле #hex, готовые цвета, область насыщенность/яркость + полоса оттенка.
export const SWATCHES = ['#2b3a55', '#3b5bdb', '#1971c2', '#0c8599', '#2b8a3e', '#5c940d', '#e67700', '#d9480f', '#c92a2a', '#a61e4d', '#862e9c', '#495057'];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function hexToHsv(hex) {
  let h = hex.replace('#', ''); if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16); const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let hue = 0; if (d) hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (hue * 60 + 360) % 360, s: mx ? d / mx : 0, v: mx };
}
function hsvToHex({ h, s, v }) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return '#' + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}
const validHex = (s) => { s = s.trim(); if (!s.startsWith('#')) s = '#' + s; return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s.toLowerCase() : null; };

let el, hsv, done;
function build() {
  el = document.createElement('div'); el.id = 'cp'; el.hidden = true;
  el.innerHTML = `<div class="cp-box">
    <div class="cp-top"><div class="cp-prev"></div><input class="cp-hex" maxlength="7" spellcheck="false" autocomplete="off"></div>
    <div class="cp-sw">${SWATCHES.map((h) => `<button type="button" data-h="${h}" style="background:${h}"></button>`).join('')}</div>
    <div class="cp-sv"><div class="cp-dot"></div></div>
    <div class="cp-hue"><div class="cp-knob"></div></div>
    <div class="cp-btns"><button type="button" class="cp-cancel" data-i18n="cp.cancel">${t('cp.cancel')}</button><button type="button" class="cp-ok" data-i18n="cp.ok">${t('cp.ok')}</button></div></div>`;
  document.body.appendChild(el);
  const q = (s) => el.querySelector(s);
  const drag = (area, fn) => area.addEventListener('pointerdown', (e) => {
    area.setPointerCapture(e.pointerId); const mv = (ev) => { const r = area.getBoundingClientRect(); fn(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)); upd(); };
    mv(e); area.onpointermove = mv; area.onpointerup = area.onpointercancel = () => { area.onpointermove = null; };
  });
  drag(q('.cp-sv'), (x, y) => { hsv.s = x; hsv.v = 1 - y; });
  drag(q('.cp-hue'), (x) => { hsv.h = x * 359.9; });
  q('.cp-sw').onclick = (e) => { const b = e.target.closest('[data-h]'); if (b) { hsv = hexToHsv(b.dataset.h); upd(); } };
  q('.cp-hex').oninput = (e) => { const h = validHex(e.target.value); if (h) { hsv = hexToHsv(h); upd(true); } };
  q('.cp-cancel').onclick = () => close();
  q('.cp-ok').onclick = () => { const f = done; close(); f(hsvToHex(hsv)); };
  el.onclick = (e) => { if (e.target === el) close(); };
}
function upd(fromHex) {
  const q = (s) => el.querySelector(s); const hex = hsvToHex(hsv);
  q('.cp-prev').style.background = hex; if (!fromHex) q('.cp-hex').value = hex;
  q('.cp-sv').style.background = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,hsl(${hsv.h},100%,50%))`;
  q('.cp-dot').style.left = hsv.s * 100 + '%'; q('.cp-dot').style.top = (1 - hsv.v) * 100 + '%';
  q('.cp-knob').style.left = hsv.h / 360 * 100 + '%';
  el.querySelectorAll('.cp-sw button').forEach((b) => b.classList.toggle('cur', b.dataset.h === hex));
}
function close() { el.hidden = true; done = null; }
export function openColorPicker(hex, onOk) {
  if (!el) build();
  hsv = hexToHsv(validHex(hex || '') || SWATCHES[0]); done = onOk; el.hidden = false; upd();
}
