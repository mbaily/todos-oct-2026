import { sortOptions, visibleEntities } from './model.js';

export const hashtagSortOptions = [
  { value: 'alphabetical', field: 'name', direction: 1, label: 'Alphabetical' },
  ...sortOptions,
];

export function parseViewHash(hash) {
  const root = { kind: 'entities', id: null, tag: null };
  if (hash === '#hashtags') return { ...root, kind: 'hashtags' };
  if (hash === '#trash') return { ...root, kind: 'trash' };
  if (hash === '#nearby') return { ...root, kind: 'nearby' };
  if (hash === '#locations') return { ...root, kind: 'locations' };
  if (hash === '#settings') return { ...root, kind: 'settings' };
  if (hash.startsWith('#tag/')) {
    try {
      const tag = decodeURIComponent(hash.slice(5)).toLowerCase();
      // Case normalization can introduce combining marks (for example, İ -> i̇).
      if (/^[\p{L}\p{N}\p{M}_-]+$/u.test(tag)) return { ...root, kind: 'tag', tag };
    } catch {
      // A malformed bookmark should fall back to the notebook index.
    }
    return root;
  }
  if (hash.startsWith('#entity/')) {
    const id = hash.slice(8);
    if (/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return { ...root, id };
  }
  return root;
}

export function hashtagIndex(entities, sortOrder = 'alphabetical') {
  const tags = new Map();
  for (const entity of visibleEntities(entities)) {
    for (const tag of entity.tags ?? []) {
      const name = tag.toLowerCase();
      const previous = tags.get(name);
      tags.set(name, {
        name,
        createdAt: previous && previous.createdAt < entity.createdAt ? previous.createdAt : entity.createdAt,
        modifiedAt: previous && previous.modifiedAt > entity.modifiedAt ? previous.modifiedAt : entity.modifiedAt,
      });
    }
  }
  const option = hashtagSortOptions.find(option => option.value === sortOrder) ?? hashtagSortOptions[0];
  return [...tags.values()].sort((a, b) =>
    option.direction * a[option.field].localeCompare(b[option.field]) || a.name.localeCompare(b.name));
}

export function breadcrumbEntities(entities, currentId) {
  const map = new Map(visibleEntities(entities).map(entity => [entity.id, entity]));
  const path = [];
  let entity = map.get(currentId);
  while (entity) {
    path.unshift(entity);
    entity = map.get(entity.parentId);
  }
  return path;
}
