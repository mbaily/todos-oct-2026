import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOT_VIEW_ID } from '../src/lib/model.js';
import { incompleteTodoCounts } from '../src/lib/todo-counts.js';
import { trashRows, trashSortOptions } from '../src/lib/trash.js';

const date = day => `2026-01-${String(day).padStart(2, '0')}T12:00:00.000Z`;
function entity(id, extra = {}) {
  return { id, type: 'notebook', parentId: null, name: id, createdAt: date(1), modifiedAt: date(2), deletedAt: date(3), trashedBy: 'trash-op', ...extra };
}

test('trash includes all five deleted types, excludes active items/settings and does not mutate snapshots', () => {
  const snapshot = ['notebook', 'folder', 'list', 'note', 'todo'].map(type => entity(type, { type }));
  snapshot.push(entity('active', { deletedAt: null }), entity(ROOT_VIEW_ID, { type: 'view-settings' }));
  const before = structuredClone(snapshot);
  assert.deepEqual(new Set(trashRows(snapshot).map(row => row.entity.type)), new Set(['notebook', 'folder', 'list', 'note', 'todo']));
  assert.deepEqual(snapshot, before);
  assert.deepEqual(trashRows([]), []);
});

test('trash defaults to latest deletion and supports six deterministic local date orders', () => {
  const snapshot = [entity('a', { deletedAt: date(4), modifiedAt: date(8) }), entity('b', { deletedAt: date(5), createdAt: date(2), modifiedAt: date(6) })];
  const expected = { 'trashed-desc': ['b', 'a'], 'trashed-asc': ['a', 'b'], 'created-desc': ['b', 'a'], 'created-asc': ['a', 'b'], 'modified-desc': ['a', 'b'], 'modified-asc': ['b', 'a'] };
  assert.equal(trashSortOptions.length, 6);
  for (const [mode, ids] of Object.entries(expected)) assert.deepEqual(trashRows(snapshot, mode).map(row => row.entity.id), ids);
  assert.deepEqual(trashRows(snapshot, 'invalid').map(row => row.entity.id), expected['trashed-desc']);
});

test('trash locations follow original parents and restoring children is blocked by the highest deleted ancestor', () => {
  const snapshot = [entity('book'), entity('folder', { type: 'folder', parentId: 'book' }), entity('list', { type: 'list', parentId: 'folder' }), entity('note', { type: 'note', parentId: 'list', trashedBy: 'earlier-deletion' })];
  let rows = trashRows(snapshot);
  assert.equal(rows.find(row => row.entity.id === 'book').reason, '');
  assert.equal(rows.find(row => row.entity.id === 'note').location, 'Notebooks › book › folder › list');
  assert.equal(rows.find(row => row.entity.id === 'note').reason, 'Restore parent first: book');
  for (const parent of snapshot.slice(0, 3)) parent.deletedAt = null;
  rows = trashRows(snapshot);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, '');
});

test('missing parents, cycles and unavailable deletion metadata disable restoration safely', () => {
  const snapshot = [entity('orphan', { parentId: 'missing' }), entity('a', { parentId: 'b' }), entity('b', { parentId: 'a' }), entity('legacy', { trashedBy: undefined }), entity('invalid', { trashedBy: '<invalid>' })];
  const rows = trashRows(snapshot);
  for (const id of ['orphan', 'a', 'b']) assert.equal(rows.find(row => row.entity.id === id).reason, 'The original parent is unavailable.');
  for (const id of ['legacy', 'invalid']) assert.equal(rows.find(row => row.entity.id === id).reason, 'Deletion information is unavailable.');
});

test('trash returns original entity records without discarding favourites, checked state, tags or text', () => {
  const original = entity('todo', { type: 'todo', text: 'Done #kept', favourite: true, checked: true, tags: ['kept'] });
  assert.strictEqual(trashRows([original])[0].entity, original);
});

test('trash metadata retains original breadcrumb IDs/references and raw strings while counts follow restoration', () => {
  const snapshot = [
    entity('book', { name: 'Same <b>&</b>' }),
    entity('folder', { type: 'folder', parentId: 'book', name: 'Same <b>&</b>' }),
    entity('nested', { type: 'folder', parentId: 'folder', name: '<img src=x onerror=alert(1)>' }),
    entity('list', { type: 'list', parentId: 'nested', name: '<script>raw</script>' }),
    entity('todo', { type: 'todo', parentId: 'list', name: undefined, text: 'Incomplete', checked: false }),
    entity('done', { type: 'todo', parentId: 'list', name: undefined, text: 'Completed', checked: true }),
  ];
  const before = structuredClone(snapshot);
  const rows = trashRows(snapshot);
  const row = rows.find(row => row.entity.id === 'todo');
  assert.strictEqual(row.entity, snapshot[4]);
  assert.deepEqual(row.locationEntities.map(item => item.id), ['book', 'folder', 'nested', 'list']);
  for (const [index, parent] of row.locationEntities.entries()) assert.strictEqual(parent, snapshot[index]);
  assert.ok(!row.locationEntities.includes(row.entity));
  assert.strictEqual(row.restoreParent, snapshot[0]);
  assert.equal(row.location, 'Notebooks › Same <b>&</b> › Same <b>&</b> › <img src=x onerror=alert(1)> › <script>raw</script>');
  assert.equal(row.reason, 'Restore parent first: Same <b>&</b>');
  const bookRow = rows.find(row => row.entity.id === 'book');
  assert.deepEqual(bookRow.locationEntities, []);
  assert.equal(bookRow.location, 'Notebooks');
  assert.equal(bookRow.reason, '');
  assert.strictEqual(bookRow.restoreParent, null);
  assert.deepEqual(incompleteTodoCounts(snapshot), new Map());

  const parentsRestored = snapshot.map(item => ['book', 'folder', 'nested', 'list'].includes(item.id)
    ? { ...item, deletedAt: null, trashedBy: null } : item);
  const unblocked = trashRows(parentsRestored).find(row => row.entity.id === 'todo');
  assert.equal(unblocked.location, row.location);
  assert.equal(unblocked.reason, '');
  assert.strictEqual(unblocked.restoreParent, null);
  for (const [index, parent] of unblocked.locationEntities.entries()) assert.strictEqual(parent, parentsRestored[index]);
  assert.deepEqual(incompleteTodoCounts(parentsRestored), new Map([['list', 0]]));

  const allRestored = parentsRestored.map(item => ({ ...item, deletedAt: null, trashedBy: null }));
  const counts = incompleteTodoCounts(allRestored);
  assert.deepEqual(counts, new Map([['list', 1]]));
  assert.equal(counts.get(row.locationEntities.at(-1).id), 1);
  assert.deepEqual(trashRows(allRestored), []);
  assert.deepEqual(snapshot, before);
});

test('trash metadata clears restoreParent on unavailable ancestors or cycles and preserves safe partial breadcrumbs', () => {
  const snapshot = [
    entity('lost-book', { parentId: 'missing', name: 'Lost book' }),
    entity('lost-list', { type: 'list', parentId: 'lost-book', name: 'Lost list' }),
    entity('orphan', { type: 'todo', parentId: 'lost-list', text: 'Orphan' }),
    entity('cycle-a', { type: 'folder', parentId: 'cycle-b' }),
    entity('cycle-b', { type: 'folder', parentId: 'cycle-a' }),
    entity('cycle-child', { type: 'todo', parentId: 'cycle-a', text: 'Cycle child' }),
    entity('self', { type: 'todo', parentId: 'self', text: 'Self cycle' }),
    entity('legacy', { trashedBy: undefined }),
  ];
  const before = structuredClone(snapshot);
  const rows = trashRows(snapshot);
  for (const row of rows) {
    assert.strictEqual(row.restoreParent, null);
    assert.ok(!row.locationEntities.includes(row.entity));
    assert.equal(new Set(row.locationEntities.map(item => item.id)).size, row.locationEntities.length);
    for (const parent of row.locationEntities) assert.strictEqual(parent, snapshot.find(item => item.id === parent.id));
    assert.equal(row.reason, row.entity.id === 'legacy'
      ? 'Deletion information is unavailable.' : 'The original parent is unavailable.');
  }
  const orphan = rows.find(row => row.entity.id === 'orphan');
  assert.deepEqual(orphan.locationEntities.map(item => item.id), ['lost-book', 'lost-list']);
  assert.equal(orphan.location, 'Notebooks › Lost book › Lost list');
  const cycle = rows.find(row => row.entity.id === 'cycle-child');
  assert.deepEqual(cycle.locationEntities.map(item => item.id), ['cycle-b', 'cycle-a']);
  assert.equal(cycle.location, 'Notebooks › cycle-b › cycle-a');
  for (const id of ['self', 'legacy']) {
    const row = rows.find(row => row.entity.id === id);
    assert.deepEqual(row.locationEntities, []);
    assert.equal(row.location, 'Notebooks');
  }
  assert.deepEqual(snapshot, before);
});