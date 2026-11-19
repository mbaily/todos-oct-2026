import { childTypes, content, sortOptions } from './model.js';

export const trashSortOptions = [
  { value: 'trashed-desc', field: 'deletedAt', direction: -1, label: 'Trashed desc' },
  { value: 'trashed-asc', field: 'deletedAt', direction: 1, label: 'Trashed asc' },
  ...sortOptions,
];

export function trashRows(entities, sortOrder = 'trashed-desc') {
  const map = new Map(entities.map(entity => [entity.id, entity]));
  const option = trashSortOptions.find(option => option.value === sortOrder) ?? trashSortOptions[0];
  return entities.filter(entity => entity.deletedAt && entity.type !== 'root' && Object.hasOwn(childTypes, entity.type))
    .sort((a, b) => option.direction * (a[option.field].localeCompare(b[option.field]) || a.id.localeCompare(b.id)))
    .map(entity => {
      const path = [];
      const locationEntities = [];
      const visited = new Set([entity.id]);
      let parentId = entity.parentId;
      let reason = '';
      let restoreParent = null;
      while (parentId !== null) {
        const parent = map.get(parentId);
        if (!parent || visited.has(parentId)) { reason = 'The original parent is unavailable.'; restoreParent = null; break; }
        visited.add(parentId);
        path.unshift(content(parent));
        locationEntities.unshift(parent);
        if (parent.deletedAt) { reason = `Restore parent first: ${content(parent)}`; restoreParent = parent; }
        parentId = parent.parentId;
      }
      if (!reason && !/^[a-zA-Z0-9_-]{1,100}$/.test(entity.trashedBy ?? '')) reason = 'Deletion information is unavailable.';
      return { entity, location: ['Notebooks', ...path].join(' › '), locationEntities, reason, restoreParent };
    });
}