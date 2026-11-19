import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';
import { ROOT_VIEW_ID } from '../src/lib/model.js';
import { locationCreationSource, previewLocationImport, exportLocations } from '../src/lib/locations.js';

const mutation = (action, id, fields) => ({ opId: randomUUID(), action, id, ...(fields === undefined ? {} : { fields }) });
const values = name => ({ name, latitude: -37.8, longitude: 145, userLocation: false });
const snapshot = store => store.db.prepare('SELECT data FROM entities').all().map(row => JSON.parse(row.data));
function apply(store, operation) {
  const response = store.sync({ cursor: 0, mutations: [operation] });
  assert.equal(response.acknowledgements[0].accepted, true);
  return response;
}
function importFile(store, locations) {
  const operation = mutation('location-import', ROOT_VIEW_ID, previewLocationImport({ version: 1, locations }, snapshot(store)).fields);
  apply(store, operation);
  return operation;
}

test('creation source survives manual edits, import updates, trash and restore; exported records acquire import origin in another database', t => {
  const store = createStore(':memory:');
  const other = createStore(':memory:');
  t.after(() => { store.close(); other.close(); });
  apply(store, mutation('location-create', 'manual', values('Added via UI')));
  importFile(store, [{ id: 'manual', ...values('Updated by file') }, { id: 'imported', ...values('Imported #shop') }]);
  apply(store, mutation('location-update', 'imported', { name: 'Manually edited #shop', userLocation: true }));
  assert.equal(snapshot(store).find(row => row.id === 'imported').importedBy, null);
  for (const [id, expected] of [['manual', 'ui'], ['imported', 'import']]) {
    assert.equal(locationCreationSource(snapshot(store).find(row => row.id === id)), expected);
    const deletion = mutation('location-trash', id);
    apply(store, deletion);
    assert.equal(locationCreationSource(snapshot(store).find(row => row.id === id)), expected);
    apply(store, mutation('location-restore', id, { trashOpId: deletion.opId }));
    assert.equal(locationCreationSource(snapshot(store).find(row => row.id === id)), expected);
  }
  const exported = exportLocations(snapshot(store));
  assert.ok(exported.locations.every(row => !Object.hasOwn(row, 'createdVia')));
  importFile(other, exported.locations);
  assert.ok(snapshot(other).every(row => row.createdVia === 'import'));
  assert.ok(previewLocationImport(exported, snapshot(store)).rows.every(row => row.status === 'Unchanged'));
});

test('SQLite backfills original sources from legacy history, publishes metadata without changing timestamps and migrates only once', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'todos-location-source-'));
  const filename = path.join(directory, 'todos.sqlite');
  let store;
  try {
    store = createStore(filename);
    apply(store, mutation('location-create', 'manual', values('Manual original')));
    const operation = importFile(store, [{ id: 'manual', ...values('UI location updated by JSON') }, { id: 'imported', ...values('Imported original') }]);
    apply(store, mutation('location-update', 'imported', { name: 'Imported then edited in UI' }));
    apply(store, mutation('location-trash', 'imported'));
    // Reproduce the old format, including its cleared import marker after a UI edit.
    store.db.exec("UPDATE entities SET data = json_remove(data, '$.createdVia'); UPDATE changes SET data = json_remove(data, '$.createdVia');");
    const before = snapshot(store);
    assert.ok(before.find(row => row.id === 'manual').importedBy);
    assert.equal(before.find(row => row.id === 'imported').importedBy, null);
    const cursor = store.sync({ cursor: 0, mutations: [] }).cursor;
    const receipts = store.db.prepare('SELECT COUNT(*) AS count FROM receipts').get().count;
    store.close();
    store = createStore(filename);
    const recovered = snapshot(store);
    for (const row of before) assert.deepEqual(recovered.find(after => after.id === row.id), { ...row, createdVia: row.id === 'manual' ? 'ui' : 'import' });
    const update = store.sync({ cursor, mutations: [] });
    assert.equal(update.changes.length, 2);
    assert.ok(update.changes.every(change => change.entity.createdVia));
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM receipts').get().count, receipts);
    assert.equal(store.sync({ cursor: update.cursor, mutations: [operation] }).changes.length, 0);
    store.close();
    store = createStore(filename);
    assert.equal(store.sync({ cursor: update.cursor, mutations: [] }).changes.length, 0);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('creation source is internal and cannot be changed through forms or JSON files', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  apply(store, mutation('location-create', 'manual', values('Manual')));
  for (const operation of [mutation('location-create', 'forged', { ...values('Forged'), createdVia: 'import' }),
    mutation('location-update', 'manual', { createdVia: 'import' })]) assert.throws(() => store.sync({ cursor: 0, mutations: [operation] }), /Unknown location field/);
  assert.throws(() => previewLocationImport({ version: 1, locations: [{ id: 'forged', ...values('Forged'), createdVia: 'ui' }] }, []), /Unknown location field/);
  assert.equal(locationCreationSource(snapshot(store).find(row => row.id === 'manual')), 'ui');
});
