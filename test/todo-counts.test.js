import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, ROOT_VIEW_ID } from '../src/lib/model.js';
import { circledTodoCount, incompleteTodoCounts } from '../src/lib/todo-counts.js';

const date = day => `2026-01-${String(day).padStart(2, '0')}T12:00:00.000Z`;
function entity(id, type, parentId, extra = {}) {
  const named = ['notebook', 'folder', 'list'].includes(type);
  return {
    id, type, parentId,
    ...(named ? { name: id } : { text: id }),
    ...(type === 'todo' ? { checked: false } : {}),
    favourite: false, tags: [], createdAt: date(1), modifiedAt: date(2), deletedAt: null,
    ...extra,
  };
}

function tree() {
  return [
    entity('book', 'notebook', null),
    entity('folder', 'folder', 'book'),
    entity('list', 'list', 'folder'),
    entity('todo', 'todo', 'list'),
    entity('completed', 'todo', 'list', { checked: true }),
    entity('note', 'note', 'list'),
    entity('other-book', 'notebook', null),
    entity('other-folder', 'folder', 'other-book'),
    entity('other-list', 'list', 'other-folder'),
    entity('other-todo', 'todo', 'other-list'),
  ];
}

function freezeSnapshot(snapshot) {
  for (const item of snapshot) {
    Object.freeze(item.tags);
    Object.freeze(item);
  }
  return Object.freeze(snapshot);
}

function nextSnapshot(snapshot, action, id, fields, opId = `${action}-${id}`) {
  const entities = new Map(snapshot.map(item => [item.id, item]));
  applyMutation(entities, { action, id, opId, ...(fields ? { fields } : {}) }, date(4));
  return freezeSnapshot([...entities.values()]);
}

const glyphs = [
  '⓪', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩',
  '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳',
];
for (const [count, glyph] of glyphs.entries()) {
  test(`circledTodoCount uses the exact single glyph for ${count}`, () => {
    assert.equal(circledTodoCount(count), glyph);
  });
}

test('circledTodoCount defaults to circled zero, including undefined and negative zero', () => {
  assert.equal(circledTodoCount(), '⓪');
  assert.equal(circledTodoCount(undefined), '⓪');
  assert.equal(circledTodoCount(-0), '⓪');
});

test('circledTodoCount formats values above twenty as exact circled digit sequences', () => {
  const expected = [
    [21, '②①'], [22, '②②'], [30, '③⓪'], [99, '⑨⑨'],
    [100, '①⓪⓪'], [101, '①⓪①'], [120, '①②⓪'], [2026, '②⓪②⑥'],
    [1000000, '①⓪⓪⓪⓪⓪⓪'],
    [Number.MAX_SAFE_INTEGER, '⑨⓪⓪⑦①⑨⑨②⑤④⑦④⓪⑨⑨①'],
  ];
  for (const [count, glyph] of expected) assert.equal(circledTodoCount(count), glyph, String(count));
});

test('circledTodoCount rejects negative, fractional, unsafe and non-number inputs without coercion', () => {
  const invalid = [
    -1, -20, -Number.MAX_SAFE_INTEGER, -0.5, 0.5, 1.5, 20.1,
    NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2, 1e100,
    null, true, false, '', '0', '21', [], [21], {}, new Number(21), 21n, Symbol('count'),
    { valueOf() { throw new Error('Counts must not coerce objects.'); } },
  ];
  for (const value of invalid) assert.equal(circledTodoCount(value), '⓪');
});

test('incompleteTodoCounts returns an empty Map for empty and list-free snapshots', () => {
  const empty = incompleteTodoCounts([]);
  assert.ok(empty instanceof Map);
  assert.equal(empty.size, 0);
  assert.deepEqual(incompleteTodoCounts([
    entity('book', 'notebook', null),
    entity('folder', 'folder', 'book'),
    entity(ROOT_VIEW_ID, 'view-settings', null),
  ]), new Map());
});

test('incompleteTodoCounts initializes every visible list to zero and ignores notes and completed todos', () => {
  const snapshot = [
    entity('book', 'notebook', null),
    entity('folder', 'folder', 'book'),
    entity('empty', 'list', 'folder'),
    entity('notes-only', 'list', 'folder'),
    entity('completed-only', 'list', 'folder'),
    entity('note', 'note', 'notes-only', { checked: false, text: 'An unchecked note is not a todo.' }),
    entity('done', 'todo', 'completed-only', { checked: true }),
    entity('deleted-list', 'list', 'folder', { deletedAt: date(3) }),
  ];
  assert.deepEqual(incompleteTodoCounts(snapshot), new Map([
    ['empty', 0], ['notes-only', 0], ['completed-only', 0],
  ]));
});

test('incompleteTodoCounts keeps duplicate list names separate and counts only direct todo children', () => {
  const snapshot = [
    entity('book', 'notebook', null),
    entity('folder', 'folder', 'book'),
    entity('nested', 'folder', 'folder'),
    entity('list-a', 'list', 'folder', { name: 'Same name' }),
    entity('list-b', 'list', 'folder', { name: 'Same name' }),
    entity('list-c', 'list', 'nested', { name: 'Same name' }),
    entity('list-empty', 'list', 'nested', { name: 'Same name' }),
    entity('a1', 'todo', 'list-a'),
    entity('a2', 'todo', 'list-a'),
    entity('a-done', 'todo', 'list-a', { checked: true }),
    entity('a-note', 'note', 'list-a', { checked: false }),
    entity('b1', 'todo', 'list-b'),
    entity('c1', 'todo', 'list-c'),
    entity('c2', 'todo', 'list-c'),
    entity('c3', 'todo', 'list-c'),
    entity('grandchild', 'todo', 'a1'),
    entity('note-child', 'todo', 'a-note'),
  ];
  const expected = new Map([['list-a', 2], ['list-b', 1], ['list-c', 3], ['list-empty', 0]]);
  assert.deepEqual(incompleteTodoCounts(snapshot), expected);
  assert.deepEqual(incompleteTodoCounts([...snapshot].reverse()), expected);
});

test('incompleteTodoCounts ignores todos with root, notebook, folder, note, todo, settings or unknown parents', () => {
  const snapshot = tree();
  snapshot.push(
    entity('root', 'root', null),
    entity(ROOT_VIEW_ID, 'view-settings', null),
    entity('unknown', 'unknown-type', null),
  );
  for (const parentId of [null, 'root', 'book', 'folder', 'note', 'todo', ROOT_VIEW_ID, 'unknown']) {
    snapshot.push(entity(`invalid-${parentId ?? 'null'}`, 'todo', parentId));
  }
  assert.deepEqual(incompleteTodoCounts(snapshot), new Map([['list', 1], ['other-list', 1]]));
});

test('incompleteTodoCounts excludes the reserved settings ID even if its record claims to be a list', () => {
  const snapshot = tree();
  snapshot.push(
    entity(ROOT_VIEW_ID, 'list', 'folder'),
    entity('settings-todo', 'todo', ROOT_VIEW_ID),
  );
  assert.deepEqual(incompleteTodoCounts(snapshot), new Map([['list', 1], ['other-list', 1]]));
});

for (const id of ['todo', 'list', 'folder', 'book']) {
  test(`incompleteTodoCounts excludes deleted ${id} and any live descendants beneath it`, () => {
    const snapshot = tree().map(item => item.id === id ? { ...item, deletedAt: date(3) } : item);
    const expected = new Map(id === 'todo' ? [['list', 0], ['other-list', 1]] : [['other-list', 1]]);
    assert.deepEqual(incompleteTodoCounts(snapshot), expected);
    for (const item of snapshot.filter(item => item.id !== id)) assert.equal(item.deletedAt, null);
  });
}

test('incompleteTodoCounts excludes orphaned lists/todos and self, multi-node and ancestor cycles', () => {
  const snapshot = tree();
  snapshot.push(
    entity('orphan-list', 'list', 'missing'),
    entity('orphan-child', 'todo', 'orphan-list'),
    entity('orphan-todo', 'todo', 'missing'),
    entity('self-list', 'list', 'self-list'),
    entity('self-child', 'todo', 'self-list'),
    entity('self-todo', 'todo', 'self-todo'),
    entity('cycle-a', 'list', 'cycle-b'),
    entity('cycle-b', 'list', 'cycle-a'),
    entity('cycle-child', 'todo', 'cycle-a'),
    entity('cycle-folder-a', 'folder', 'cycle-folder-b'),
    entity('cycle-folder-b', 'folder', 'cycle-folder-a'),
    entity('below-cycle', 'list', 'cycle-folder-a'),
    entity('below-cycle-todo', 'todo', 'below-cycle'),
  );
  assert.deepEqual(incompleteTodoCounts(snapshot), new Map([['list', 1], ['other-list', 1]]));
});

test('incompleteTodoCounts accepts frozen input, leaves cloned data unchanged and never stores or shares counts', () => {
  const snapshot = tree();
  snapshot[0].tags.push('kept');
  const before = structuredClone(snapshot);
  freezeSnapshot(snapshot);
  const first = incompleteTodoCounts(snapshot);
  const second = incompleteTodoCounts(snapshot);
  assert.notStrictEqual(first, second);
  assert.deepEqual(first, new Map([['list', 1], ['other-list', 1]]));
  first.set('list', 999);
  first.set('not-a-list', 999);
  assert.deepEqual(second, new Map([['list', 1], ['other-list', 1]]));
  assert.deepEqual(incompleteTodoCounts(snapshot), second);
  assert.deepEqual(incompleteTodoCounts(structuredClone(snapshot)), second);
  assert.deepEqual(snapshot, before);
});

test('incompleteTodoCounts derives a large list total that formats above twenty without changing its records', () => {
  const snapshot = [
    entity('book', 'notebook', null),
    entity('folder', 'folder', 'book'),
    entity('list', 'list', 'folder'),
    ...Array.from({ length: 101 }, (_, index) => entity(`todo-${index}`, 'todo', 'list')),
    entity('completed', 'todo', 'list', { checked: true }),
    entity('note', 'note', 'list'),
  ];
  const before = structuredClone(snapshot);
  const counts = incompleteTodoCounts(freezeSnapshot(snapshot));
  assert.deepEqual(counts, new Map([['list', 101]]));
  assert.equal(circledTodoCount(counts.get('list')), '①⓪①');
  assert.deepEqual(snapshot, before);
});

test('checked updates recompute counts on successive snapshots with the same IDs, leaving prior results intact', () => {
  const initial = freezeSnapshot(tree());
  const before = structuredClone(initial);
  const initialCounts = incompleteTodoCounts(initial);
  const checked = nextSnapshot(initial, 'update', 'todo', { checked: true }, 'check-todo');
  const checkedCounts = incompleteTodoCounts(checked);
  const unchecked = nextSnapshot(checked, 'update', 'todo', { checked: false }, 'uncheck-todo');
  assert.deepEqual(initialCounts, new Map([['list', 1], ['other-list', 1]]));
  assert.deepEqual(checkedCounts, new Map([['list', 0], ['other-list', 1]]));
  assert.deepEqual(incompleteTodoCounts(unchecked), initialCounts);
  assert.deepEqual(incompleteTodoCounts(checked), checkedCounts);
  assert.deepEqual(unchecked.map(item => item.id), initial.map(item => item.id));
  assert.deepEqual(initial, before);
});

test('trashing and restoring a todo derives new counts without losing IDs or mutating earlier snapshots', () => {
  const initial = freezeSnapshot(tree());
  const before = structuredClone(initial);
  const initialCounts = incompleteTodoCounts(initial);
  const trashed = nextSnapshot(initial, 'trash', 'todo', undefined, 'delete-todo');
  const trashedBefore = structuredClone(trashed);
  const trashedCounts = incompleteTodoCounts(trashed);
  const restored = nextSnapshot(trashed, 'restore', 'todo', { trashOpId: 'delete-todo' });
  assert.deepEqual(trashedCounts, new Map([['list', 0], ['other-list', 1]]));
  assert.deepEqual(incompleteTodoCounts(restored), initialCounts);
  assert.deepEqual(initialCounts, new Map([['list', 1], ['other-list', 1]]));
  assert.deepEqual(incompleteTodoCounts(trashed), trashedCounts);
  assert.deepEqual(restored.map(item => item.id), initial.map(item => item.id));
  assert.deepEqual(initial, before);
  assert.deepEqual(trashed, trashedBefore);
});

for (const id of ['list', 'folder', 'book']) {
  test(`restoring a trashed ${id} derives counts again while preserving completed and earlier-trashed todos`, () => {
    const initial = freezeSnapshot([...tree(), entity('earlier', 'todo', 'list')]);
    const initialBefore = structuredClone(initial);
    const earlier = nextSnapshot(initial, 'trash', 'earlier', undefined, 'delete-earlier');
    const earlierBefore = structuredClone(earlier);
    const earlierCounts = incompleteTodoCounts(earlier);
    const trashed = nextSnapshot(earlier, 'trash', id, undefined, `delete-${id}`);
    const trashedBefore = structuredClone(trashed);
    const trashedCounts = incompleteTodoCounts(trashed);
    const restored = nextSnapshot(trashed, 'restore', id, { trashOpId: `delete-${id}` });
    assert.deepEqual(incompleteTodoCounts(initial), new Map([['list', 2], ['other-list', 1]]));
    assert.deepEqual(earlierCounts, new Map([['list', 1], ['other-list', 1]]));
    assert.deepEqual(trashedCounts, new Map([['other-list', 1]]));
    assert.deepEqual(incompleteTodoCounts(restored), earlierCounts);
    assert.deepEqual(incompleteTodoCounts(trashed), trashedCounts);
    assert.deepEqual(restored.map(item => item.id), initial.map(item => item.id));
    assert.equal(restored.find(item => item.id === 'completed').checked, true);
    assert.equal(restored.find(item => item.id === 'todo').deletedAt, null);
    assert.equal(restored.find(item => item.id === 'earlier').trashedBy, 'delete-earlier');
    assert.equal(restored.find(item => item.id === 'earlier').deletedAt, date(4));
    assert.deepEqual(initial, initialBefore);
    assert.deepEqual(earlier, earlierBefore);
    assert.deepEqual(trashed, trashedBefore);
  });
}