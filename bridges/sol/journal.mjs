import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { COORDINATOR_MODES, CoordinatorMode, SAFE_KEY } from './config.mjs';
import { ENTRY_STRUCTURES, EntryStructure, normalizeEntryStructure } from '../entry-structure.mjs';

export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();

function checkDirectory(dir) {
  const canonical = fs.realpathSync(dir);
  if (path.relative(dir, canonical) || !fs.lstatSync(dir).isDirectory()) throw Error('Coordinator state directory has an unexpected canonical path.');
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  checkDirectory(dir);
}

function read(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 768000) throw Error('Coordinator state is not a bounded regular file.');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Error('Coordinator state is unreadable. Keep the original handle and inspect the local receipt.');
  }
}

function write(file, value, create = false) {
  // An exclusive first record precedes any API/executor call. A partial
  // creation after a crash fails closed, so even that key cannot be rerun.
  const target = create ? file : `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (!create) {
    try { fs.renameSync(target, file); }
    catch (error) { try { fs.unlinkSync(target); } catch {} throw error; }
  }
}

export class SolJournal {
  constructor(directory) {
    ensureDirectory(directory);
    this.directory = directory;
  }

  root(rootId, create = false) {
    const dir = path.join(this.directory, 'root-' + digest(rootId));
    if (create) ensureDirectory(dir);
    else if (fs.lstatSync(dir, { throwIfNoEntry: false })) checkDirectory(dir);
    return dir;
  }

  mode(rootId) {
    const record = read(path.join(this.root(rootId), 'mode.json'));
    if (!record) return { coordinator_mode: CoordinatorMode.SUBSCRIPTION, updated_at: null };
    if (record.schema !== 1 || record.root_id !== rootId || !COORDINATOR_MODES.includes(record.coordinator_mode)) throw Error('Invalid recorded coordinator mode.');
    return { coordinator_mode: record.coordinator_mode, updated_at: record.updated_at };
  }

  setMode(rootId, mode) {
    if (!COORDINATOR_MODES.includes(mode)) throw Error('Coordinator mode must be subscription or api.');
    const record = { schema: 1, root_id: rootId, coordinator_mode: mode, updated_at: now() };
    write(path.join(this.root(rootId, true), 'mode.json'), record);
    return { coordinator_mode: mode, updated_at: record.updated_at };
  }

  entryStructure(rootId) {
    const record = read(path.join(this.root(rootId), 'entry-structure.json'));
    if (!record) return { entry_structure: EntryStructure.ASTRA, entry_structure_source: 'default', entry_structure_updated_at: null };
    if (record.schema !== 1 || record.root_id !== rootId || !ENTRY_STRUCTURES.includes(record.entry_structure)) {
      throw Error('Invalid recorded entry structure.');
    }
    return { entry_structure: record.entry_structure, entry_structure_source: 'session', entry_structure_updated_at: record.updated_at };
  }

  setEntryStructure(rootId, value) {
    if (value === undefined) throw Error('An explicit entryStructure is required.');
    const entryStructure = normalizeEntryStructure(value);
    const updatedAt = now();
    write(path.join(this.root(rootId, true), 'entry-structure.json'),
      { schema: 1, root_id: rootId, entry_structure: entryStructure, updated_at: updatedAt });
    return { entry_structure: entryStructure, entry_structure_source: 'session', entry_structure_updated_at: updatedAt };
  }

  file(rootId, key, create = false) {
    if (typeof key !== 'string' || !SAFE_KEY.test(key)) throw Error('A stable idempotencyKey of 1..100 safe ASCII characters is required.');
    return path.join(this.root(rootId, create), `task-${digest(key)}.json`);
  }

  get(rootId, key) {
    const record = read(this.file(rootId, key));
    if (record && (record.schema !== 1 || record.root_id !== rootId || record.idempotency_key !== key
      || (record.coordinator_mode !== CoordinatorMode.API
        && !(record.coordinator_mode === CoordinatorMode.SUBSCRIPTION && record.requested_backend === 'Antigravity')))) {
      throw Error('Coordinator receipt ownership or schema does not match the requested task.');
    }
    return record;
  }

  create(record) { write(this.file(record.root_id, record.idempotency_key, true), record, true); }
  save(record) { write(this.file(record.root_id, record.idempotency_key), record); }
}
