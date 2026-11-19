const scope = self.registration.scope;
const cachePrefix = `todos-pwa:${encodeURIComponent(scope)}:`;
const cacheName = cachePrefix + build.version;
const entry = new URL('index.html', scope).href;
const files = new Set(build.files.map(file => new URL(file, scope).href));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll([...files].map(url => new Request(url, { cache: 'reload' })));
    // Other open tabs must not keep a fully cached update waiting.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(cachePrefix) && name !== cacheName)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function loadPage(request) {
  let response;
  try {
    response = await fetch(request, { cache: 'no-cache' });
    if (response.status < 500) return response;
  } catch {
    // Use the installed app when the network is unavailable.
  }
  return (await caches.match(entry, { cacheName })) ?? response ?? Response.error();
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  url.search = '';
  url.hash = '';
  if (request.mode === 'navigate' && (url.href === scope || url.href === entry)) {
    event.respondWith(loadPage(request));
  } else if (files.has(request.url)) {
    event.respondWith(caches.match(request.url, { cacheName }).then(response => response ?? fetch(request)));
  }
});
