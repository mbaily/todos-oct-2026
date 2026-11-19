import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';
import { applyMutation, hashtags, ROOT_VIEW_ID, visibleEntities } from '../src/lib/model.js';
import { hashtagIndex } from '../src/lib/navigation.js';
import { trashRows } from '../src/lib/trash.js';
import { distanceKm, nearbyRows, nearbyPreferences, previewLocationImport, exportLocations, validateLocationFile } from '../src/lib/locations.js';

const timestamp = '2026-10-07T00:00:00.000Z';
const mutation = (action, id, fields) => ({ opId: randomUUID(), action, id, ...(fields === undefined ? {} : { fields }) });
const values = (name, latitude = 0, longitude = 0, userLocation = false) => ({ name, latitude, longitude, userLocation });
const location = (id, name, latitude = 0, longitude = 0, userLocation = false) => ({ id, type: 'location', parentId: null, ...values(name, latitude, longitude, userLocation), tags: hashtags(name), deletedAt: null });
const entity = (id, name, type = 'notebook', extra = {}) => ({ id, type, parentId: null, [type === 'todo' || type === 'note' ? 'text' : 'name']: name, tags: hashtags(name), createdAt: timestamp, modifiedAt: timestamp, deletedAt: null, ...extra });
const settings = (origin, radius = 5) => ({ id: ROOT_VIEW_ID, type: 'view-settings', parentId: null, nearbyLocationId: origin, nearbyRadius: radius });
const snapshot = store => store.db.prepare('SELECT data FROM entities').all().map(row => JSON.parse(row.data));

test('nearby exact OR matching deduplicates branches, uses inclusive distances and excludes completed/trash/hidden entities', () => {
  const origin = location('home', 'Home', 0, 0, true);
  const near = location('near', 'Coles #Supermarket', 0, 0.01);
  const far = location('far', 'Woolworths #woolworths #supermarket', 0, 0.1);
  const boundary = distanceKm(origin, near);
  assert.ok(boundary > 1.11 && boundary < 1.12);
  const data = [origin, near, far, settings('home', 2),
    entity('milk', 'Milk #SUPERMARKET'), entity('specific', 'Specific #woolworths'), entity('prefix', 'Prefix #super'),
    entity('suffix', 'Suffix #supermarket_specials'), entity('both', 'Both #woolworths #supermarket'),
    entity('always', 'Always #errand #woolworths'), entity('completed', 'Done #errand', 'todo', { checked: true }),
    entity('deleted', 'Trash #errand', 'note', { deletedAt: timestamp }), entity('orphan', 'Hidden #errand', 'note', { parentId: 'missing' })];
  const rows = nearbyRows(data);
  assert.deepEqual(new Set(rows.map(row => row.entity.id)), new Set(['milk', 'both', 'always']));
  assert.equal(rows.find(row => row.entity.id === 'both').locations.length, 2);
  assert.equal(rows.find(row => row.entity.id === 'both').nearest.location.id, 'near');
  assert.equal(rows.at(-1).entity.id, 'always');
  assert.equal(rows.at(-1).errandOnly, true);
  data.find(item => item.id === ROOT_VIEW_ID).nearbyRadius = boundary;
  assert.ok(nearbyRows(data).some(row => row.entity.id === 'milk'));
  data.find(item => item.id === ROOT_VIEW_ID).nearbyRadius = boundary - 0.000001;
  assert.deepEqual(nearbyRows(data).map(row => row.entity.id), ['always']);
});

test('no origin shows only #errand under a radius; no filter matches any saved destination and sorts alphabetically', () => {
  const data = [location('store', 'Store #shop'), entity('b', 'B #shop'), entity('a', 'A #errand'), entity('c', 'C #unmatched')];
  assert.deepEqual(nearbyRows(data).map(row => row.entity.id), ['a']);
  assert.equal(nearbyPreferences(data).radius, 5);
  data.push(settings(null, null));
  assert.deepEqual(nearbyRows(data).map(row => row.entity.id), ['a', 'b']);
  data.find(item => item.id === 'store').deletedAt = timestamp;
  assert.deepEqual(nearbyRows(data).map(row => row.entity.id), ['a']);
});

test('nearby matching combines item and immediate list tags, including #errand', () => {
  const origin = location('home', 'Home #home', 0, 0, true);
  const preferences = settings('home', 2);
  const list = entity('list', 'List #home', 'list', { parentId: 'folder' });
  const todo = entity('todo', 'Todo #home', 'todo', { parentId: 'list', checked: false });
  const data = [origin, location('pharmacy', 'Pharmacy #pharmacy', 0, 0.01),
    location('other', 'Other #other', 0, 0.005), preferences, entity('book', 'Book #home'),
    entity('folder', 'Folder #home #other', 'folder', { parentId: 'book' }), list,
    entity('note', 'Note #pharmacy', 'note', { parentId: 'list' }), todo,
    entity('untagged', 'Untagged', 'todo', { parentId: 'list', checked: false })];
  const rows = nearbyRows(data);
  assert.deepEqual(rows.map(row => row.entity.id), ['book', 'folder', 'list', 'note', 'todo', 'untagged']);
  assert.ok(rows.every(row => row.nearest.distance === 0));
  assert.deepEqual(rows.find(row => row.entity.id === 'note').locations.map(match => match.location.id), ['home', 'pharmacy']);
  assert.deepEqual(rows.find(row => row.entity.id === 'todo').locations.map(match => match.location.id), ['home']);

  todo.checked = true;
  assert.deepEqual(nearbyRows(data).map(row => row.entity.id), ['book', 'folder', 'list', 'note', 'untagged']);

  list.checked = true;
  assert.deepEqual(nearbyRows(data).map(row => row.entity.id), ['book', 'folder']);

  list.checked = false;
  list.tags = hashtags('List #home #errand');
  preferences.nearbyLocationId = null;
  assert.deepEqual(nearbyRows(data).map(row => row.entity.id), ['list', 'note', 'untagged']);
  list.tags = hashtags('List #home');
  assert.deepEqual(nearbyRows(data), []);
});

test('Haversine handles identical coordinates, poles, antipodes and the date line', () => {
  const point = (latitude, longitude) => ({ latitude, longitude });
  assert.equal(distanceKm(point(0, 0), point(0, 0)), 0);
  assert.ok(distanceKm(point(0, 179.99), point(0, -179.99)) < 3);
  assert.ok(distanceKm(point(90, 0), point(90, 180)) < 0.000001);
  assert.ok(Math.abs(distanceKm(point(0, 0), point(0, 180)) - 20015.1144) < 0.001);
});

test('locations and preferences survive SQLite reopening; selection clears on toggle/deletion and restore does not select', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'todos-locations-'));
  const filename = path.join(directory, 'todos.sqlite');
  let store;
  try {
    store = createStore(filename);
    const creation = mutation('location-create', 'home', values('Home #home', -37.8, 145, true));
    const result = store.sync({ cursor: 0, mutations: [creation, mutation('nearby-settings', ROOT_VIEW_ID, { nearbyLocationId: 'home', nearbyRadius: 10 })] });
    assert.ok(result.acknowledgements.every(ack => ack.accepted));
    store.close();
    store = createStore(filename);
    assert.equal(nearbyPreferences(snapshot(store)).origin.id, 'home');
    assert.equal(nearbyPreferences(snapshot(store)).radius, 10);
    const revision = store.sync({ cursor: 0, mutations: [] }).cursor;
    assert.equal(store.sync({ cursor: revision, mutations: [creation] }).changes.length, 0);
    store.sync({ cursor: 0, mutations: [mutation('location-update', 'home', { userLocation: false })] });
    assert.equal(snapshot(store).find(item => item.id === ROOT_VIEW_ID).nearbyLocationId, null);
    store.sync({ cursor: 0, mutations: [mutation('location-update', 'home', { userLocation: true }), mutation('nearby-settings', ROOT_VIEW_ID, { nearbyLocationId: 'home' })] });
    const deletion = mutation('location-trash', 'home');
    const deleted = store.sync({ cursor: 0, mutations: [deletion] });
    assert.ok(deleted.acknowledgements[0].accepted);
    assert.equal(nearbyPreferences(snapshot(store)).origin, null);
    assert.equal(store.sync({ cursor: 0, mutations: [mutation('nearby-settings', ROOT_VIEW_ID, { nearbyLocationId: 'home' })] }).acknowledgements[0].accepted, false);
    store.sync({ cursor: 0, mutations: [mutation('location-restore', 'home', { trashOpId: deletion.opId })] });
    assert.equal(snapshot(store).find(item => item.id === 'home').deletedAt, null);
    assert.equal(nearbyPreferences(snapshot(store)).origin, null);
    assert.deepEqual(visibleEntities(snapshot(store)), []);
    assert.deepEqual(hashtagIndex(snapshot(store)), []);
    assert.deepEqual(trashRows(snapshot(store)), []);
    assert.equal(store.sync({ cursor: 0, mutations: [mutation('update', 'home', { name: 'Wrong action' })] }).acknowledgements[0].accepted, false);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('JSON validation rejects malformed formats, duplicate/reserved IDs, invalid coordinates and inconsistent fields', () => {
  const valid = { id: 'shop', ...values('Shop #shop') };
  for (const file of [null, [], { version: 2, locations: [] }, { version: 1, locations: [valid, valid] },
    ...[{ id: ROOT_VIEW_ID }, { id: 'bad id' }, { name: '' }, { latitude: 91 }, { longitude: -181 }, { latitude: '0' }, { longitude: NaN }, { userLocation: 'false' }, { tags: ['other'] }]
      .map(patch => ({ version: 1, locations: [{ ...valid, ...patch }] }))]) assert.throws(() => validateLocationFile(file));
  assert.deepEqual(validateLocationFile({ version: 1, locations: [valid] }), [valid]);
});

test('import previews merge stable IDs atomically, preserve absent records/preferences, and export round trips', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  store.sync({ cursor: 0, mutations: [mutation('location-create', 'home', values('Home', 0, 0, true)), mutation('location-create', 'keep', values('Keep #keep')),
    mutation('nearby-settings', ROOT_VIEW_ID, { nearbyLocationId: 'home', nearbyRadius: 20 })] });
  const file = { version: 1, locations: [{ id: 'home', ...values('Home renamed', 1, 1, true) }, { id: 'shop', ...values('Shop #shop') }] };
  const preview = previewLocationImport(file, snapshot(store));
  assert.deepEqual(preview.rows.map(row => row.status), ['Update', 'Add']);
  const operation = mutation('location-import', ROOT_VIEW_ID, preview.fields);
  assert.equal(store.sync({ cursor: 0, mutations: [operation] }).acknowledgements[0].accepted, true);
  assert.equal(snapshot(store).filter(item => item.type === 'location').length, 3);
  assert.equal(nearbyPreferences(snapshot(store)).origin.id, 'home');
  assert.equal(nearbyPreferences(snapshot(store)).radius, 20);
  assert.ok(previewLocationImport(exportLocations(snapshot(store)), snapshot(store)).rows.every(row => row.status === 'Unchanged'));
  assert.deepEqual(Object.keys(exportLocations(snapshot(store))), ['version', 'locations']);
  assert.ok(exportLocations(snapshot(store)).locations.every(item => !Object.hasOwn(item, 'tags')));
  const beforeRetry = store.sync({ cursor: 0, mutations: [] }).cursor;
  assert.equal(store.sync({ cursor: beforeRetry, mutations: [operation] }).changes.length, 0);
  const togglePreview = previewLocationImport({ version: 1, locations: [{ id: 'home', ...values('Home renamed', 1, 1, false) }] }, snapshot(store));
  store.sync({ cursor: 0, mutations: [mutation('location-import', ROOT_VIEW_ID, togglePreview.fields)] });
  assert.equal(nearbyPreferences(snapshot(store)).origin, null);
});

test('concurrent changes invalidate a whole import, and import cannot resurrect a deleted location or overwrite an entity', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  store.sync({ cursor: 0, mutations: [mutation('location-create', 'shop', values('Shop'))] });
  const file = { version: 1, locations: [{ id: 'new', ...values('New') }, { id: 'shop', ...values('Imported') }] };
  const preview = previewLocationImport(file, snapshot(store));
  store.sync({ cursor: 0, mutations: [mutation('location-update', 'shop', { name: 'Manual edit' })] });
  const response = store.sync({ cursor: 0, mutations: [mutation('location-import', ROOT_VIEW_ID, preview.fields)] });
  assert.equal(response.acknowledgements[0].accepted, false);
  assert.match(response.acknowledgements[0].error, /changed since/);
  assert.ok(!snapshot(store).some(item => item.id === 'new'));
  assert.equal(snapshot(store).find(item => item.id === 'shop').name, 'Manual edit');
  store.sync({ cursor: 0, mutations: [mutation('location-trash', 'shop')] });
  assert.throws(() => previewLocationImport(file, snapshot(store)), /deleted/);
  assert.throws(() => previewLocationImport({ version: 1, locations: [{ id: 'book', ...values('Collision') }] }, [entity('book', 'Book')]), /another item/);
});

test('bulk-import projection survives partial canonical pull and tags update on location edits', () => {
  const map = new Map();
  const preview = previewLocationImport({ version: 1, locations: [{ id: 'one', ...values('One #old') }, { id: 'two', ...values('Two') }] }, []);
  const operation = mutation('location-import', ROOT_VIEW_ID, preview.fields);
  const imported = applyMutation(map, operation, timestamp);
  const partial = new Map([[imported[0].id, imported[0]]]);
  applyMutation(partial, operation, timestamp);
  assert.equal(partial.size, 2);
  applyMutation(partial, mutation('location-update', 'one', { name: 'One #NEW' }), timestamp);
  assert.deepEqual(partial.get('one').tags, ['new']);
});
