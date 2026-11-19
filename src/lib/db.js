import { applyMutation, validateMutation, visibleEntities, ROOT_VIEW_ID } from './model.js';
import { newId } from './id.js';

const DATABASE = 'plain-todos-v1';
let opening;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function openDatabase() {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const entities = db.createObjectStore('entities', { keyPath: 'id' });
      entities.createIndex('parentId', 'parentId');
      db.createObjectStore('canonical', { keyPath: 'id' });
      const outbox = db.createObjectStore('outbox', { keyPath: 'sequence', autoIncrement: true });
      outbox.createIndex('opId', 'opId', { unique: true });
      db.createObjectStore('metadata', { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const connection = opening;
      const release = () => {
        if (opening === connection) opening = undefined;
      };
      db.onclose = release;
      db.onversionchange = () => { db.close(); release(); };
      resolve(db);
    };
    request.onerror = () => { opening = undefined; reject(request.error); };
  });
  return opening;
}

async function transaction(names, mode, run, signal) {
  signal?.throwIfAborted();
  const db = await openDatabase();
  signal?.throwIfAborted();
  const tx = db.transaction(names, mode);
  const completed = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error ?? new Error('Local storage transaction aborted.'));
    tx.onerror = () => {};
  });
  function abort() {
    try { tx.abort(); } catch { /* Already finished. */ }
  }
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await run(tx);
    await completed;
    return result;
  } catch (error) {
    abort();
    await completed.catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export function readEntitySnapshot() {
  return transaction(['entities'], 'readonly', tx =>
    requestResult(tx.objectStore('entities').getAll()));
}

export async function readEntities() {
  return visibleEntities(await readEntitySnapshot());
}

export function readRootSortOrder() {
  return transaction(['entities'], 'readonly', async tx =>
    (await requestResult(tx.objectStore('entities').get(ROOT_VIEW_ID)))?.sortOrder ?? 'created-desc');
}

export function readRootDateDisplay() {
  return transaction(['entities'], 'readonly', async tx =>
    (await requestResult(tx.objectStore('entities').get(ROOT_VIEW_ID)))?.dateDisplay ?? 'none');
}

export async function mutate(action, id, fields) {
  const mutation = {
    opId: newId(), action, id,
    ...(fields === undefined ? {} : { fields }), timestamp: new Date().toISOString(),
  };
  const inverse = await transaction(['entities', 'outbox'], 'readwrite', async tx => {
    const store = tx.objectStore('entities');
    let records;
    if (action === 'create') {
      // Validate the keys before passing them to IndexedDB. Creation only needs the target and its direct parent.
      validateMutation(mutation);
      const ids = fields.parentId === null ? [id] : [id, fields.parentId];
      records = (await Promise.all(ids.map(key => requestResult(store.get(key)))))
        .filter(entity => entity !== undefined);
    } else {
      records = await requestResult(store.getAll());
    }
    const entities = new Map(records.map(entity => [entity.id, entity]));
    const previous = entities.get(id);
    const oldFields = action === 'update' && previous ? Object.fromEntries(
      ['name', 'text', 'checked'].filter(field => Object.hasOwn(fields, field) && fields[field] !== previous[field])
        .map(field => [field, previous[field]])) : {};
    const changed = applyMutation(entities, mutation, mutation.timestamp);
    tx.objectStore('outbox').add(mutation);
    changed.forEach(entity => store.put(entity));
    if (action === 'move-items') {
      return { action, opId: mutation.opId, id: fields.destinationId, fields: {
        destinationId: id, itemIds: fields.itemIds,
        ...(fields.newListName === undefined ? {} : { removeSourceCreatedBy: mutation.opId }),
      } };
    }
    if (action === 'trash') return { action: 'restore', id, fields: { trashOpId: mutation.opId } };
    if (Object.keys(oldFields).length) return { action: 'update', id, fields: oldFields };
    return null;
  });
  return { opId: mutation.opId, inverse };
}

export function hasPendingSync() {
  return transaction(['outbox', 'metadata'], 'readonly', async tx => {
    const [pending, state] = await Promise.all([
      requestResult(tx.objectStore('outbox').count()),
      requestResult(tx.objectStore('metadata').get('cursor')),
    ]);
    return pending > 0 || state?.rebuilding === true || (state?.operationThrough ?? state?.trashThrough ?? null) !== null;
  });
}

export async function readSyncQueue() {
  async function readQueue(tx) {
    const metadata = tx.objectStore('metadata');
    const [storedState, receipts] = await Promise.all([
      requestResult(metadata.get('cursor')),
      requestResult(metadata.get('awaitingReceipts')),
    ]);
    let state = storedState;
    let operationThrough = state?.operationThrough ?? state?.trashThrough ?? null;
    if (state && (!validRevision(state.value) || (operationThrough !== null &&
      (!validRevision(operationThrough) || operationThrough <= state.value)))) {
      if (tx.mode === 'readonly') return;
      state = resetSyncHistory(tx, state.generation ?? 0);
      operationThrough = null;
    }
    const { value: cursor = 0, checkpoint = null, generation = 0, rebuilding = false } = state ?? {};
    // Finish any download started by an older app before sending edits that might be rejected.
    const pullingLegacyOperation = operationThrough !== null && !state.hasStagedPageBases;
    const pending = rebuilding || pullingLegacyOperation ? [] : await requestResult(tx.objectStore('outbox').getAll(null, 100));
    const accepted = new Set(receipts?.value);
    const mutations = [];
    const awaiting = [];
    let bytes = 0;
    for (const { sequence, ...mutation } of pending) {
      // Resolve earlier receipts before sending later edits that may depend on them.
      if (accepted.has(mutation.opId)) {
        if (mutations.length) break;
        awaiting.push(mutation.opId);
        continue;
      }
      if (awaiting.length) break;
      const size = new TextEncoder().encode(JSON.stringify(mutation)).length;
      // Keep large note edits below the HTTP body limit without changing order.
      if (mutations.length && bytes + size > 1000000) break;
      mutations.push(mutation);
      bytes += size;
    }
    return { cursor, checkpoint, generation, rebuilding, mutations, awaiting, operationThrough };
  }

  const stores = ['outbox', 'metadata'];
  return await transaction(stores, 'readonly', readQueue) ??
    transaction([...stores, 'canonical'], 'readwrite', readQueue);
}

function stagedPageBaseKeys() {
  return IDBKeyRange.bound(['stagedPageBase', 0], ['stagedPageBase', Number.MAX_SAFE_INTEGER]);
}

function resetSyncHistory(tx, generation) {
  const metadata = tx.objectStore('metadata');
  const state = { key: 'cursor', value: 0, checkpoint: null, generation: generation + 1, rebuilding: true };
  tx.objectStore('canonical').clear();
  metadata.delete(stagedPageBaseKeys());
  metadata.put(state);
  return state;
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validSyncEntries(response, request) {
  if (!Array.isArray(response.changes) || !Array.isArray(response.acknowledgements)) return false;
  let fromRevision = request?.cursor ?? 0;
  for (const change of response.changes) {
    if (!validRevision(change?.revision) || change.revision <= fromRevision ||
      typeof change.entity?.id !== 'string' || typeof change.entity.type !== 'string') return false;
    fromRevision = change.revision;
  }
  const unmatched = request && new Set([...request.awaiting, ...request.mutations.map(mutation => mutation.opId)]);
  for (const receipt of response.acknowledgements) {
    if (typeof receipt?.opId !== 'string') return false;
    const validOutcome = receipt.accepted === true ? validRevision(receipt.revision) :
      receipt.accepted === false && typeof receipt.error === 'string';
    if (!validOutcome || (unmatched && !unmatched.delete(receipt.opId))) return false;
  }
  // Lookups can legitimately come back empty after a backup restore.
  return !request || request.mutations.every(mutation => !unmatched.has(mutation.opId));
}

// Merge under one lock with any edits made while the network request was in flight.
// The server snapshot plus remaining local mutations is always the UI's projection.
export function reconcile(response, request, signal) {
  return transaction(['canonical', 'entities', 'outbox', 'metadata'], 'readwrite', async tx => {
    const canonical = tx.objectStore('canonical');
    const outbox = tx.objectStore('outbox');
    const metadata = tx.objectStore('metadata');
    const state = await requestResult(metadata.get('cursor'));
    const { value: cursor = 0, checkpoint = null, generation = 0, rebuilding = false } = state ?? {};
    const operationThrough = state?.operationThrough ?? state?.trashThrough ?? null;
    if (request && (request.generation !== generation || request.cursor !== cursor ||
      request.checkpoint !== checkpoint || request.rebuilding !== rebuilding ||
      (request.operationThrough ?? request.trashThrough ?? null) !== operationThrough)) {
      return { retry: true };
    }
    if (response.resetRequired === true) {
      resetSyncHistory(tx, generation);
      return { retry: true };
    }
    if (request && !Object.hasOwn(response, 'checkpoint')) throw new Error('Server sync response is missing a history checkpoint.');
    const nextOperationThrough = response.operationThrough ?? response.trashThrough ?? null;
    if (!validRevision(response.cursor) || !validSyncEntries(response, request) ||
      (nextOperationThrough !== null && (!validRevision(nextOperationThrough) ||
        nextOperationThrough <= response.cursor || response.hasMore === false)) ||
      (request && (typeof response.hasMore !== 'boolean' || response.cursor < cursor ||
        (response.changes.at(-1)?.revision ?? cursor) !== response.cursor ||
        (response.hasMore && response.cursor === cursor)))) {
      throw new Error('Server returned an invalid sync page.');
    }
    if (!rebuilding && operationThrough === null && !request?.awaiting?.length && response.cursor <= cursor &&
      !response.changes.length && !response.acknowledgements.length) {
      return { pending: await requestResult(outbox.count()), errors: [], changed: false };
    }
    const nextCursor = Math.max(cursor, response.cursor);
    const nextCheckpoint = response.cursor > cursor ? response.checkpoint ?? null : checkpoint;
    const hasStagedPageBases = !rebuilding && nextOperationThrough !== null &&
      (operationThrough === null || (nextOperationThrough === operationThrough && state.hasStagedPageBases === true));
    const changes = response.changes.filter(change => change.revision > cursor);
    if (operationThrough !== nextOperationThrough) metadata.delete(stagedPageBaseKeys());
    if (hasStagedPageBases && changes.length) {
      // Keep the previous values so rejected edits can be undone without publishing a partial operation.
      const ids = new Set(changes.map(change => change.entity.id));
      const previous = await Promise.all([...ids].map(async id => [id, await requestResult(canonical.get(id))]));
      metadata.put({ key: ['stagedPageBase', nextCursor], previous });
    }
    for (const change of changes) canonical.put(change.entity);
    metadata.put({
      key: 'cursor', value: nextCursor, checkpoint: nextCheckpoint, generation,
      rebuilding: rebuilding && response.hasMore,
      operationThrough: nextOperationThrough, hasStagedPageBases,
    });
    // Keep the previous projection usable until the restored history has finished downloading.
    if (rebuilding && response.hasMore) return { retry: true };
    const [pending, receipts] = await Promise.all([
      requestResult(outbox.getAll()),
      requestResult(metadata.get('awaitingReceipts')),
    ]);
    const acknowledgements = new Map(response.acknowledgements.map(ack => [ack.opId, ack]));
    const accepted = new Set(receipts?.value);
    const lookedUp = new Set(request?.awaiting);
    const awaiting = [];
    const remaining = [];
    const errors = [];
    for (const mutation of pending) {
      const ack = acknowledgements.get(mutation.opId);
      if (ack && (!ack.accepted || ack.revision <= nextCursor)) {
        outbox.delete(mutation.sequence);
        if (!ack.accepted) errors.push({ id: mutation.opId, message: `${mutation.action}: ${ack.error}` });
      } else {
        // If a backup restore removed a receipt, the outbox sends the original edit again.
        if (ack?.accepted || (accepted.has(mutation.opId) && !lookedUp.has(mutation.opId))) {
          awaiting.push(mutation.opId);
        }
        remaining.push(mutation);
      }
    }
    if (awaiting.length) metadata.put({ key: 'awaitingReceipts', value: awaiting });
    else if (receipts) metadata.delete('awaitingReceipts');
    if (errors.length) {
      const previous = await readSyncErrorEntries(metadata);
      metadata.put({ key: 'syncErrors', value: [...previous, ...errors] });
    }
    const pageOperationId = response.operationId ?? response.changes.at(-1)?.entity.trashedBy;
    // A local operation can still be projected from its outbox entry.
    const stagingRemoteOperation = nextOperationThrough !== null && !remaining.some(op => op.opId === pageOperationId);
    if (stagingRemoteOperation && (!errors.length || !hasStagedPageBases)) {
      return { pending: remaining.length, errors, changed: false };
    }

    const entities = new Map((await requestResult(canonical.getAll())).map(entity => [entity.id, entity]));
    if (stagingRemoteOperation) {
      const pages = await requestResult(metadata.getAll(stagedPageBaseKeys()));
      for (const { previous } of pages.reverse()) {
        for (const [id, entity] of previous) {
          if (entity) entities.set(id, entity);
          else entities.delete(id);
        }
      }
    }
    for (const mutation of remaining) {
      try { applyMutation(entities, mutation, mutation.timestamp); }
      catch { /* Canonical trash or an already accepted creation takes precedence. */ }
    }
    const projection = tx.objectStore('entities');
    projection.clear();
    for (const entity of entities.values()) projection.put(entity);
    return {
      pending: remaining.length, errors,
      changed: rebuilding || operationThrough !== null || response.changes.length > 0 || errors.length > 0 ||
        request?.mutations.length > 0 || request?.awaiting?.length > 0,
    };
  }, signal).catch(error => {
    if (signal?.aborted) return { retry: true };
    throw error;
  });
}

async function readSyncErrorEntries(metadata) {
  const { value = [] } = (await requestResult(metadata.get('syncErrors'))) ?? {};
  // Older builds stored plain messages. Preserve their IDs when the list is next written.
  return value.map((entry, index) => typeof entry === 'string' ? { id: `legacy:${index}`, message: entry } : entry);
}

export function readSyncErrors() {
  return transaction(['metadata'], 'readonly', tx => readSyncErrorEntries(tx.objectStore('metadata')));
}

export function dismissSyncErrors(ids) {
  const dismissed = new Set(ids);
  return transaction(['metadata'], 'readwrite', async tx => {
    const metadata = tx.objectStore('metadata');
    const entries = await readSyncErrorEntries(metadata);
    const remaining = entries.filter(entry => !dismissed.has(entry.id));
    if (remaining.length) metadata.put({ key: 'syncErrors', value: remaining });
    else metadata.delete('syncErrors');
  });
}
