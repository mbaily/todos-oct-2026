import { content, hashtags, ROOT_VIEW_ID, visibleEntities } from './model.js';

export const locationActions = new Set(['location-create', 'location-update', 'location-trash', 'location-restore', 'location-import', 'nearby-settings']);
export const radiusOptions = [2, 5, 10, 20, null];
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_LOCATIONS = 5000;
export const MAX_LOCATION_NAME_LENGTH = 5000;
// A JSON fingerprint can escape each name character as six ASCII characters.
const MAX_LOCATION_FINGERPRINT_LENGTH = 6 * MAX_LOCATION_NAME_LENGTH + 1000;
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const locationFields = ['name', 'latitude', 'longitude', 'userLocation'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateLocation(fields, { partial = false, withId = false } = {}) {
  if (!object(fields)) throw new Error('Invalid location.');
  const allowed = withId ? ['id', ...locationFields] : locationFields;
  if (Object.keys(fields).some(key => !allowed.includes(key))) throw new Error('Unknown location field.');
  if (withId && (typeof fields.id !== 'string' || !idPattern.test(fields.id) || fields.id === ROOT_VIEW_ID)) throw new Error('Invalid location ID.');
  if (!partial && locationFields.some(key => !Object.hasOwn(fields, key))) throw new Error('A location needs a name, latitude, longitude and userLocation.');
  if (Object.hasOwn(fields, 'name') && (typeof fields.name !== 'string' || !fields.name.trim() || fields.name.length > MAX_LOCATION_NAME_LENGTH)) throw new Error(`A location name is required (at most ${MAX_LOCATION_NAME_LENGTH} characters).`);
  for (const [key, limit] of [['latitude', 90], ['longitude', 180]]) {
    if (Object.hasOwn(fields, key) && (typeof fields[key] !== 'number' || !Number.isFinite(fields[key]) || Math.abs(fields[key]) > limit)) throw new Error(`${key} must be a number from ${-limit} to ${limit}.`);
  }
  if (Object.hasOwn(fields, 'userLocation') && typeof fields.userLocation !== 'boolean') throw new Error('userLocation must be boolean.');
  if (partial && !Object.keys(fields).length) throw new Error('No location changes supplied.');
}

export function validateLocationFile(file) {
  if (!object(file) || file.version !== 1 || Object.keys(file).some(key => !['version', 'locations'].includes(key))) throw new Error('Use a version 1 location file: { "version": 1, "locations": [...] }.');
  if (!Array.isArray(file.locations) || file.locations.length > MAX_IMPORT_LOCATIONS) throw new Error(`Import at most ${MAX_IMPORT_LOCATIONS} locations at a time.`);
  const seen = new Set();
  for (const [index, location] of file.locations.entries()) {
    try { validateLocation(location, { withId: true }); }
    catch (error) { throw new Error(`Location ${index + 1}: ${error.message}`); }
    if (seen.has(location.id)) throw new Error(`Duplicate location ID: ${location.id}.`);
    seen.add(location.id);
  }
  return file.locations;
}

// The fingerprint ignores provisional timestamps, which change when offline edits sync.
export function locationFingerprint(location) {
  return location ? JSON.stringify([location.type, ...locationFields.map(key => location[key]), location.deletedAt ?? null]) : null;
}

export function validateLocationMutation(mutation) {
  const { action, fields, id } = mutation;
  if (action === 'location-trash') {
    if (fields !== undefined) throw new Error('Deletion does not take fields.');
    return;
  }
  if (!object(fields)) throw new Error('Invalid fields.');
  if (action === 'nearby-settings') {
    if (id !== ROOT_VIEW_ID) throw new Error('Invalid nearby settings ID.');
    if (!Object.keys(fields).length || Object.keys(fields).some(key => !['nearbyLocationId', 'nearbyRadius'].includes(key))) throw new Error('Invalid nearby settings.');
    if (Object.hasOwn(fields, 'nearbyLocationId') && fields.nearbyLocationId !== null && (typeof fields.nearbyLocationId !== 'string' || !idPattern.test(fields.nearbyLocationId))) throw new Error('Invalid current location ID.');
    if (Object.hasOwn(fields, 'nearbyRadius') && !radiusOptions.includes(fields.nearbyRadius)) throw new Error('Invalid nearby radius.');
  } else if (action === 'location-restore') {
    if (Object.keys(fields).length !== 1 || typeof fields.trashOpId !== 'string' || !idPattern.test(fields.trashOpId)) throw new Error('Invalid location deletion to restore.');
  } else if (action === 'location-import') {
    if (id !== ROOT_VIEW_ID || Object.keys(fields).some(key => !['locations', 'expected'].includes(key))) throw new Error('Invalid location import.');
    validateLocationFile({ version: 1, locations: fields.locations });
    if (!Array.isArray(fields.expected) || fields.expected.length !== fields.locations.length || fields.expected.some(value => value !== null && (typeof value !== 'string' || value.length > MAX_LOCATION_FINGERPRINT_LENGTH))) throw new Error('Invalid import preview.');
    if (new TextEncoder().encode(JSON.stringify(fields)).length > 2 * MAX_IMPORT_BYTES) throw new Error('Location import is too large.');
  } else {
    if (id === ROOT_VIEW_ID) throw new Error('Reserved settings ID.');
    validateLocation(fields, { partial: action === 'location-update' });
  }
}

export function locationCreationSource(location) {
  return location.createdVia ?? (location.importedBy ? 'import' : 'ui');
}

function makeLocation(id, fields, timestamp, previous, createdVia = 'ui') {
  return { ...(previous ?? { id, type: 'location', parentId: null, createdAt: timestamp, deletedAt: null }),
    ...fields, tags: hashtags(fields.name ?? previous.name), modifiedAt: timestamp, importedBy: null,
    createdVia: previous ? locationCreationSource(previous) : createdVia };
}

function clearUnavailableOrigin(entities, changed) {
  const settings = entities.get(ROOT_VIEW_ID);
  if (!settings?.nearbyLocationId) return;
  const origin = entities.get(settings.nearbyLocationId);
  if (origin?.type === 'location' && !origin.deletedAt && origin.userLocation) return;
  const cleared = { ...settings, nearbyLocationId: null };
  entities.set(ROOT_VIEW_ID, cleared);
  changed.push(cleared);
}

export function applyLocationMutation(entities, mutation, timestamp) {
  const { action, id, fields } = mutation;
  const current = entities.get(id);
  if (action === 'nearby-settings') {
    if (fields.nearbyLocationId !== undefined && fields.nearbyLocationId !== null) {
      const origin = entities.get(fields.nearbyLocationId);
      if (origin?.type !== 'location' || origin.deletedAt || !origin.userLocation) throw new Error('Select an available user location.');
    }
    const settings = { ...(current ?? { id: ROOT_VIEW_ID, type: 'view-settings', parentId: null }), ...fields };
    entities.set(id, settings);
    return [settings];
  }
  if (action === 'location-import') {
    // Check the entire preview before writing; a concurrent edit invalidates the import.
    for (const [index, location] of fields.locations.entries()) {
      const previous = entities.get(location.id);
      if (previous?.importedBy === mutation.opId) continue;
      if (previous && (previous.type !== 'location' || previous.deletedAt)) throw new Error(`Location ${location.id} is deleted or its ID belongs to another item. Restore it or choose a different ID.`);
      if (locationFingerprint(previous) !== fields.expected[index]) throw new Error('Locations changed since the preview. Preview the file again.');
    }
    const changed = [];
    for (const location of fields.locations) {
      const { id: locationId, ...values } = location;
      const previous = entities.get(locationId);
      if (previous?.importedBy === mutation.opId) continue;
      if (previous && locationFields.every(key => previous[key] === values[key])) continue;
      const entity = { ...makeLocation(locationId, values, timestamp, previous, 'import'), importedBy: mutation.opId };
      entities.set(locationId, entity);
      changed.push(entity);
    }
    clearUnavailableOrigin(entities, changed);
    return changed;
  }
  if (action === 'location-create') {
    if (current) throw new Error('This location ID already exists.');
  } else if (current?.type !== 'location') throw new Error('This location no longer exists.');
  let entity;
  if (action === 'location-restore') {
    if (!current.deletedAt || current.trashedBy !== fields.trashOpId) throw new Error('This location deletion can no longer be restored.');
    entity = { ...current, deletedAt: null, trashedBy: null, modifiedAt: timestamp };
  } else {
    if (current?.deletedAt) throw new Error('This location is deleted. Restore it first.');
    entity = action === 'location-trash'
      ? { ...current, deletedAt: timestamp, trashedBy: mutation.opId, modifiedAt: timestamp }
      : makeLocation(id, fields, timestamp, current);
  }
  entities.set(id, entity);
  const changed = [entity];
  clearUnavailableOrigin(entities, changed);
  return changed;
}

export function savedLocations(snapshot, deleted = false) {
  return snapshot.filter(entity => entity.type === 'location' && Boolean(entity.deletedAt) === deleted)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function nearbyPreferences(snapshot) {
  const settings = snapshot.find(entity => entity.id === ROOT_VIEW_ID);
  const origin = savedLocations(snapshot).find(location => location.userLocation && location.id === settings?.nearbyLocationId) ?? null;
  return { origin, radius: settings?.nearbyRadius === undefined ? 5 : settings.nearbyRadius };
}

export function distanceKm(a, b) {
  const radians = value => value * Math.PI / 180;
  const deltaLat = radians(b.latitude - a.latitude);
  const deltaLon = radians(b.longitude - a.longitude);
  const haversine = Math.sin(deltaLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(deltaLon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
}

export function nearbyRows(snapshot) {
  const { origin, radius } = nearbyPreferences(snapshot);
  const byTag = new Map();
  for (const location of savedLocations(snapshot)) {
    const distance = origin ? distanceKm(origin, location) : null;
    for (const tag of location.tags) {
      const matches = byTag.get(tag.toLowerCase()) ?? [];
      matches.push({ location, distance });
      byTag.set(tag.toLowerCase(), matches);
    }
  }
  const map = new Map(snapshot.map(entity => [entity.id, entity]));
  function isCompleted(entity) {
    let current = entity;
    while (current) {
      if (current.checked) return true;
      current = current.parentId ? map.get(current.parentId) : null;
    }
    return false;
  }
  const rows = [];
  for (const entity of visibleEntities(snapshot)) {
    if (isCompleted(entity)) continue;
    const parent = map.get(entity.parentId);
    const listTags = parent?.type === 'list' ? parent.tags ?? [] : [];
    const tags = new Set([...(entity.tags ?? []), ...listTags].map(tag => tag.toLowerCase()));
    const errand = tags.has('errand');
    const matches = new Map();
    for (const tag of tags) for (const match of byTag.get(tag) ?? []) matches.set(match.location.id, match);
    const locations = [...matches.values()].sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0)
      || a.location.name.localeCompare(b.location.name) || a.location.id.localeCompare(b.location.id));
    const qualifying = locations.filter(match => radius === null || (match.distance !== null && match.distance <= radius));
    if (!qualifying.length && !errand) continue;
    rows.push({ entity, locations, nearest: qualifying[0] ?? null, errandOnly: !qualifying.length });
  }
  return rows.sort((a, b) => {
    // With no origin and no filter, every row is ordered by name.
    if (origin || radius !== null) {
      const reason = Number(a.errandOnly) - Number(b.errandOnly);
      if (reason) return reason;
      const distance = (a.nearest?.distance ?? Infinity) - (b.nearest?.distance ?? Infinity);
      if (distance && Number.isFinite(distance)) return distance;
    }
    return content(a.entity).localeCompare(content(b.entity)) || a.entity.id.localeCompare(b.entity.id);
  });
}

export function previewLocationImport(file, snapshot) {
  const locations = validateLocationFile(file);
  const existing = new Map(snapshot.map(entity => [entity.id, entity]));
  const rows = locations.map(location => {
    const previous = existing.get(location.id);
    if (previous && (previous.type !== 'location' || previous.deletedAt)) throw new Error(`Location ${location.id} is deleted or its ID belongs to another item. Restore it or choose a different ID.`);
    const status = !previous ? 'Add' : locationFields.some(key => location[key] !== previous[key]) ? 'Update' : 'Unchanged';
    return { location, previous, status };
  });
  return { rows, fields: { locations, expected: locations.map(location => locationFingerprint(existing.get(location.id))) } };
}

export function exportLocations(snapshot) {
  return { version: 1, locations: savedLocations(snapshot).map(location => Object.fromEntries(['id', ...locationFields].map(key => [key, location[key]]))) };
}

export function formatDistance(distance) {
  return distance === null ? '' : `${distance.toFixed(distance < 10 ? 2 : 1)} km`;
}
