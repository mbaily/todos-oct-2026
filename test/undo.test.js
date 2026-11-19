import test from 'node:test';
import assert from 'node:assert/strict';
import { recordUndo, UNDO_LIMIT } from '../src/lib/undo.js';

const edit = (id, fields) => ({ action: 'update', id, fields });

test('undo retains the newest 50 steps and ignores non-undoable saves', () => {
  let history = [];
  for (let index = 0; index < 53; index++) history = recordUndo(history, edit(String(index), { checked: false }));
  assert.equal(history.length, UNDO_LIMIT);
  assert.equal(history[0].id, '3');
  assert.equal(history.at(-1).id, '52');
  assert.equal(recordUndo(history, null), history);
});

test('autosaves in one session keep the original values without mutating earlier history', () => {
  const group = {};
  const first = recordUndo([], edit('note', { text: 'Original' }), group);
  const second = recordUndo(first, edit('note', { text: 'Intermediate' }), group);
  assert.equal(second.length, 1);
  assert.deepEqual(second[0].fields, { text: 'Original' });
  assert.notEqual(second[0], first[0]);
  assert.deepEqual(first[0].fields, { text: 'Original' });
  const reopened = recordUndo(second, edit('note', { text: 'Final' }), {});
  assert.equal(reopened.length, 2);
  assert.deepEqual(reopened.at(-1).fields, { text: 'Final' });
});

test('intervening checkbox changes, another editor or deletion separate text steps', () => {
  const group = {};
  for (const intervening of [edit('todo', { checked: false }), edit('note', { checked: false }), { action: 'restore', id: 'note', fields: { trashOpId: 'deletion' } }]) {
    let history = recordUndo([], edit('note', { text: 'Original' }), group);
    history = recordUndo(history, intervening);
    history = recordUndo(history, edit('note', { text: 'Intermediate' }), group);
    assert.equal(history.length, 3);
    assert.deepEqual(history[0].fields, { text: 'Original' });
    assert.deepEqual(history.at(-1).fields, { text: 'Intermediate' });
  }
  const anotherEditor = recordUndo(recordUndo([], edit('note', { text: 'Original' }), group), edit('other-note', { text: 'Other' }), {});
  assert.equal(recordUndo(anotherEditor, edit('note', { text: 'Intermediate' }), group).length, 3);
});
