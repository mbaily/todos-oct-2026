import { hasPendingSync, readSyncQueue, reconcile } from './db.js';
import { requestSyncPage } from './sync-request.js';

const FALLBACK_POLL_INTERVAL_MS = 10000;
const INITIAL_EVENT_RETRY_MS = 1000;
const SYNC_LOCK_WAIT_MS = 15000;

const channel = new BroadcastChannel('plain-todos');
let running = false;
let requested = false;
let pullRequested = false;
let notifiedRevision = 0;
let retryDelay = 1000;
let retryTimer;
let events;
let eventConnection = new AbortController();
let eventRetryTimer;
let eventRetryDelay = INITIAL_EVENT_RETRY_MS;
let syncPageActive = false;
let reconnectAfterPage = false;
let serverReachable;

function reportReachability(reachable) {
  if (serverReachable === reachable) return;
  serverReachable = reachable;
  postMessage({ type: 'connectivity', reachable });
}

async function syncPage() {
  requested = false;
  const pull = pullRequested;
  const revision = notifiedRevision;
  pullRequested = false;
  notifiedRevision = 0;
  const queue = await readSyncQueue();
  // A sibling tab may have completed the pull or sent the outbox while we waited.
  if (!pull && !queue.rebuilding && queue.operationThrough === null &&
    !queue.mutations.length && !queue.awaiting.length && queue.cursor >= revision) return;

  postMessage({ type: 'status', message: 'Syncing…' });
  const { signal } = eventConnection;
  let data;
  let result;
  syncPageActive = true;
  try {
    data = await requestSyncPage(`${import.meta.env.BASE_URL}api/sync`, queue, signal, reportReachability).catch(error => {
      if (signal.aborted) return null;
      throw error;
    });
    result = data === null ? { retry: true } : await reconcile(data, queue, signal);
  } finally {
    syncPageActive = false;
    if (reconnectAfterPage) connectEvents();
  }
  if (result.retry) {
    requested = true;
    pullRequested = true;
    return;
  }
  if (result.changed) {
    postMessage({ type: 'changed' });
    channel.postMessage({ type: 'changed' });
  }
  if (result.errors.length) {
    postMessage({ type: 'sync-errors-changed' });
    channel.postMessage({ type: 'sync-errors-changed' });
  }
  requested ||= data.hasMore || result.pending > 0;
  pullRequested ||= data.hasMore;
}

async function trySyncWithLock() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_LOCK_WAIT_MS);
  try {
    await navigator.locks.request('plain-todos-sync', { signal: controller.signal }, () => {
      clearTimeout(timer);
      return syncPage();
    });
    return true;
  } catch (error) {
    if (controller.signal.aborted && error.name === 'AbortError') return false;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function sync({ pull = false } = {}) {
  requested = true;
  pullRequested ||= pull;
  if (running) return;
  running = true;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  try {
    let useLock = Boolean(navigator.locks);
    do {
      // A frozen tab can keep the lock. Receipts and reconciliation also support overlapping requests.
      if (useLock) useLock = await trySyncWithLock();
      if (!useLock) await syncPage();
    } while (requested);
    retryDelay = 1000;
    postMessage({ type: 'status', message: 'Synced' });
  } catch (error) {
    // Keep the failed pull pending if a save notification wakes sync before the retry timer.
    pullRequested = true;
    postMessage({ type: 'status', message: `Waiting to sync: ${error.message} Changes are saved locally.` });
    retryTimer = setTimeout(sync, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  } finally {
    running = false;
  }
}

async function checkPendingSync() {
  if (running || retryTimer !== undefined) return;
  // Let ordinary sync report and retry any storage errors when the check fails.
  const pending = await hasPendingSync().catch(() => true);
  if (pending && !running && retryTimer === undefined) sync();
}

function scheduleEventReconnect() {
  eventRetryTimer = setTimeout(connectEvents, eventRetryDelay);
  eventRetryDelay = Math.min(eventRetryDelay * 2, FALLBACK_POLL_INTERVAL_MS);
}

function invalidateEventConnection() {
  // A reply from before the disconnect can acknowledge edits absent from a restored server.
  eventConnection.abort();
  eventConnection = new AbortController();
}

function connectEvents() {
  if (events || typeof WebSocket === 'undefined') return;
  clearTimeout(eventRetryTimer);
  eventRetryTimer = undefined;
  // Let the HTTP fallback finish before another socket drop can cancel it.
  if (syncPageActive) {
    reconnectAfterPage = true;
    return;
  }
  reconnectAfterPage = false;
  const url = new URL(`${import.meta.env.BASE_URL}api/events`, self.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket;
  try { socket = new WebSocket(url, 'todos-revisions'); }
  catch { return; } // Some environments disallow WebSockets entirely.
  events = socket;
  let opened = false;
  let timeout;

  function watchHeartbeat() {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      events = undefined;
      if (opened) invalidateEventConnection();
      socket.close();
      scheduleEventReconnect();
      sync({ pull: true });
    }, FALLBACK_POLL_INTERVAL_MS);
  }

  watchHeartbeat();
  socket.addEventListener('open', () => {
    if (events !== socket) return;
    opened = true;
    watchHeartbeat();
    sync({ pull: true });
  });
  socket.addEventListener('message', event => {
    if (events !== socket) return;
    watchHeartbeat();
    eventRetryDelay = INITIAL_EVENT_RETRY_MS;
    if (event.data === 'heartbeat') checkPendingSync();
    else if (event.data === 'changed') sync({ pull: true });
    else if (typeof event.data === 'string' && event.data.startsWith('changed:')) {
      const revision = Number(event.data.slice('changed:'.length));
      if (Number.isSafeInteger(revision) && revision > 0) {
        notifiedRevision = Math.max(notifiedRevision, revision);
        sync();
      }
    }
  });
  socket.addEventListener('close', () => {
    if (events !== socket) return;
    clearTimeout(timeout);
    events = undefined;
    scheduleEventReconnect();
    if (opened) {
      invalidateEventConnection();
      sync({ pull: true });
    }
  });
}

onmessage = event => {
  if (event.data.type === 'sync') {
    connectEvents();
    sync({ pull: true });
  }
};
channel.onmessage = event => {
  if (event.data.type === 'mutation') {
    connectEvents();
    sync();
  }
};
setInterval(() => {
  if (events && events.readyState === WebSocket.OPEN) return;
  if (eventRetryTimer === undefined) connectEvents();
  sync({ pull: true });
}, FALLBACK_POLL_INTERVAL_MS);
connectEvents();
sync({ pull: true });
