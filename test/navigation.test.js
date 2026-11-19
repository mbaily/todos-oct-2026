import test from 'node:test';
import assert from 'node:assert/strict';
import { hashtags, ROOT_VIEW_ID, sortOptions } from '../src/lib/model.js';
import { breadcrumbEntities, hashtagIndex, hashtagSortOptions, parseViewHash } from '../src/lib/navigation.js';

const date = day => `2026-01-${String(day).padStart(2, '0')}T12:00:00.000Z`;
function entity(id, tags = [], createdAt = date(1), modifiedAt = createdAt, extra = {}) {
  return { id, type: 'notebook', parentId: null, name: id, tags, createdAt, modifiedAt, deletedAt: null, ...extra };
}

test('view hashes distinguish entities, the hashtag index and normalized Unicode tag searches', () => {
  assert.deepEqual(parseViewHash(''), { kind: 'entities', id: null, tag: null });
  assert.deepEqual(parseViewHash('#entity/book_1'), { kind: 'entities', id: 'book_1', tag: null });
  assert.deepEqual(parseViewHash('#hashtags'), { kind: 'hashtags', id: null, tag: null });
  assert.deepEqual(parseViewHash('#trash'), { kind: 'trash', id: null, tag: null });
  assert.deepEqual(parseViewHash('#tag/WORK'), { kind: 'tag', id: null, tag: 'work' });
  assert.deepEqual(parseViewHash(`#tag/${encodeURIComponent('日本語_1-tag')}`), { kind: 'tag', id: null, tag: '日本語_1-tag' });
  const [tag] = hashtags('#İstanbul');
  assert.deepEqual(parseViewHash(`#tag/${encodeURIComponent(tag)}`), { kind: 'tag', id: null, tag });
});

test('malformed or unsupported bookmarks fall back safely to the notebook index', () => {
  for (const hash of ['#entity/', '#entity/a/b', '#tag/', '#tag/%broken', '#tag/two%20words', '#unknown']) {
    assert.deepEqual(parseViewHash(hash), { kind: 'entities', id: null, tag: null });
  }
});

test('the hashtag index includes all visible entity types, normalizes duplicates and excludes trash and orphans', () => {
  const entities = [
    entity('book', ['Work', 'work']),
    entity('folder', ['folder-tag'], date(2), date(2), { type: 'folder', parentId: 'book' }),
    entity('list', ['list-tag'], date(3), date(3), { type: 'list', parentId: 'folder' }),
    entity('todo', ['work', 'todo-tag'], date(4), date(4), { type: 'todo', parentId: 'list' }),
    entity('note', ['日本語'], date(5), date(5), { type: 'note', parentId: 'list' }),
    entity('trash', ['in-trash'], date(1), date(1), { deletedAt: date(6) }),
    entity('child', ['under-trash'], date(1), date(1), { type: 'folder', parentId: 'trash' }),
    entity('orphan', ['orphan'], date(1), date(1), { parentId: 'missing' }),
  ];
  const names = hashtagIndex(entities).map(tag => tag.name);
  assert.deepEqual(new Set(names), new Set(['work', 'folder-tag', 'list-tag', 'todo-tag', '日本語']));
  assert.equal(names.length, 5);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test('hashtag dates use earliest item creation and latest item modification without mutating entities', () => {
  const entities = [entity('newer', ['shared'], date(3), date(4)), entity('older', ['shared'], date(1), date(6))];
  const before = structuredClone(entities);
  assert.deepEqual(hashtagIndex(entities), [{ name: 'shared', createdAt: date(1), modifiedAt: date(6) }]);
  assert.deepEqual(entities, before);
});

test('hashtag sorting includes Alphabetical and all four date modes without changing entity sort modes', () => {
  const entities = [entity('z', ['zeta'], date(1), date(6)), entity('a', ['alpha'], date(2), date(4)), entity('b', ['beta'], date(3), date(5))];
  const expected = {
    alphabetical: ['alpha', 'beta', 'zeta'],
    'created-desc': ['beta', 'alpha', 'zeta'],
    'created-asc': ['zeta', 'alpha', 'beta'],
    'modified-desc': ['zeta', 'beta', 'alpha'],
    'modified-asc': ['alpha', 'beta', 'zeta'],
  };
  assert.deepEqual(hashtagSortOptions.map(option => option.label), ['Alphabetical', 'Created desc', 'Created asc', 'Modified desc', 'Modified asc']);
  for (const [mode, names] of Object.entries(expected)) {
    assert.deepEqual(hashtagIndex(entities, mode).map(tag => tag.name), names);
  }
  assert.deepEqual(hashtagIndex(entities, 'unknown').map(tag => tag.name), expected.alphabetical);
  assert.deepEqual(hashtagIndex([entity('tie', ['zeta', 'alpha'])], 'created-desc').map(tag => tag.name), ['alpha', 'zeta']);
  assert.equal(sortOptions.some(option => option.value === 'alphabetical'), false);
});

test('breadcrumbs follow the live notebook/folder/list ancestor chain and reflect renames', () => {
  const entities = [
    entity('book'),
    entity('folder', [], date(1), date(1), { type: 'folder', parentId: 'book' }),
    entity('nested', [], date(1), date(1), { type: 'folder', parentId: 'folder' }),
    entity('list', [], date(1), date(1), { type: 'list', parentId: 'nested' }),
  ];
  assert.deepEqual(breadcrumbEntities(entities, 'list').map(entity => entity.id), ['book', 'folder', 'nested', 'list']);
  entities[1] = { ...entities[1], name: 'Renamed folder' };
  assert.equal(breadcrumbEntities(entities, 'list')[1].name, 'Renamed folder');
  assert.deepEqual(breadcrumbEntities(entities, null), []);
  assert.deepEqual(breadcrumbEntities(entities, 'missing'), []);
});

test('empty, settings-only and cyclic/deleted hierarchies do not produce tags or breadcrumb loops', () => {
  assert.deepEqual(hashtagIndex([]), []);
  assert.deepEqual(hashtagIndex([entity(ROOT_VIEW_ID, ['settings'])]), []);
  const cycle = [entity('a', ['cycle-a'], date(1), date(1), { parentId: 'b' }), entity('b', ['cycle-b'], date(1), date(1), { parentId: 'a' })];
  assert.deepEqual(hashtagIndex(cycle), []);
  assert.deepEqual(breadcrumbEntities(cycle, 'a'), []);
  const deleted = [entity('book', ['trash'], date(1), date(1), { deletedAt: date(2) }), entity('child', ['hidden'], date(1), date(1), { parentId: 'book' })];
  assert.deepEqual(breadcrumbEntities(deleted, 'child'), []);
});