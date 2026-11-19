import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeScheduleMode, ScheduleMode } from '../dsh/schedule.mjs';

// Schema 3 keeps the primary worker at its original key and runtime and adds
// sibling workers and schedule choices. Older schemas remain readable.
const UUID = /^[a-f0-9-]{36}$/i;
const OPERATION = /^[A-Za-z0-9_-]{20,120}$/;
const HANDLE_KEYS = Object.freeze(['schema', 'root_id', 'worker', 'ordinal', 'generation', 'lease_id']);
const TASK_ID = /^[a-f0-9-]{36}$/i;
const STATE = new Set(['idle', 'starting', 'active', 'unknown']);

const real = value => (fs.realpathSync.native || fs.realpathSync)(value);
const positiveInt = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1) throw Error(`${name} must be a positive integer`);
  return value;
};
const isInside = (base, value) => {
  const rel = path.relative(base, value);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};
const safeNow = clock => {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw Error('pool clock returned an invalid date');
  return date;
};

export function poolRootKey(rootId) {
  if (!UUID.test(rootId || '')) throw Error('root chat ID must be a UUID');
  return crypto.createHash('sha256').update(`root:${rootId.toLowerCase()}`).digest('hex').slice(0, 16);
}
// Stable, ordinal-independent, valid lower-case instance name. It is derived
// only from the verified root UUID; two roots never share a runtime.
export function poolInstanceName(rootId, worker = 1) {
  positiveInt(worker, 'worker number');
  const primary = `pool-${poolRootKey(rootId)}`;
  return worker === 1 ? primary : `${primary}-${worker}`;
}

const bindingKey = (rootId, worker) => worker === 1 ? rootId : `${rootId}:${worker}`;

export class RootPool {
  constructor({ root, bindingCap = Infinity, concurrency = 3, ttlHours = 24, clock = () => new Date() } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw Error('pool root must be an absolute path');
    if (bindingCap !== Infinity && bindingCap !== null && bindingCap !== undefined) positiveInt(bindingCap, 'binding cap');
    positiveInt(concurrency, 'running cap');
    if (typeof ttlHours !== 'number' || !Number.isFinite(ttlHours) || ttlHours <= 0) throw Error('ttl hours must be positive');
    if (typeof clock !== 'function') throw Error('clock must be a function');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = real(root);
    if (fs.lstatSync(root).isSymbolicLink()) throw Error('pool root must not be a symlink or junction');
    this.file = path.join(this.root, 'bindings.json');
    this.lock = path.join(this.root, 'bindings.lock');
    this.bindingCap = bindingCap === null || bindingCap === undefined ? Infinity : bindingCap;
    this.concurrency = concurrency;
    this.ttlHours = ttlHours;
    this.ttlMs = ttlHours * 3600000;
    this.clock = clock;
  }
  _nowDate() { return safeNow(this.clock); }
  _now() { return this._nowDate().toISOString(); }
  _empty() {
    return {
      schema: 3, roots: {}, generations: {}, schedule_choices: {},
      binding_cap: this.bindingCap === Infinity ? null : this.bindingCap,
      concurrency: this.concurrency, ttl_hours: this.ttlHours
    };
  }
  _read() {
    let data;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) {
      if (error.code === 'ENOENT') return this._empty();
      throw Error('pool state unreadable; refusing destructive recovery');
    }
    if (!data || ![1, 2, 3].includes(data.schema) || !data.roots || typeof data.roots !== 'object' || Array.isArray(data.roots)) {
      throw Error('pool state has an unsupported schema; refusing destructive recovery');
    }
    for (const [key, binding] of Object.entries(data.roots)) {
      const rootId = binding?.root_id;
      const worker = binding?.worker ?? 1;
      if (!UUID.test(rootId || '') || !Number.isSafeInteger(worker) || worker < 1 || key !== bindingKey(rootId, worker)) {
        throw Error('pool state contains an invalid worker binding; refusing destructive recovery');
      }
      const expectedRuntime = this.workerPath(rootId, worker);
      if (!STATE.has(binding.state)
        || !Number.isInteger(binding.ordinal) || binding.ordinal < 1 || !Number.isInteger(binding.generation)
        || typeof binding.lease_id !== 'string' || binding.lease_id.length < 20
        || typeof binding.runtime_path !== 'string' || !path.isAbsolute(binding.runtime_path)
        || path.resolve(binding.runtime_path).toLowerCase() !== path.resolve(expectedRuntime).toLowerCase()
        || !fs.existsSync(binding.runtime_path)
        || (binding.dsh_instance !== undefined && binding.dsh_instance !== poolInstanceName(rootId, worker))
        || !Number.isInteger(binding.task_revision ?? 0) || (binding.task_revision ?? 0) < 0) {
        throw Error('pool state contains an invalid binding; refusing destructive recovery');
      }
      const realRuntime = real(binding.runtime_path);
      if (fs.lstatSync(binding.runtime_path).isSymbolicLink() || !isInside(this.root, realRuntime)
        || !isInside(this.rootPath(rootId), realRuntime)) {
        throw Error('pool state runtime escaped the pool root; refusing destructive recovery');
      }
    }
    // Policy is persisted with the bindings. A second process with a different
    // cap/TTL for the same runtime fails closed instead of reinterpreting it.
    if (data.schema >= 2) {
      const cap = data.binding_cap === undefined ? Infinity : data.binding_cap;
      const expectedCap = this.bindingCap === Infinity ? null : this.bindingCap;
      if ((cap === null ? null : cap) !== expectedCap) throw Error('pool binding cap policy differs from the persisted runtime; refusing to reinterpret state');
      if (data.concurrency !== undefined && data.concurrency !== this.concurrency) throw Error('pool running cap policy differs from the persisted runtime; refusing to reinterpret state');
      if (data.ttl_hours !== undefined && data.ttl_hours !== this.ttlHours) throw Error('pool TTL policy differs from the persisted runtime; refusing to reinterpret state');
    }
    data.generations ||= {};
    data.schedule_choices ??= {};
    if (typeof data.schedule_choices !== 'object' || Array.isArray(data.schedule_choices)
      || Object.entries(data.schedule_choices).some(([rootId, choice]) => !UUID.test(rootId)
        || (typeof choice !== 'boolean' && ![1, 2, 3].includes(choice)))) {
      throw Error('pool state contains an invalid schedule choice');
    }
    return data;
  }
  _write(data) {
    data.schema = 3;
    data.binding_cap = this.bindingCap === Infinity ? null : this.bindingCap;
    data.concurrency = this.concurrency;
    data.ttl_hours = this.ttlHours;
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  _withLock(fn) {
    let fd;
    const deadline = Date.now() + 2000;
    for (;;) {
      try { fd = fs.openSync(this.lock, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST' || Date.now() >= deadline) throw Error('pool lock contention or unknown lock; retry after inspection');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try { return fn(); } finally { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(this.lock); } catch {} }
  }
  rootPath(rootId) {
    return path.join(this.root, 'roots', poolRootKey(rootId));
  }
  workerPath(rootId, worker = 1) {
    positiveInt(worker, 'worker number');
    const base = this.rootPath(rootId);
    return worker === 1 ? base : path.join(base, 'workers', String(worker));
  }
  _ensureDirectory(dir, parent) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory()
      || !isInside(real(parent), real(dir))) {
      throw Error('pooled runtime must be a real directory in its owning root');
    }
  }
  // Every root directory contains three disjoint backends. No directory is a
  // link; an existing link/alias fails closed instead of escaping the pool.
  _ensureRoot(rootId) {
    const base = this.rootPath(rootId);
    const roots = path.join(this.root, 'roots');
    this._ensureDirectory(roots, this.root);
    this._ensureDirectory(base, roots);
    for (const name of ['dsh', 'hy4', 'routing']) {
      this._ensureDirectory(path.join(base, name), base);
    }
    return base;
  }
  _view(b) {
    if (!b) return null;
    const { lease_id: _lease, ...view } = b;
    return { ...view };
  }
  _handle(b) {
    const handle = { schema: 1, root_id: b.root_id, ordinal: b.ordinal, generation: b.generation, lease_id: b.lease_id };
    if (b.worker > 1) handle.worker = b.worker;
    return handle;
  }
  _verify(data, handle) {
    if (!handle || typeof handle !== 'object' || Array.isArray(handle)) throw Error('full pool handle required (rootId+ordinal+generation+lease)');
    for (const key of Object.keys(handle)) if (!HANDLE_KEYS.includes(key)) throw Error(`unknown pool handle field: ${key}`);
    if (handle.schema !== 1 || !UUID.test(handle.root_id || '') || !Number.isInteger(handle.ordinal)
      || !Number.isInteger(handle.generation) || typeof handle.lease_id !== 'string' || handle.lease_id.length < 20) {
      throw Error('malformed full pool handle');
    }
    const worker = handle.worker ?? 1;
    if (!Number.isSafeInteger(worker) || worker < 1) throw Error('malformed pool worker handle');
    const b = data.roots[bindingKey(handle.root_id, worker)];
    if (!b) throw Error('root not bound');
    if (b.ordinal !== handle.ordinal) throw Error('stale ordinal');
    if (b.generation !== handle.generation) throw Error('stale generation');
    if (b.lease_id !== handle.lease_id) throw Error('stale or invalid lease');
    return b;
  }
  _assertOperation(operationId) {
    if (typeof operationId !== 'string' || !OPERATION.test(operationId)) throw Error('unique operation proof required');
    return operationId;
  }
  _assertRevision(binding, revision) {
    if (revision !== undefined && (!Number.isInteger(revision) || revision !== binding.task_revision)) throw Error('stale task revision');
  }
  _running(data) {
    return Object.values(data.roots).filter(b => ['starting', 'active', 'unknown'].includes(b.state)).length;
  }
  _expire(data) {
    const now = this._nowDate().getTime();
    let changed = 0;
    for (const [rootId, b] of Object.entries(data.roots)) {
      if (b.state === 'idle' && now - Date.parse(b.last_used_at) >= this.ttlMs) { delete data.roots[rootId]; changed++; }
    }
    return changed;
  }
  _newLease() { return crypto.randomBytes(32).toString('base64url'); }
  newOperationId() { return crypto.randomBytes(32).toString('base64url'); }

  _allocate(data, rootId, worker) {
    const key = bindingKey(rootId, worker);
    const existing = data.roots[key];
    if (existing) return existing;
    const bindings = Object.values(data.roots);
    const rootIds = new Set(bindings.map(binding => binding.root_id));
    if (!rootIds.has(rootId) && rootIds.size >= this.bindingCap) throw Error('binding cap reached');
    const used = new Set(bindings.map(binding => binding.ordinal));
    let ordinal = 1;
    while (used.has(ordinal)) ordinal++;
    const generation = Number(data.generations[ordinal] || 0) + 1;
    const base = this._ensureRoot(rootId);
    const runtime = this.workerPath(rootId, worker);
    if (worker > 1) {
      const workers = path.join(base, 'workers');
      this._ensureDirectory(workers, base);
      this._ensureDirectory(runtime, workers);
      this._ensureDirectory(path.join(runtime, 'dsh'), runtime);
    }
    const binding = {
      schema: 2, root_id: rootId, ordinal, generation, lease_id: this._newLease(), state: 'idle',
      runtime_path: runtime, dsh_instance: poolInstanceName(rootId, worker), created_at: this._now(), last_used_at: this._now(),
      active_task_id: null, active_operation_id: null, active_key: null, active_backend: null,
      request_hash: null, task_revision: 0, uncertain_since: null
    };
    if (worker > 1) binding.worker = worker;
    data.generations[ordinal] = generation;
    data.roots[key] = binding;
    return binding;
  }

  // Allocation creates only metadata and the three empty runtime directories;
  // it never spawns an idle DSH/HY4 process.
  allocate(rootId) {
    if (!UUID.test(rootId || '')) throw Error('root chat ID must be a UUID');
    return this._withLock(() => {
      const data = this._read();
      this._expire(data);
      const binding = this._allocate(data, rootId, 1);
      if (binding.state === 'unknown') throw Error('root is unknown; inspect without destructive recovery');
      this._write(data);
      return { ...binding, handle: this._handle(binding) };
    });
  }
  // Internal handle retrieval for the owning stdio server. The lease is never
  // returned by an MCP tool or CLI output.
  handleFor(rootId) {
    if (!UUID.test(rootId || '')) throw Error('root chat ID must be a UUID');
    return this._withLock(() => {
      const b = this._read().roots[rootId];
      if (!b) throw Error('root not bound');
      return this._handle(b);
    });
  }
  // Read-only. Does not create a binding and does not refresh TTL.
  lookup(rootId) {
    if (!UUID.test(rootId || '')) throw Error('root chat ID must be a UUID');
    return this._withLock(() => this._view(this._read().roots[rootId] || null));
  }
  scheduleMode(rootId) {
    poolRootKey(rootId);
    return normalizeScheduleMode(this._read().schedule_choices[rootId] ?? ScheduleMode.UNRESTRICTED);
  }
  scheduleEnabled(rootId) {
    return this.scheduleMode(rootId) !== ScheduleMode.UNRESTRICTED;
  }
  setSchedule(rootId, choice) {
    poolRootKey(rootId);
    const mode = normalizeScheduleMode(choice);
    this._withLock(() => {
      const data = this._read();
      data.schedule_choices[rootId] = mode === ScheduleMode.WORKBUDDY_AT_PEAK ? mode : mode === ScheduleMode.OFFPEAK_ONLY;
      this._write(data);
    });
  }
  snapshot(handle) {
    return this._withLock(() => this._view(this._verify(this._read(), handle)));
  }
  list() {
    return this._withLock(() => {
      const data = this._read();
      return {
        schema: 3, binding_cap: this.bindingCap === Infinity ? null : this.bindingCap, concurrency: this.concurrency,
        running: this._running(data), bindings: Object.values(data.roots).map(b => this._view(b))
      };
    });
  }
  recycleExpired() {
    return this._withLock(() => {
      const data = this._read();
      const before = Object.keys(data.roots).length;
      this._expire(data);
      this._write(data);
      return { recycled: before - Object.keys(data.roots).length };
    });
  }
  // Reserve capacity BEFORE backend submission. `requestHash` is the pool's
  // conflict guard; `operationId` is unique per run, never derived from the key.
  reserve(handle, { operationId, idempotencyKey, requestHash } = {}) {
    return this._withLock(() => {
      const data = this._read();
      const b = this._verify(data, handle);
      const proof = { operationId, idempotencyKey, requestHash };
      this._checkReservation(data, b.root_id, proof);
      this._reserve(b, proof);
      this._write(data);
      return this._view(b);
    });
  }
  _checkReservation(data, rootId, { operationId, idempotencyKey, requestHash }) {
    this._assertOperation(operationId);
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(idempotencyKey)) throw Error('valid idempotency key required');
    if (typeof requestHash !== 'string' || !/^[a-f0-9]{64}$/i.test(requestHash)) throw Error('request fingerprint required');
    if (Object.values(data.roots).some(other => other.root_id === rootId && other.active_key === idempotencyKey)) {
      throw Error('the request key is already active or its admission is unknown');
    }
    if (this._running(data) >= this.concurrency) throw Error('global running capacity reached');
  }
  _reserve(b, { operationId, idempotencyKey, requestHash }) {
    if (b.state === 'unknown') throw Error('unknown binding is pinned; no automatic reuse');
    if (b.state !== 'idle') throw Error('worker is already active/starting');
    Object.assign(b, {
      state: 'starting', active_operation_id: operationId, active_key: idempotencyKey,
      active_task_id: null, active_backend: null, request_hash: requestHash,
      task_revision: Number(b.task_revision || 0) + 1, reserved_at: this._now(), last_used_at: this._now()
    });
  }
  reserveTask(rootId, proof, worker) {
    poolRootKey(rootId);
    if (worker !== undefined) positiveInt(worker, 'worker number');
    return this._withLock(() => {
      const data = this._read();
      this._expire(data);
      this._checkReservation(data, rootId, proof);
      if (worker === undefined) {
        worker = 1;
        while (data.roots[bindingKey(rootId, worker)] && data.roots[bindingKey(rootId, worker)].state !== 'idle') worker++;
      }
      const binding = this._allocate(data, rootId, worker);
      this._reserve(binding, proof);
      this._write(data);
      return { ...this._view(binding), handle: this._handle(binding) };
    });
  }
  admit(handle, { operationId, taskId, backend, revision } = {}) {
    return this._withLock(() => {
      const data = this._read(); const b = this._verify(data, handle);
      this._assertOperation(operationId);
      this._assertRevision(b, revision);
      if (b.state !== 'starting') throw Error('binding is not in a reserved starting state');
      if (b.active_operation_id !== operationId) throw Error('operation proof does not match reservation');
      if (!TASK_ID.test(taskId || '')) throw Error('accepted backend task ID required');
      if (!['dsh', 'hy4'].includes(backend)) throw Error('accepted backend must be dsh or hy4');
      b.active_task_id = taskId; b.active_backend = backend; b.state = 'active'; b.admitted_at = this._now();
      this._write(data);
      return this._view(b);
    });
  }
  // Only a reservation with no accepted task can be released as a proven
  // pre-admission rejection. This prevents a failed bookkeeping write from
  // pretending no task was accepted.
  reject(handle, { operationId, idempotencyKey, revision } = {}) {
    return this._withLock(() => {
      const data = this._read(); const b = this._verify(data, handle);
      this._assertOperation(operationId);
      this._assertRevision(b, revision);
      if (b.state !== 'starting' || b.active_operation_id !== operationId || b.active_task_id) {
        throw Error('not a live pre-admission reservation');
      }
      if (idempotencyKey !== undefined && b.active_key !== idempotencyKey) throw Error('idempotency proof does not match reservation');
      b.state = 'idle'; b.active_operation_id = null; b.active_key = null; b.active_task_id = null;
      b.active_backend = null; b.request_hash = null; b.last_used_at = this._now();
      this._write(data);
      return this._view(b);
    });
  }
  markUnknown(handle, { operationId, taskId, revision } = {}) {
    return this._withLock(() => {
      const data = this._read(); const b = this._verify(data, handle);
      this._assertOperation(operationId);
      this._assertRevision(b, revision);
      if (!['starting', 'active'].includes(b.state)) throw Error('only a live owned binding can become unknown');
      if (b.active_operation_id !== operationId) throw Error('operation proof does not match live binding');
      if (taskId !== undefined && b.active_task_id && b.active_task_id !== taskId) throw Error('task proof does not match binding');
      b.state = 'unknown';
      if (taskId && !b.active_task_id) b.active_task_id = taskId;
      b.uncertain_since = this._now();
      this._write(data);
      return this._view(b);
    });
  }
  // Finalization is accepted only for the exact admitted task and the live
  // operation. A delayed holder of an older lease/operation cannot release a
  // later task.
  finish(handle, { operationId, taskId, revision } = {}) {
    return this._withLock(() => {
      const data = this._read(); const b = this._verify(data, handle);
      this._assertOperation(operationId);
      this._assertRevision(b, revision);
      if (b.state !== 'active') throw Error('only an active admitted binding can be finalized');
      if (b.active_operation_id !== operationId) throw Error('operation proof does not match live task');
      if (!TASK_ID.test(taskId || '') || b.active_task_id !== taskId) throw Error('task proof does not match admitted task');
      b.state = 'idle'; b.active_operation_id = null; b.active_key = null; b.active_task_id = null;
      b.active_backend = null; b.request_hash = null; b.last_used_at = this._now(); b.uncertain_since = null;
      this._write(data);
      return this._view(b);
    });
  }
}
