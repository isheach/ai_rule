import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Schema 2 keeps the durable binding store v0.3-compatible for readers but
// makes every mutation require a full capability handle and a live operation
// proof. A lease alone (or rootId+lease) is never sufficient.
const UUID = /^[a-f0-9-]{36}$/i;
const OPERATION = /^[A-Za-z0-9_-]{20,120}$/;
const HANDLE_KEYS = Object.freeze(['schema', 'root_id', 'ordinal', 'generation', 'lease_id']);
const TASK_ID = /^[a-f0-9-]{36}$/i;
const STATE = new Set(['idle', 'starting', 'active', 'unknown']);

const real = value => (fs.realpathSync.native || fs.realpathSync)(value);
const positiveInt = (value, name) => {
  if (!Number.isInteger(value) || value < 1) throw Error(`${name} must be a positive integer`);
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
export function poolInstanceName(rootId) {
  return `pool-${poolRootKey(rootId)}`;
}

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
      schema: 2, roots: {}, generations: {},
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
    if (!data || ![1, 2].includes(data.schema) || !data.roots || typeof data.roots !== 'object' || Array.isArray(data.roots)) {
      throw Error('pool state has an unsupported schema; refusing destructive recovery');
    }
    for (const [rootId, binding] of Object.entries(data.roots)) {
      const expectedRuntime = path.join(this.root, 'roots', poolRootKey(rootId));
      if (!UUID.test(rootId) || !binding || binding.root_id !== rootId || !STATE.has(binding.state)
        || !Number.isInteger(binding.ordinal) || binding.ordinal < 1 || !Number.isInteger(binding.generation)
        || typeof binding.lease_id !== 'string' || binding.lease_id.length < 20
        || typeof binding.runtime_path !== 'string' || !path.isAbsolute(binding.runtime_path)
        || path.resolve(binding.runtime_path).toLowerCase() !== path.resolve(expectedRuntime).toLowerCase()
        || !fs.existsSync(binding.runtime_path)
        || !Number.isInteger(binding.task_revision ?? 0) || (binding.task_revision ?? 0) < 0) {
        throw Error('pool state contains an invalid binding; refusing destructive recovery');
      }
      const realRuntime = real(binding.runtime_path);
      if (fs.lstatSync(binding.runtime_path).isSymbolicLink() || !isInside(this.root, realRuntime)) {
        throw Error('pool state runtime escaped the pool root; refusing destructive recovery');
      }
    }
    // Policy is persisted with the bindings. A second process with a different
    // cap/TTL for the same runtime fails closed instead of reinterpreting it.
    if (data.schema === 2) {
      const cap = data.binding_cap === undefined ? Infinity : data.binding_cap;
      const expectedCap = this.bindingCap === Infinity ? null : this.bindingCap;
      if ((cap === null ? null : cap) !== expectedCap) throw Error('pool binding cap policy differs from the persisted runtime; refusing to reinterpret state');
      if (data.concurrency !== undefined && data.concurrency !== this.concurrency) throw Error('pool running cap policy differs from the persisted runtime; refusing to reinterpret state');
      if (data.ttl_hours !== undefined && data.ttl_hours !== this.ttlHours) throw Error('pool TTL policy differs from the persisted runtime; refusing to reinterpret state');
    }
    data.generations ||= {};
    return data;
  }
  _write(data) {
    data.schema = 2;
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
    poolRootKey(rootId);
    return path.join(this.root, 'roots', poolRootKey(rootId));
  }
  // Every root directory contains three disjoint backends. No directory is a
  // link; an existing link/alias fails closed instead of escaping the pool.
  _ensureRoot(rootId) {
    const base = this.rootPath(rootId);
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    if (!isInside(real(this.root), real(base))) throw Error('root runtime escaped the pool root through a link');
    for (const name of ['dsh', 'hy4', 'routing']) {
      const dir = path.join(base, name);
      if (fs.existsSync(dir)) {
        if (fs.lstatSync(dir).isSymbolicLink()) throw Error(`root ${name} runtime is a link; refusing pooled task`);
        if (!fs.statSync(dir).isDirectory()) throw Error(`root ${name} runtime is not a directory`);
      } else {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      if (!isInside(real(base), real(dir))) throw Error(`root ${name} runtime escaped the root directory`);
    }
    return base;
  }
  _view(b) {
    if (!b) return null;
    const { lease_id: _lease, ...view } = b;
    return { ...view };
  }
  _handle(b) {
    return { schema: 1, root_id: b.root_id, ordinal: b.ordinal, generation: b.generation, lease_id: b.lease_id };
  }
  _verify(data, handle) {
    if (!handle || typeof handle !== 'object' || Array.isArray(handle)) throw Error('full pool handle required (rootId+ordinal+generation+lease)');
    for (const key of Object.keys(handle)) if (!HANDLE_KEYS.includes(key)) throw Error(`unknown pool handle field: ${key}`);
    if (handle.schema !== 1 || !UUID.test(handle.root_id || '') || !Number.isInteger(handle.ordinal)
      || !Number.isInteger(handle.generation) || typeof handle.lease_id !== 'string' || handle.lease_id.length < 20) {
      throw Error('malformed full pool handle');
    }
    const b = data.roots[handle.root_id];
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

  // Allocation creates only metadata and the three empty runtime directories;
  // it never spawns an idle DSH/HY4 process.
  allocate(rootId) {
    if (!UUID.test(rootId || '')) throw Error('root chat ID must be a UUID');
    return this._withLock(() => {
      const data = this._read();
      this._expire(data);
      const existing = data.roots[rootId];
      if (existing) {
        if (existing.state === 'unknown') throw Error('root is unknown; inspect without destructive recovery');
        this._write(data);
        return { ...existing, handle: this._handle(existing) };
      }
      if (this.bindingCap !== Infinity && Object.keys(data.roots).length >= this.bindingCap) throw Error('binding cap reached');
      const used = new Set(Object.values(data.roots).map(x => x.ordinal));
      let ordinal = 1;
      while (used.has(ordinal)) ordinal++;
      const generation = Number(data.generations?.[ordinal] || 0) + 1;
      const base = this._ensureRoot(rootId);
      const binding = {
        schema: 2, root_id: rootId, ordinal, generation, lease_id: this._newLease(), state: 'idle',
        runtime_path: base, dsh_instance: poolInstanceName(rootId), created_at: this._now(), last_used_at: this._now(),
        active_task_id: null, active_operation_id: null, active_key: null, active_backend: null,
        request_hash: null, task_revision: 0, uncertain_since: null
      };
      data.generations[ordinal] = generation;
      data.roots[rootId] = binding;
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
  snapshot(handle) {
    return this._withLock(() => this._view(this._verify(this._read(), handle)));
  }
  list() {
    return this._withLock(() => {
      const data = this._read();
      return {
        schema: 2, binding_cap: this.bindingCap === Infinity ? null : this.bindingCap, concurrency: this.concurrency,
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
      const data = this._read(); const b = this._verify(data, handle);
      this._assertOperation(operationId);
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(idempotencyKey)) throw Error('valid idempotency key required');
      if (typeof requestHash !== 'string' || !/^[a-f0-9]{64}$/i.test(requestHash)) throw Error('request fingerprint required');
      if (b.state === 'unknown') throw Error('unknown binding is pinned; no automatic reuse');
      if (b.state !== 'idle') throw Error('root is already active/starting');
      if (this._running(data) >= this.concurrency) throw Error('global running capacity reached');
      b.state = 'starting';
      b.active_operation_id = operationId;
      b.active_key = idempotencyKey;
      b.active_task_id = null;
      b.active_backend = null;
      b.request_hash = requestHash;
      b.task_revision = Number(b.task_revision || 0) + 1;
      b.reserved_at = this._now();
      b.last_used_at = this._now();
      this._write(data);
      return this._view(b);
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
