import { locationActions, validateLocationMutation, applyLocationMutation } from './locations.js';

export const childTypes = {
  root: ['notebook'],
  notebook: ['folder'],
  folder: ['folder', 'list'],
  list: ['note', 'todo'],
  note: [],
  todo: [],
};

// App-wide preferences and notebook index preferences share a hidden settings record.
export const ROOT_VIEW_ID = 'root-view-settings';
export const sortOptions = [
  { value: 'created-desc', field: 'createdAt', direction: -1, label: 'Created desc' },
  { value: 'created-asc', field: 'createdAt', direction: 1, label: 'Created asc' },
  { value: 'modified-desc', field: 'modifiedAt', direction: -1, label: 'Modified desc' },
  { value: 'modified-asc', field: 'modifiedAt', direction: 1, label: 'Modified asc' },
];

export const dateDisplayOptions = [
  { value: 'none', label: 'No date' },
  { value: 'created-date', field: 'createdAt', label: 'Cr. Date' },
  { value: 'created-time', field: 'createdAt', time: true, label: 'Cr. Time' },
  { value: 'modified-date', field: 'modifiedAt', label: 'Mod Date' },
  { value: 'modified-time', field: 'modifiedAt', time: true, label: 'Mod Time' },
];

const hashtagPattern = /(?<![\p{L}\p{N}_])#([\p{L}\p{N}_-]+)/gu;
const hashtagBeforeCaret = new RegExp(`${hashtagPattern.source}$`, 'u');
const hashtagSuffix = /^[\p{L}\p{N}_-]*/u;

export function hashtagMatches(value) {
  return value.matchAll(hashtagPattern);
}

export function hashtags(value) {
  return [...new Set([...hashtagMatches(value)]
    .map(match => match[1].toLowerCase()))];
}

export function hashtagAtCaret(value, caret) {
  const match = hashtagBeforeCaret.exec(value.slice(0, caret));
  if (!match) return null;
  return {
    prefix: match[1].toLowerCase(),
    start: match.index,
    end: caret + hashtagSuffix.exec(value.slice(caret))[0].length,
  };
}

export function content(entity) {
  return entity.name ?? entity.text ?? '';
}

export function validateMutation(mutation) {
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) throw new Error('Invalid mutation.');
  for (const field of ['opId', 'id']) {
    if (typeof mutation[field] !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(mutation[field])) {
      throw new Error(`Invalid ${field}.`);
    }
  }
  if (locationActions.has(mutation.action)) { validateLocationMutation(mutation); return; }
  if (!['create', 'update', 'trash', 'sort', 'restore', 'date-display', 'hashtag-completion-settings'].includes(mutation.action)) throw new Error('Invalid action.');
  if (mutation.action === 'trash') return;
  const fields = mutation.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Invalid fields.');
  if (mutation.action === 'hashtag-completion-settings') {
    if (mutation.id !== ROOT_VIEW_ID || Object.keys(fields).length !== 1 ||
      !Object.hasOwn(fields, 'excludeLocationOnlyHashtags') || typeof fields.excludeLocationOnlyHashtags !== 'boolean') {
      throw new Error('Invalid hashtag completion settings.');
    }
    return;
  }
  if (mutation.action === 'restore') {
    if (Object.keys(fields).length !== 1 || typeof fields.trashOpId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(fields.trashOpId)) {
      throw new Error('Invalid deletion to undo.');
    }
    return;
  }
  if (mutation.action === 'sort') {
    if (Object.keys(fields).length !== 1 || !sortOptions.some(option => option.value === fields.sortOrder)) {
      throw new Error('Invalid sort order.');
    }
    return;
  }
  if (mutation.action === 'date-display') {
    if (Object.keys(fields).length !== 1 || !dateDisplayOptions.some(option => option.value === fields.dateDisplay)) {
      throw new Error('Invalid date display mode.');
    }
    return;
  }
  const allowed = mutation.action === 'create' ? ['type', 'parentId', 'name', 'text', 'checked'] : ['name', 'text', 'checked', 'favourite', 'pinned'];
  if (Object.keys(fields).some(key => !allowed.includes(key))) throw new Error('Unknown field.');
  if (mutation.action === 'create') {
    if (!Object.hasOwn(childTypes, fields.type) || fields.type === 'root') throw new Error('Invalid type.');
    if (fields.parentId !== null && (typeof fields.parentId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(fields.parentId))) {
      throw new Error('Invalid parent.');
    }
  }
  for (const field of ['name', 'text']) {
    if (Object.hasOwn(fields, field) && (typeof fields[field] !== 'string' || fields[field].length > 100000)) {
      throw new Error(`${field} must be text of at most 100000 characters.`);
    }
  }
  if (Object.hasOwn(fields, 'checked') && typeof fields.checked !== 'boolean') throw new Error('checked must be boolean.');
  if (Object.hasOwn(fields, 'favourite') && typeof fields.favourite !== 'boolean') throw new Error('favourite must be boolean.');
  if (Object.hasOwn(fields, 'pinned') && typeof fields.pinned !== 'boolean') throw new Error('pinned must be boolean.');
}

// The same hierarchy and mutation rules run on the server and on the local projection.
export function applyMutation(entities, mutation, timestamp) {
  validateMutation(mutation);
  if (locationActions.has(mutation.action)) return applyLocationMutation(entities, mutation, timestamp);
  const current = entities.get(mutation.id);
  if (current?.type === 'location') throw new Error('Use location actions for locations.');
  if (mutation.action === 'hashtag-completion-settings') {
    const settings = { ...(current ?? { id: ROOT_VIEW_ID, type: 'view-settings', parentId: null }), ...mutation.fields };
    entities.set(ROOT_VIEW_ID, settings);
    return [settings];
  }
  if (mutation.action === 'sort' || mutation.action === 'date-display') {
    if (mutation.id !== ROOT_VIEW_ID && (!current || current.deletedAt || !childTypes[current.type]?.length)) {
      throw new Error(mutation.action === 'sort' ? 'Only existing notebooks, folders and lists can be sorted.' : 'Only existing notebooks, folders and lists can have date display settings.');
    }
    const preference = mutation.action === 'sort' ? 'sortOrder' : 'dateDisplay';
    const entity = {
      ...(current ?? { id: ROOT_VIEW_ID, type: 'view-settings', parentId: null }),
      [preference]: mutation.fields[preference],
    };
    // A view preference does not change the content's modification timestamp.
    entities.set(entity.id, entity);
    return [entity];
  }
  if (mutation.id === ROOT_VIEW_ID) throw new Error('Reserved settings ID.');
  if (mutation.action === 'create') {
    if (current) throw new Error('This item already exists.');
    const { type, parentId } = mutation.fields;
    const parent = parentId === null ? null : entities.get(parentId);
    if (parentId !== null && (!parent || parent.deletedAt)) throw new Error('The parent no longer exists.');
    if (!childTypes[parent?.type ?? 'root'].includes(type)) throw new Error('This type is not allowed inside its parent.');
    const named = ['notebook', 'folder', 'list'].includes(type);
    const value = mutation.fields[named ? 'name' : 'text'];
    if (typeof value !== 'string') throw new Error(`Missing ${named ? 'name' : 'text'}.`);
    if (named && !value.trim()) throw new Error('A name is required.');
    if (named && ('text' in mutation.fields || (type !== 'list' && 'checked' in mutation.fields))) throw new Error('Invalid fields for this type.');
    if (!named && ('name' in mutation.fields || (type !== 'todo' && 'checked' in mutation.fields))) throw new Error('Invalid fields for this type.');
    const entity = {
      id: mutation.id, type, parentId,
      ...(named ? { name: value } : { text: value }),
      ...(type === 'todo' || type === 'list' ? { checked: mutation.fields.checked ?? false } : {}),
      favourite: false, pinned: false, tags: hashtags(value), createdAt: timestamp, modifiedAt: timestamp, deletedAt: null,
    };
    entities.set(entity.id, entity);
    return [entity];
  }
  if (mutation.action === 'restore') {
    const sameDeletion = current?.deletedAt && current.trashedBy === mutation.fields.trashOpId;
    const partiallySynced = current && !current.deletedAt && current.restoredBy === mutation.opId;
    if (!sameDeletion && !partiallySynced) throw new Error('This deletion can no longer be undone.');
    let parent = entities.get(current.parentId);
    while (parent) {
      if (parent.deletedAt) throw new Error('Restore the deleted parent first.');
      parent = entities.get(parent.parentId);
    }
    const children = new Map();
    for (const entity of entities.values()) {
      const siblings = children.get(entity.parentId) ?? [];
      siblings.push(entity.id);
      children.set(entity.parentId, siblings);
    }
    const changed = [];
    const queue = [current.id];
    for (let i = 0; i < queue.length; i++) {
      const entity = entities.get(queue[i]);
      if (!entity.deletedAt && entity.restoredBy === mutation.opId) {
        queue.push(...(children.get(entity.id) ?? []));
        continue;
      }
      if (!entity.deletedAt || entity.trashedBy !== mutation.fields.trashOpId) continue;
      const restored = { ...entity, deletedAt: null, trashedBy: null, restoredBy: mutation.opId, modifiedAt: timestamp };
      entities.set(entity.id, restored);
      changed.push(restored);
      queue.push(...(children.get(entity.id) ?? []));
    }
    return changed;
  }
  // The parent's tombstone can arrive before the rest of this same deletion.
  const continuingTrash = mutation.action === 'trash' && current?.trashedBy === mutation.opId;
  if (!current || (current.deletedAt && !continuingTrash)) throw new Error('This item is in trash or no longer exists.');
  if (mutation.action === 'update') {
    const named = ['notebook', 'folder', 'list'].includes(current.type);
    const allowed = current.type === 'list' ? ['name', 'checked', 'favourite', 'pinned']
      : named ? ['name', 'favourite', 'pinned']
      : current.type === 'todo' ? ['text', 'checked', 'favourite', 'pinned']
      : ['text', 'favourite', 'pinned'];
    if (Object.keys(mutation.fields).some(field => !allowed.includes(field))) throw new Error('Invalid fields for this type.');
    if (named && 'name' in mutation.fields && !mutation.fields.name.trim()) throw new Error('A name is required.');
    const entity = { ...current, ...mutation.fields, modifiedAt: timestamp };
    entity.tags = hashtags(content(entity));
    entities.set(entity.id, entity);
    return [entity];
  }
  const children = new Map();
  for (const entity of entities.values()) {
    const siblings = children.get(entity.parentId) ?? [];
    siblings.push(entity.id);
    children.set(entity.parentId, siblings);
  }
  const deletedAt = current.deletedAt || timestamp;
  const changed = [];
  const queue = [current.id];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    queue.push(...(children.get(id) ?? []));
    const entity = entities.get(id);
    if (!entity.deletedAt) {
      const trashed = { ...entity, deletedAt, trashedBy: mutation.opId, modifiedAt: deletedAt };
      entities.set(id, trashed);
      changed.push(trashed);
    }
  }
  return changed;
}

export function visibleEntities(entities) {
  const map = new Map(entities.map(entity => [entity.id, entity]));
  return entities.filter(entity => {
    if (entity.id === ROOT_VIEW_ID || !Object.hasOwn(childTypes, entity.type) || entity.type === 'root') return false;
    let ancestor = entity;
    const visited = new Set();
    while (ancestor) {
      if (ancestor.deletedAt || visited.has(ancestor.id)) return false;
      visited.add(ancestor.id);
      if (ancestor.parentId === null) return true;
      ancestor = map.get(ancestor.parentId);
    }
    return false;
  });
}

export function matchesSearch(entity, query) {
  const text = content(entity).toLowerCase();
  return query.toLowerCase().trim().split(/\s+/u).every(term =>
    term.startsWith('#') ? entity.tags.some(tag => tag.startsWith(term.slice(1))) : text.includes(term));
}
