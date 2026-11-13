// DSH-first routing policy with a narrowly authorized, pre-admission-only HY4 fallback.
//
// This module is intentionally independent of the MCP server and of any live
// WorkBuddy bridge. It is a reviewable candidate policy: the default HY4
// adapter is fail-closed because no verified local HY4 route exists. Tests use
// an injected mock adapter; a mock success is not evidence of real HY4 access.
//
// Invariants:
//   * DSH remains the default backend and an explicit DSH session stays explicit.
//   * HY4 is used for a fallback only after a structured pre-admission rejection
//     whose code is in the closed eligibility set, with explicit local
//     authorization, and only once.
//   * Any accepted, running, unknown, timeout, disconnect, permission, parameter,
//     busy/lock, or stop condition is never routed to HY4.
//   * Routing decisions never store the prompt, credentials, or a raw error text.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeTaskAuthorization, safeWriteMetadata } from '../hy4/policy.mjs';

export const ROUTING_POLICY_VERSION = '2026-11-13.hy4-preadmission-r1';

// Closed vocabulary. New codes require a policy review; callers must never
// infer a code by matching a generic error message.
export const AdmissionCode = Object.freeze({
  INVALID_PARAMS: 'DSH_INVALID_PARAMS',
  PERMISSION_REFUSED: 'DSH_PERMISSION_REFUSED',
  SESSION_CONFLICT: 'DSH_SESSION_CONFLICT',
  BUSY: 'DSH_BUSY',
  LOCKED: 'DSH_LOCKED',
  SCHEDULE_GATE: 'DSH_SCHEDULE_GATE',
  PRE_ACCEPTANCE_UNAVAILABLE: 'DSH_PRE_ACCEPTANCE_UNAVAILABLE',
  PREFLIGHT_FAILED: 'DSH_PREFLIGHT_FAILED',
  UNKNOWN: 'DSH_ADMISSION_UNKNOWN',
  DSH_ADMITTED: 'DSH_ADMITTED',
  HY4_EXPLICIT_ADMITTED: 'HY4_EXPLICIT_ADMITTED',
  HY4_FALLBACK_ADMITTED: 'HY4_FALLBACK_ADMITTED',
  HY4_UNAVAILABLE: 'HY4_UNAVAILABLE',
  FALLBACK_NOT_AUTHORIZED: 'FALLBACK_NOT_AUTHORIZED'
});

const PRE_ACCEPTANCE_CAUSES = new Set(['auth_rejected', 'quota_exhausted', 'provider_unreachable']);
const DSH_PRE_ACCEPTANCE_CODES = new Set([AdmissionCode.SCHEDULE_GATE, AdmissionCode.PRE_ACCEPTANCE_UNAVAILABLE]);

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const now = () => new Date().toISOString();
const safeKeyHash = key => sha256(`idempotency:${key}`);

const SAFE_REASON = Object.freeze({
  [AdmissionCode.INVALID_PARAMS]: 'Task input failed local validation before any backend call.',
  [AdmissionCode.PERMISSION_REFUSED]: 'The requested permission mode is not locally authorized.',
  [AdmissionCode.SESSION_CONFLICT]: 'DSH session ownership could not be proven locally.',
  [AdmissionCode.BUSY]: 'The DSH instance already has an active task.',
  [AdmissionCode.LOCKED]: 'A live or unknown DSH instance lock exists.',
  [AdmissionCode.SCHEDULE_GATE]: 'The local DSH schedule gate rejected new work before admission.',
  [AdmissionCode.PRE_ACCEPTANCE_UNAVAILABLE]: 'A supported pre-admission check reported provider unavailability.',
  [AdmissionCode.PREFLIGHT_FAILED]: 'The local DSH preflight check failed before task acceptance.',
  [AdmissionCode.UNKNOWN]: 'Task acceptance is unknown; no fallback or retry is allowed.',
  [AdmissionCode.HY4_UNAVAILABLE]: 'HY4 has no verified local route; no fallback was accepted.',
  [AdmissionCode.FALLBACK_NOT_AUTHORIZED]: 'HY4 fallback is not explicitly authorized on this machine.'
});
const HY4_SAFE_CODES = new Set(['HY4_ROUTE_UNVERIFIED', 'HY4_STATUS_FAILED', 'HY4_UNAVAILABLE']);
const SAFE_TASK_STATUS = new Set(['starting', 'running', 'completed', 'failed', 'cancelled', 'accepted']);
const safeReason = code => SAFE_REASON[code] || 'Routing rejected the request before task acceptance.';
const safeHy4Code = code => HY4_SAFE_CODES.has(code) ? code : 'HY4_ROUTE_UNVERIFIED';
const safeTaskStatus = value => typeof value === 'string' && SAFE_TASK_STATUS.has(value) ? value : null;
const safeTaskId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : null;

// A failure that this bridge can prove happened before task acceptance. The
// `admission_state` is part of the object, not inferred from the message.
export class PreAdmissionRejection extends Error {
  constructor(code, message, { details = {}, evidence = null } = {}) {
    super(message);
    this.name = 'PreAdmissionRejection';
    this.code = code;
    this.admission_state = 'not_accepted';
    this.details = details && typeof details === 'object' ? { ...details } : {};
    this.evidence = evidence && typeof evidence === 'object' ? { ...evidence } : null;
    this.fallback_eligible = isFallbackEligible(this);
  }
}

export function isFallbackEligible(value) {
  if (!(value instanceof PreAdmissionRejection) || value.admission_state !== 'not_accepted') return false;
  if (!DSH_PRE_ACCEPTANCE_CODES.has(value.code)) return false;
  if (value.code === AdmissionCode.SCHEDULE_GATE) return true;
  // A provider auth/quota probe is eligible only when trusted code records that
  // it was supported, that no task was accepted, and a concrete cause. No such
  // probe is wired into the installed bridge.
  const evidence = value.evidence;
  return Boolean(evidence && evidence.provider_check === 'supported' && evidence.task_accepted === false
    && PRE_ACCEPTANCE_CAUSES.has(evidence.cause));
}

export class Hy4UnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'Hy4UnavailableError';
    this.code = AdmissionCode.HY4_UNAVAILABLE;
    this.admission_state = 'not_accepted';
    this.details = { ...details };
  }
}

// Default adapter: fail closed with the exact missing entry. It never invokes
// CodeBuddy, never reads vendor configuration, and never fabricates a task.
export class UnavailableWorkBuddyHy4 {
  constructor({ model = 'hy4free' } = {}) { this.model = model; }
  status() {
    return {
      backend: 'hy4',
      ready: false,
      model: this.model,
      reason_code: 'HY4_ROUTE_UNVERIFIED',
      missing_entry: 'A vendor-supported local route that explicitly selects hy4free and documents a narrow permission contract. The optional CodeBuddy ACP adapter exists separately but this default fail-closed adapter has no local manifest/readiness proof.',
      local_evidence: {
        evidence_scope: 'reference machine 2026-11-13; not rechecked on this host',
        workbuddy_desktop: '5.9.3',
        bundled_codebuddy: '2.165.0',
        static_model_list_includes_hy4_preview: false,
        acp_flag_advertised: true,
        model_availability_proven: false,
        provider_mapping_invented: false,
        vendor_config_or_credentials_read: false
      },
      next_step: 'Use the optional CodeBuddy ACP adapter with a local manifest, or another vendor-supported route that explicitly selects hy4free, documents permission handling, and verifies it without extracting GUI tokens, adding bypass flags, or changing approval settings.'
    };
  }
  async submit() {
    const status = this.status();
    throw new Hy4UnavailableError(`HY4 is unavailable: ${status.missing_entry}`, status);
  }
}

export const FALLBACK_DISABLED = Object.freeze({
  schema: 1,
  enabled: false,
  authorization_ref: null,
  scope: 'pre_admission_only',
  max_attempts: 0
});

export function validateFallbackAuthorization(value) {
  if (value === undefined || value === null) return FALLBACK_DISABLED;
  if (typeof value !== 'object' || Array.isArray(value)) throw Error('Fallback authorization must be an object.');
  const allowed = new Set(['schema', 'enabled', 'authorization_ref', 'scope', 'max_attempts']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw Error(`Unknown fallback authorization field: ${key}`);
  if (value.enabled === false) return FALLBACK_DISABLED;
  if (value.schema !== 1) throw Error('Fallback authorization schema must be 1.');
  if (value.enabled !== true) throw Error('Fallback authorization must set enabled: true explicitly.');
  if (typeof value.authorization_ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/.test(value.authorization_ref)
    || /^(?:sk-|ghp_|github_pat_|Bearer)/i.test(value.authorization_ref)) {
    throw Error('authorization_ref must be a non-secret 1..120 character local approval reference.');
  }
  if (value.scope !== 'pre_admission_only') throw Error('Fallback authorization scope must be pre_admission_only.');
  if (value.max_attempts !== 1) throw Error('Fallback authorization permits exactly one attempt.');
  return Object.freeze({ schema: 1, enabled: true, authorization_ref: value.authorization_ref, scope: 'pre_admission_only', max_attempts: 1 });
}

export class RoutingConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoutingConflictError';
    this.code = 'ROUTING_IDEMPOTENCY_CONFLICT';
    this.admission_state = 'not_accepted';
  }
}

export class RoutingDecisionError extends Error {
  constructor(code, message, decision, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RoutingDecisionError';
    this.code = code;
    this.admission_state = decision?.admission_state ?? 'unknown';
    this.decision = decision ?? null;
  }
}

function basicTask(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'Task must be an object.');
  const allowed = new Set(['prompt', 'cwd', 'idempotencyKey', 'timeoutMs', 'permissionMode', 'authorizationNote', 'sessionId', 'capability', 'writes', 'writeScopes', 'commands']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, `Unknown task field: ${key}`);
  }
  if (value.capability !== undefined && !['default', 'text-only', 'workspace-read', 'workspace-write'].includes(value.capability)) {
    throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'capability must be default, text-only, workspace-read or workspace-write.');
  }
  for (const [key, limit] of [['writes', 32], ['writeScopes', 32], ['commands', 32]]) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > limit)) {
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, `${key} must be an array of at most ${limit} entries.`);
    }
  }
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || Buffer.byteLength(value.prompt) > 60000) {
    throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'prompt must contain 1..60000 UTF-8 bytes.');
  }
  if (typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)) throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'cwd must be an absolute path.');
  let cwd;
  try {
    cwd = (fs.realpathSync.native || fs.realpathSync)(value.cwd);
    if (!fs.statSync(cwd).isDirectory()) throw Error('not a directory');
  } catch {
    throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'cwd must be an existing directory.');
  }
  if (typeof value.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(value.idempotencyKey)) {
    throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'idempotencyKey must contain 1..100 safe ASCII characters.');
  }
  const permissionMode = value.permissionMode ?? 'read-only';
  if (!['read-only', 'workspace-write'].includes(permissionMode)) {
    throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'Only read-only and workspace-write are supported.');
  }
  const timeoutMs = value.timeoutMs ?? 900000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) {
    throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'timeoutMs must be an integer between 1000 and 3600000.');
  }
  if (value.authorizationNote !== undefined && (typeof value.authorizationNote !== 'string' || Buffer.byteLength(value.authorizationNote) > 2000)) {
    throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'authorizationNote must be a string up to 2000 UTF-8 bytes.');
  }
  if (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value.sessionId))) {
    throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'Invalid sessionId.');
  }
  let authorization;
  try {
    authorization = normalizeTaskAuthorization({
      cwd, permissionMode, capability: value.capability ?? 'default',
      writes: value.writes, writeScopes: value.writeScopes, commands: value.commands
    });
  } catch (error) {
    throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, error.message);
  }
  return {
    ...value, cwd, permissionMode, timeoutMs,
    writes: authorization.writes,
    writeScopes: authorization.writeScopes,
    commands: authorization.commands
  };
}

function fingerprint(task, { sessionMode, requestedBackend, continuationOfTaskId, repairOfTaskId, taskCapability }) {
  return sha256(JSON.stringify({
    prompt_sha256: sha256(task.prompt),
    cwd: task.cwd,
    idempotencyKey: task.idempotencyKey,
    timeoutMs: task.timeoutMs,
    permissionMode: task.permissionMode,
    sessionId: task.sessionId ?? null,
    authorizationNote: typeof task.authorizationNote === 'string' ? task.authorizationNote : '',
    session_mode: sessionMode,
    requested_backend: requestedBackend,
    task_capability: taskCapability,
    write_scopes: (task.writeScopes ?? []).map(scope => ({ path: scope.path, operations: scope.operations })),
    writes: (task.writes ?? []).map(write => ({ path: write.path, mode: write.mode, content_sha256: write.content_sha256 ?? null })),
    commands: task.commands ?? [],
    continuation_of_task_id: continuationOfTaskId ?? null,
    repair_of_task_id: repairOfTaskId ?? null
  }));
}

function taskIdOf(record) {
  return safeTaskId(record?.task_id);
}

function withoutCapability(task) {
  const copy = { ...task };
  delete copy.capability;
  delete copy.writes;
  delete copy.writeScopes;
  delete copy.commands;
  return copy;
}

export class RoutingCoordinator {
  constructor({ runtime, dsh, hy4 = new UnavailableWorkBuddyHy4(), authorization = null, clock = () => new Date(), liveMcpDispatchWired = false } = {}) {
    if (!runtime) throw Error('RoutingCoordinator requires a runtime directory.');
    if (!dsh || typeof dsh.submit !== 'function') throw Error('RoutingCoordinator requires a DSH submit adapter.');
    if (!hy4 || typeof hy4.submit !== 'function' || typeof hy4.status !== 'function') throw Error('RoutingCoordinator requires an HY4 adapter with submit() and status().');
    this.runtime = path.resolve(runtime);
    this.dsh = dsh;
    this.hy4 = hy4;
    this.authorization = validateFallbackAuthorization(authorization);
    this.clock = clock;
    this.liveMcpDispatchWired = Boolean(liveMcpDispatchWired);
    this.inflight = new Map();
    fs.mkdirSync(path.join(this.runtime, 'routing'), { recursive: true, mode: 0o700 });
  }

  decisionPath(key) { return path.join(this.runtime, 'routing', `${safeKeyHash(key)}.json`); }
  claimPath(key) { return path.join(this.runtime, 'routing', `${safeKeyHash(key)}.claim`); }

  // Durable, cross-process exclusion. The claim is never deleted automatically;
  // a crash or partial write therefore becomes a permanent fail-closed marker.
  _claim(key, requestId) {
    const file = this.claimPath(key);
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (error) {
      let prior = null;
      try { prior = this.get(key); } catch {}
      throw new RoutingDecisionError(error.code === 'EEXIST' ? 'ROUTING_IN_FLIGHT_OR_UNKNOWN' : 'ROUTING_CLAIM_FAILED',
        'A durable dispatch claim already exists or could not be acquired; no backend was called and no retry is allowed.', prior, { cause: error });
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ schema: 1, request_id: requestId, state: 'dispatching', pid: process.pid, created_at: now() }) + '\n');
      fs.fsyncSync(fd);
    } catch (error) {
      // Leave the claim in place: a failed write must not unlock a retry.
      throw new RoutingDecisionError('ROUTING_CLAIM_FAILED', 'The dispatch claim could not be persisted; no backend was called.', null, { cause: error });
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
  }

  get(idempotencyKey) {
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(idempotencyKey)) {
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'Invalid idempotencyKey for routing lookup.');
    }
    const file = this.decisionPath(idempotencyKey);
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw Error(`Routing decision ${file} is unreadable; refusing to guess admission state.`);
    }
  }

  _write(decision) {
    const file = this.decisionPath(decision.idempotency_key);
    decision.updated_at = now();
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(decision, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  _newDecision({ task, fingerprintValue, sessionMode, requestedBackend, requestId, taskCapability }) {
    return {
      schema: 1,
      policy_version: ROUTING_POLICY_VERSION,
      request_id: requestId,
      idempotency_key: task.idempotencyKey,
      idempotency_key_sha256: safeKeyHash(task.idempotencyKey),
      request_fingerprint: fingerprintValue,
      session_mode: sessionMode,
      requested_backend: requestedBackend,
      selected_backend: requestedBackend,
      task_capability: taskCapability,
      authorized_writes: task.writes?.length ?? 0,
      ...safeWriteMetadata(task),
      admission_state: 'not_accepted',
      reason_code: null,
      reason: null,
      task_id: null,
      prompt_sha256: sha256(task.prompt),
      cwd: task.cwd,
      permission_mode: task.permissionMode,
      fallback: {
        authorized: this.authorization.enabled,
        authorization_ref: this.authorization.authorization_ref,
        eligible: false,
        blocked_reason: null,
        attempted: false,
        hy4_ready: null,
        result: 'not_attempted'
      },
      dsh: { state: 'not_attempted', code: null, task_id: null },
      hy4: { state: 'not_attempted', code: null, task_id: null },
      created_at: now(),
      updated_at: now()
    };
  }

  _fail(decision, code, message, { cause } = {}) {
    decision.reason_code = code;
    decision.reason = message;
    decision.updated_at = now();
    this._write(decision);
    throw new RoutingDecisionError(code, message, decision, { cause });
  }

  status() {
    let hy4;
    try { hy4 = this.hy4.status(); }
    catch { hy4 = { backend: 'hy4', ready: false, reason_code: 'HY4_STATUS_FAILED' }; }
    return {
      policy_version: ROUTING_POLICY_VERSION,
      default_backend: 'dsh',
      live_mcp_dispatch_wired: this.liveMcpDispatchWired,
      candidate_only: !this.liveMcpDispatchWired,
      fallback_authorization: {
        enabled: this.authorization.enabled,
        authorization_ref: this.authorization.authorization_ref,
        scope: this.authorization.scope,
        max_attempts: this.authorization.max_attempts
      },
      eligible_before_acceptance: [...DSH_PRE_ACCEPTANCE_CODES],
      never_after_acceptance: true,
      pre_admission_probe_supported: false,
      hy4
    };
  }

  async submit(taskInput, options = {}) {
    const task = basicTask(taskInput);
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'Options must be an object.');
    const allowedOptions = new Set(['sessionMode', 'requestedBackend', 'preAdmissionProbe', 'allowWorkspaceWrite', 'continuationOfTaskId', 'repairOfTaskId', 'taskCapability']);
    for (const key of Object.keys(options)) if (!allowedOptions.has(key)) throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, `Unknown routing option: ${key}`);
    const sessionMode = options.sessionMode ?? 'DSH';
    if (!['DSH', 'HY4'].includes(sessionMode)) {
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, `Routing policy supports session modes DSH and HY4, not "${sessionMode}".`);
    }
    const requestedBackend = options.requestedBackend ?? (sessionMode === 'HY4' ? 'hy4' : 'dsh');
    if (!['dsh', 'hy4'].includes(requestedBackend)) throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'requestedBackend must be dsh or hy4.');
    if (sessionMode === 'HY4' && requestedBackend !== 'hy4') throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'Explicit HY4 selection cannot be redirected to DSH by this policy.');
    if (sessionMode === 'DSH' && requestedBackend === 'hy4') throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'A DSH session must not request HY4 as its primary backend; HY4 is fallback-only here.');
    if (options.preAdmissionProbe !== undefined && typeof options.preAdmissionProbe !== 'function') {
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'preAdmissionProbe must be a function.');
    }
    if (options.allowWorkspaceWrite !== undefined && typeof options.allowWorkspaceWrite !== 'boolean') {
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'allowWorkspaceWrite must be boolean.');
    }
    if (options.taskCapability !== undefined && task.capability !== undefined && options.taskCapability !== task.capability) {
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'taskCapability conflicts with task.capability.');
    }
    const taskCapability = options.taskCapability ?? task.capability ?? 'default';
    if (!['default', 'text-only', 'workspace-read', 'workspace-write'].includes(taskCapability)) {
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'taskCapability must be default, text-only, workspace-read or workspace-write.');
    }
    if (task.permissionMode === 'workspace-write' && taskCapability !== 'workspace-write') {
      throw new PreAdmissionRejection(AdmissionCode.PERMISSION_REFUSED, 'Workspace writes require the explicit workspace-write capability.');
    }
    if (task.permissionMode === 'workspace-write' && (options.allowWorkspaceWrite !== true || !task.authorizationNote)) {
      throw new PreAdmissionRejection(AdmissionCode.PERMISSION_REFUSED, 'Workspace writes require local routing allowWorkspaceWrite AND an explicit user-approval reference.');
    }
    if (taskCapability === 'workspace-write' && task.permissionMode !== 'workspace-write') {
      throw new PreAdmissionRejection(AdmissionCode.PERMISSION_REFUSED, 'The workspace-write capability requires workspace-write permission; it cannot be downgraded to read-only.');
    }
    if ((task.writes.length > 0 || task.writeScopes.length > 0 || task.commands.length > 0) && (task.permissionMode !== 'workspace-write' || taskCapability !== 'workspace-write')) {
      throw new PreAdmissionRejection(AdmissionCode.PERMISSION_REFUSED, 'The supplied write/command scope requires workspace-write capability and permission.');
    }
    for (const field of ['continuationOfTaskId', 'repairOfTaskId']) {
      if (options[field] !== undefined && (typeof options[field] !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(options[field]))) {
        throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, `${field} must be a safe task ID.`);
      }
    }
    const continuationOfTaskId = options.continuationOfTaskId ?? null;
    const repairOfTaskId = options.repairOfTaskId ?? null;
    const noFallback = Boolean(task.sessionId || continuationOfTaskId || repairOfTaskId);
    if (noFallback && (sessionMode === 'HY4' || requestedBackend === 'hy4')) {
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'A session continuation/repair cannot be routed to HY4; a new approved cwd is a new HY4 session.');
    }

    const fp = fingerprint(task, { sessionMode, requestedBackend, continuationOfTaskId, repairOfTaskId, taskCapability });
    const keyHash = safeKeyHash(task.idempotencyKey);
    const pending = this.inflight.get(keyHash);
    if (pending) {
      if (pending.fingerprint !== fp) throw new RoutingConflictError('A concurrent request used the same idempotency key with different arguments or routing mode.');
      return await pending.promise;
    }
    const prior = this.get(task.idempotencyKey);
    if (prior) {
      // In-flight/unknown wins over fingerprint comparison: never disclose or
      // resubmit against an admission state that may already have side effects.
      if (prior.admission_state === 'dispatching') {
        throw new RoutingDecisionError('ROUTING_IN_FLIGHT_OR_UNKNOWN', 'A routing decision for this idempotency key is in flight or its admission is unknown. Do not resubmit or fall back; inspect the decision receipt.', prior);
      }
      if (typeof prior.request_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(prior.request_fingerprint)) {
        throw new RoutingDecisionError('ROUTING_LEGACY_UNVERIFIABLE', 'The prior routing decision predates scope identity and cannot be replayed safely. Read it only; do not resubmit.', prior);
      }
      if (prior.request_fingerprint !== fp) throw new RoutingConflictError(`Idempotency key already used with different arguments or routing mode for request ${prior.request_id}.`);
      if (prior.admission_state === 'accepted') return prior;
      throw new RoutingDecisionError(prior.reason_code || AdmissionCode.UNKNOWN, `Routing decision ${prior.request_id} is ${prior.admission_state}; no silent success or automatic resubmission.`, prior);
    }
    const requestId = crypto.randomUUID();
    this._claim(task.idempotencyKey, requestId);
    const work = this._dispatch({ task, fingerprintValue: fp, sessionMode, requestedBackend, requestId, noFallback, taskCapability, probe: options.preAdmissionProbe });
    const entry = { fingerprint: fp, promise: work };
    this.inflight.set(keyHash, entry);
    try { return await work; }
    finally { if (this.inflight.get(keyHash) === entry) this.inflight.delete(keyHash); }
  }

  async _dispatch({ task, fingerprintValue, sessionMode, requestedBackend, requestId, noFallback, taskCapability, probe }) {
    const decision = this._newDecision({ task, fingerprintValue, sessionMode, requestedBackend, requestId, taskCapability });
    // The durable claim already exists. Publish the in-flight admission state
    // before the first probe/DSH/HY4 call, not after it.
    decision.admission_state = 'dispatching';
    this._write(decision);
    if (requestedBackend === 'hy4') {
      if (!['text-only', 'workspace-read', 'workspace-write'].includes(taskCapability)) {
        decision.admission_state = 'not_accepted';
        return this._fail(decision, AdmissionCode.INVALID_PARAMS, 'HY4 requires an explicit text-only, workspace-read or workspace-write capability.');
      }
      if (this.hy4.supports && !this.hy4.supports(taskCapability)) {
        decision.admission_state = 'not_accepted';
        return this._fail(decision, AdmissionCode.PERMISSION_REFUSED, 'The requested HY4 capability is not enabled by local policy.');
      }
      return this._hy4Direct(decision, { ...task, capability: taskCapability });
    }

    // Optional trusted pre-admission auth/quota probe. It must never run for a
    // session continuation/repair or an unauthorized write request.
    if (typeof probe === 'function' && !noFallback) {
      let result;
      try { result = await probe(); } catch { result = null; }
      if (result && result.available === false) {
        const rejection = new PreAdmissionRejection(AdmissionCode.PRE_ACCEPTANCE_UNAVAILABLE,
          'The supported DSH pre-admission probe reported provider unavailability before task submission.',
          { evidence: { provider_check: 'supported', task_accepted: false, cause: result.cause } });
        decision.dsh = { state: 'not_accepted', code: rejection.code, task_id: null };
        decision.admission_state = 'not_accepted';
        decision.reason_code = rejection.code;
        decision.reason = safeReason(rejection.code);
        if (!isFallbackEligible(rejection)) {
          decision.updated_at = now();
          this._write(decision);
          throw new RoutingDecisionError(rejection.code,
            'The pre-admission probe did not return a recognized, supported cause; no HY4 fallback was attempted.', decision, { cause: rejection });
        }
        return this._fallback(decision, rejection, task);
      }
    }

    let record;
    try { record = await this.dsh.submit(withoutCapability(task)); }
    catch (error) {
      if (error instanceof PreAdmissionRejection) {
        decision.dsh = { state: 'not_accepted', code: error.code, task_id: null };
        decision.admission_state = 'not_accepted';
        decision.reason_code = error.code;
        decision.reason = safeReason(error.code);
        decision.fallback.eligible = isFallbackEligible(error);
        if (noFallback) {
          decision.fallback.eligible = false;
          decision.fallback.blocked_reason = 'session_continuation_or_repair_is_dsh_only';
          decision.updated_at = now();
          this._write(decision);
          throw new RoutingDecisionError(error.code, `DSH rejected a session continuation/repair before acceptance (${error.code}); HY4 fallback is forbidden for this request.`, decision, { cause: error });
        }
        if (!isFallbackEligible(error)) {
          decision.updated_at = now();
          this._write(decision);
          throw new RoutingDecisionError(error.code, `DSH rejected the task before acceptance (${error.code}); no HY4 fallback applies.`, decision, { cause: error });
        }
        return this._fallback(decision, error, task);
      }
      // An unstructured failure may have happened after spawn. Acceptance cannot
      // be ruled out, so no fallback and no retry.
      decision.admission_state = 'unknown';
      decision.dsh = { state: 'unknown', code: AdmissionCode.UNKNOWN, task_id: null };
      return this._fail(decision, AdmissionCode.UNKNOWN,
        'DSH submission failed without a structured pre-admission rejection; task acceptance cannot be ruled out. No HY4 fallback.', { cause: error });
    }

    const taskId = taskIdOf(record);
    if (!taskId) {
      decision.admission_state = 'unknown';
      decision.dsh = { state: 'unknown', code: AdmissionCode.UNKNOWN, task_id: null };
      return this._fail(decision, AdmissionCode.UNKNOWN,
        'DSH adapter returned without a valid task ID; admission is unknown. No HY4 fallback.');
    }
    decision.admission_state = 'accepted';
    decision.selected_backend = 'dsh';
    decision.reason_code = AdmissionCode.DSH_ADMITTED;
    decision.reason = 'DSH accepted the task before any fallback decision. Backend is locked to DSH.';
    decision.task_id = taskId;
    decision.dsh = { state: 'accepted', code: null, task_id: taskId, status: safeTaskStatus(record.status) };
    decision.updated_at = now();
    this._write(decision);
    return decision;
  }

  async _hy4Direct(decision, task) {
    if (!['text-only', 'workspace-read', 'workspace-write'].includes(decision.task_capability)) {
      decision.admission_state = 'not_accepted';
      return this._fail(decision, AdmissionCode.INVALID_PARAMS, 'HY4 requires an explicit supported capability.');
    }
    if (this.hy4.supports && !this.hy4.supports(decision.task_capability)) {
      decision.admission_state = 'not_accepted';
      return this._fail(decision, AdmissionCode.PERMISSION_REFUSED, 'The requested HY4 capability is not enabled by local policy.');
    }
    decision.selected_backend = 'hy4';
    decision.reason_code = 'EXPLICIT_HY4_SELECTION';
    decision.reason = 'The caller explicitly selected HY4; this policy never redirects it to DSH.';
    decision.updated_at = now();
    this._write(decision);
    let status;
    try { status = this.hy4.status(); } catch { status = { ready: false, reason_code: 'HY4_STATUS_FAILED' }; }
    if (!status?.ready && typeof this.hy4.probe === 'function') {
      try { status = await this.hy4.probe(); } catch { status = { ready: false, reason_code: 'HY4_STATUS_FAILED' }; }
    }
    decision.fallback.hy4_ready = Boolean(status?.ready);
    if (!status?.ready) {
      decision.admission_state = 'not_accepted';
      decision.hy4 = { state: 'unavailable', code: safeHy4Code(status?.reason_code), task_id: null };
      decision.selected_backend = 'hy4';
      return this._fail(decision, AdmissionCode.HY4_UNAVAILABLE,
        'HY4 was explicitly selected but no verified local route is ready. No DSH fallback was attempted.');
    }
    decision.hy4 = { state: 'attempting', code: null, task_id: null };
    decision.admission_state = 'dispatching';
    this._write(decision);
    let record;
    try { record = await this.hy4.submit(task); }
    catch (error) {
      if (error instanceof Hy4UnavailableError) {
        decision.admission_state = 'not_accepted';
        decision.hy4 = { state: 'not_accepted', code: safeHy4Code(error.code), task_id: null };
        return this._fail(decision, AdmissionCode.HY4_UNAVAILABLE, 'HY4 is unavailable; no task was accepted.', { cause: error });
      }
      decision.admission_state = 'unknown';
      decision.hy4 = { state: 'unknown', code: 'HY4_ADMISSION_UNKNOWN', task_id: null };
      return this._fail(decision, AdmissionCode.UNKNOWN, 'HY4 submission failed without structured proof of non-acceptance. No retry or backend switch.', { cause: error });
    }
    const taskId = taskIdOf(record);
    if (!taskId) {
      decision.admission_state = 'unknown';
      decision.hy4 = { state: 'unknown', code: 'HY4_ADMISSION_UNKNOWN', task_id: null };
      return this._fail(decision, AdmissionCode.UNKNOWN, 'HY4 adapter returned without a valid task ID; admission is unknown. No retry.');
    }
    decision.admission_state = 'accepted';
    decision.task_id = taskId;
    decision.reason_code = AdmissionCode.HY4_EXPLICIT_ADMITTED;
    decision.hy4 = { state: 'accepted', code: null, task_id: taskId, status: safeTaskStatus(record.status) };
    decision.updated_at = now();
    this._write(decision);
    return decision;
  }

  async _fallback(decision, rejection, task) {
    decision.fallback.eligible = true;
    // DSH (or the supported probe) positively proved non-admission. Record that
    // proof; a HY4 attempt below transitions back to dispatching before it runs.
    decision.admission_state = 'not_accepted';
    if (decision.fallback.blocked_reason) {
      return this._fail(decision, AdmissionCode.PERMISSION_REFUSED,
        'This request is a DSH session continuation/repair and is locked to DSH; no HY4 fallback is allowed.');
    }
    if (decision.dsh.state === 'not_attempted') {
      decision.dsh = { state: 'not_accepted', code: rejection.code, task_id: null };
    }
    decision.reason_code = rejection.code;
    decision.reason = safeReason(rejection.code);
    // Durable proof of non-admission before any HY4 authorization/readiness
    // check. If the process stops here, no backend accepted the task.
    this._write(decision);
    if (!['text-only', 'workspace-read', 'workspace-write'].includes(decision.task_capability)) {
      decision.fallback.eligible = false;
      decision.selected_backend = 'none';
      return this._fail(decision, AdmissionCode.PERMISSION_REFUSED,
        'HY4 fallback requires an explicit supported capability; default/ordinary read-only work is not eligible.', { cause: rejection });
    }
    if (this.hy4.supports && !this.hy4.supports(decision.task_capability)) {
      decision.fallback.eligible = false;
      decision.selected_backend = 'none';
      return this._fail(decision, AdmissionCode.PERMISSION_REFUSED, 'The requested HY4 capability is not enabled by local policy.', { cause: rejection });
    }
    if (!this.authorization.enabled) {
      decision.selected_backend = 'none';
      return this._fail(decision, AdmissionCode.FALLBACK_NOT_AUTHORIZED,
        `DSH rejected before acceptance (${rejection.code}), but HY4 fallback is not explicitly authorized on this machine.`, { cause: rejection });
    }

    let status;
    try { status = this.hy4.status(); } catch { status = { ready: false, reason_code: 'HY4_STATUS_FAILED' }; }
    if (!status?.ready && typeof this.hy4.probe === 'function') {
      try { status = await this.hy4.probe(); } catch { status = { ready: false, reason_code: 'HY4_STATUS_FAILED' }; }
    }
    decision.fallback.hy4_ready = Boolean(status?.ready);
    if (!status?.ready) {
      decision.selected_backend = 'none';
      decision.fallback.result = 'unavailable';
      decision.hy4 = { state: 'unavailable', code: safeHy4Code(status?.reason_code), task_id: null };
      return this._fail(decision, AdmissionCode.HY4_UNAVAILABLE,
        `DSH rejected before acceptance (${rejection.code}); HY4 has no verified local route.`, { cause: rejection });
    }

    decision.fallback.attempted = true;
    decision.selected_backend = 'hy4';
    decision.hy4 = { state: 'attempting', code: null, task_id: null };
    decision.admission_state = 'dispatching';
    // Persist the HY4 transition before invoking it. If this write fails, the
    // durable claim remains and no retry is possible.
    this._write(decision);
    let record;
    try { record = await this.hy4.submit({ ...task, capability: decision.task_capability }); }
    catch (error) {
      if (error instanceof Hy4UnavailableError) {
        decision.admission_state = 'not_accepted';
        decision.selected_backend = 'none';
        decision.fallback.result = 'not_accepted';
        decision.hy4 = { state: 'not_accepted', code: safeHy4Code(error.code), task_id: null };
        return this._fail(decision, AdmissionCode.HY4_UNAVAILABLE, 'HY4 fallback is unavailable; no task was accepted.', { cause: error });
      }
      decision.admission_state = 'unknown';
      decision.selected_backend = 'none';
      decision.fallback.result = 'unknown';
      decision.hy4 = { state: 'unknown', code: 'HY4_ADMISSION_UNKNOWN', task_id: null };
      return this._fail(decision, AdmissionCode.UNKNOWN, 'HY4 fallback failed without structured proof of non-acceptance. No retry and no return to DSH.', { cause: error });
    }
    const taskId = taskIdOf(record);
    if (!taskId) {
      decision.admission_state = 'unknown';
      decision.selected_backend = 'none';
      decision.fallback.result = 'unknown';
      decision.hy4 = { state: 'unknown', code: 'HY4_ADMISSION_UNKNOWN', task_id: null };
      return this._fail(decision, AdmissionCode.UNKNOWN, 'HY4 fallback returned without a valid task ID; admission is unknown. No retry and no return to DSH.');
    }
    decision.admission_state = 'accepted';
    decision.fallback.result = 'accepted';
    decision.task_id = taskId;
    decision.reason_code = AdmissionCode.HY4_FALLBACK_ADMITTED;
    decision.reason = `DSH rejected before acceptance (${rejection.code}); one explicitly authorized HY4 fallback was accepted. Backend is locked to HY4.`;
    decision.hy4 = { state: 'accepted', code: null, task_id: taskId, status: safeTaskStatus(record.status) };
    decision.updated_at = now();
    this._write(decision);
    return decision;
  }
}
