import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';
import { applyMutation, ROOT_VIEW_ID, visibleEntities } from '../src/lib/model.js';

const mutation = (action, id, fields) => ({ action, id, opId: randomUUID(), ...(fields === undefined ? {} : { fields }) });
function tree(store) {
  const ids = Object.fromEntries(['notebook', 'folder', 'list', 'note', 'todo'].map(type => [type, randomUUID()]));
  const changes = store.sync({ cursor: 0, mutations: [
    mutation('create', ids.notebook, { type: 'notebook', parentId: null, name: 'Notebook #tag' }),
    mutation('create', ids.folder, { type: 'folder', parentId: ids.notebook, name: 'Folder' }),
    mutation('create', ids.list, { type: 'list', parentId: ids.folder, name: 'List' }),
    mutation('create', ids.note, { type: 'note', parentId: ids.list, text: 'Note #tag' }),
    mutation('create', ids.todo, { type: 'todo', parentId: ids.list, text: 'Todo #tag' }),
  ] });
  assert.ok(changes.acknowledgements.every(ack => ack.accepted));
  return { ids, changes };
}
const snapshot = store => store.db.prepare('SELECT data FROM entities').all().map(row => JSON.parse(row.data));

test('pins work on every entity type, persist in SQLite, retry idempotently, and remain independent of favourites and other fields', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'todos-pins-'));
  const filename = path.join(directory, 'todos.sqlite');
  let store;
  try {
    store = createStore(filename);
    const { ids, changes } = tree(store);
    assert.ok(changes.changes.every(change => change.entity.pinned === false));
    const operations = Object.values(ids).map(id => mutation('update', id, { pinned: true }));
    const response = store.sync({ cursor: changes.cursor, mutations: operations });
    assert.ok(response.acknowledgements.every(ack => ack.accepted));
    assert.ok(response.changes.every(change => change.entity.pinned === true));
    const retry = store.sync({ cursor: response.cursor, mutations: operations });
    assert.equal(retry.changes.length, 0);
    store.sync({ cursor: 0, mutations: [mutation('update', ids.todo, { favourite: true, checked: true, text: 'Renamed #new' }), mutation('update', ids.list, { name: 'Renamed list' })] });
    store.close();
    store = createStore(filename);
    const entities = new Map(snapshot(store).map(entity => [entity.id, entity]));
    assert.ok(Object.values(ids).every(id => entities.get(id).pinned));
    assert.equal(entities.get(ids.todo).favourite, true);
    assert.equal(entities.get(ids.todo).checked, true);
    assert.equal(entities.get(ids.todo).text, 'Renamed #new');
    assert.deepEqual(entities.get(ids.todo).tags, ['new']);
    const unpinned = store.sync({ cursor: 0, mutations: [mutation('update', ids.todo, { pinned: false })] }).changes.at(-1).entity;
    assert.equal(unpinned.pinned, false);
    assert.equal(unpinned.favourite, true);
    assert.equal(unpinned.checked, true);
    assert.equal(unpinned.text, 'Renamed #new');
    assert.equal(unpinned.createdAt, entities.get(ids.todo).createdAt);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('legacy entities without a pin field can be pinned and unpinned without changing their other fields', () => {
  const legacy = { id: 'legacy', type: 'notebook', parentId: null, name: 'Legacy #tag', favourite: true, tags: ['tag'], createdAt: '2026-10-01T00:00:00Z', modifiedAt: '2026-10-01T00:00:00Z', deletedAt: null };
  const entities = new Map([[legacy.id, legacy]]);
  applyMutation(entities, mutation('update', legacy.id, { pinned: true }), '2026-10-07T00:00:00Z');
  assert.deepEqual(entities.get(legacy.id), { ...legacy, pinned: true, modifiedAt: '2026-10-07T00:00:00Z' });
  applyMutation(entities, mutation('update', legacy.id, { pinned: false }), '2026-10-07T00:00:01Z');
  assert.equal(entities.get(legacy.id).pinned, false);
  assert.equal(entities.get(legacy.id).favourite, true);
});

test('pins reject non-booleans, reserved settings, locations, unknown and deleted entities without partial writes', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const { ids } = tree(store);
  const before = snapshot(store);
  for (const value of ['true', 1, null, [], {}]) {
    assert.throws(() => store.sync({ cursor: 0, mutations: [mutation('update', ids.notebook, { name: 'Should not be written' }), mutation('update', ids.todo, { pinned: value })] }), /pinned must be boolean/);
    assert.deepEqual(snapshot(store), before);
  }
  store.sync({ cursor: 0, mutations: [mutation('location-create', 'location', { name: 'Home', latitude: 0, longitude: 0, userLocation: true })] });
  const invalid = store.sync({ cursor: 0, mutations: [ROOT_VIEW_ID, 'location', 'unknown'].map(id => mutation('update', id, { pinned: true })) });
  assert.ok(invalid.acknowledgements.every(ack => !ack.accepted));
  store.sync({ cursor: 0, mutations: [mutation('trash', ids.todo)] });
  assert.equal(store.sync({ cursor: 0, mutations: [mutation('update', ids.todo, { pinned: true })] }).acknowledgements[0].accepted, false);
});

test('trash hides pinned descendants and restore retains all their pins', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const { ids } = tree(store);
  store.sync({ cursor: 0, mutations: Object.values(ids).map(id => mutation('update', id, { pinned: true })) });
  const deletion = mutation('trash', ids.folder);
  store.sync({ cursor: 0, mutations: [deletion] });
  assert.deepEqual(visibleEntities(snapshot(store)).map(entity => entity.id), [ids.notebook]);
  assert.ok(snapshot(store).every(entity => entity.pinned));
  store.sync({ cursor: 0, mutations: [mutation('restore', ids.folder, { trashOpId: deletion.opId })] });
  assert.equal(visibleEntities(snapshot(store)).length, 5);
  assert.ok(visibleEntities(snapshot(store)).every(entity => entity.pinned));
});
