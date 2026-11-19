import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { applyMutation, validateMutation } from '../src/lib/model.js';
import { locationCreationSource } from '../src/lib/locations.js';

const CHANGE_PAGE_BYTES = 512 * 1024;

function legacyChangeOperationId(entity) {
  return entity.deletedAt ? entity.trashedBy : entity.importedBy ?? entity.restoredBy;
}

function migrateChangeLog(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('changes')").all().map(row => row.name));
    if (!columns.has('checkpoint')) {
      db.exec(`
        ALTER TABLE changes ADD COLUMN checkpoint TEXT;
        UPDATE changes SET checkpoint = lower(hex(randomblob(16)));
      `);
    }
    if (!columns.has('operation_id')) {
      db.exec('ALTER TABLE changes ADD COLUMN operation_id TEXT;');
    }
    // An older server can leave operation IDs empty when it writes after a rollback.
    db.exec(`
      WITH origin_clears AS (
        SELECT receipt.op_id, location.revision AS first_revision, settings.revision AS last_revision
        FROM receipts AS receipt
        JOIN changes AS settings ON settings.revision = json_extract(receipt.result, '$.revision')
        JOIN changes AS location ON location.revision = settings.revision - 1
        WHERE (settings.operation_id IS NULL OR location.operation_id IS NULL)
          AND json_extract(receipt.mutation, '$.action') = 'location-update'
          AND json_extract(settings.data, '$.type') = 'view-settings'
          AND json_extract(location.data, '$.id') = json_extract(receipt.mutation, '$.id')
      ),
      operation_revisions AS (
        SELECT op_id, first_revision AS revision FROM origin_clears
        UNION ALL
        SELECT op_id, last_revision AS revision FROM origin_clears
      )
      UPDATE changes SET operation_id = operation_revisions.op_id
      FROM operation_revisions
      WHERE changes.revision = operation_revisions.revision AND changes.operation_id IS NULL;
    `);
    // Stamp every new revision, including writes by earlier versions of the server.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS set_change_checkpoint AFTER INSERT ON changes
      BEGIN
        UPDATE changes SET checkpoint = lower(hex(randomblob(16))) WHERE revision = NEW.revision;
      END;
      COMMIT;
    `);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function backfillLocationCreationSources(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const legacy = new Map(db.prepare("SELECT id, data FROM entities WHERE type = 'location' AND json_extract(data, '$.createdVia') IS NULL")
      .all().map(row => [row.id, JSON.parse(row.data)]));
    if (legacy.size) {
      const sources = new Map();
      // Scan history once: an imported location may have been manually edited since creation.
      for (const row of db.prepare("SELECT data FROM changes WHERE json_extract(data, '$.type') = 'location' ORDER BY revision").iterate()) {
        const location = JSON.parse(row.data);
        if (legacy.has(location.id) && !sources.has(location.id)) sources.set(location.id, locationCreationSource(location));
        if (sources.size === legacy.size) break;
      }
      const update = db.prepare('UPDATE entities SET data = ? WHERE id = ?');
      const change = db.prepare('INSERT INTO changes (data) VALUES (?)');
      for (const [id, location] of legacy) {
        const data = JSON.stringify({ ...location, createdVia: sources.get(id) ?? locationCreationSource(location) });
        update.run(data, id);
        // Publish the recovered source to browsers without changing user edit timestamps.
        change.run(data);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function backfillListChecked(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const legacy = db.prepare("SELECT id, data FROM entities WHERE type = 'list' AND json_extract(data, '$.checked') IS NULL")
      .all().map(row => [row.id, JSON.parse(row.data)]);
    if (legacy.length) {
      const update = db.prepare('UPDATE entities SET data = ? WHERE id = ?');
      const change = db.prepare('INSERT INTO changes (data) VALUES (?)');
      for (const [id, list] of legacy) {
        const data = JSON.stringify({ ...list, checked: false });
        update.run(data, id);
        change.run(data);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createStore(filename, { onChange } = {}) {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES entities(id),
      type TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS entities_parent ON entities(parent_id);
    CREATE TABLE IF NOT EXISTS changes (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS receipts (
      op_id TEXT PRIMARY KEY,
      mutation TEXT NOT NULL,
      result TEXT NOT NULL
    );
  `);
  migrateChangeLog(db);
  backfillLocationCreationSources(db);
  backfillListChecked(db);
  const entityRows = db.prepare('SELECT data FROM entities');
  const latest = db.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM changes');
  const receipt = db.prepare('SELECT mutation, result FROM receipts WHERE op_id = ?');
  const receiptResult = db.prepare('SELECT result FROM receipts WHERE op_id = ?');
  const saveReceipt = db.prepare('INSERT INTO receipts (op_id, mutation, result) VALUES (?, ?, ?)');
  const saveEntity = db.prepare(`INSERT INTO entities (id, parent_id, type, data) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data`);
  const saveChange = db.prepare('INSERT INTO changes (data, operation_id) VALUES (?, ?)');
  const changesSince = db.prepare('SELECT revision, data, operation_id FROM changes WHERE revision > ? AND revision <= ? ORDER BY revision LIMIT 500');
  const checkpointAt = db.prepare('SELECT checkpoint FROM changes WHERE revision = ?');
  const readCheckpoint = cursor => cursor === 0 ? null : checkpointAt.get(cursor)?.checkpoint;
  const readReceipt = id => {
    const stored = receiptResult.get(id);
    return stored && JSON.parse(stored.result);
  };

  const accept = (mutation, getEntities) => {
    const prior = receipt.get(mutation.opId);
    const serialized = JSON.stringify(mutation);
    if (prior) {
      if (prior.mutation !== serialized && !isDeepStrictEqual(JSON.parse(prior.mutation), JSON.parse(serialized))) {
        throw new Error('An operation ID cannot be reused for another mutation.');
      }
      return JSON.parse(prior.result);
    }
    const entities = getEntities();
    let result;
    try {
      const changed = applyMutation(entities, mutation, new Date().toISOString());
      const operationId = changed.length > 1 ? mutation.opId : null;
      for (const entity of changed) {
        const data = JSON.stringify(entity);
        saveEntity.run(entity.id, entity.parentId, entity.type, data);
        saveChange.run(data, operationId);
      }
      result = { opId: mutation.opId, accepted: true, revision: latest.get().revision };
    } catch (error) {
      // Validation failures are durable receipts too. Retries get the same outcome.
      // SQL failures must roll back the whole mutation rather than leave partial trash.
      if (error.code) throw error;
      result = { opId: mutation.opId, accepted: false, error: error.message };
    }
    saveReceipt.run(mutation.opId, serialized, JSON.stringify(result));
    return result;
  };

  const synchronize = ({ cursor, checkpoint, mutations, awaiting = [], operationThrough, trashThrough }, revision) => {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || (checkpoint === undefined && cursor > revision)) {
      const error = new Error('Invalid sync cursor.');
      error.status = 409;
      throw error;
    }
    // Validate history before writing any queued edits from this browser.
    if (checkpoint !== undefined && checkpoint !== readCheckpoint(cursor)) return { resetRequired: true };
    const boundary = operationThrough ?? trashThrough ?? null;
    // A browser cannot finish a staged operation beyond the available history.
    if (checkpoint !== undefined && Number.isSafeInteger(boundary) && boundary > revision) {
      return { resetRequired: true };
    }
    if (boundary !== null && (!Number.isSafeInteger(boundary) || boundary <= cursor || boundary > revision)) {
      throw new Error('Invalid operation page boundary.');
    }
    if (!Array.isArray(mutations) || mutations.length > 100) throw new Error('Send at most 100 mutations.');
    if (!Array.isArray(awaiting) || awaiting.length > 100 ||
      awaiting.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) {
      throw new Error('Send at most 100 valid operation IDs for receipt lookup.');
    }
    // Validate the envelope before accepting any of the batch.
    mutations.forEach(validateMutation);
    // Mutations share the results of earlier edits in this SQLite transaction.
    let entities;
    const getEntities = () => {
      if (entities) return entities;
      entities = new Map();
      for (const { data } of entityRows.iterate()) {
        const entity = JSON.parse(data);
        entities.set(entity.id, entity);
      }
      return entities;
    };
    const acknowledgements = mutations.map(mutation => accept(mutation, getEntities));
    for (const id of new Set(awaiting)) {
      const stored = readReceipt(id);
      if (stored) acknowledgements.push(stored);
    }
    const latestRevision = latest.get().revision;
    const changes = [];
    let pageBytes = 2; // JSON array brackets.
    let operationId;
    let operationStart = 0;
    // Finish the staged operation before pulling newer changes.
    for (const { revision, data, operation_id } of changesSince.iterate(cursor, boundary ?? latestRevision)) {
      const entryBytes = Buffer.byteLength(data) + `{"revision":${revision},"entity":},`.length;
      // A large individual record still needs its own page so the cursor can advance.
      if (changes.length && pageBytes + entryBytes > CHANGE_PAGE_BYTES) break;
      const entity = JSON.parse(data);
      const changeOperation = operation_id ?? legacyChangeOperationId(entity);
      if (changeOperation !== operationId) {
        operationId = changeOperation;
        operationStart = changes.length;
      }
      changes.push({ revision, entity });
      pageBytes += entryBytes;
    }
    const last = changes.at(-1);
    const receipt = operationId && last.revision < latestRevision ? readReceipt(operationId) : undefined;
    let nextOperationThrough;
    if (receipt?.accepted && receipt.revision > last.revision) {
      // Let the browser publish earlier revisions before staging the incomplete operation.
      if (operationStart > 0) changes.length = operationStart;
      else nextOperationThrough = receipt.revision;
    }
    const nextCursor = changes.at(-1)?.revision ?? cursor;
    return {
      acknowledgements, changes, cursor: nextCursor, hasMore: nextCursor < latestRevision,
      ...(checkpoint === undefined ? {} : { checkpoint: readCheckpoint(nextCursor) }),
      // Older clients use trashThrough to stage a partial page.
      ...(nextOperationThrough ? { operationThrough: nextOperationThrough, operationId, trashThrough: nextOperationThrough } : {}),
    };
  };
  const sync = request => {
    db.exec('BEGIN IMMEDIATE');
    let response;
    let committedRevision;
    try {
      const previousRevision = latest.get().revision;
      response = synchronize(request, previousRevision);
      const revision = latest.get().revision;
      if (revision > previousRevision) committedRevision = revision;
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (committedRevision !== undefined) onChange?.(committedRevision);
    return response;
  };
  return { sync, close: () => db.close(), db };
}
