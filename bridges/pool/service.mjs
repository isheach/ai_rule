import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RootPool, poolInstanceName, poolRootKey } from './core.mjs';
import { resolveContext } from './context.mjs';
import { TaskManager, discoverDsh, redact, runtimeBase } from '../dsh/core.mjs';
import { loadSchedule, ScheduleMode, schedulePolicySnapshot } from '../dsh/schedule.mjs';
import { RoutingCoordinator, RoutingConflictError, UnavailableWorkBuddyHy4, AdmissionCode, PreAdmissionRejection } from '../dsh/routing.mjs';
import { validateWorkBuddyContinuation, WorkBuddyDispatch } from '../workbuddy/dispatch.mjs';
import { Hy4AcpManager } from '../hy4/acp.mjs';
import { loadManifest } from '../hy4/manifest.mjs';
import { normalizeTaskAuthorization, safeWriteMetadata } from '../hy4/policy.mjs';
import { DSH_TIMEOUT_MS, WAIT_MS, validateWaitMs } from '../task-lifecycle.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'schedule_stopped', 'refused', 'not_accepted']);
const FAILURE = new Set(['failed', 'timed_out', 'cancelled', 'schedule_stopped', 'refused', 'unknown', 'unknown_after_disconnect', 'not_accepted']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const CONFIG_KEYS = new Set(['pool_root', 'dsh_entry', 'schedule_config', 'workspace_root', 'allow_write', 'binding_cap', 'running_cap', 'ttl_hours', 'hy4_manifest', 'fallback_authorization_ref', 'context_dir']);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const real = value => (fs.realpathSync.native || fs.realpathSync)(value);
const isInside = (base, value) => {
  const rel = path.relative(base, value);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};
const nowIso = clock => { const d = clock(); const x = d instanceof Date ? d : new Date(d); if (!Number.isFinite(x.getTime())) throw Error('clock returned an invalid date'); return x; };

export function loadPoolConfig(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw Error('--config must be an absolute path');
  let value;
  try { value = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw Error('config unreadable or invalid JSON'); }
  return validatePoolConfig(value);
}
export function validatePoolConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('pool config must be an object');
  for (const key of Object.keys(value)) if (!CONFIG_KEYS.has(key)) throw Error(`unknown pool config field: ${key}`);
  for (const key of ['pool_root', 'dsh_entry', 'schedule_config', 'workspace_root']) {
    if (typeof value[key] !== 'string' || !path.isAbsolute(value[key])) throw Error(`config ${key} must be an absolute path`);
  }
  for (const key of ['dsh_entry', 'schedule_config', 'workspace_root']) {
    if (!fs.existsSync(value[key])) throw Error(`config ${key} does not exist`);
  }
  if (!fs.statSync(value.workspace_root).isDirectory()) throw Error('config workspace_root must be a directory');
  if (!/\.(?:mjs|cjs|js)$/i.test(value.dsh_entry)) throw Error('config dsh_entry must be a JavaScript entry, not a shell shim');
  if (value.allow_write !== undefined && typeof value.allow_write !== 'boolean') throw Error('config allow_write must be boolean');
  for (const key of ['binding_cap', 'running_cap']) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || value[key] < 1)) throw Error(`config ${key} must be a positive integer`);
  }
  if (value.ttl_hours !== undefined && (typeof value.ttl_hours !== 'number' || !Number.isFinite(value.ttl_hours) || value.ttl_hours <= 0)) {
    throw Error('config ttl_hours must be positive');
  }
  if (value.context_dir !== undefined && (typeof value.context_dir !== 'string' || !path.isAbsolute(value.context_dir))) throw Error('config context_dir must be an absolute path');
  if (value.hy4_manifest !== undefined) {
    if (typeof value.hy4_manifest !== 'string' || !path.isAbsolute(value.hy4_manifest) || !fs.existsSync(value.hy4_manifest)) throw Error('config hy4_manifest must be an existing absolute file');
  }
  if (value.fallback_authorization_ref !== undefined) {
    if (typeof value.fallback_authorization_ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/.test(value.fallback_authorization_ref)
      || /^(?:sk-|ghp_|github_pat_|Bearer)/i.test(value.fallback_authorization_ref)) {
      throw Error('config fallback_authorization_ref must be a non-secret local reference');
    }
    if (!value.hy4_manifest) throw Error('fallback_authorization_ref requires hy4_manifest; no implicit fallback route');
  }
  return { ...value, allow_write: value.allow_write !== false };
}

function safeBinding(binding) {
  if (!binding) return null;
  return {
    root_chat_id: binding.root_id, worker: binding.worker ?? 1, ordinal: binding.ordinal, generation: binding.generation, state: binding.state,
    dsh_instance: binding.dsh_instance, active_task_id: binding.active_task_id, active_backend: binding.active_backend,
    task_revision: binding.task_revision, created_at: binding.created_at, last_used_at: binding.last_used_at,
    uncertain_since: binding.uncertain_since ?? null
  };
}
function routingView(decision) {
  if (!decision) return null;
  return {
    request_id: decision.request_id, policy_version: decision.policy_version, admission_state: decision.admission_state,
    selected_backend: decision.selected_backend, reason_code: decision.reason_code, task_id: decision.task_id,
    task_capability: decision.task_capability ?? null,
    write_scope_count: decision.write_scope_count ?? 0,
    exact_write_count: decision.exact_write_count ?? 0,
    command_count: decision.command_count ?? 0,
    fallback: decision.fallback
  };
}

export class PoolService {
  constructor({ config, schedule, allowWriteCli = true, clock = () => new Date(), sessionsRoot } = {}) {
    this.config = config;
    this.clock = clock;
    this.sessionsRoot = sessionsRoot;
    this.allowWrite = config.allow_write !== false && allowWriteCli === true;
    this.schedule = schedule ?? loadSchedule(config.schedule_config);
    if (!this.schedule || this.schedule.enabled !== true || this.schedule.hardStopAtPeak !== true || this.schedule.resumeAutomatically !== false) {
      throw Error('an explicit enabled schedule with hard stop and no automatic resume is required');
    }
    this.workspaceRoot = real(config.workspace_root);
    const poolPath = path.resolve(config.pool_root);
    let poolReal;
    try { poolReal = real(poolPath); } catch { poolReal = poolPath; }
    const legacyBase = path.resolve(runtimeBase());
    const overlap = (a, b) => isInside(a, b) || isInside(b, a);
    if (overlap(this.workspaceRoot, poolReal)) throw Error('pool_root and workspace_root must be physically disjoint');
    if (overlap(legacyBase, poolReal)) throw Error('pool_root must be disjoint from legacy/default DSH runtimes');
    this.cli = discoverDsh(config.dsh_entry);
    this.manifest = config.hy4_manifest ? loadManifest(config.hy4_manifest) : null;
    this.authorization = config.fallback_authorization_ref ? {
      schema: 1, enabled: true, authorization_ref: config.fallback_authorization_ref, scope: 'pre_admission_only', max_attempts: 1
    } : null;
    this.pool = new RootPool({
      root: config.pool_root,
      bindingCap: config.binding_cap ?? Infinity,
      concurrency: config.running_cap ?? 3,
      ttlHours: config.ttl_hours ?? 24,
      clock
    });
    this.roots = new Map();
    this.inflight = new Map();
    this.owned = new Map();
    this.starting = new Map();
    this.settling = new Map();
    this.closing = false;
  }

  runtimeFor(rootId) {
    return this.pool.rootPath(rootId);
  }
  workBuddyFor(rootId) {
    return new WorkBuddyDispatch({ runtime: this.runtimeFor(rootId), clock: this.clock, redact });
  }
  _workerRuntime(rootId, worker) {
    const expected = path.join(this.pool.workerPath(rootId, worker), 'dsh');
    const actual = real(expected);
    if (!samePath(actual, expected) || !isInside(this.runtimeFor(rootId), actual)) {
      throw Error('worker runtime does not match its canonical path');
    }
    return actual;
  }
  _workerNumbers(rootId) {
    const dir = path.join(this.runtimeFor(rootId), 'workers');
    let entries;
    try {
      if (!samePath(real(dir), dir)) throw Error('workers directory does not match its canonical path');
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [1];
      throw error;
    }
    return [1, ...entries.filter(entry => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name))
      .map(entry => Number(entry.name)).filter(number => Number.isSafeInteger(number) && number > 1)];
  }
  _sessionWorker(rootId, sessionId) {
    const owners = [];
    for (const worker of this._workerNumbers(rootId)) {
      let runtime;
      try { runtime = this._workerRuntime(rootId, worker); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const index = this._readJson(path.join(runtime, 'sessions.json'));
      if (!index) continue;
      if (index.schema !== 1 || !index.sessions || typeof index.sessions !== 'object' || Array.isArray(index.sessions)) {
        throw Error('worker session index is invalid; refusing to guess ownership');
      }
      if (Object.hasOwn(index.sessions, sessionId)) {
        if (index.sessions[sessionId]?.instance !== poolInstanceName(rootId, worker)) {
          throw Error('worker session index has conflicting ownership');
        }
        owners.push(worker);
      }
    }
    if (owners.length > 1) throw Error('session ownership is ambiguous across workers');
    // The primary worker also knows how to check legacy, unindexed receipts.
    return owners[0] ?? 1;
  }
  managerFor(rootId, worker) {
    const runtime = this.runtimeFor(rootId);
    let root = this.roots.get(rootId);
    if (!root) {
      const hy4 = this.manifest ? new Hy4AcpManager({ manifest: this.manifest, runtime: path.join(runtime, 'hy4'), clock: this.clock }) : null;
      root = { hy4, workers: new Map() };
      this.roots.set(rootId, root);
    }
    const existing = root.workers.get(worker);
    if (existing) return existing;
    const manager = new TaskManager({
      cli: this.cli, runtime: this._workerRuntime(rootId, worker), instance: poolInstanceName(rootId, worker),
      allowWrite: this.allowWrite, schedule: this.schedule, clock: this.clock,
      scheduleModeForRoot: () => this.pool.scheduleMode(rootId)
    });
    const coordinator = new RoutingCoordinator({
      runtime, dsh: { submit: (task, authorization) => manager.start(task, authorization) }, hy4: root.hy4 ?? new UnavailableWorkBuddyHy4(),
      authorization: this.authorization, clock: this.clock, liveMcpDispatchWired: true
    });
    const entry = { manager, hy4: root.hy4, coordinator };
    root.workers.set(worker, entry);
    return entry;
  }

  _prepare(args, rootId) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'Task arguments must be an object.');
    const allowed = new Set(['prompt', 'cwd', 'idempotencyKey', 'timeoutMs', 'permissionMode', 'capability', 'authorizationNote', 'sessionId', 'workBuddyContinuationKey', 'writes', 'writeScopes', 'commands']);
    for (const key of Object.keys(args)) if (!allowed.has(key)) throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, `Unknown task field: ${key}`);
    if (typeof args.prompt !== 'string' || !args.prompt.trim() || Buffer.byteLength(args.prompt) > 60000) {
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'prompt must contain 1..60000 UTF-8 bytes.');
    }
    if (typeof args.cwd !== 'string' || !path.isAbsolute(args.cwd)) throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'cwd must be an absolute path.');
    if (typeof args.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(args.idempotencyKey)) {
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'idempotencyKey must contain 1..100 safe ASCII characters.');
    }
    let cwd;
    try { cwd = real(args.cwd); } catch { throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'cwd must be an existing directory.'); }
    if (!fs.statSync(cwd).isDirectory() || !isInside(this.workspaceRoot, cwd)) {
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'cwd is outside the approved workspace root.');
    }
    const capability = args.capability ?? 'default';
    const permissionMode = args.permissionMode ?? (capability === 'default' && this.allowWrite ? 'workspace-write' : 'read-only');
    if (!['read-only', 'workspace-write'].includes(permissionMode)) throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'permissionMode must be read-only or workspace-write.');
    if (!['default', 'text-only', 'workspace-read', 'workspace-write'].includes(capability)) throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'Invalid capability.');
    const wantsWrite = permissionMode === 'workspace-write' || capability === 'workspace-write';
    if (wantsWrite && !this.allowWrite) {
      throw new PreAdmissionRejection(AdmissionCode.PERMISSION_REFUSED, 'This DSH pool is configured read-only.');
    }
    if (args.authorizationNote !== undefined && (typeof args.authorizationNote !== 'string' || args.authorizationNote.length > 2000)) {
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'authorizationNote must be a string of at most 2000 characters.');
    }
    if (capability === 'workspace-write' && permissionMode !== 'workspace-write') {
      throw new PreAdmissionRejection(AdmissionCode.PERMISSION_REFUSED, 'workspace-write capability requires permissionMode workspace-write.');
    }
    if (permissionMode === 'workspace-write' && !['default', 'workspace-write'].includes(capability)) {
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'This capability requires read-only permission.');
    }
    if (capability === 'workspace-write' && !args.authorizationNote?.trim()) {
      throw new PreAdmissionRejection(AdmissionCode.PERMISSION_REFUSED, 'Explicit workspace-write capability requires a per-task authorizationNote.');
    }
    let authorization;
    try {
      authorization = normalizeTaskAuthorization({
        cwd, permissionMode, capability,
        writes: args.writes, writeScopes: args.writeScopes, commands: args.commands
      });
    } catch (error) {
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, error.message);
    }
    const timeoutMs = args.timeoutMs ?? DSH_TIMEOUT_MS.default;
    if (!Number.isInteger(timeoutMs) || timeoutMs < DSH_TIMEOUT_MS.minimum || timeoutMs > DSH_TIMEOUT_MS.maximum) {
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS,
        `timeoutMs must be an integer ${DSH_TIMEOUT_MS.minimum}..${DSH_TIMEOUT_MS.maximum}.`);
    }
    if (args.sessionId !== undefined && (typeof args.sessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(args.sessionId))) {
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'Invalid sessionId.');
    }
    validateWorkBuddyContinuation(args);
    const task = {
      prompt: args.prompt, cwd, idempotencyKey: args.idempotencyKey,
      timeoutMs, permissionMode,
      writes: authorization.writes,
      writeScopes: authorization.writeScopes,
      commands: authorization.commands
    };
    if (args.authorizationNote !== undefined) task.authorizationNote = args.authorizationNote;
    if (args.sessionId !== undefined) task.sessionId = args.sessionId;
    if (args.workBuddyContinuationKey !== undefined) task.workBuddyContinuationKey = args.workBuddyContinuationKey;
    if (capability !== 'default') task.capability = capability;
    const options = {
      sessionMode: 'DSH', taskCapability: capability,
      allowWorkspaceWrite: this.allowWrite && wantsWrite
    };
    const metadata = safeWriteMetadata(task);
    const requestIdentity = {
      schema: 2,
      prompt_sha256: sha256(String(task.prompt ?? '')), cwd, idempotencyKey: task.idempotencyKey,
      timeoutMs: task.timeoutMs, permissionMode, sessionId: task.sessionId ?? null,
      capability, task_capability: capability, authorization_note: task.authorizationNote ?? null,
      write_scopes: task.writeScopes, writes: task.writes, commands: task.commands,
      metadata, root: rootId, session_mode: 'DSH', requested_backend: 'dsh',
      ...(task.workBuddyContinuationKey === undefined ? {} : { workbuddy_continuation_key: task.workBuddyContinuationKey })
    };
    const requestHash = sha256(JSON.stringify(requestIdentity));
    const legacyHash = args.permissionMode === undefined && permissionMode === 'workspace-write'
      ? sha256(JSON.stringify({ ...requestIdentity, permissionMode: 'read-only' }))
      : null;
    return { task, options, requestHash, legacyHash, key: task.idempotencyKey };
  }

  _decisionPath(rootId, key) {
    return path.join(this.runtimeFor(rootId), 'routing', `${sha256(`idempotency:${key}`)}.json`);
  }
  _proofPath(rootId, key) {
    return path.join(this.runtimeFor(rootId), 'routing', `${sha256(`idempotency:${key}`)}.pool.json`);
  }
  _readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw Error('pooled receipt is unreadable; refusing to guess admission state'); }
  }
  _readDecision(rootId, key) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(key)) throw Error('Invalid idempotencyKey.');
    const value = this._readJson(this._decisionPath(rootId, key));
    if (!value) return null;
    if (value.schema !== 1 || value.idempotency_key !== key || typeof value.selected_backend !== 'string') {
      throw Error('routing decision has an invalid shape; refusing to guess admission state');
    }
    return value;
  }
  _findDecisionByTaskId(rootId, taskId) {
    const dir = path.join(this.runtimeFor(rootId), 'routing');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return null; }
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.pool.json')) continue;
      try {
        const value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (value?.task_id === taskId && value?.schema === 1 && typeof value?.selected_backend === 'string') return value;
      } catch { /* an unreadable decision is never guessed around */ }
    }
    return null;
  }
  _readReceipt(rootId, decision) {
    const runtime = this.runtimeFor(rootId);
    const taskId = decision.task_id;
    if (typeof taskId !== 'string') throw Error('accepted routing decision has no task ID');
    let receipt;
    if (decision.selected_backend === 'hy4') {
      const dir = path.join(runtime, 'hy4', 'requests');
      let names = [];
      try { names = fs.readdirSync(dir); } catch { throw Error('HY4 receipt directory is unavailable'); }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const value = this._readJson(path.join(dir, name));
        if (value?.task_id === taskId) { receipt = value; break; }
      }
      if (!receipt) throw Error('HY4 task receipt is unavailable');
    } else {
      if (!/^[a-f0-9-]{36}$/.test(taskId)) throw Error('Invalid DSH task ID in routing decision.');
      const proof = decision.idempotency_key ? this._readJson(this._proofPath(rootId, decision.idempotency_key)) : null;
      const candidates = proof?.task_id === taskId ? [proof.worker ?? 1] : this._workerNumbers(rootId);
      for (const worker of candidates) {
        let dshRuntime;
        try { dshRuntime = this._workerRuntime(rootId, worker); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const candidate = this._readJson(path.join(dshRuntime, taskId, 'RUN_RECEIPT.json'));
        if (!candidate) continue;
        if (candidate.task_id !== taskId || (candidate.instance !== poolInstanceName(rootId, worker)
          && !(worker === 1 && candidate.instance === undefined))) {
          throw Error('task receipt belongs to another DSH instance');
        }
        if (receipt) throw Error('ambiguous task receipt across workers');
        receipt = candidate;
      }
      if (!receipt) throw Error('DSH task receipt is unavailable');
    }
    if (['starting', 'running', 'cancelling', 'accepted'].includes(receipt.status) && this.owned.get(taskId)?.rootId !== rootId) {
      receipt = {
        ...receipt, status: 'unknown_after_disconnect',
        warning: 'This connection does not own the child process; snapshot only. No retry, kill or pool mutation.'
      };
    }
    return receipt;
  }
  _resolveDecision(rootId, { idempotencyKey, taskId }) {
    let decision;
    if (idempotencyKey !== undefined) {
      if (typeof idempotencyKey !== 'string') throw Error('idempotencyKey must be a string');
      decision = this._readDecision(rootId, idempotencyKey);
      if (!decision) throw Error('No routing decision exists for this idempotency key in this root.');
      if (taskId !== undefined && decision.task_id !== taskId) throw Error('taskId does not match the routing decision for this idempotency key.');
    } else {
      if (typeof taskId !== 'string' || !/^[a-f0-9-]{36}$/i.test(taskId)) throw Error('taskId or idempotencyKey is required.');
      decision = this._findDecisionByTaskId(rootId, taskId);
      if (!decision) throw Error('Task ID is not mapped to this root; refusing to guess a DSH instance.');
    }
    if (decision.selected_backend === 'hy4' && !this.manifest) throw Error('HY4 task exists but HY4 is not configured in this server.');
    const owner = this.owned.get(decision.task_id);
    return { owner: owner?.rootId === rootId ? owner : null, decision };
  }

  _receipt(entry, decision, waitMs) {
    const backend = decision.selected_backend;
    if (backend === 'hy4') return waitMs === undefined ? entry.hy4.get(decision.task_id) : entry.hy4.wait(decision.task_id, waitMs);
    return waitMs === undefined ? entry.manager.get(decision.task_id) : entry.manager.wait(decision.task_id, waitMs);
  }

  _pack(rootId, decision, receipt) {
    return {
      task_id: decision?.task_id ?? null,
      backend: decision?.selected_backend ?? null,
      status: receipt?.status ?? decision?.admission_state ?? 'unknown',
      admission_state: decision?.admission_state ?? 'unknown',
      routing: routingView(decision),
      receipt: receipt ?? null
    };
  }

  async submit(rootId, args) {
    if (this.closing) throw Error('pool server is shutting down; no new tasks are admitted');
    const prepared = this._prepare(args, rootId);
    const mapKey = `${rootId}:${prepared.key}`;
    const pending = this.inflight.get(mapKey);
    if (pending) {
      if (pending.hash !== prepared.requestHash) throw new RoutingConflictError('Concurrent use of one idempotency key with different task arguments.');
      const result = await pending.promise;
      return { ...result, deduplicated: true };
    }
    const work = this._submitPrepared(rootId, prepared);
    const entry = { hash: prepared.requestHash, promise: work };
    this.inflight.set(mapKey, entry);
    try { return await work; } finally { if (this.inflight.get(mapKey) === entry) this.inflight.delete(mapKey); }
  }

  _writeProof(rootId, key, requestHash, taskId, worker) {
    const file = this._proofPath(rootId, key);
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ schema: 2, request_hash: requestHash, task_id: taskId, worker }) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  _replay(rootId, { key, requestHash, legacyHash }, prior) {
    if (prior.admission_state !== 'accepted') {
      throw Error(`Idempotency key is already ${prior.admission_state} (${prior.reason_code ?? 'no reason'}); no resubmission, fallback or capacity use is allowed.`);
    }
    const proof = this._readJson(this._proofPath(rootId, key));
    if (!proof || ![1, 2].includes(proof.schema) || proof.task_id !== prior.task_id
      || (proof.request_hash !== requestHash && !(proof.schema === 1 && legacyHash && proof.request_hash === legacyHash))) {
      throw new RoutingConflictError('The idempotency key belongs to a different frozen task/scopes; no replay and no capacity use.');
    }
    const receipt = this._readReceipt(rootId, prior);
    return { ...this._pack(rootId, prior, receipt), replayed: true, observation_only: !TERMINAL.has(receipt.status) };
  }

  async _submitPrepared(rootId, prepared) {
    const { task, options, requestHash, key } = prepared;
    const workBuddy = this.workBuddyFor(rootId);
    const workBuddyReplay = workBuddy.replay(key, requestHash);
    if (workBuddyReplay) return workBuddyReplay;
    const prior = this._readDecision(rootId, key);
    if (prior) return this._replay(rootId, prepared, prior);
    if (this.closing) throw Error('pool server is shutting down; no new tasks are admitted');
    const requestedWorker = task.sessionId ? this._sessionWorker(rootId, task.sessionId) : undefined;
    const operationId = this.pool.newOperationId();
    let binding;
    try { binding = this.pool.reserveTask(rootId, { operationId, idempotencyKey: key, requestHash }, requestedWorker); }
    catch (error) { throw new Error(`Pool reservation refused: ${error.message}`); }
    const handle = Object.freeze({ ...binding.handle });
    const worker = binding.worker ?? 1;
    // A prior owner may have finished between the first read and reservation.
    // The reserved worker has not dispatched anything, so release it on replay.
    let recorded;
    try { recorded = this._readDecision(rootId, key); }
    catch (error) {
      this.pool.reject(handle, { operationId, idempotencyKey: key });
      throw error;
    }
    if (recorded || this.closing) {
      this.pool.reject(handle, { operationId, idempotencyKey: key });
      if (recorded) return this._replay(rootId, prepared, recorded);
      throw Error('pool server is shutting down; the reserved task was not submitted');
    }
    let resolveDone;
    const starting = { rootId, handle, operationId, key, state: 'reserved', done: new Promise(resolve => { resolveDone = resolve; }) };
    starting.resolve = resolveDone;
    this.starting.set(operationId, starting);
    const settleStarting = state => {
      starting.state = state;
      try { starting.resolve?.(state); } catch {}
      this.starting.delete(operationId);
    };
    let entry;
    try { entry = this.managerFor(rootId, worker); }
    catch (error) {
      try { this.pool.reject(handle, { operationId, idempotencyKey: key }); } catch {}
      settleStarting('released');
      throw error;
    }
    let decision;
    try {
      decision = await entry.coordinator.submit(task, options);
    } catch (error) {
      if (error?.admission_state === 'not_accepted') {
        let released = false;
        try {
          this.pool.reject(handle, { operationId, idempotencyKey: key });
          released = true;
        }
        catch { try { this.pool.markUnknown(handle, { operationId }); } catch {} }
        settleStarting(released ? 'released' : 'unknown');
        // The structured peak decision comes from the owned DSH worker after
        // validating input, session, exclusive lock and schedule, before spawn.
        const rejection = error.cause;
        if (released && rejection instanceof PreAdmissionRejection && rejection.code === AdmissionCode.WORKBUDDY_DSF_PEAK) {
          return workBuddy.offer(task, requestHash, rejection.details.schedule);
        }
      } else {
        try { this.pool.markUnknown(handle, { operationId }); } catch {}
        settleStarting('unknown');
      }
      throw error;
    }
    const taskId = decision?.task_id;
    const backend = decision?.selected_backend;
    let admitted;
    try {
      if (!taskId || !['dsh', 'hy4'].includes(backend)) throw Error('routing returned no accepted task');
      admitted = this.pool.admit(handle, { operationId, taskId, backend });
    } catch (error) {
      // We own the just-accepted child in this live process. Stop only that
      // child, then leave the binding pinned as unknown (never silently free).
      try {
        if (backend === 'hy4' && entry.hy4) await entry.hy4.cancel(taskId, 'bookkeeping_failure');
        else if (backend === 'dsh') entry.manager.cancel(taskId, 'bookkeeping_failure');
        if (backend === 'dsh') await entry.manager.wait(taskId, 5000);
      } catch {}
      try { this.pool.markUnknown(handle, { operationId, taskId }); } catch {}
      settleStarting('unknown');
      throw Error(`Post-admission pool bookkeeping failed; the task may have been stopped and its binding is pinned unknown: ${error.message}`);
    }
    // Freeze the exact handle/operation/revision proved at admission. No later
    // lookup may replace it before finalization.
    const record = { rootId, taskId, backend, operationId, revision: admitted.task_revision, handle, entry, decision };
    this.owned.set(taskId, record);
    try { this._writeProof(rootId, key, requestHash, taskId, worker); } catch { /* replay stays conflict-closed */ }
    settleStarting('admitted');
    void this._watchSettlement(record, entry, backend).catch(() => {});
    return this._pack(rootId, decision, null);
  }

  async _watchSettlement(record, entry, backend) {
    let done = null;
    for (let attempt = 0; attempt < 25; attempt++) {
      let receipt = null;
      try { receipt = this._readReceipt(record.rootId, record.decision); } catch {}
      if (receipt && TERMINAL.has(receipt.status)) { await this._settleFrozen(record, receipt); return; }
      if (receipt && ['unknown', 'unknown_after_disconnect'].includes(receipt.status)) { await this._pinUnknownFrozen(record); return; }
      if (backend === 'hy4') done = entry.hy4?.active.get(record.taskId)?.finished ?? null;
      else done = entry.manager.pending.get(record.taskId)
        ?? (entry.manager.active?.record.task_id === record.taskId ? entry.manager.active.finished : null);
      if (done) break;
      await sleep(20);
    }
    if (!done) { await this._pinUnknownFrozen(record); return; }
    let receipt;
    try { receipt = await done; } catch { await this._pinUnknownFrozen(record); return; }
    if (receipt && TERMINAL.has(receipt.status)) await this._settleFrozen(record, receipt);
    else if (receipt && ['unknown', 'unknown_after_disconnect'].includes(receipt.status)) await this._pinUnknownFrozen(record);
    else await this._pinUnknownFrozen(record);
  }

  async _settleFrozen(record, receipt) {
    if (!record || this.owned.get(record.taskId) !== record) return;
    const existing = this.settling.get(record.taskId);
    if (existing) return existing;
    const work = (async () => {
      if (this.owned.get(record.taskId) !== record) return;
      if (!receipt || !TERMINAL.has(receipt.status)) {
        if (receipt && ['unknown', 'unknown_after_disconnect'].includes(receipt.status)) await this._pinUnknownFrozen(record);
        return;
      }
      const entry = record.entry;
      if (record.backend === 'dsh' && entry?.manager.active?.record.task_id === record.taskId) {
        // Lock/child release happens before TaskManager's finished promise.
        for (let attempt = 0; attempt < 20 && entry.manager.active?.record.task_id === record.taskId; attempt++) await sleep(25);
        if (entry.manager.active?.record.task_id === record.taskId) return;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          this.pool.finish(record.handle, { operationId: record.operationId, taskId: record.taskId, revision: record.revision });
          this.owned.delete(record.taskId);
          return;
        } catch (error) {
          if (/lock contention/i.test(error.message) && attempt < 2) { await sleep(30); continue; }
          try {
            const binding = this.pool.snapshot(record.handle);
            if (binding && binding.state === 'idle' && !binding.active_task_id) { this.owned.delete(record.taskId); return; }
          } catch {}
          break;
        }
      }
      await this._pinUnknownFrozen(record);
    })();
    this.settling.set(record.taskId, work);
    try { return await work; } finally { this.settling.delete(record.taskId); }
  }

  async _pinUnknownFrozen(record) {
    if (!record || this.owned.get(record.taskId) !== record) return;
    try {
      this.pool.markUnknown(record.handle, { operationId: record.operationId, taskId: record.taskId, revision: record.revision });
      this.owned.delete(record.taskId);
    } catch {
      try {
        const binding = this.pool.snapshot(record.handle);
        if (binding && (binding.state === 'unknown' || binding.state === 'idle')) this.owned.delete(record.taskId);
      } catch {}
    }
  }

  async run(rootId, args, onAccepted = null) {
    const started = await this.submit(rootId, args);
    if (started.workbuddy_dispatch) return started;
    if (typeof onAccepted === 'function' && started.task_id) onAccepted(started);
    if (started.replayed) return started;
    if (started.receipt && TERMINAL.has(started.receipt.status)) {
      const owned = this.owned.get(started.task_id);
      if (owned) await this._settleFrozen(owned, started.receipt);
      return started;
    }
    const taskId = started.task_id;
    const entry = this.owned.get(taskId)?.entry;
    if (!entry) return this.get(rootId, { taskId });
    const deadline = Date.now() + (args.timeoutMs ?? DSH_TIMEOUT_MS.default) + 5000;
    let receipt = started.receipt ?? this._receipt(entry, { selected_backend: started.backend, task_id: taskId });
    while (!TERMINAL.has(receipt.status) && !['unknown', 'unknown_after_disconnect'].includes(receipt.status) && Date.now() < deadline) {
      receipt = await this._receipt(entry, { selected_backend: started.backend, task_id: taskId }, WAIT_MS.maximum);
    }
    const owned = this.owned.get(taskId);
    if (owned) {
      if (TERMINAL.has(receipt.status)) await this._settleFrozen(owned, receipt);
      else if (['unknown', 'unknown_after_disconnect'].includes(receipt.status)) await this._pinUnknownFrozen(owned);
    }
    return { ...this._pack(rootId, { ...started.routing, selected_backend: started.backend, task_id: taskId, admission_state: 'accepted' }, receipt), task_id: taskId, backend: started.backend };
  }

  _workBuddyForQuery(rootId, query) {
    return query.idempotencyKey !== undefined && query.taskId === undefined
      ? this.workBuddyFor(rootId).lookup(query.idempotencyKey) : null;
  }

  get(rootId, query) {
    const workBuddy = this._workBuddyForQuery(rootId, query);
    if (workBuddy) return workBuddy;
    const { decision } = this._resolveDecision(rootId, query);
    if (decision.admission_state !== 'accepted') return this._pack(rootId, decision, null);
    return this._pack(rootId, decision, this._readReceipt(rootId, decision));
  }

  async wait(rootId, query, waitMs = WAIT_MS.default) {
    validateWaitMs(waitMs);
    const workBuddy = this._workBuddyForQuery(rootId, query);
    if (workBuddy) return workBuddy;
    const { owner, decision } = this._resolveDecision(rootId, query);
    if (decision.admission_state !== 'accepted') return this._pack(rootId, decision, null);
    if (!owner) return this._pack(rootId, decision, this._readReceipt(rootId, decision));
    const receipt = await this._receipt(owner.entry, decision, waitMs);
    // Waiting is an observation. The independently attached terminal watcher
    // performs the only finalization; this call may await that existing work,
    // but never initiates a pool mutation.
    if (TERMINAL.has(receipt.status) && this.settling.has(decision.task_id)) {
      try { await this.settling.get(decision.task_id); } catch {}
    }
    return this._pack(rootId, decision, receipt);
  }

  async cancel(rootId, query) {
    const workBuddy = this._workBuddyForQuery(rootId, query);
    if (workBuddy) {
      return { ...workBuddy, cancelled: false, owner: false, warning: 'The WorkBuddy MCP owns its external task. For an unclaimed handoff use finish_workbuddy_dsf_dispatch with status cancelled.' };
    }
    const { owner: owned, decision } = this._resolveDecision(rootId, query);
    if (decision.admission_state !== 'accepted') throw Error('Routing decision has no accepted task to cancel.');
    if (!owned) {
      let receipt;
      try { receipt = this._readReceipt(rootId, decision); } catch (error) { throw Error(`Task is not owned by this server and its receipt is unavailable: ${error.message}`); }
      return { ...this._pack(rootId, decision, receipt), cancelled: false, owner: false, warning: 'This connection does not own the child process; read-only snapshot only. No kill or pool mutation was performed.' };
    }
    const entry = owned.entry;
    const active = decision.selected_backend === 'hy4'
      ? entry?.hy4?.active.has(decision.task_id)
      : entry?.manager.active?.record.task_id === decision.task_id;
    if (!active) {
      let receipt;
      try { receipt = this._readReceipt(rootId, decision); } catch { receipt = null; }
      if (receipt && TERMINAL.has(receipt.status)) await this._settleFrozen(owned, receipt);
      else await this._pinUnknownFrozen(owned);
      return { ...this._pack(rootId, decision, receipt), cancelled: false, owner: true, warning: 'No live child is owned by this connection; the reservation was pinned/diagnosed without a kill.' };
    }
    let receipt = decision.selected_backend === 'hy4'
      ? await entry.hy4.cancel(decision.task_id, 'mcp_cancel')
      : entry.manager.cancel(decision.task_id, 'mcp_cancel');
    if (!TERMINAL.has(receipt.status)) {
      try { receipt = await this._receipt(entry, decision, 10000); } catch { /* keep the last owned snapshot */ }
    }
    if (TERMINAL.has(receipt.status)) await this._settleFrozen(owned, receipt);
    else await this._pinUnknownFrozen(owned);
    return { ...this._pack(rootId, decision, receipt), cancelled: true, owner: true };
  }

  setSchedule(rootId, mode) {
    this.pool.setSchedule(rootId, mode);
    const root = this.roots.get(rootId);
    if (root) for (const { manager } of root.workers.values()) manager.refreshSchedule();
    return this.status(rootId);
  }

  scheduleStatus(rootId) {
    const mode = rootId ? this.pool.scheduleMode(rootId) : ScheduleMode.UNRESTRICTED;
    return schedulePolicySnapshot(this.schedule, mode, nowIso(this.clock));
  }

  status(rootId) {
    const list = this.pool.list();
    const workers = rootId ? list.bindings.filter(binding => binding.root_id === rootId).map(safeBinding) : [];
    workers.sort((a, b) => a.worker - b.worker);
    const binding = workers.length ? { ...workers[0], workers } : null;
    const schedule = this.scheduleStatus(rootId);
    return {
      server: 'pooled-dsh', transport: 'stdio', backend_default: 'dsh', pool_scope: 'root-chat',
      binding_cap: list.binding_cap, running_cap: list.concurrency, running: list.running,
      bindings: new Set(list.bindings.map(item => item.root_id)).size, worker_bindings: list.bindings.length, root: binding,
      schedule: {
        configured: Boolean(this.schedule), enabled: schedule.enabled, mode: schedule.mode, phase: schedule.phase,
        new_task_backend: schedule.new_task_backend, accept_new_tasks: schedule.accept_new_tasks,
        next_offpeak_at: schedule.next_offpeak_at, hard_stop_at: schedule.hard_stop_at,
        reject_if_budget_exceeds_window: schedule.reject_if_budget_exceeds_window, resume_automatically: false
      },
      write_enabled: this.allowWrite, hy4_configured: Boolean(this.manifest),
      hy4_commands_enabled: Boolean(this.manifest?.allow_commands),
      context_required: true, identity_is_authentication: false
    };
  }

  hasLiveChildren() {
    for (const root of this.roots.values()) {
      if ([...root.workers.values()].some(entry => entry.manager.active)) return true;
      if (root.hy4 && (root.hy4.active.size > 0 || root.hy4.opening.size > 0)) return true;
    }
    return false;
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    // Stop admitting, but let a reservation already in flight reach a proved
    // admission/rejection before deciding. No new query can start work.
    const starts = [...this.starting.values()];
    await Promise.allSettled(starts.map(start => Promise.race([start.done, sleep(5000)])));
    for (const start of [...this.starting.values()]) {
      if (start.state === 'reserved') {
        try { this.pool.reject(start.handle, { operationId: start.operationId, idempotencyKey: start.key }); }
        catch { try { this.pool.markUnknown(start.handle, { operationId: start.operationId }); } catch {} }
        start.state = 'released';
        try { start.resolve?.('released'); } catch {}
        this.starting.delete(start.operationId);
      }
    }
    // Cancel only children this live process owns, with a bounded wait for a
    // terminal proof. If proof cannot be obtained the binding stays pinned.
    await Promise.allSettled([...this.owned.values()].map(async record => {
      const entry = record.entry;
      let receipt = null;
      try {
        if (record.backend === 'hy4' && entry?.hy4?.active.has(record.taskId)) {
          receipt = await entry.hy4.cancel(record.taskId, 'bridge_shutdown');
        } else if (record.backend === 'dsh' && entry?.manager.active?.record.task_id === record.taskId) {
          entry.manager.cancel(record.taskId, 'bridge_shutdown');
          receipt = await entry.manager.wait(record.taskId, 8000);
        } else {
          receipt = this._readReceipt(record.rootId, record.decision);
        }
      } catch {}
      if (receipt && TERMINAL.has(receipt.status)) await this._settleFrozen(record, receipt);
      else await this._pinUnknownFrozen(record);
    }));
    for (const root of this.roots.values()) {
      await Promise.allSettled([...root.workers.values()].map(entry => entry.manager.close()));
      try { if (root.hy4) await root.hy4.close(); } catch {}
    }
    for (const record of [...this.owned.values()]) {
      let receipt = null;
      try { receipt = this._readReceipt(record.rootId, record.decision); } catch {}
      if (receipt && TERMINAL.has(receipt.status)) await this._settleFrozen(record, receipt);
      else await this._pinUnknownFrozen(record);
    }
  }
}

export function resolveTrustedContext(config, reference, { sessionsRoot, clock } = {}) {
  return resolveContext({ config, reference, sessionsRoot, clock });
}
