/* Service Worker «ГолосУЗИ (UZD Voce) · Приказ 1130н».
 * Обеспечивает полноценную офлайн-работу: приложение и html2pdf кэшируются
 * при установке, далее отдаются из кэша без обращения к сети.
 * mutlp6u1-zygd заменяется сборщиком, чтобы браузер видел новый SW при каждом релизе. */

const CACHE = 'golosuzi-mutlp6u1-zygd';
const PRECACHE = [
    './',
    './index.html',
    './manifest.webmanifest',
    './favicon.png',
    './icon-192.png',
    './icon-512.png',
    './vendor/html2pdf.bundle.min.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((cache) => Promise.all(
                PRECACHE.map((url) => cache.add(url).catch(() => { /* не критично */ }))
            ))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== location.origin) return; // сторонние запросы не трогаем

    // Навигация — сеть в приоритете; при каждой онлайн-загрузке обновляем
    // офлайн-копию, чтобы установленное приложение получало свежую версию.
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req)
                .then((resp) => {
                    if (resp && resp.ok) {
                        const copy = resp.clone();
                        caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
                    }
                    return resp;
                })
                .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
        );
        return;
    }

    // Ресурсы — сначала кэш, потом сеть (с докэшированием).
    event.respondWith(
        caches.match(req).then((cached) => {
            if (cached) return cached;
            return fetch(req).then((resp) => {
                if (resp && resp.ok && resp.type === 'basic') {
                    const copy = resp.clone();
                    caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
                }
                return resp;
            });
        })
    );
});
