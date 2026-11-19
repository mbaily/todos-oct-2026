const scope = self.registration.scope;
const cachePrefix = `todos-pwa:${encodeURIComponent(scope)}:`;
const cacheName = cachePrefix + build.version;
const entry = new URL('index.html', scope).href;
const files = new Set(build.files.map(file => new URL(file, scope).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache =>
    cache.addAll([...files].map(url => new Request(url, { cache: 'reload' }))),
  ));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(cachePrefix) && name !== cacheName)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  url.search = '';
  url.hash = '';
  const isAppNavigation = request.mode === 'navigate' && (url.href === scope || url.href === entry);
  const cachedURL = isAppNavigation ? entry : request.url;
  if (!files.has(cachedURL)) return;
  event.respondWith(caches.match(cachedURL, { cacheName }).then(response => response ?? fetch(request)));
});
