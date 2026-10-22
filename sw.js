// Service Worker: офлайн-работа установленного PWA.
// При установке кладёт в кэш ВСЕ файлы приложения (FILES). Запросы: сначала сеть
// (с таймаутом), при ошибке/зависании сети — из кэша. Удачные ответы сети обновляют кэш,
// так что новая версия с сервера подхватывается при следующем открытии.
// Добавили/переименовали файл приложения -> впишите его в FILES и увеличьте номер в CACHE.
const CACHE = 'overlay-pad-1.5.1'; // = файл VERSION; меняйте вместе
const NET_TIMEOUT_MS = 2500;
const FILES = ['./', 'index.html', 'css/styles.css', 'js/app.js', 'js/obs.js', 'js/actions.js', 'js/store.js', 'js/colorpicker.js', 'manifest.webmanifest', 'VERSION', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  // cache: 'reload' — мимо HTTP-кэша браузера, прямо с сервера
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function fromCache(req) {
  return caches.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === 'navigate' ? caches.match('index.html') : undefined));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(new Promise((resolve) => {
    let done = false;
    const fallback = (netResp) => { if (done) return; done = true; fromCache(req).then((r) => resolve(r || netResp || Response.error())); };
    const timer = setTimeout(() => fallback(), NET_TIMEOUT_MS); // сеть висит — отдаём кэш, не ждём
    fetch(req).then((r) => {
      clearTimeout(timer);
      if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); }
      if (done) return;
      if (r.ok) { done = true; resolve(r); } else fallback(r);
    }).catch(() => { clearTimeout(timer); fallback(); });
  }));
});
