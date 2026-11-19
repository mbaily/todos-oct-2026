import 'fake-indexeddb/auto';
import { forceCloseDatabase } from 'fake-indexeddb';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';
import { mutate, readEntities, readEntitySnapshot, readRootSortOrder, readRootDateDisplay, readSyncQueue, reconcile, openDatabase, readSyncErrors, dismissSyncErrors } from '../src/lib/db.js';
import { ROOT_VIEW_ID, dateDisplayOptions } from '../src/lib/model.js';
import { trashRows } from '../src/lib/trash.js';

async function reset() {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['entities', 'canonical', 'outbox', 'metadata'], 'readwrite');
    for (const name of ['entities', 'canonical', 'outbox', 'metadata']) tx.objectStore(name).clear();
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
}

test('IndexedDB atomically stores optimistic edits and outbox; failures leave neither', async () => {
  await reset();
  const id = randomUUID();
  await mutate('create', id, { type: 'notebook', parentId: null, name: 'Local #tag' });
  assert.equal((await readEntities())[0].name, 'Local #tag');
  assert.equal((await readSyncQueue()).mutations.length, 1);
  await assert.rejects(mutate('create', randomUUID(), { type: 'todo', parentId: id, text: 'Invalid' }));
  await assert.rejects(mutate('create', null, { type: 'notebook', parentId: null, name: 'Invalid' }), /Invalid id/);
  await assert.rejects(mutate('create', 'task', { type: 'todo', text: 'Invalid' }), /Invalid parent/);
  assert.equal((await readEntities()).length, 1);
  assert.equal((await readSyncQueue()).mutations.length, 1);
});

test('task creation reads by ID and queues only one of two concurrent creates with the same ID', async t => {
  await reset();
  await mutate('create', 'book', { type: 'notebook', parentId: null, name: 'Book' });
  await mutate('create', 'folder', { type: 'folder', parentId: 'book', name: 'Folder' });
  await mutate('create', 'list', { type: 'list', parentId: 'folder', name: 'List' });

  const get = t.mock.method(IDBObjectStore.prototype, 'get');
  const getAll = t.mock.method(IDBObjectStore.prototype, 'getAll');
  const fields = { type: 'todo', parentId: 'list', text: 'First version #tag' };
  const [first, second] = await Promise.allSettled([
    mutate('create', 'task', fields),
    mutate('create', 'task', { ...fields, text: 'Second version' }),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.match(second.reason.message, /already exists/);
  assert.deepEqual(get.mock.calls.map(call => call.arguments[0]), ['task', 'list', 'task', 'list']);
  assert.equal(getAll.mock.callCount(), 0);

  const task = (await readEntitySnapshot()).find(entity => entity.id === 'task');
  assert.equal(task.text, fields.text);
  assert.deepEqual(task.tags, ['tag']);
  const queued = (await readSyncQueue()).mutations.filter(mutation => mutation.id === 'task');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].opId, first.value.opId);
  assert.deepEqual(queued[0].fields, fields);
});

test('sync reopens an unexpectedly closed IndexedDB and sends the saved outbox', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const id = randomUUID();
  const { opId } = await mutate('create', id, { type: 'notebook', parentId: null, name: 'Queued before close' });

  const closedDb = await openDatabase();
  const closed = new Promise(resolve => closedDb.addEventListener('close', resolve, { once: true }));
  forceCloseDatabase(closedDb);
  await closed;

  const queued = await readSyncQueue();
  assert.notEqual(await openDatabase(), closedDb);
  assert.deepEqual(queued.mutations.map(mutation => mutation.opId), [opId]);
  const response = server.sync(queued);
  assert.equal(response.acknowledgements[0].accepted, true);
  assert.equal((await reconcile(response, queued)).pending, 0);
  assert.equal((await readEntitySnapshot()).find(book => book.id === id).name, 'Queued before close');
});

test('full snapshots expose durable trash while active reads hide it, including offline restore and sync', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const book = randomUUID();
  const folder = randomUUID();
  await mutate('create', book, { type: 'notebook', parentId: null, name: 'Trash snapshot' });
  await mutate('create', folder, { type: 'folder', parentId: book, name: 'Child' });
  await mutate('sort', ROOT_VIEW_ID, { sortOrder: 'modified-asc' });
  await reconcile(server.sync(await readSyncQueue()));
  const original = (await readEntities()).find(entity => entity.id === book);
  await mutate('trash', book);
  await reconcile(server.sync(await readSyncQueue()));
  assert.equal((await readEntities()).length, 0);
  const snapshot = await readEntitySnapshot();
  const deletion = snapshot.find(entity => entity.id === book);
  assert.ok(deletion.deletedAt);
  assert.ok(deletion.trashedBy);
  assert.ok(snapshot.some(entity => entity.id === ROOT_VIEW_ID));
  await assert.rejects(mutate('restore', folder, { trashOpId: deletion.trashedBy }), /parent first/);
  assert.equal((await readSyncQueue()).mutations.length, 0);
  await mutate('restore', book, { trashOpId: deletion.trashedBy });
  assert.equal((await readEntities()).length, 2);
  assert.equal((await readEntities()).find(entity => entity.id === book).createdAt, original.createdAt);
  assert.equal((await readSyncQueue()).mutations.length, 1);
  await reconcile(server.sync(await readSyncQueue()));
  assert.equal((await readSyncQueue()).mutations.length, 0);
  assert.equal((await readEntitySnapshot()).filter(entity => entity.deletedAt).length, 0);
});

test('a new local edit made during a network round trip survives reconciliation', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const id = randomUUID();
  await mutate('create', id, { type: 'notebook', parentId: null, name: 'Before sync' });
  const response = server.sync(await readSyncQueue());
  await mutate('update', id, { name: 'Typed while syncing #new' });
  await reconcile(response);
  assert.equal((await readEntities())[0].name, 'Typed while syncing #new');
  assert.equal((await readSyncQueue()).mutations.length, 1);
  await reconcile(server.sync(await readSyncQueue()));
  assert.equal((await readSyncQueue()).mutations.length, 0);
  assert.equal((await readEntities())[0].name, 'Typed while syncing #new');
});

test('an empty sync response reports an edit queued in flight without rewriting the projection', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const request = await readSyncQueue();
  const response = server.sync(request);
  const id = randomUUID();
  await mutate('create', id, { type: 'notebook', parentId: null, name: 'Queued during an empty pull' });

  const clear = t.mock.method(IDBObjectStore.prototype, 'clear');
  assert.deepEqual(await reconcile(response, request), { pending: 1, errors: [], changed: false });
  assert.equal(clear.mock.callCount(), 0);
  assert.equal((await readEntities())[0].id, id);
});

test('invalid sync pages preserve the cursor and queued edits for retry', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  await mutate('create', 'queued-book', { type: 'notebook', parentId: null, name: 'Queued book' });
  const request = await readSyncQueue();
  const empty = { checkpoint: null, acknowledgements: [], changes: [], hasMore: false };
  const incompleteReceipt = { opId: request.mutations[0].opId };
  const invalidPages = [
    empty,
    { ...empty, cursor: 1 },
    { ...empty, cursor: 0, hasMore: true },
    { ...empty, cursor: 0, operationThrough: 0 },
    { ...empty, cursor: 0, acknowledgements: [incompleteReceipt] },
    { ...empty, cursor: 2, changes: [{ entity: { id: 'skipped', type: 'notebook' } },
      { revision: 2, entity: { id: 'later', type: 'notebook' } }] },
  ];
  for (const response of invalidPages) {
    await assert.rejects(reconcile(response, request), /invalid sync page/i);
    assert.deepEqual(await readSyncQueue(), request);
    assert.equal((await readEntities())[0].name, 'Queued book');
  }

  assert.equal((await reconcile(server.sync(request), request)).pending, 0);
  assert.equal((await readSyncQueue()).cursor, 1);
  assert.equal((await readEntities())[0].name, 'Queued book');
});

test('sync requires one receipt per submitted edit and preserves edits queued in flight', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  await mutate('create', 'first', { type: 'notebook', parentId: null, name: 'First' });
  const request = await readSyncQueue();
  const response = server.sync(request);
  const later = await mutate('create', 'later', { type: 'notebook', parentId: null, name: 'Later' });
  const before = await readSyncQueue();
  const [receipt] = response.acknowledgements;
  const unsolicited = { opId: later.opId, accepted: false, error: 'Unrelated rejection' };
  for (const acknowledgements of [[], [receipt, receipt], [receipt, unsolicited]]) {
    await assert.rejects(reconcile({ ...response, acknowledgements }, request), /invalid sync page/i);
    assert.deepEqual(await readSyncQueue(), before);
    assert.deepEqual(await readSyncErrors(), []);
  }

  assert.equal((await reconcile(response, request)).pending, 1);
  const next = await readSyncQueue();
  assert.deepEqual(next.mutations.map(op => op.opId), [later.opId]);
  assert.equal((await reconcile(server.sync(next), next)).pending, 0);
});

test('an invalid saved cursor is rebuilt without losing offline edits', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  await mutate('create', 'book', { type: 'notebook', parentId: null, name: 'Before' });
  const first = await readSyncQueue();
  await reconcile(server.sync(first), first);
  const edited = await mutate('update', 'book', { name: 'Offline rename' });
  const before = await readSyncQueue();
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('metadata', 'readwrite');
    tx.objectStore('metadata').put({ key: 'cursor', value: NaN, checkpoint: before.checkpoint, generation: before.generation });
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
  forceCloseDatabase(db);

  const rebuild = await readSyncQueue();
  assert.deepEqual(rebuild, { cursor: 0, checkpoint: null, generation: before.generation + 1, rebuilding: true,
    mutations: [], awaiting: [], operationThrough: null });
  assert.equal((await readEntities())[0].name, 'Offline rename');
  await reconcile(server.sync(rebuild), rebuild);
  const resend = await readSyncQueue();
  assert.equal(resend.rebuilding, false);
  assert.deepEqual(resend.mutations.map(op => op.opId), [edited.opId]);
  const response = server.sync(resend);
  assert.equal(response.changes[0].entity.name, 'Offline rename');
  assert.equal((await reconcile(response, resend)).pending, 0);
});

test('a boundary past server history triggers a rebuild before uploading offline edits', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  await mutate('create', 'book', { type: 'notebook', parentId: null, name: 'Original book' });
  const first = await readSyncQueue();
  await reconcile(server.sync(first), first);

  const pull = await readSyncQueue();
  server.sync({ cursor: pull.cursor, mutations: [
    { opId: 'remote-book', action: 'create', id: 'remote', fields: { type: 'notebook', parentId: null, name: 'Remote book' } },
  ] });
  const page = server.sync(pull);
  await reconcile({ ...page, hasMore: true, operationThrough: page.cursor + 10 }, pull);
  const edit = await mutate('update', 'book', { name: 'Offline rename' });
  const blocked = await readSyncQueue();
  assert.equal(blocked.operationThrough, page.cursor + 10);
  assert.deepEqual(blocked.mutations.map(mutation => mutation.opId), [edit.opId]);
  assert.throws(() => server.sync({ ...blocked, checkpoint: undefined }), /Invalid operation page boundary/);
  const resetResponse = server.sync(blocked);
  assert.deepEqual(resetResponse, { resetRequired: true });
  assert.equal(server.db.prepare('SELECT 1 FROM receipts WHERE op_id = ?').get(edit.opId), undefined);
  assert.deepEqual(await reconcile(resetResponse, blocked), { retry: true });
  assert.equal((await readEntities()).find(entity => entity.id === 'book').name, 'Offline rename');

  const rebuild = await readSyncQueue();
  assert.equal(rebuild.cursor, 0);
  assert.equal(rebuild.operationThrough, null);
  assert.deepEqual(rebuild.mutations, []);
  await reconcile(server.sync(rebuild), rebuild);
  const resend = await readSyncQueue();
  assert.deepEqual(resend.mutations.map(mutation => mutation.opId), [edit.opId]);
  assert.equal((await reconcile(server.sync(resend), resend)).pending, 0);
  assert.deepEqual((await readEntities()).map(entity => entity.name).sort(), ['Offline rename', 'Remote book']);
});

test('out-of-order responses from two tab workers do not roll back canonical data', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const id = randomUUID();
  await mutate('create', id, { type: 'notebook', parentId: null, name: 'First' });
  const stale = server.sync(await readSyncQueue());
  await mutate('update', id, { name: 'Latest' });
  const latest = server.sync(await readSyncQueue());
  await reconcile(latest);
  await reconcile(stale);
  assert.equal((await readEntities())[0].name, 'Latest');
  assert.equal((await readSyncQueue()).cursor, latest.cursor);
});

test('a disconnected sync reply cannot apply after waiting for IndexedDB', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  await mutate('create', 'queued', { type: 'notebook', parentId: null, name: 'Queued book' });
  const request = await readSyncQueue();
  const response = server.sync(request);
  const db = await openDatabase();
  const metadata = db.transaction('metadata', 'readwrite').objectStore('metadata');
  const entered = Promise.withResolvers();
  let hold = true;
  function keepAlive() {
    entered.resolve();
    if (hold) metadata.get('cursor').onsuccess = keepAlive;
  }
  metadata.get('cursor').onsuccess = keepAlive;
  await entered.promise;

  const queued = Promise.withResolvers();
  const transaction = db.transaction;
  t.mock.method(db, 'transaction', function (names, ...options) {
    const tx = transaction.call(this, names, ...options);
    if (names.includes('canonical')) queued.resolve();
    return tx;
  });
  const connection = new AbortController();
  try {
    const applying = reconcile(response, request, connection.signal);
    await queued.promise;
    connection.abort();
    hold = false;
    assert.deepEqual(await applying, { retry: true });
    assert.deepEqual(await readSyncQueue(), request);
    assert.equal((await readEntities())[0].name, 'Queued book');
  } finally {
    hold = false;
  }
});

test('a restored backup replaces divergent history without losing queued edits or applying stale responses', async t => {
  await reset();
  const directory = mkdtempSync(path.join(tmpdir(), 'todos-sync-restore-'));
  const backup = path.join(directory, 'backup.sqlite');
  const original = createStore(':memory:');
  let restored;
  t.after(() => {
    restored?.close();
    original.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const syncWith = async server => {
    const request = await readSyncQueue();
    return reconcile(server.sync(request), request);
  };
  const createBook = name => ({
    action: 'create', opId: randomUUID(), id: randomUUID(), fields: { type: 'notebook', parentId: null, name },
  });
  const shared = createBook('From backup');
  const abandoned = createBook('Lost from server');
  const replacement = createBook('Replacement at reused revision');
  original.sync({ cursor: 0, mutations: [shared] });
  original.db.prepare('VACUUM INTO ?').run(backup);
  original.sync({ cursor: 1, mutations: [abandoned] });
  await syncWith(original);
  await mutate('update', shared.id, { name: 'Queued offline edit' });
  const staleRequest = await readSyncQueue();
  const staleResponse = original.sync(staleRequest);

  restored = createStore(backup);
  assert.deepEqual(restored.sync(staleRequest), { resetRequired: true });
  restored.sync({ cursor: 1, mutations: [replacement] });
  assert.deepEqual(restored.sync(staleRequest), { resetRequired: true });
  for (let batch = 0; batch < 5; batch++) {
    restored.sync({ cursor: 0, mutations: Array.from({ length: 100 }, () => createBook('Other notebook')) });
  }
  assert.deepEqual(await syncWith(restored), { retry: true });
  assert.deepEqual((await readSyncQueue()).mutations, []);
  assert.deepEqual(await reconcile(staleResponse, staleRequest), { retry: true });
  assert.deepEqual(await syncWith(restored), { retry: true });
  assert.deepEqual(new Set((await readEntities()).map(entity => entity.name)),
    new Set(['Queued offline edit', 'Lost from server']));

  const rebuilt = await syncWith(restored);
  assert.equal(rebuilt.changed, true);
  assert.equal(rebuilt.pending, 1);
  const local = new Map((await readEntities()).map(entity => [entity.id, entity.name]));
  assert.equal(local.get(shared.id), 'Queued offline edit');
  assert.equal(local.get(replacement.id), 'Replacement at reused revision');
  assert.equal(local.has(abandoned.id), false);
  assert.equal(local.size, 502);
  assert.equal((await syncWith(restored)).pending, 0);
  assert.equal(JSON.parse(restored.db.prepare('SELECT data FROM entities WHERE id = ?').get(shared.id).data).name,
    'Queued offline edit');
});

test('a legacy browser cursor is rebuilt even when the server history is empty', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const old = { id: randomUUID(), type: 'notebook', parentId: null, name: 'Legacy record' };
  await reconcile({ cursor: 1, acknowledgements: [], changes: [{ revision: 1, entity: old }] });
  const request = await readSyncQueue();
  assert.equal(request.checkpoint, null);
  assert.deepEqual(await reconcile(server.sync(request), request), { retry: true });
  assert.deepEqual(await readEntities(), [old]);
  const rebuilding = await readSyncQueue();
  assert.equal((await reconcile(server.sync(rebuilding), rebuilding)).changed, true);
  assert.deepEqual(await readEntities(), []);
});

test('accepted mutations stay projected and use receipt lookups until the pull reaches their revisions', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  for (let batch = 0; batch < 5; batch++) {
    server.sync({ cursor: 0, mutations: Array.from({ length: 100 }, () => ({ action: 'create', opId: randomUUID(), id: randomUUID(), fields: { type: 'notebook', parentId: null, name: 'Other device' } })) });
  }
  const id = randomUUID();
  const { opId } = await mutate('create', id, { type: 'notebook', parentId: null, name: 'My pending book' });
  const first = server.sync(await readSyncQueue());
  assert.equal(first.hasMore, true);
  await reconcile(first);
  const lookup = await readSyncQueue();
  assert.deepEqual(lookup.mutations, []);
  assert.deepEqual(lookup.awaiting, [opId]);
  assert.equal((await readEntities()).find(entity => entity.id === id).name, 'My pending book');
  const second = server.sync(lookup);
  assert.deepEqual(second.acknowledgements, first.acknowledgements);
  assert.equal((await reconcile(second, lookup)).pending, 0);
  assert.deepEqual((await readSyncQueue()).awaiting, []);
});

test('a backup that loses a receipt but keeps the browser checkpoint causes an ordered resend', async t => {
  await reset();
  const directory = mkdtempSync(path.join(tmpdir(), 'todos-receipt-restore-'));
  const backup = path.join(directory, 'backup.sqlite');
  const original = createStore(':memory:');
  let restored;
  t.after(() => {
    restored?.close();
    original.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (let batch = 0; batch < 5; batch++) {
    original.sync({ cursor: 0, mutations: Array.from({ length: 100 }, () => ({
      action: 'create', opId: randomUUID(), id: randomUUID(),
      fields: { type: 'notebook', parentId: null, name: 'From backup' },
    })) });
  }
  original.db.prepare('VACUUM INTO ?').run(backup);
  const id = randomUUID();
  const { opId } = await mutate('create', id, { type: 'notebook', parentId: null, name: 'Pending book' });
  const originalRequest = await readSyncQueue();
  const first = original.sync(originalRequest);
  assert.equal(first.hasMore, true);
  await reconcile(first, originalRequest);
  const { opId: editId } = await mutate('update', id, { name: 'Dependent edit' });

  restored = createStore(backup);
  const lookup = await readSyncQueue();
  assert.deepEqual(lookup.awaiting, [opId]);
  assert.deepEqual(lookup.mutations, []);
  const missing = restored.sync(lookup);
  assert.equal(missing.checkpoint, lookup.checkpoint);
  assert.deepEqual(missing.acknowledgements, []);
  await reconcile(missing, lookup);
  const resend = await readSyncQueue();
  assert.deepEqual(resend.awaiting, []);
  assert.deepEqual(resend.mutations.map(mutation => mutation.opId), [opId, editId]);
  assert.equal((await reconcile(restored.sync(resend), resend)).pending, 0);
  assert.equal((await readEntities()).find(book => book.id === id).name, 'Dependent edit');
});

test('canonical trash hides stale edits and preserves rejections across sync batches until dismissed', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const id = randomUUID();
  await mutate('create', id, { type: 'notebook', parentId: null, name: 'Book' });
  await reconcile(server.sync(await readSyncQueue()));
  server.sync({ cursor: 0, mutations: [{ action: 'trash', id, opId: randomUUID() }] });
  await mutate('update', id, { name: 'Stale' });
  for (let i = 0; i < 99; i++) {
    await mutate('sort', ROOT_VIEW_ID, { sortOrder: 'created-asc' });
  }
  await mutate('create', randomUUID(), { type: 'folder', parentId: id, name: 'Stale child' });

  const firstRequest = await readSyncQueue();
  const firstResponse = server.sync(firstRequest);
  await reconcile(firstResponse, firstRequest);
  const firstError = 'update: This item is in trash or no longer exists.';
  const firstDisplayed = await readSyncErrors();
  assert.deepEqual(firstDisplayed.map(entry => entry.message), [firstError]);

  const secondRequest = await readSyncQueue();
  const secondResponse = server.sync(secondRequest);
  await reconcile(secondResponse, secondRequest);
  await reconcile(secondResponse, secondRequest); // Another tab can deliver the same receipt.
  assert.equal((await readEntities()).length, 0);
  assert.equal((await readSyncQueue()).mutations.length, 0);
  const both = await readSyncErrors();
  assert.deepEqual(both.map(entry => entry.message), [firstError, 'create: The parent no longer exists.']);
  const firstIds = firstDisplayed.map(entry => entry.id);
  await dismissSyncErrors(firstIds);
  await dismissSyncErrors(firstIds); // A tab can dismiss the same alert again from a stale view.
  assert.deepEqual(await readSyncErrors(), [both[1]]);
  await dismissSyncErrors([both[1].id]);
  assert.deepEqual(await readSyncErrors(), []);
});

test('legacy rejection messages keep separate identities when one is dismissed', async () => {
  await reset();
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['metadata'], 'readwrite');
    tx.objectStore('metadata').put({ key: 'syncErrors', value: ['Same message', 'Same message'] });
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
  const [first, second] = await readSyncErrors();
  assert.notEqual(first.id, second.id);
  await dismissSyncErrors([first.id]);
  assert.deepEqual(await readSyncErrors(), [second]);
});

test('offline sort choices stay projected during sync and root settings stay out of browsing and search', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const id = randomUUID();
  await mutate('create', id, { type: 'notebook', parentId: null, name: 'Sorted notebook' });
  await reconcile(server.sync(await readSyncQueue()));
  assert.equal(await readRootSortOrder(), 'created-desc');
  await mutate('sort', ROOT_VIEW_ID, { sortOrder: 'modified-asc' });
  await mutate('sort', id, { sortOrder: 'created-asc' });
  const response = server.sync(await readSyncQueue());
  await mutate('sort', id, { sortOrder: 'modified-desc' });
  await reconcile(response);
  assert.equal((await readEntities()).length, 1);
  assert.equal((await readEntities())[0].sortOrder, 'modified-desc');
  assert.equal(await readRootSortOrder(), 'modified-asc');
  await reconcile(server.sync(await readSyncQueue()));
  assert.equal((await readSyncQueue()).mutations.length, 0);
  assert.equal((await readEntities())[0].sortOrder, 'modified-desc');
});

test('a favourite toggled during text sync remains local and later reaches the server', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const id = randomUUID();
  await mutate('create', id, { type: 'notebook', parentId: null, name: 'Before starring' });
  await reconcile(server.sync(await readSyncQueue()));
  await mutate('update', id, { name: 'Edited' });
  const response = server.sync(await readSyncQueue());
  await mutate('update', id, { favourite: true });
  await reconcile(response);
  assert.equal((await readEntities())[0].favourite, true);
  assert.equal((await readEntities())[0].name, 'Edited');
  await reconcile(server.sync(await readSyncQueue()));
  assert.equal((await readEntities())[0].favourite, true);
  assert.equal((await readSyncQueue()).mutations.length, 0);
  assert.equal(server.sync({ cursor: 0, mutations: [] }).changes.at(-1).entity.favourite, true);
});

test('undo records the previous edited fields atomically and restores an offline deletion after sync', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const id = randomUUID();
  await mutate('create', id, { type: 'notebook', parentId: null, name: 'Before' });
  const edit = await mutate('update', id, { name: 'After' });
  assert.deepEqual(edit.inverse, { action: 'update', id, fields: { name: 'Before' } });
  await mutate('update', id, { favourite: true });
  await mutate(edit.inverse.action, id, edit.inverse.fields);
  assert.equal((await readEntities())[0].name, 'Before');
  assert.equal((await readEntities())[0].favourite, true);
  const deletion = await mutate('trash', id);
  const response = server.sync(await readSyncQueue());
  await mutate(deletion.inverse.action, id, deletion.inverse.fields);
  await reconcile(response);
  assert.equal((await readEntities())[0].name, 'Before');
  assert.equal((await readEntities())[0].favourite, true);
  await reconcile(server.sync(await readSyncQueue()));
  assert.equal((await readSyncQueue()).mutations.length, 0);
  assert.equal((await readEntities())[0].deletedAt, null);
});

test('trash keeps all descendants visible while their deletion is pulled in pages', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const book = randomUUID();
  const earlier = randomUUID();
  const create = (id, type, parentId) => ({
    action: 'create', id, opId: randomUUID(), fields: { type, parentId, name: type },
  });
  server.sync({ cursor: 0, mutations: [create(book, 'notebook', null), create(earlier, 'folder', book)] });
  const earlierDeletion = server.sync({
    cursor: 0, mutations: [{ action: 'trash', id: earlier, opId: randomUUID() }],
  }).changes.at(-1).entity;
  for (let batch = 0; batch < 6; batch++) {
    server.sync({ cursor: 0, mutations: Array.from({ length: 100 }, () => create(randomUUID(), 'folder', book)) });
  }
  const sync = async () => {
    const request = await readSyncQueue();
    const response = server.sync(request);
    await reconcile(response, request);
    return response;
  };
  while ((await sync()).hasMore) {}

  const { opId } = await mutate('trash', book);
  const readTrash = async () => trashRows(await readEntitySnapshot()).map(row => row.entity);
  assert.equal((await readTrash()).length, 602);
  const first = await sync();
  assert.equal(first.hasMore, true);
  assert.deepEqual((await readSyncQueue()).awaiting, [opId]);
  const partial = await readTrash();
  assert.equal(partial.length, 602);
  assert.deepEqual(partial.find(entity => entity.id === earlier), earlierDeletion);
  const { deletedAt } = first.changes.find(change => change.entity.id === book).entity;
  assert.equal(partial.filter(entity => entity.trashedBy === opId && entity.deletedAt === deletedAt).length, 601);

  const stale = server.sync({
    cursor: first.cursor, mutations: [{ action: 'trash', id: book, opId: randomUUID() }],
  });
  assert.equal(stale.acknowledgements[0].accepted, false);
  assert.equal((await sync()).hasMore, false);
  assert.deepEqual((await readSyncQueue()).awaiting, []);
  assert.deepEqual(await readTrash(), partial);
});

test('receiving a paginated deletion publishes the whole subtree before newer deletions', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const books = [randomUUID(), randomUUID()];
  const create = (id, type, parentId) => ({
    action: 'create', id, opId: randomUUID(), fields: { type, parentId, name: type },
  });
  server.sync({ cursor: 0, mutations: books.map(book => create(book, 'notebook', null)) });
  for (const book of books) {
    for (let batch = 0; batch < 6; batch++) {
      server.sync({ cursor: 0, mutations: Array.from({ length: 100 }, () => create(randomUUID(), 'folder', book)) });
    }
  }
  const sync = async () => {
    const request = await readSyncQueue();
    const response = server.sync(request);
    return { response, result: await reconcile(response, request) };
  };
  while ((await sync()).response.hasMore) {}
  const { acknowledgements } = server.sync({
    cursor: 0, mutations: books.map(id => ({ action: 'trash', id, opId: randomUUID() })),
  });
  const trashCount = async () => trashRows(await readEntitySnapshot()).length;

  const first = await sync();
  assert.equal(first.response.trashThrough, acknowledgements[0].revision);
  assert.equal(first.result.changed, false);
  assert.equal(await trashCount(), 0);
  assert.equal((await readEntities()).length, 1202);

  const local = randomUUID();
  await mutate('create', local, { type: 'notebook', parentId: null, name: 'Edited while pulling' });
  const boundary = await sync();
  assert.equal(boundary.response.cursor, acknowledgements[0].revision);
  assert.equal(boundary.response.hasMore, true);
  assert.equal(boundary.result.changed, true);
  assert.equal(await trashCount(), 601);
  assert.ok((await readEntities()).some(entity => entity.id === local));

  const second = await sync();
  assert.equal(second.response.trashThrough, acknowledgements[1].revision);
  assert.equal(second.result.changed, false);
  assert.equal(await trashCount(), 601);
  const secondBoundary = await sync();
  assert.equal(secondBoundary.response.cursor, acknowledgements[1].revision);
  assert.equal(await trashCount(), 1202);
  assert.equal((await sync()).result.pending, 0);
  assert.equal((await readEntities())[0].id, local);
});

test('a receiving browser publishes a restore and a following import at their own boundaries', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const book = randomUUID();
  const create = (id, type, parentId) => ({
    action: 'create', id, opId: randomUUID(), fields: { type, parentId, name: type },
  });
  server.sync({ cursor: 0, mutations: [create(book, 'notebook', null)] });
  for (let batch = 0; batch < 6; batch++) {
    server.sync({ cursor: 0, mutations: Array.from({ length: 100 }, () => create(randomUUID(), 'folder', book)) });
  }
  const trashOpId = randomUUID();
  server.sync({ cursor: 0, mutations: [{ action: 'trash', id: book, opId: trashOpId }] });
  const sync = async () => {
    const request = await readSyncQueue();
    const response = server.sync(request);
    return { response, result: await reconcile(response, request) };
  };
  while ((await sync()).response.hasMore) {}
  const rows = async () => {
    const snapshot = await readEntitySnapshot();
    return { trash: trashRows(snapshot).length, locations: snapshot.filter(entity => entity.type === 'location').length };
  };
  assert.deepEqual(await rows(), { trash: 601, locations: 0 });

  const locations = Array.from({ length: 601 }, (_, i) => ({
    id: `remote-import-${i}`, name: `Location ${i}`, latitude: 0, longitude: 0, userLocation: false,
  }));
  const restoreId = randomUUID();
  const importId = randomUUID();
  const { acknowledgements: [restoration, imported] } = server.sync({ cursor: 0, mutations: [
    { opId: restoreId, action: 'restore', id: book, fields: { trashOpId } },
    { opId: importId, action: 'location-import', id: ROOT_VIEW_ID, fields: { locations, expected: locations.map(() => null) } },
  ] });
  assert.equal(restoration.accepted, true);
  assert.equal(imported.accepted, true);

  const first = await sync();
  assert.equal(first.response.operationId, restoreId);
  assert.equal(first.response.operationThrough, restoration.revision);
  assert.equal(first.result.changed, false);
  assert.deepEqual(await rows(), { trash: 601, locations: 0 });
  assert.equal((await readEntities()).length, 0);

  const restored = await sync();
  assert.equal(restored.response.cursor, restoration.revision);
  assert.equal(restored.response.hasMore, true);
  assert.equal(restored.result.changed, true);
  assert.equal((await readEntities()).length, 601);
  assert.deepEqual(await rows(), { trash: 0, locations: 0 });

  const third = await sync();
  assert.equal(third.response.operationId, importId);
  assert.equal(third.response.operationThrough, imported.revision);
  assert.equal(third.result.changed, false);
  assert.deepEqual(await rows(), { trash: 0, locations: 0 });
  const finished = await sync();
  assert.equal(finished.response.cursor, imported.revision);
  assert.equal(finished.response.hasMore, false);
  assert.equal(finished.result.changed, true);
  assert.deepEqual(await rows(), { trash: 0, locations: 601 });
});

test('a completed restore is visible before a following paginated import', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  server.sync({ cursor: 0, mutations: [
    { opId: 'create-book', action: 'create', id: 'book', fields: { type: 'notebook', parentId: null, name: 'Book' } },
    { opId: 'create-folder', action: 'create', id: 'folder', fields: { type: 'folder', parentId: 'book', name: 'Folder' } },
    { opId: 'trash-book', action: 'trash', id: 'book' },
  ] });
  const sync = async () => {
    const request = await readSyncQueue();
    const response = server.sync(request);
    await reconcile(response, request);
    return response;
  };
  await sync();
  assert.equal((await readEntities()).length, 0);

  const locations = Array.from({ length: 501 }, (_, i) => ({
    id: `location-${i}`, name: `Location ${i}`, latitude: 0, longitude: 0, userLocation: false,
  }));
  const { acknowledgements: [restoration, imported] } = server.sync({ cursor: 0, mutations: [
    { opId: 'restore-book', action: 'restore', id: 'book', fields: { trashOpId: 'trash-book' } },
    { opId: 'import-locations', action: 'location-import', id: ROOT_VIEW_ID,
      fields: { locations, expected: locations.map(() => null) } },
  ] });
  assert.ok(restoration.accepted && imported.accepted);

  const first = await sync();
  assert.equal(first.cursor, restoration.revision);
  assert.equal(first.hasMore, true);
  assert.equal(first.operationThrough, undefined);
  assert.deepEqual((await readEntities()).map(entity => entity.id).sort(), ['book', 'folder']);
  assert.equal((await readEntitySnapshot()).length, 2);

  const partial = await sync();
  assert.equal(partial.operationId, 'import-locations');
  assert.equal(partial.operationThrough, imported.revision);
  assert.equal((await readEntitySnapshot()).length, 2);
  const finished = await sync();
  assert.equal(finished.cursor, imported.revision);
  assert.equal(finished.hasMore, false);
  assert.equal((await readEntitySnapshot()).length, 503);
});

test('restored descendants remain visible while their accepted restoration is pulled in pages', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const id = randomUUID();
  await mutate('create', id, { type: 'notebook', parentId: null, name: 'Large notebook' });
  await reconcile(server.sync(await readSyncQueue()));
  for (let batch = 0; batch < 6; batch++) {
    server.sync({ cursor: 0, mutations: Array.from({ length: 100 }, () => ({ action: 'create', opId: randomUUID(), id: randomUUID(), fields: { type: 'folder', parentId: id, name: 'Folder' } })) });
  }
  let response;
  do {
    response = server.sync(await readSyncQueue());
    await reconcile(response);
  } while (response.hasMore);
  const deletion = await mutate('trash', id);
  do {
    response = server.sync(await readSyncQueue());
    await reconcile(response);
  } while (response.hasMore);
  await mutate(deletion.inverse.action, id, deletion.inverse.fields);
  const first = server.sync(await readSyncQueue());
  assert.equal(first.hasMore, true);
  await reconcile(first);
  assert.equal((await readEntities()).length, 601);
  assert.equal((await readSyncQueue()).awaiting.length, 1);
  await reconcile(server.sync(await readSyncQueue()));
  assert.equal((await readEntities()).length, 601);
  assert.equal((await readSyncQueue()).mutations.length, 0);
});

test('root date display defaults to none for missing and legacy sort-only settings', async t => {
  await reset();
  assert.equal(await readRootDateDisplay(), 'none');
  assert.deepEqual(await readEntitySnapshot(), []);
  assert.deepEqual(await readSyncQueue(), { cursor: 0, checkpoint: null, generation: 0, rebuilding: false, mutations: [], awaiting: [], operationThrough: null });
  const server = createStore(':memory:');
  t.after(() => server.close());
  const id = randomUUID();
  const legacy = server.sync({ cursor: 0, mutations: [
    { action: 'create', opId: randomUUID(), id, fields: { type: 'notebook', parentId: null, name: 'Legacy #book' } },
    { action: 'sort', opId: randomUUID(), id: ROOT_VIEW_ID, fields: { sortOrder: 'modified-asc' } },
  ] });
  assert.ok(legacy.changes.every(change => change.entity.dateDisplay === undefined));
  await reconcile(legacy);
  assert.equal(await readRootDateDisplay(), 'none');
  assert.equal(await readRootSortOrder(), 'modified-asc');
  assert.deepEqual(await readEntities(), [legacy.changes[0].entity]);
  assert.deepEqual((await readEntitySnapshot()).find(entity => entity.id === ROOT_VIEW_ID), {
    id: ROOT_VIEW_ID, type: 'view-settings', parentId: null, sortOrder: 'modified-asc',
  });
  const result = await mutate('date-display', ROOT_VIEW_ID, { dateDisplay: 'created-time' });
  assert.equal(result.inverse, null);
  assert.equal(await readRootDateDisplay(), 'created-time');
  assert.equal(await readRootSortOrder(), 'modified-asc');
  assert.deepEqual(await readEntities(), [legacy.changes[0].entity]);
});

test('offline date modes preserve full active records and timestamps, hide root settings and have no inverse', async () => {
  await reset();
  const book = randomUUID();
  const folder = randomUUID();
  const list = randomUUID();
  const note = randomUUID();
  const todo = randomUUID();
  for (const [id, type, parentId, value] of [
    [book, 'notebook', null, 'Book #work'], [folder, 'folder', book, 'Folder #work'],
    [list, 'list', folder, 'List #work'], [note, 'note', list, 'Note #text'], [todo, 'todo', list, 'Todo #text'],
  ]) {
    await mutate('create', id, { type, parentId, [['note', 'todo'].includes(type) ? 'text' : 'name']: value });
  }
  const first = await mutate('date-display', ROOT_VIEW_ID, { dateDisplay: 'created-time' });
  assert.equal(first.inverse, null);
  assert.equal(await readRootSortOrder(), 'created-desc');
  assert.deepEqual((await readEntitySnapshot()).find(entity => entity.id === ROOT_VIEW_ID), {
    id: ROOT_VIEW_ID, type: 'view-settings', parentId: null, dateDisplay: 'created-time',
  });
  const targets = [ROOT_VIEW_ID, book, folder, list];
  for (const id of targets) await mutate('sort', id, { sortOrder: 'modified-desc' });
  for (const id of [book, folder, list]) await mutate('update', id, { favourite: true });
  await mutate('update', todo, { checked: true, favourite: true });
  const before = new Map((await readEntitySnapshot()).map(entity => [entity.id, entity]));
  for (const option of dateDisplayOptions) {
    for (const id of targets) {
      const result = await mutate('date-display', id, { dateDisplay: option.value });
      assert.equal(result.inverse, null);
      const entity = (await readEntitySnapshot()).find(entity => entity.id === id);
      assert.deepEqual(entity, { ...before.get(id), dateDisplay: option.value });
    }
    assert.equal(await readRootDateDisplay(), option.value);
    assert.equal(await readRootSortOrder(), 'modified-desc');
    const active = await readEntities();
    assert.equal(active.length, 5);
    assert.deepEqual(active.find(entity => entity.id === note), before.get(note));
    assert.deepEqual(active.find(entity => entity.id === todo), before.get(todo));
    for (const id of [book, folder, list]) assert.deepEqual(active.find(entity => entity.id === id), { ...before.get(id), dateDisplay: option.value });
    assert.ok(active.every(entity => entity.id !== ROOT_VIEW_ID));
  }
  const preferences = (await readSyncQueue()).mutations.filter(mutation => mutation.action === 'date-display');
  assert.equal(preferences.length, 1 + targets.length * dateDisplayOptions.length);
  assert.deepEqual(preferences.slice(1).map(mutation => [mutation.id, mutation.fields]),
    dateDisplayOptions.flatMap(option => targets.map(id => [id, { dateDisplay: option.value }])));
});

test('newer pending root and entity dates, content and sort survive an older sync response', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const id = randomUUID();
  await mutate('create', id, { type: 'notebook', parentId: null, name: 'Before #old' });
  await mutate('update', id, { favourite: true });
  await reconcile(server.sync(await readSyncQueue()));
  for (const target of [ROOT_VIEW_ID, id]) await mutate('date-display', target, { dateDisplay: 'modified-date' });
  const response = server.sync(await readSyncQueue());
  await mutate('date-display', ROOT_VIEW_ID, { dateDisplay: 'created-time' });
  await mutate('date-display', id, { dateDisplay: 'modified-time' });
  await mutate('update', id, { name: 'Typed while syncing #pending' });
  await mutate('sort', id, { sortOrder: 'modified-desc' });
  await mutate('sort', ROOT_VIEW_ID, { sortOrder: 'created-asc' });
  const projection = await readEntitySnapshot();
  const pending = (await readSyncQueue()).mutations.slice(-5);
  await reconcile(response);
  assert.deepEqual(await readEntitySnapshot(), projection);
  assert.deepEqual((await readSyncQueue()).mutations, pending);
  assert.equal(await readRootDateDisplay(), 'created-time');
  assert.equal(await readRootSortOrder(), 'created-asc');
  const entity = (await readEntities())[0];
  assert.equal(entity.dateDisplay, 'modified-time');
  assert.equal(entity.sortOrder, 'modified-desc');
  assert.equal(entity.name, 'Typed while syncing #pending');
  assert.deepEqual(entity.tags, ['pending']);
  assert.equal(entity.favourite, true);
  const latest = server.sync(await readSyncQueue());
  await reconcile(latest);
  assert.equal((await readSyncQueue()).mutations.length, 0);
  assert.deepEqual((await readEntities())[0], latest.changes.filter(change => change.entity.id === id).at(-1).entity);
  const settled = await readEntitySnapshot();
  await reconcile(response);
  assert.deepEqual(await readEntitySnapshot(), settled);
  assert.equal((await readSyncQueue()).cursor, latest.cursor);
});

test('pending date preferences replay over independent canonical text and sort patches', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const id = randomUUID();
  await mutate('create', id, { type: 'notebook', parentId: null, name: 'Before remote edit' });
  await reconcile(server.sync(await readSyncQueue()));
  await mutate('date-display', ROOT_VIEW_ID, { dateDisplay: 'created-date' });
  await mutate('date-display', id, { dateDisplay: 'modified-time' });
  const pending = await readSyncQueue();
  const remote = server.sync({ cursor: pending.cursor, checkpoint: pending.checkpoint, mutations: [
    { action: 'update', id, opId: randomUUID(), fields: { name: 'Remote #new', favourite: true } },
    { action: 'sort', id, opId: randomUUID(), fields: { sortOrder: 'modified-asc' } },
    { action: 'sort', id: ROOT_VIEW_ID, opId: randomUUID(), fields: { sortOrder: 'created-asc' } },
  ] });
  await reconcile(remote);
  const canonical = remote.changes.filter(change => change.entity.id === id).at(-1).entity;
  assert.deepEqual((await readEntities())[0], { ...canonical, dateDisplay: 'modified-time' });
  assert.equal(await readRootDateDisplay(), 'created-date');
  assert.equal(await readRootSortOrder(), 'created-asc');
  assert.deepEqual((await readSyncQueue()).mutations, pending.mutations);
  await reconcile(server.sync(await readSyncQueue()));
  assert.deepEqual((await readEntities())[0], { ...canonical, dateDisplay: 'modified-time' });
  assert.equal((await readSyncQueue()).mutations.length, 0);
});

test('invalid local date fields and live-leaf, deleted or unknown targets leave projection and outbox unchanged', async () => {
  await reset();
  const ids = [];
  for (let branch = 0; branch < 2; branch++) {
    const [book, folder, list, note, todo] = Array.from({ length: 5 }, () => randomUUID());
    for (const [id, type, parentId] of [[book, 'notebook', null], [folder, 'folder', book], [list, 'list', folder], [note, 'note', list], [todo, 'todo', list]]) {
      await mutate('create', id, { type, parentId, [['note', 'todo'].includes(type) ? 'text' : 'name']: type });
    }
    ids.push([book, folder, list, note, todo]);
  }
  await mutate('sort', ROOT_VIEW_ID, { sortOrder: 'modified-desc' });
  await mutate('date-display', ROOT_VIEW_ID, { dateDisplay: 'created-time' });
  await mutate('trash', ids[1][0]);
  const snapshot = await readEntitySnapshot();
  const active = await readEntities();
  const queue = await readSyncQueue();
  const invalidFields = [undefined, null, [], 'created-date', true, 42, {}, { sortOrder: 'created-asc' },
    ...[undefined, null, '', 'invalid', 'CREATED-DATE', 1, false, {}, []].map(dateDisplay => ({ dateDisplay })),
    ...['name', 'sortOrder', 'createdAt', 'modifiedAt'].map(field => ({ dateDisplay: 'created-date', [field]: 'forbidden' })),
  ];
  const attempts = [
    ...[ROOT_VIEW_ID, ids[0][0]].flatMap(id => invalidFields.map(fields => ({ id, fields, error: /Invalid fields|Invalid date display mode/ }))),
    ...[ids[0][3], ids[0][4], ...ids[1], randomUUID()].map(id => ({ id, fields: { dateDisplay: 'created-date' }, error: /Only existing/ })),
  ];
  for (const { id, fields, error } of attempts) {
    await assert.rejects(mutate('date-display', id, fields), error);
    assert.deepEqual(await readEntitySnapshot(), snapshot);
    assert.deepEqual(await readEntities(), active);
    assert.deepEqual(await readSyncQueue(), queue);
    assert.equal(await readRootDateDisplay(), 'created-time');
    assert.equal(await readRootSortOrder(), 'modified-desc');
    assert.deepEqual(await readSyncErrors(), []);
  }
});

test('offline locations, selections and a paginated bulk import stay projected through sync', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const { nearbyPreferences, previewLocationImport, savedLocations } = await import('../src/lib/locations.js');
  const locations = Array.from({ length: 601 }, (_, i) => ({ id: `import-${i}`, name: `Store ${i} #shop`, latitude: 0, longitude: i / 10000, userLocation: i === 0 }));
  const preview = previewLocationImport({ version: 1, locations }, []);
  await mutate('location-import', ROOT_VIEW_ID, preview.fields);
  await mutate('nearby-settings', ROOT_VIEW_ID, { nearbyLocationId: 'import-0', nearbyRadius: 10 });
  assert.equal(savedLocations(await readEntitySnapshot()).length, 601);
  assert.equal((await readEntities()).length, 0);
  const first = server.sync(await readSyncQueue());
  assert.equal(first.hasMore, true);
  await reconcile(first);
  assert.equal(savedLocations(await readEntitySnapshot()).length, 601);
  assert.equal(nearbyPreferences(await readEntitySnapshot()).origin.id, 'import-0');
  await reconcile(server.sync(await readSyncQueue()));
  assert.equal((await readSyncQueue()).mutations.length, 0);
  assert.equal(nearbyPreferences(await readEntitySnapshot()).radius, 10);
  await mutate('location-update', 'import-0', { userLocation: false });
  assert.equal(nearbyPreferences(await readEntitySnapshot()).origin, null);
  await reconcile(server.sync(await readSyncQueue()));
  assert.equal(nearbyPreferences(await readEntitySnapshot()).origin, null);
});

test('pulling a disabled location also clears its selection as the Nearby origin', async t => {
  const { nearbyPreferences } = await import('../src/lib/locations.js');
  for (const history of ['new', 'legacy', 'rollback']) {
    await t.test(history + ' history', async t => {
      await reset();
      const directory = mkdtempSync(path.join(tmpdir(), 'todos-origin-sync-'));
      const filename = path.join(directory, 'todos.sqlite');
      let server = createStore(filename);
      t.after(() => {
        server?.close();
        rmSync(directory, { recursive: true, force: true });
      });
      const sync = async () => {
        const queue = await readSyncQueue();
        const response = server.sync(queue);
        await reconcile(response, queue);
        return response;
      };
      await mutate('location-create', 'home', { name: 'Home', latitude: 0, longitude: 0, userLocation: true });
      await mutate('nearby-settings', ROOT_VIEW_ID, { nearbyLocationId: 'home', nearbyRadius: 10 });
      const initial = await sync();
      const edits = Array.from({ length: 499 }, (_, i) => ({
        opId: `create-book-${i}`, action: 'create', id: `book-${i}`,
        fields: { type: 'notebook', parentId: null, name: `Book ${i}` },
      }));
      for (let i = 0; i < edits.length; i += 100) {
        server.sync({ cursor: initial.cursor, mutations: edits.slice(i, i + 100) });
      }
      const { acknowledgements: [disabled] } = server.sync({ cursor: initial.cursor, mutations: [
        { opId: 'disable-home', action: 'location-update', id: 'home', fields: { userLocation: false } },
      ] });
      assert.equal(disabled.accepted, true);
      if (history === 'legacy') {
        if (server.db.prepare("SELECT 1 FROM pragma_table_info('changes') WHERE name = 'operation_id'").get()) {
          server.db.exec('ALTER TABLE changes DROP COLUMN operation_id');
        }
      } else if (history === 'rollback') {
        // An older server leaves these IDs empty even when the column exists.
        server.db.prepare('UPDATE changes SET operation_id = NULL WHERE revision IN (?, ?)')
          .run(disabled.revision - 1, disabled.revision);
      }
      if (history !== 'new') {
        server.close();
        server = null;
        server = createStore(filename);
      }

      const earlier = await sync();
      assert.equal(earlier.changes.length, 499);
      assert.equal(earlier.hasMore, true);
      assert.equal(nearbyPreferences(await readEntitySnapshot()).origin.id, 'home');
      const cleared = await sync();
      assert.equal(cleared.cursor, disabled.revision);
      assert.deepEqual(cleared.changes.map(change => change.entity.id), ['home', ROOT_VIEW_ID]);
      assert.equal(cleared.hasMore, false);

      await mutate('location-update', 'home', { userLocation: true });
      const offline = await readEntitySnapshot();
      assert.equal(offline.find(entity => entity.id === 'home').userLocation, true);
      assert.deepEqual(nearbyPreferences(offline), { origin: null, radius: 10 });
    });
  }
});

test('a stale offline import is rejected atomically and reports the conflict', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const { previewLocationImport } = await import('../src/lib/locations.js');
  await mutate('location-create', 'shop', { name: 'Shop', latitude: 0, longitude: 0, userLocation: false });
  await reconcile(server.sync(await readSyncQueue()));
  const preview = previewLocationImport({ version: 1, locations: [
    { id: 'shop', name: 'Import edit', latitude: 0, longitude: 0, userLocation: false },
    { id: 'new-shop', name: 'New shop', latitude: 0, longitude: 0, userLocation: false },
  ] }, await readEntitySnapshot());
  server.sync({ cursor: 0, mutations: [{ opId: randomUUID(), action: 'location-update', id: 'shop', fields: { name: 'Other device' } }] });
  await mutate('location-import', ROOT_VIEW_ID, preview.fields);
  await reconcile(server.sync(await readSyncQueue()));
  assert.equal((await readEntitySnapshot()).find(entity => entity.id === 'shop').name, 'Other device');
  assert.ok(!(await readEntitySnapshot()).some(entity => entity.id === 'new-shop'));
  assert.match((await readSyncErrors())[0].message, /changed since the preview/);
});

test('rejected offline changes are removed while a remote import is still downloading', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const { nearbyPreferences, previewLocationImport } = await import('../src/lib/locations.js');
  const location = (id, name, userLocation = false) => ({ id, name, latitude: 0, longitude: 0, userLocation });
  const sync = async () => {
    const request = await readSyncQueue();
    const response = server.sync(request);
    return { response, result: await reconcile(response, request) };
  };
  await mutate('location-create', 'shop', { name: 'Original shop', latitude: 0, longitude: 0, userLocation: false });
  await sync();
  const original = await readEntitySnapshot();
  const locations = [
    location('shop', 'Server shop'),
    ...Array.from({ length: 1000 }, (_, i) => location(`remote-${i}`, `Remote ${i}`)),
  ];
  server.sync({ cursor: 0, mutations: [{
    opId: 'remote-import', action: 'location-import', id: ROOT_VIEW_ID,
    fields: previewLocationImport({ version: 1, locations }, original).fields,
  }] });
  const first = await sync();
  assert.equal(first.response.operationId, 'remote-import');
  assert.equal(first.result.changed, false);
  forceCloseDatabase(await openDatabase());

  const offlineImport = [location('shop', 'Offline shop'), location('offline-origin', 'Offline origin', true)];
  const imported = await mutate('location-import', ROOT_VIEW_ID,
    previewLocationImport({ version: 1, locations: offlineImport }, original).fields);
  const selected = await mutate('nearby-settings', ROOT_VIEW_ID, { nearbyLocationId: 'offline-origin' });
  assert.equal(nearbyPreferences(await readEntitySnapshot()).origin.id, 'offline-origin');
  const request = await readSyncQueue();
  const partial = server.sync(request);
  assert.equal(partial.operationId, 'remote-import');
  const saved = await mutate('create', 'pending-book', { type: 'notebook', parentId: null, name: 'Saved in flight' });
  const result = await reconcile(partial, request);
  assert.deepEqual(result.errors.map(error => error.id), [imported.opId, selected.opId]);
  assert.equal(result.changed, true);

  forceCloseDatabase(await openDatabase());
  const offline = await readEntitySnapshot();
  assert.deepEqual(offline.filter(entity => entity.type === 'location'), original);
  assert.equal(nearbyPreferences(offline).origin, null);
  assert.equal(offline.find(entity => entity.id === 'pending-book').name, 'Saved in flight');
  assert.deepEqual((await readSyncQueue()).mutations.map(op => op.opId), [saved.opId]);

  await sync();
  const complete = await readEntitySnapshot();
  assert.equal(complete.find(entity => entity.id === 'shop').name, 'Server shop');
  assert.equal(complete.filter(entity => entity.type === 'location').length, locations.length);
  assert.equal(nearbyPreferences(complete).origin, null);
  assert.equal((await sync()).result.pending, 0);
});

test('offline UI edits preserve imported origin while JSON updates preserve UI origin through reconciliation', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const { previewLocationImport, locationCreationSource } = await import('../src/lib/locations.js');
  const values = { latitude: -37.8, longitude: 145, userLocation: false };
  await mutate('location-create', 'manual', { ...values, name: 'Added via UI' });
  const file = { version: 1, locations: [{ id: 'manual', ...values, name: 'Updated via JSON' }, { id: 'imported', ...values, name: 'Imported' }] };
  await mutate('location-import', ROOT_VIEW_ID, previewLocationImport(file, await readEntitySnapshot()).fields);
  const response = server.sync(await readSyncQueue());
  await mutate('location-update', 'imported', { name: 'Edited offline' });
  function verify(data) {
    assert.equal(locationCreationSource(data.find(row => row.id === 'manual')), 'ui');
    assert.equal(locationCreationSource(data.find(row => row.id === 'imported')), 'import');
    assert.equal(data.find(row => row.id === 'imported').name, 'Edited offline');
  }
  verify(await readEntitySnapshot());
  await reconcile(response);
  verify(await readEntitySnapshot());
  await reconcile(server.sync(await readSyncQueue()));
  assert.equal((await readSyncQueue()).mutations.length, 0);
  assert.equal(locationCreationSource((await readEntitySnapshot()).find(row => row.id === 'imported')), 'import');
});

test('offline pin patches survive concurrent text/favourite sync without replacing Undo or other fields', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const id = randomUUID();
  await mutate('create', id, { type: 'notebook', parentId: null, name: 'Before' });
  await reconcile(server.sync(await readSyncQueue()));
  await mutate('update', id, { name: 'While syncing', favourite: true });
  const response = server.sync(await readSyncQueue());
  const pin = await mutate('update', id, { pinned: true });
  assert.equal(pin.inverse, null);
  await reconcile(response);
  let entity = (await readEntities())[0];
  assert.equal(entity.pinned, true);
  assert.equal(entity.name, 'While syncing');
  assert.equal(entity.favourite, true);
  await reconcile(server.sync(await readSyncQueue()));
  const edit = await mutate('update', id, { name: 'New draft' });
  const unpin = await mutate('update', id, { pinned: false });
  assert.equal(unpin.inverse, null);
  await mutate(edit.inverse.action, id, edit.inverse.fields);
  await reconcile(server.sync(await readSyncQueue()));
  entity = (await readEntities())[0];
  assert.equal(entity.pinned, false);
  assert.equal(entity.name, 'While syncing');
  assert.equal(entity.favourite, true);
  const deletion = await mutate('trash', id);
  await mutate('restore', id, deletion.inverse.fields);
  await reconcile(server.sync(await readSyncQueue()));
  assert.equal((await readEntities())[0].pinned, false);
});

test('list completion checkboxes persist in IndexedDB and generate undo inverse mutations', async t => {
  await reset();
  const server = createStore(':memory:');
  t.after(() => server.close());
  const book = randomUUID();
  const folder = randomUUID();
  const list = randomUUID();
  await mutate('create', book, { type: 'notebook', parentId: null, name: 'Book' });
  await mutate('create', folder, { type: 'folder', parentId: book, name: 'Folder' });
  await mutate('create', list, { type: 'list', parentId: folder, name: 'List' });
  await reconcile(server.sync(await readSyncQueue()));

  let listEntity = (await readEntities()).find(e => e.id === list);
  assert.equal(listEntity.checked, false);

  const completed = await mutate('update', list, { checked: true });
  assert.deepEqual(completed.inverse, { action: 'update', id: list, fields: { checked: false } });
  listEntity = (await readEntities()).find(e => e.id === list);
  assert.equal(listEntity.checked, true);

  // Undo by applying inverse
  await mutate(completed.inverse.action, completed.inverse.id, completed.inverse.fields);
  listEntity = (await readEntities()).find(e => e.id === list);
  assert.equal(listEntity.checked, false);

  // Sync to server and verify persistence
  await mutate('update', list, { checked: true });
  await reconcile(server.sync(await readSyncQueue()));
  assert.equal((await readSyncQueue()).mutations.length, 0);
  listEntity = (await readEntities()).find(e => e.id === list);
  assert.equal(listEntity.checked, true);
});
