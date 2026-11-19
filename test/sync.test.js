import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';
import { ROOT_VIEW_ID, sortOptions, dateDisplayOptions } from '../src/lib/model.js';

function create(type, parentId, value, id = randomUUID()) {
  return { action: 'create', opId: randomUUID(), id, fields: { type, parentId, [['note', 'todo'].includes(type) ? 'text' : 'name']: value } };
}

function mutation(action, id, fields) {
  return { action, id, opId: randomUUID(), ...(fields ? { fields } : {}) };
}

function tree(store) {
  const notebook = create('notebook', null, 'Notebook #Work');
  const folder = create('folder', notebook.id, 'Folder');
  const nested = create('folder', folder.id, 'Nested');
  const list = create('list', nested.id, 'List');
  const todo = create('todo', list.id, 'Do this #WORK #work #日本語');
  const note = create('note', list.id, 'Some notes');
  const response = store.sync({ cursor: 0, mutations: [notebook, folder, nested, list, todo, note] });
  assert.ok(response.acknowledgements.every(ack => ack.accepted));
  return { notebook, folder, nested, list, todo, note, response };
}

test('hierarchy, hashtags and server-owned timestamps; invalid contents are rejected', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const { folder, todo, response } = tree(store);
  const entity = response.changes.find(change => change.entity.id === todo.id).entity;
  assert.deepEqual(entity.tags, ['work', '日本語']);
  assert.equal(entity.checked, false);
  assert.equal(entity.createdAt, entity.modifiedAt);
  assert.ok(!Number.isNaN(Date.parse(entity.createdAt)));
  const result = store.sync({ cursor: response.cursor, mutations: [create('todo', folder.id, 'Invalid')] });
  assert.equal(result.acknowledgements[0].accepted, false);
  assert.equal(result.changes.length, 0);
});

test('retry after a lost response is idempotent; later accepted field patches win', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const item = create('notebook', null, 'First');
  const initial = store.sync({ cursor: 0, mutations: [item] });
  const retry = store.sync({ cursor: 0, mutations: [item] });
  assert.deepEqual(retry, initial);
  const firstEdit = mutation('update', item.id, { name: 'Device A' });
  store.sync({ cursor: initial.cursor, mutations: [firstEdit] });
  const secondEdit = mutation('update', item.id, { name: 'Device B' });
  const response = store.sync({ cursor: initial.cursor, mutations: [secondEdit] });
  assert.equal(response.changes.at(-1).entity.name, 'Device B');
  store.sync({ cursor: response.cursor, mutations: [firstEdit] });
  assert.equal(JSON.parse(store.db.prepare('SELECT data FROM entities').get().data).name, 'Device B');
  assert.throws(() => store.sync({ cursor: 0, mutations: [{ ...firstEdit, fields: { name: 'Reused ID' } }] }), /cannot be reused/);
});

test('HTTP retries ignore object key order and still apply other edits in the batch', async t => {
  const store = createStore(':memory:');
  const server = createApp(store).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/sync`;
  const sync = (cursor, mutations) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor, mutations }),
  });
  const locations = ['north', 'south'].map(id => ({
    id, name: id, latitude: 0, longitude: 0, userLocation: false,
  }));
  const operation = mutation('location-import', ROOT_VIEW_ID, { locations, expected: [null, null] });
  const first = await sync(0, [operation]);
  assert.equal(first.status, 200);
  const initial = await first.json();
  assert.equal(initial.acknowledgements[0].accepted, true);

  const retry = {
    fields: {
      expected: operation.fields.expected,
      locations: locations.map(location => Object.fromEntries(Object.entries(location).reverse())),
    },
    id: operation.id, action: operation.action, opId: operation.opId,
  };
  const later = mutation('location-update', 'north', { name: 'Renamed' });
  const response = await sync(initial.cursor, [retry, later]);
  assert.equal(response.status, 200);
  const repeated = await response.json();
  assert.deepEqual(repeated.acknowledgements[0], initial.acknowledgements[0]);
  assert.equal(repeated.acknowledgements[1].accepted, true);
  assert.deepEqual(repeated.changes.map(change => change.entity.name), ['Renamed']);

  const changed = { ...retry, fields: { ...retry.fields, locations: retry.fields.locations.toReversed() } };
  const conflict = await sync(repeated.cursor, [changed]);
  assert.equal(conflict.status, 400);
  assert.match((await conflict.json()).error, /cannot be reused/);
});

test('text and checkbox field patches do not overwrite each other', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const { todo, response } = tree(store);
  store.sync({ cursor: response.cursor, mutations: [mutation('update', todo.id, { checked: true })] });
  const result = store.sync({ cursor: response.cursor, mutations: [mutation('update', todo.id, { text: 'Changed' })] });
  assert.equal(result.changes.at(-1).entity.checked, true);
  assert.equal(result.changes.at(-1).entity.text, 'Changed');
});

test('trash retains the entire subtree and rejects stale edits and new children', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const { notebook, folder, todo, response } = tree(store);
  const deletion = mutation('trash', notebook.id);
  const result = store.sync({ cursor: response.cursor, mutations: [deletion] });
  assert.equal(result.changes.length, 6);
  assert.ok(result.changes.every(change => change.entity.deletedAt));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM entities').get().n, 6);
  const stale = store.sync({ cursor: response.cursor, mutations: [mutation('update', todo.id, { text: 'Stale edit' }), create('folder', folder.id, 'Stale child')] });
  assert.ok(stale.acknowledgements.every(ack => !ack.accepted));
  assert.equal(store.sync({ cursor: result.cursor, mutations: [deletion] }).changes.length, 0);
});

test('pull paginates changes without skipping revisions', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  for (let batch = 0; batch < 6; batch++) {
    store.sync({ cursor: 0, mutations: Array.from({ length: 100 }, (_, i) => create('notebook', null, `Book ${batch}-${i}`)) });
  }
  const first = store.sync({ cursor: 0, mutations: [] });
  assert.equal(first.changes.length, 500);
  assert.equal(first.hasMore, true);
  const second = store.sync({ cursor: first.cursor, mutations: [] });
  assert.equal(second.changes.length, 100);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.changes, ...second.changes].map(change => change.revision)).size, 600);
});

test('pull limits change pages by UTF-8 size and makes progress through a single oversized record', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const { list, response } = tree(store);
  const notes = Array.from({ length: 8 }, () => create('note', list.id, '界'.repeat(30000)));
  const large = create('note', list.id, '\u0001'.repeat(100000));
  const last = create('note', list.id, 'Small note after a large record');
  store.sync({ cursor: response.cursor, mutations: [...notes, large, last] });

  let page = store.sync({ cursor: 0, checkpoint: null, mutations: [] });
  const seen = [];
  const byteLimit = 512 * 1024;
  do {
    const size = Buffer.byteLength(JSON.stringify(page.changes));
    if (page.changes.some(change => change.entity.id === large.id)) {
      assert.equal(page.changes.length, 1);
      assert(size > byteLimit);
    } else {
      assert(size <= byteLimit);
    }
    seen.push(...page.changes.map(change => change.entity.id));
    if (!page.hasMore) break;
    const next = store.sync({ cursor: page.cursor, checkpoint: page.checkpoint, mutations: [] });
    assert(next.cursor > page.cursor);
    page = next;
  } while (true);
  assert.deepEqual(seen, [...response.changes.map(change => change.entity.id), ...notes.map(note => note.id), large.id, last.id]);
});

test('SQLite data and retry receipts survive reopening the server', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'todos-store-'));
  const filename = path.join(directory, 'todos.sqlite');
  let store;
  try {
    store = createStore(filename);
    const item = create('notebook', null, 'Persisted');
    const original = store.sync({ cursor: 0, mutations: [item] });
    store.close();
    store = createStore(filename);
    assert.deepEqual(store.sync({ cursor: 0, mutations: [item] }), original);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP sync validates requests, restricts cross-origin writes and serves the app', async t => {
  const store = createStore(':memory:');
  const server = createApp(store).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${url}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cursor: 0, mutations: [create('notebook', null, 'HTTP')] }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).changes.length, 1);
  const invalid = await fetch(`${url}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cursor: -1, mutations: [] }) });
  assert.equal(invalid.status, 409);
  const crossOrigin = await fetch(`${url}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' }, body: '{}' });
  assert.equal(crossOrigin.status, 403);
  assert.match(await (await fetch(url)).text(), /id="app"/);
});

test('sort preferences persist in SQLite, sync independently and reject invalid targets and modes', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'todos-sort-'));
  const filename = path.join(directory, 'todos.sqlite');
  let store;
  try {
    store = createStore(filename);
    const { notebook, folder, list, todo } = tree(store);
    const before = JSON.parse(store.db.prepare('SELECT data FROM entities WHERE id = ?').get(folder.id).data);
    for (const [id, mode] of [[ROOT_VIEW_ID, 'created-asc'], [notebook.id, 'modified-asc'], [folder.id, 'modified-desc'], [list.id, 'created-asc']]) {
      const result = store.sync({ cursor: 0, mutations: [mutation('sort', id, { sortOrder: mode })] });
      assert.equal(result.acknowledgements[0].accepted, true);
      assert.equal(result.changes.at(-1).entity.sortOrder, mode);
    }
    const sorted = JSON.parse(store.db.prepare('SELECT data FROM entities WHERE id = ?').get(folder.id).data);
    assert.equal(sorted.modifiedAt, before.modifiedAt);
    assert.equal(sorted.createdAt, before.createdAt);
    store.sync({ cursor: 0, mutations: [mutation('update', folder.id, { name: 'Renamed' })] });
    const rejected = store.sync({ cursor: 0, mutations: [mutation('sort', todo.id, { sortOrder: 'created-asc' }), mutation('sort', randomUUID(), { sortOrder: 'created-asc' })] });
    assert.ok(rejected.acknowledgements.every(ack => !ack.accepted));
    assert.throws(() => store.sync({ cursor: 0, mutations: [mutation('sort', list.id, { sortOrder: 'invalid' })] }), /Invalid sort order/);
    store.close();
    store = createStore(filename);
    const pulled = new Map(store.sync({ cursor: 0, mutations: [] }).changes.map(change => [change.entity.id, change.entity]));
    assert.equal(pulled.get(ROOT_VIEW_ID).sortOrder, 'created-asc');
    assert.equal(pulled.get(notebook.id).sortOrder, 'modified-asc');
    assert.equal(pulled.get(folder.id).sortOrder, 'modified-desc');
    assert.equal(pulled.get(folder.id).name, 'Renamed');
    assert.equal(pulled.get(list.id).sortOrder, 'created-asc');
    for (const option of sortOptions) {
      assert.equal(store.sync({ cursor: 0, mutations: [mutation('sort', list.id, { sortOrder: option.value })] }).acknowledgements[0].accepted, true);
    }
    store.sync({ cursor: 0, mutations: [mutation('trash', list.id)] });
    assert.equal(store.sync({ cursor: 0, mutations: [mutation('sort', list.id, { sortOrder: 'created-desc' })] }).acknowledgements[0].accepted, false);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('favourites work for every entity type, preserve other fields and survive SQLite reopening', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'todos-favourites-'));
  const filename = path.join(directory, 'todos.sqlite');
  let store;
  try {
    store = createStore(filename);
    const { response, notebook, todo } = tree(store);
    const ids = response.changes.map(change => change.entity.id);
    assert.ok(response.changes.every(change => change.entity.favourite === false));
    const favourited = store.sync({ cursor: response.cursor, mutations: ids.map(id => mutation('update', id, { favourite: true })) });
    assert.ok(favourited.acknowledgements.every(ack => ack.accepted));
    assert.ok(favourited.changes.every(change => change.entity.favourite === true));
    store.sync({ cursor: 0, mutations: [mutation('update', todo.id, { text: 'Edited after starring', checked: true })] });
    store.close();
    store = createStore(filename);
    const pulled = new Map(store.sync({ cursor: 0, mutations: [] }).changes.map(change => [change.entity.id, change.entity]));
    assert.ok(ids.every(id => pulled.get(id).favourite === true));
    assert.equal(pulled.get(todo.id).text, 'Edited after starring');
    assert.equal(pulled.get(todo.id).checked, true);
    const removed = store.sync({ cursor: 0, mutations: [mutation('update', todo.id, { favourite: false })] });
    assert.equal(removed.changes.at(-1).entity.favourite, false);
    assert.equal(removed.changes.at(-1).entity.checked, true);
    assert.throws(() => store.sync({ cursor: 0, mutations: [mutation('update', todo.id, { favourite: 'yes' })] }), /must be boolean/);
    store.sync({ cursor: 0, mutations: [mutation('trash', notebook.id)] });
    assert.equal(store.sync({ cursor: 0, mutations: [mutation('update', todo.id, { favourite: true })] }).acknowledgements[0].accepted, false);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('undo deletion restores exactly its subtree, keeps earlier trash and retries idempotently', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const { notebook, list, todo, note } = tree(store);
  store.sync({ cursor: 0, mutations: [mutation('update', todo.id, { checked: true, favourite: true })] });
  store.sync({ cursor: 0, mutations: [mutation('trash', note.id)] });
  const deletion = mutation('trash', notebook.id);
  store.sync({ cursor: 0, mutations: [deletion] });
  const wrong = store.sync({ cursor: 0, mutations: [mutation('restore', notebook.id, { trashOpId: randomUUID() })] });
  assert.equal(wrong.acknowledgements[0].accepted, false);
  const restore = mutation('restore', notebook.id, { trashOpId: deletion.opId });
  const result = store.sync({ cursor: 0, mutations: [restore] });
  assert.equal(result.acknowledgements[0].accepted, true);
  assert.deepEqual(store.sync({ cursor: 0, mutations: [restore] }), result);
  const latest = new Map(result.changes.map(change => [change.entity.id, change.entity]));
  assert.equal(latest.get(list.id).deletedAt, null);
  assert.equal(latest.get(todo.id).checked, true);
  assert.equal(latest.get(todo.id).favourite, true);
  assert.ok(latest.get(note.id).deletedAt);
  assert.equal(latest.get(todo.id).createdAt, result.changes.find(change => change.entity.id === todo.id).entity.createdAt);
  const childDelete = mutation('trash', list.id);
  store.sync({ cursor: 0, mutations: [childDelete, mutation('trash', notebook.id)] });
  assert.equal(store.sync({ cursor: 0, mutations: [mutation('restore', list.id, { trashOpId: childDelete.opId })] }).acknowledgements[0].accepted, false);
});

test('every date mode survives SQLite reopening for root, notebooks, folders and lists with durable retry receipts', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'todos-dates-'));
  const filename = path.join(directory, 'todos.sqlite');
  let store;
  try {
    store = createStore(filename);
    const { notebook, folder, list, todo, note, response } = tree(store);
    const targets = [ROOT_VIEW_ID, notebook.id, folder.id, list.id];
    const read = id => JSON.parse(store.db.prepare('SELECT data FROM entities WHERE id = ?').get(id).data);
    const counts = () => ({
      changes: store.db.prepare('SELECT COUNT(*) AS n FROM changes').get().n,
      receipts: store.db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n,
    });
    let cursor = response.cursor;
    const send = operation => {
      const result = store.sync({ cursor, mutations: [operation] });
      cursor = result.cursor;
      assert.equal(result.acknowledgements[0].accepted, true);
      return result;
    };
    assert.ok(response.changes.every(change => change.entity.dateDisplay === undefined));
    store.close();
    store = undefined;
    store = createStore(filename);
    assert.deepEqual(store.sync({ cursor: 0, mutations: [] }).changes, response.changes);
    for (const entity of response.changes.map(change => change.entity)) assert.deepEqual(read(entity.id), entity);
    const rootDate = send(mutation('date-display', ROOT_VIEW_ID, { dateDisplay: 'created-time' }));
    assert.deepEqual(rootDate.changes[0].entity, {
      id: ROOT_VIEW_ID, type: 'view-settings', parentId: null, dateDisplay: 'created-time',
    });
    assert.deepEqual(read(ROOT_VIEW_ID), rootDate.changes[0].entity);
    for (const [id, sortOrder] of [[ROOT_VIEW_ID, 'created-asc'], [notebook.id, 'modified-asc'], [folder.id, 'modified-desc'], [list.id, 'created-asc']]) {
      const before = read(id);
      const result = send(mutation('sort', id, { sortOrder }));
      assert.deepEqual(result.changes[0].entity, { ...before, sortOrder });
    }
    for (const id of [notebook.id, folder.id, list.id]) send(mutation('update', id, { name: 'Before date choice #kept', favourite: true }));
    const leaves = new Map([todo.id, note.id].map(id => [id, read(id)]));
    for (const option of dateDisplayOptions) {
      const expected = new Map();
      const retries = [];
      for (const id of targets) {
        const before = read(id);
        const oldCursor = cursor;
        const operation = mutation('date-display', id, { dateDisplay: option.value });
        const result = send(operation);
        assert.equal(result.changes.length, 1);
        assert.equal(result.cursor, oldCursor + 1);
        assert.deepEqual(result.acknowledgements, [{ opId: operation.opId, accepted: true, revision: result.cursor }]);
        expected.set(id, { ...before, dateDisplay: option.value });
        assert.deepEqual(result.changes[0].entity, expected.get(id));
        assert.deepEqual(read(id), expected.get(id));
        assert.equal(read(id).dateDisplay, option.value);
        const written = counts();
        assert.deepEqual(store.sync({ cursor: oldCursor, mutations: [operation] }), result);
        assert.deepEqual(counts(), written);
        retries.push([operation, result.acknowledgements[0]]);
      }
      store.close();
      store = undefined;
      store = createStore(filename);
      const pulled = new Map(store.sync({ cursor: 0, mutations: [] }).changes.map(change => [change.entity.id, change.entity]));
      for (const id of targets) {
        assert.deepEqual(read(id), expected.get(id));
        assert.deepEqual(pulled.get(id), expected.get(id));
      }
      for (const [id, entity] of leaves) {
        assert.deepEqual(read(id), entity);
        assert.deepEqual(pulled.get(id), entity);
      }
      const written = counts();
      for (const [operation, acknowledgement] of retries) {
        assert.deepEqual(store.sync({ cursor, mutations: [operation] }), {
          acknowledgements: [acknowledgement], changes: [], cursor, hasMore: false,
        });
        assert.deepEqual(counts(), written);
      }
      const root = read(ROOT_VIEW_ID);
      assert.deepEqual(root, {
        id: ROOT_VIEW_ID, type: 'view-settings', parentId: null, dateDisplay: option.value, sortOrder: 'created-asc',
      });
      const row = store.db.prepare('SELECT parent_id, type FROM entities WHERE id = ?').get(ROOT_VIEW_ID);
      assert.equal(row.parent_id, null);
      assert.equal(row.type, 'view-settings');
    }
    for (const id of targets) {
      const before = read(id);
      const result = send(mutation('sort', id, { sortOrder: 'created-desc' }));
      assert.deepEqual(result.changes[0].entity, { ...before, sortOrder: 'created-desc' });
      assert.deepEqual(read(id), result.changes[0].entity);
    }
    for (const id of [notebook.id, folder.id, list.id]) {
      const before = read(id);
      const result = send(mutation('update', id, { name: 'Renamed after date choice #later', favourite: false }));
      const entity = result.changes[0].entity;
      assert.deepEqual(entity, {
        ...before, name: 'Renamed after date choice #later', favourite: false, tags: ['later'], modifiedAt: entity.modifiedAt,
      });
      assert.ok(!Number.isNaN(Date.parse(entity.modifiedAt)));
      assert.deepEqual(read(id), entity);
      const preference = send(mutation('date-display', id, { dateDisplay: 'created-time' }));
      assert.deepEqual(preference.changes[0].entity, { ...entity, dateDisplay: 'created-time' });
    }
    const final = new Map(targets.map(id => [id, read(id)]));
    store.close();
    store = undefined;
    store = createStore(filename);
    for (const [id, entity] of final) assert.deepEqual(read(id), entity);
    assert.deepEqual(store.sync({ cursor, mutations: [] }), { acknowledgements: [], changes: [], cursor, hasMore: false });
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid date fields, types and modes reject the whole server batch without data, revisions or receipts', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const { notebook, list } = tree(store);
  const initial = store.sync({ cursor: 0, mutations: [
    mutation('sort', ROOT_VIEW_ID, { sortOrder: 'modified-desc' }),
    mutation('date-display', ROOT_VIEW_ID, { dateDisplay: 'created-time' }),
    mutation('sort', list.id, { sortOrder: 'modified-asc' }),
    mutation('date-display', list.id, { dateDisplay: 'modified-date' }),
  ] });
  const snapshot = () => ({
    entities: store.db.prepare('SELECT * FROM entities ORDER BY id').all(),
    changes: store.db.prepare('SELECT * FROM changes ORDER BY revision').all(),
    receipts: store.db.prepare('SELECT * FROM receipts ORDER BY op_id').all(),
  });
  const before = snapshot();
  const invalidFields = [undefined, null, [], 'created-date', true, 42, {}, { sortOrder: 'created-asc' },
    ...[undefined, null, '', 'invalid', 'CREATED-DATE', 'created-desc', 0, false, {}, []].map(dateDisplay => ({ dateDisplay })),
    ...['name', 'sortOrder', 'createdAt', 'modifiedAt'].map(field => ({ dateDisplay: 'created-date', [field]: 'forbidden' })),
  ];
  for (const id of [ROOT_VIEW_ID, notebook.id]) {
    for (const fields of invalidFields) {
      const invalid = { action: 'date-display', id, opId: randomUUID(), fields };
      assert.throws(() => store.sync({ cursor: initial.cursor, mutations: [
        mutation('date-display', ROOT_VIEW_ID, { dateDisplay: 'none' }), invalid,
      ] }), /Invalid fields|Invalid date display mode/);
      assert.deepEqual(snapshot(), before);
    }
  }
  const bypasses = [
    mutation('update', notebook.id, { dateDisplay: 'created-date' }),
    mutation('sort', notebook.id, { sortOrder: 'created-asc', dateDisplay: 'created-date' }),
    { ...create('notebook', null, 'Cannot set preferences on create'), fields: { type: 'notebook', parentId: null, name: 'Cannot set preferences on create', dateDisplay: 'created-date' } },
  ];
  for (const invalid of bypasses) {
    assert.throws(() => store.sync({ cursor: initial.cursor, mutations: [
      mutation('date-display', list.id, { dateDisplay: 'none' }), invalid,
    ] }), /Unknown field|Invalid sort order/);
    assert.deepEqual(snapshot(), before);
  }
});

test('date preferences reject live leaves, unknown and deleted targets without revisions, and root stays settings-only', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const { notebook, folder, nested, list, todo, note } = tree(store);
  let cursor = store.sync({ cursor: 0, mutations: [
    mutation('date-display', ROOT_VIEW_ID, { dateDisplay: 'created-time' }),
    ...[notebook.id, folder.id, nested.id, list.id].map(id => mutation('date-display', id, { dateDisplay: 'modified-time' })),
  ] }).cursor;
  const reject = (operation, error) => {
    const rows = store.db.prepare('SELECT * FROM entities ORDER BY id').all();
    const revisions = store.db.prepare('SELECT * FROM changes ORDER BY revision').all();
    const receipts = store.db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n;
    const result = store.sync({ cursor, mutations: [operation] });
    assert.equal(result.acknowledgements[0].accepted, false);
    assert.match(result.acknowledgements[0].error, error);
    assert.deepEqual(result.changes, []);
    assert.equal(result.cursor, cursor);
    assert.equal(result.hasMore, false);
    assert.deepEqual(store.db.prepare('SELECT * FROM entities ORDER BY id').all(), rows);
    assert.deepEqual(store.db.prepare('SELECT * FROM changes ORDER BY revision').all(), revisions);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n, receipts + 1);
    assert.deepEqual(store.sync({ cursor, mutations: [operation] }), result);
    assert.deepEqual(store.db.prepare('SELECT * FROM changes ORDER BY revision').all(), revisions);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n, receipts + 1);
  };
  for (const id of [todo.id, note.id, randomUUID()]) reject(mutation('date-display', id, { dateDisplay: 'created-date' }), /Only existing/);
  for (const operation of [mutation('update', ROOT_VIEW_ID, { name: 'Not content' }), mutation('trash', ROOT_VIEW_ID), create('notebook', null, 'Not a notebook', ROOT_VIEW_ID)]) {
    reject(operation, /Reserved settings ID/);
  }
  cursor = store.sync({ cursor, mutations: [mutation('trash', notebook.id)] }).cursor;
  for (const id of [notebook.id, folder.id, nested.id, list.id, todo.id, note.id]) {
    assert.ok(JSON.parse(store.db.prepare('SELECT data FROM entities WHERE id = ?').get(id).data).deletedAt);
    reject(mutation('date-display', id, { dateDisplay: 'none' }), /Only existing/);
  }
  assert.deepEqual(JSON.parse(store.db.prepare('SELECT data FROM entities WHERE id = ?').get(ROOT_VIEW_ID).data), {
    id: ROOT_VIEW_ID, type: 'view-settings', parentId: null, dateDisplay: 'created-time',
  });
});

test('list completion checkboxes persist in SQLite, backfill legacy rows and survive reopening', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'todos-list-checked-'));
  const filename = path.join(directory, 'todos.sqlite');
  let store;
  try {
    store = createStore(filename);
    const { list, folder, note, response } = tree(store);
    const listEntity = response.changes.find(c => c.entity.id === list.id).entity;
    assert.equal(listEntity.checked, false);

    // Update list to completed
    const complete = store.sync({ cursor: response.cursor, mutations: [mutation('update', list.id, { checked: true })] });
    assert.equal(complete.acknowledgements[0].accepted, true);
    assert.equal(complete.changes.at(-1).entity.checked, true);

    // Update list back to uncompleted
    const uncomplete = store.sync({ cursor: complete.cursor, mutations: [mutation('update', list.id, { checked: false })] });
    assert.equal(uncomplete.acknowledgements[0].accepted, true);
    assert.equal(uncomplete.changes.at(-1).entity.checked, false);

    // Can create list with checked: true directly
    const checkedList = create('list', folder.id, 'Already done');
    checkedList.fields.checked = true;
    const created = store.sync({ cursor: uncomplete.cursor, mutations: [checkedList] });
    assert.equal(created.acknowledgements[0].accepted, true);
    assert.equal(created.changes.at(-1).entity.checked, true);

    // Rejects non-boolean checked
    assert.throws(() => store.sync({ cursor: created.cursor, mutations: [mutation('update', list.id, { checked: 'true' })] }), /must be boolean/);

    // Folder and note reject checked field
    const invalidFolder = store.sync({ cursor: created.cursor, mutations: [mutation('update', folder.id, { checked: true })] });
    assert.equal(invalidFolder.acknowledgements[0].accepted, false);
    const invalidNote = store.sync({ cursor: created.cursor, mutations: [mutation('update', note.id, { checked: true })] });
    assert.equal(invalidNote.acknowledgements[0].accepted, false);

    // Insert legacy list entity directly without checked to test backfill
    const legacyId = randomUUID();
    const legacyData = JSON.stringify({
      id: legacyId, type: 'list', parentId: folder.id, name: 'Legacy list',
      tags: [], createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString(), deletedAt: null,
    });
    store.db.prepare('INSERT INTO entities (id, parent_id, type, data) VALUES (?, ?, ?, ?)').run(legacyId, folder.id, 'list', legacyData);
    store.close();
    store = undefined;

    // Reopen store; backfill should populate checked: false
    store = createStore(filename);
    const backfilledData = JSON.parse(store.db.prepare('SELECT data FROM entities WHERE id = ?').get(legacyId).data);
    assert.equal(backfilledData.checked, false);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
