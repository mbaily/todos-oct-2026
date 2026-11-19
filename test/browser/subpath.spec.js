import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createApp } from '../../server/app.js';
import { createStore } from '../../server/store.js';
import { createSyncEvents } from '../../server/sync-events.js';

const prefix = process.env.TEST_BASE_PATH ?? '/';

async function startSyncServer(app) {
  const sockets = [];
  const server = createServer((request, response) => {
    request.url = request.url.slice(prefix.length - 1);
    app(request, response);
  });
  server.on('upgrade', (_request, socket) => sockets.push(socket));
  const events = createSyncEvents(server, { path: prefix + 'api/events' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server, events, sockets, url: `http://127.0.0.1:${server.address().port}${prefix}`,
    async close() {
      events.close();
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}

test('assets, the sync worker and saved edits work below the app prefix', async ({ page, context, request }) => {
  const id = randomUUID();
  const name = `Server notebook ${id}`;
  const seeded = await request.post('api/sync', { data: { cursor: 0, mutations: [{
    opId: randomUUID(), action: 'create', id,
    fields: { type: 'notebook', parentId: null, name }, timestamp: new Date().toISOString(),
  }] } });
  expect(seeded.ok()).toBeTruthy();
  const { acknowledgements: [seedReceipt] } = await seeded.json();
  expect(seedReceipt.accepted).toBeTruthy();
  const paths = [];
  const failures = [];
  context.on('request', req => paths.push(new URL(req.url()).pathname));
  page.on('response', response => { if (response.status() >= 400) failures.push(response.url()); });
  page.on('pageerror', error => failures.push(String(error)));
  await page.goto('./');
  await expect(page.locator('#contents')).toContainText(name);
  await expect(page.locator('#sync-status')).toHaveText('Synced');
  await expect(page.locator(`link[rel="stylesheet"][href="${prefix}reset.css"]`)).toHaveCount(1);
  const added = `Browser notebook ${randomUUID()}`;
  await page.getByRole('textbox', { name: 'New notebook', exact: true }).fill(added);
  const synced = page.waitForResponse(response => new URL(response.url()).pathname === prefix + 'api/sync' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  expect((await synced).ok()).toBeTruthy();
  await expect.poll(async () => {
    const response = await request.post('api/sync', { data: { cursor: seedReceipt.revision, mutations: [] } });
    return (await response.json()).changes.some(change => change.entity.name === added);
  }).toBeTruthy();
  await page.reload();
  await expect(page.locator('#contents')).toContainText(added);
  const icon = await request.get('icons/todos-192.png');
  expect(icon.ok()).toBeTruthy();
  expect(icon.headers()['content-type']).toBe('image/png');
  expect(paths.some(path => path.startsWith(prefix + 'assets/sync-worker-'))).toBeTruthy();
  expect(paths.some(path => path === prefix + 'api/sync')).toBeTruthy();
  expect(paths.every(path => path.startsWith(prefix))).toBeTruthy();
  expect(failures).toEqual([]);
});

test('Todos can reopen offline, edit local data, and sync after reconnecting', async ({ page, context, request }) => {
  const id = randomUUID();
  const name = `Notebook ${id}`;
  const updated = `Edited offline ${id}`;
  const seed = await request.post('api/sync', { data: { cursor: 0, mutations: [{
    opId: randomUUID(), action: 'create', id,
    fields: { type: 'notebook', parentId: null, name }, timestamp: new Date().toISOString(),
  }] } });
  expect(seed.ok()).toBeTruthy();
  const { acknowledgements: [seedReceipt] } = await seed.json();
  expect(seedReceipt.accepted).toBeTruthy();
  await page.goto('./');
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  const dotsBeforeTrash = '#breadcrumbs > #service-worker-status:has(+ button[aria-label="Trash"])';
  const status = page.locator(dotsBeforeTrash);
  await expect(status).toHaveAttribute('title', 'Service worker active');
  await expect(status).toHaveCSS('background-color', 'rgb(74, 222, 128)');
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL))
    .toBe(new URL(prefix + 'sw.js', page.url()).href);
  const manifest = await request.get('manifest.webmanifest');
  expect(manifest.ok()).toBeTruthy();
  expect(await manifest.json()).toMatchObject({ start_url: './', scope: './', display: 'standalone' });

  await context.setOffline(true);
  await expect(status).toHaveAttribute('title', 'Offline');
  await expect(status).toHaveCSS('background-color', 'rgb(96, 165, 250)');
  await page.close();
  const reopened = await context.newPage();
  const navigation = await reopened.goto('./?offline=1');
  expect(navigation.fromServiceWorker()).toBeTruthy();
  const reopenedStatus = reopened.locator(dotsBeforeTrash);
  await expect(reopenedStatus).toHaveAttribute('title', 'Offline');
  const notebook = reopened.locator(`[data-id="${id}"]`);
  await notebook.getByRole('button', { name: 'Edit', exact: true }).click();
  await notebook.getByRole('textbox', { name: 'Name', exact: true }).fill(updated);
  await notebook.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(notebook.getByRole('textbox', { name: 'Name', exact: true })).toHaveCount(0);
  const serverName = async () => {
    const result = await request.post('api/sync', { data: { cursor: seedReceipt.revision - 1, mutations: [] } });
    return (await result.json()).changes.filter(change => change.entity.id === id).at(-1)?.entity.name;
  };
  expect(await serverName()).toBe(name);
  await reopened.reload();
  await expect(reopened.getByRole('link', { name: updated, exact: true })).toBeVisible();

  await context.setOffline(false);
  await expect(reopenedStatus).toHaveAttribute('title', 'Service worker active');
  await expect(reopenedStatus).toHaveCSS('background-color', 'rgb(74, 222, 128)');
  await expect.poll(serverName).toBe(updated);
});

test('normal reloads pick up a new deployment with another tab open and still work offline', async ({ page, context }) => {
  const index = await readFile(new URL('../../dist/index.html', import.meta.url), 'utf8');
  const legacyWorker = `
    const entry = new URL('index.html', self.registration.scope).href;
    const cacheName = 'todos-pwa:' + encodeURIComponent(self.registration.scope) + ':legacy';
    self.addEventListener('install', event => {
      event.waitUntil(caches.open(cacheName).then(cache => cache.add(entry)));
    });
    self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', event => {
      if (event.request.mode === 'navigate') {
        event.respondWith(caches.match(entry, { cacheName }));
      }
    });
  `;
  let deployment = 'old';
  let pageAvailable = true;
  const store = createStore(':memory:');
  const app = createApp(store);
  const server = await startSyncServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/' || pathname === '/index.html') {
      if (!pageAvailable) {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
        .end(index.replace('<head>', `<head><meta name="deployment" content="${deployment}">`));
      return;
    }
    if (pathname === '/sw.js' && deployment === 'old') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }).end(legacyWorker);
      return;
    }
    app(request, response);
  });
  const other = await context.newPage();
  try {
    const marker = current => current.locator('meta[name="deployment"]');
    await page.goto(server.url);
    await expect(page.locator('#service-worker-status')).toHaveAttribute('data-state', 'active');
    await other.goto(server.url);
    const previousWorker = await other.evaluateHandle(() => navigator.serviceWorker.controller);
    try {
      await expect(marker(other)).toHaveAttribute('content', 'old');
      deployment = 'updated';
      await page.reload();
      await expect.poll(() => other.evaluate(previous => {
        const active = navigator.serviceWorker.controller;
        return active !== null && active !== previous && active.state === 'activated';
      }, previousWorker)).toBe(true);
      await expect(marker(other)).toHaveAttribute('content', 'old');
    } finally {
      await previousWorker.dispose();
    }

    await page.reload();
    await expect(marker(page)).toHaveAttribute('content', 'updated');
    deployment = 'latest';
    await page.reload();
    await expect(marker(page)).toHaveAttribute('content', 'latest');
    pageAvailable = false;
    await page.reload();
    await expect(marker(page)).toHaveAttribute('content', 'updated');
    await context.setOffline(true);
    await page.reload();
    await expect(marker(page)).toHaveAttribute('content', 'updated');
    await expect(page.getByRole('textbox', { name: 'New notebook' })).toBeVisible();
  } finally {
    await context.setOffline(false);
    await other.close();
    await page.close();
    await server.close();
    store.close();
  }
});

test('the offline status stays green when a hard reload bypasses an active service worker', async ({ page, context }) => {
  await page.goto('./');
  const dot = page.locator('#service-worker-status');
  await expect(dot).toHaveAttribute('title', 'Service worker active');
  const url = page.url();
  const session = await context.newCDPSession(page);
  const [navigation] = await Promise.all([
    page.waitForResponse(response => response.url() === url && response.request().isNavigationRequest()),
    session.send('Page.reload', { ignoreCache: true }),
  ]);
  expect(navigation.fromServiceWorker()).toBe(false);
  await expect(dot).toHaveAttribute('title', 'Service worker active');
  await expect(dot).toHaveCSS('background-color', 'rgb(74, 222, 128)');
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
});

test('a bookmarked folder survives the first sync in a fresh browser', async ({ page, context, request }) => {
  const notebookId = randomUUID();
  const folderId = randomUUID();
  const name = `Bookmarked folder ${folderId}`;
  const timestamp = new Date().toISOString();
  const seed = await request.post('api/sync', { data: { cursor: 0, mutations: [
    { opId: randomUUID(), action: 'create', id: notebookId,
      fields: { type: 'notebook', parentId: null, name: 'Bookmark test notebook' }, timestamp },
    { opId: randomUUID(), action: 'create', id: folderId,
      fields: { type: 'folder', parentId: notebookId, name }, timestamp },
  ] } });
  expect(seed.ok()).toBeTruthy();
  const { acknowledgements } = await seed.json();
  expect(acknowledgements.map(receipt => receipt.accepted)).toEqual([true, true]);

  const { promise: beforeFirstPull, resolve: resumePull } = Promise.withResolvers();
  const delayPull = async route => {
    await beforeFirstPull;
    await route.continue();
  };
  await context.route('**/api/sync', delayPull);
  const bookmark = `./#entity/${folderId}`;
  try {
    await page.goto(bookmark);
    await expect(page.getByRole('status').filter({ hasText: 'Waiting to sync the linked item' })).toBeVisible();
    await expect(page).toHaveURL(bookmark);
  } finally {
    resumePull();
  }
  await expect(page.locator('#breadcrumbs [aria-current="page"]')).toHaveText(name);
  await expect(page).toHaveURL(bookmark);

  await expect(page.locator('#service-worker-status')).toHaveAttribute('title', 'Service worker active');
  await context.unroute('**/api/sync', delayPull);
  await page.close();
  await context.setOffline(true);
  const reopened = await context.newPage();
  const offlineBookmark = `./?offline=1#entity/${folderId}`;
  const navigation = await reopened.goto(offlineBookmark);
  expect(navigation.fromServiceWorker()).toBeTruthy();
  await expect(reopened.locator('#breadcrumbs [aria-current="page"]')).toHaveText(name);
  await expect(reopened).toHaveURL(offlineBookmark);
});

test('a missing bookmark falls back to Notebooks after sync', async ({ page, context }) => {
  const { promise: beforeFirstPull, resolve: resumePull } = Promise.withResolvers();
  await context.route('**/api/sync', async route => {
    await beforeFirstPull;
    await route.continue();
  });
  const bookmark = `./#entity/${randomUUID()}`;
  try {
    await page.goto(bookmark);
    await expect(page.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
    await expect(page).toHaveURL(bookmark);
  } finally {
    resumePull();
  }
  await expect(page.locator('#sync-status')).toHaveText('Synced');
  await expect(page.locator('#breadcrumbs [aria-current="page"]')).toHaveText('🏠');
  await expect.poll(() => new URL(page.url()).hash).toBe('');
});

test('an idle browser pulls a server change into IndexedDB as soon as it is notified', async ({ page, request }) => {
  await page.goto('./');
  await expect(page.locator('#sync-status')).toHaveText('Synced');

  const id = randomUUID();
  const name = `WebSocket notebook ${id}`;
  const response = await request.post('api/sync', { data: { cursor: 0, mutations: [{
    opId: randomUUID(), action: 'create', id,
    fields: { type: 'notebook', parentId: null, name }, timestamp: new Date().toISOString(),
  }] } });
  expect((await response.json()).acknowledgements[0].accepted).toBeTruthy();

  await expect.poll(() => page.evaluate(id => new Promise((resolve, reject) => {
    const open = indexedDB.open('plain-todos-v1');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('entities');
      const read = transaction.objectStore('entities').get(id);
      transaction.oncomplete = () => { db.close(); resolve(read.result?.name); };
      transaction.onerror = () => reject(transaction.error);
    };
  }), id), { timeout: 4000 }).toBe(name);
});

test('a dropped sync socket reconnects before the fallback poll', async ({ page }) => {
  const store = createStore(':memory:', { onChange: revision => events.notify(revision) });
  const { events, sockets, url, close } = await startSyncServer(createApp(store));
  try {
    await page.goto(url);
    await expect.poll(() => sockets.length).toBe(1);
    await expect(page.locator('#sync-status')).toHaveText('Synced');
    sockets[0].destroy();
    await expect.poll(() => sockets.length, { timeout: 3500 }).toBe(2);
    await expect(page.locator('#sync-status')).toHaveText('Synced');

    const { acknowledgements } = store.sync({ cursor: 0, mutations: [{
      opId: randomUUID(), action: 'create', id: randomUUID(),
      fields: { type: 'notebook', parentId: null, name: 'Reconnected notebook' },
    }] });
    expect(acknowledgements[0].accepted).toBe(true);
    await expect(page.getByRole('link', { name: 'Reconnected notebook', exact: true })).toBeVisible({ timeout: 3500 });
  } finally {
    await page.close();
    await close();
    store.close();
  }
});

test('the version and offline dot show when the sync server is unreachable on an active network', async ({ page }) => {
  const store = createStore(':memory:');
  const app = createApp(store);
  let syncReachable = true;
  const { sockets, url, close } = await startSyncServer((request, response) => {
    if (!syncReachable && request.url === '/api/sync') request.socket.destroy();
    else app(request, response);
  });
  try {
    await page.goto(url);
    await expect.poll(() => sockets.length).toBe(1);
    await expect(page.locator('#sync-status')).toHaveText('Synced');
    await expect(page.locator('#breadcrumbs > .app-version:has(+ #service-worker-status)')).toHaveText(/^v\d+\.\d+\.\d+$/);
    const dot = page.locator('#service-worker-status');
    await expect(dot).toHaveAttribute('title', 'Service worker active');

    syncReachable = false;
    sockets[0].destroy();
    await expect(dot).toHaveAttribute('title', 'Offline');
    await expect(dot).toHaveCSS('background-color', 'rgb(96, 165, 250)');
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);

    syncReachable = true;
    await expect(dot).toHaveAttribute('title', 'Service worker active');
    await expect(page.locator('#sync-status')).toHaveText('Synced');
  } finally {
    await page.close();
    await close();
    store.close();
  }
});

test('a delayed reply from before a server restore cannot block a queued edit', async ({ page }) => {
  const original = createStore(':memory:', { onChange: revision => events.notify(revision) });
  const restored = createStore(':memory:', { onChange: revision => events.notify(revision) });
  let app = createApp(original);
  const release = Promise.withResolvers();
  const name = 'Edited while the server was restored';
  let holdNext = false;
  let held = false;
  const { events, sockets, url, close } = await startSyncServer((request, response) => {
    if (holdNext && request.method === 'POST' && request.url === '/api/sync') {
      holdNext = false;
      const end = response.end;
      response.end = function (...args) {
        held = true;
        release.promise.then(() => {
          if (!response.destroyed) end.apply(response, args);
        });
        return response;
      };
    }
    app(request, response);
  });

  try {
    await page.goto(url);
    await expect(page.locator('#sync-status')).toHaveText('Synced');
    await expect.poll(() => sockets.length).toBe(1);
    await expect.poll(() => page.evaluate(async () => {
      const { held, pending } = await navigator.locks.query();
      return [...held, ...pending].filter(lock => lock.name === 'plain-todos-sync').length;
    })).toBe(0);
    await page.getByRole('textbox', { name: 'New notebook', exact: true }).fill(name);
    holdNext = true;
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect.poll(() => held).toBe(true);
    expect(original.db.prepare("SELECT json_extract(data, '$.name') AS name FROM entities").get()?.name).toBe(name);

    app = createApp(restored);
    sockets[0].destroy();
    await expect.poll(() => sockets.length, { timeout: 3500 }).toBe(2);
    await expect.poll(() => restored.db.prepare("SELECT json_extract(data, '$.name') AS name FROM entities").get()?.name).toBe(name);
    release.resolve();
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(page.locator('#sync-status')).toHaveText('Synced');
  } finally {
    release.resolve();
    await page.close();
    await close();
    original.close();
    restored.close();
  }
});

test('a fallback pull can finish before a new sync socket opens', async ({ page, context }) => {
  const store = createStore(':memory:');
  const { server, sockets, url, close } = await startSyncServer(createApp(store));
  const fallbackStarted = Promise.withResolvers();
  const release = Promise.withResolvers();
  let holdPull = false;
  try {
    await context.route('**/api/sync', async route => {
      if (holdPull) {
        fallbackStarted.resolve();
        await release.promise;
      }
      await route.continue();
    });
    await page.goto(url);
    await expect(page.locator('#sync-status')).toHaveText('Synced');
    await expect.poll(() => sockets.length).toBe(1);
    await expect.poll(() => page.evaluate(async () => {
      const { held, pending } = await navigator.locks.query();
      return [...held, ...pending].filter(lock => lock.name === 'plain-todos-sync').length;
    })).toBe(0);
    store.sync({ cursor: 0, mutations: [{
      opId: randomUUID(), action: 'create', id: randomUUID(),
      fields: { type: 'notebook', parentId: null, name: 'Downloaded during fallback' },
    }] });
    holdPull = true;
    sockets[0].destroy();
    await fallbackStarted.promise;
    await expect(once(server, 'upgrade', { signal: AbortSignal.timeout(1500) })).rejects.toMatchObject({ name: 'AbortError' });
    release.resolve();
    await expect(page.getByRole('link', { name: 'Downloaded during fallback', exact: true })).toBeVisible();
    await expect.poll(() => sockets.length, { timeout: 3500 }).toBe(2);
  } finally {
    release.resolve();
    await page.close();
    await close();
    store.close();
  }
});

test('a missed local notification does not strand a saved edit', async ({ page }) => {
  await page.addInitScript(() => {
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (message) {
      if (message?.type !== 'mutation') post.call(this, message);
    };
  });
  await page.goto('./');
  await expect(page.locator('#sync-status')).toHaveText('Synced');
  await expect.poll(() => page.evaluate(async () => {
    const { held, pending } = await navigator.locks.query();
    return [...held, ...pending].filter(lock => lock.name === 'plain-todos-sync').length;
  })).toBe(0);

  const name = `Saved without a notification ${randomUUID()}`;
  await page.getByRole('textbox', { name: 'New notebook', exact: true }).fill(name);
  const [response] = await Promise.all([
    page.waitForResponse(reply => new URL(reply.url()).pathname === prefix + 'api/sync' &&
      reply.request().postDataJSON()?.mutations.some(mutation => mutation.fields?.name === name), { timeout: 6500 }),
    page.getByRole('button', { name: 'Add', exact: true }).click(),
    expect(page.getByRole('link', { name, exact: true })).toBeVisible(),
  ]);
  const { mutations } = response.request().postDataJSON();
  const submitted = mutations.find(mutation => mutation.fields?.name === name);
  const { acknowledgements } = await response.json();
  expect(acknowledgements.find(receipt => receipt.opId === submitted.opId)?.accepted).toBe(true);
});

test('a delayed tab notification cannot cancel retrying a failed pull', async ({ page, context }) => {
  let attempt = 0;
  let interrupt = false;
  await context.route('**/api/sync', route => {
    if (interrupt && ++attempt === 1) {
      return route.fulfill({ status: 503, json: { error: 'Interrupted pull in test' } });
    }
    return route.continue();
  });
  await page.goto('./');
  await expect(page.locator('#sync-status')).toHaveText('Synced');
  await expect.poll(() => page.evaluate(async () => {
    const { held, pending } = await navigator.locks.query();
    return [...held, ...pending].filter(lock => lock.name === 'plain-todos-sync').length;
  })).toBe(0);

  await page.evaluate(() => {
    const status = document.querySelector('#sync-status');
    const observer = new MutationObserver(() => {
      if (!status.textContent.includes('Interrupted pull in test')) return;
      observer.disconnect();
      // A sibling tab's save notification can arrive after its edit has already synced.
      const channel = new BroadcastChannel('plain-todos');
      channel.postMessage({ type: 'mutation' });
      channel.close();
    });
    observer.observe(status, { childList: true, characterData: true, subtree: true });
  });
  interrupt = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => attempt, { timeout: 3500 }).toBe(2);
  await expect(page.locator('#sync-status')).toHaveText('Synced');
});

test('one edit in two open tabs produces one sync request', async ({ page, context }) => {
  const peer = await context.newPage();
  await Promise.all([page.goto('./'), peer.goto('./')]);
  await page.bringToFront();
  await Promise.all([page, peer].map(tab => expect(tab.locator('#sync-status')).toHaveText('Synced')));
  await expect.poll(() => page.evaluate(async () => {
    const { held, pending } = await navigator.locks.query();
    return [...held, ...pending].filter(lock => lock.name === 'plain-todos-sync').length;
  })).toBe(0);

  const requests = [];
  context.on('request', req => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === prefix + 'api/sync') requests.push(req.postDataJSON());
  });
  const name = `Shared notebook ${randomUUID()}`;
  await page.getByRole('textbox', { name: 'New notebook', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(peer.getByRole('link', { name, exact: true })).toBeVisible();
  await expect.poll(() => requests.length).toBe(1);
  await Promise.all([page, peer].map(tab => expect(tab.locator('#sync-status')).toHaveText('Synced')));
  await expect(context.waitForEvent('request', {
    predicate: req => req.method() === 'POST' && new URL(req.url()).pathname === prefix + 'api/sync',
    timeout: 400,
  })).rejects.toThrow(/Timeout/);
  expect(requests.map(body => body.mutations.map(mutation => mutation.fields.name))).toEqual([[name]]);
});

test('an active tab syncs when a frozen tab holds the sync lock', async ({ page, context }) => {
  const holder = await context.newPage();
  const session = await context.newCDPSession(holder);
  try {
    await Promise.all([page.goto('./'), holder.goto('./')]);
    await Promise.all([page, holder].map(tab => expect(tab.locator('#sync-status')).toHaveText('Synced')));
    await holder.evaluate(() => new Promise(resolve => {
      navigator.locks.request('plain-todos-sync', () => {
        resolve();
        return new Promise(() => {});
      });
    }));
    await session.send('Page.setWebLifecycleState', { state: 'frozen' });
    await page.bringToFront();

    const name = `Saved while a tab is frozen ${randomUUID()}`;
    await page.getByRole('textbox', { name: 'New notebook', exact: true }).fill(name);
    const [response] = await Promise.all([
      page.waitForResponse(reply => new URL(reply.url()).pathname === prefix + 'api/sync' &&
        reply.request().postDataJSON()?.mutations?.some(mutation => mutation.fields?.name === name), { timeout: 20000 }),
      page.getByRole('button', { name: 'Add', exact: true }).click(),
    ]);
    expect(response.ok()).toBe(true);
    expect((await response.json()).acknowledgements.some(receipt => receipt.accepted)).toBe(true);
    await expect(page.locator('#sync-status')).toHaveText('Synced');
  } finally {
    await session.send('Page.setWebLifecycleState', { state: 'active' });
    await holder.close();
  }
});
