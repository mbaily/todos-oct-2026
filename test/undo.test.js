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

test('explicitly saved edits to the same item stay as separate Undo steps', () => {
  const first = recordUndo([], edit('note', { text: 'Original' }));
  const second = recordUndo(first, edit('note', { text: 'First save' }));
  assert.deepEqual(first.map(step => step.fields.text), ['Original']);
  assert.deepEqual(second.map(step => step.fields.text), ['Original', 'First save']);
});
