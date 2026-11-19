import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AdmissionCode, PreAdmissionRejection, RoutingConflictError } from '../dsh/routing.mjs';

export const WORKBUDDY_DSF = Object.freeze({
  backend: 'workbuddy-dsf',
  server_name: 'deepseek-v4-flash-workbuddy',
  model: 'deepseek-v4-flash',
  status_tool: 'get_task_bridge_status',
  run_tool: 'run_workbuddy_task'
});

const KEY = /^[A-Za-z0-9_.:-]{1,100}$/;
const TASK_ID = /^[A-Za-z0-9_.:@/-]{1,160}$/;
const PENDING = 'workbuddy_pending';
const CLAIMED = 'workbuddy_claimed';
const UNKNOWN = 'unknown_after_disconnect';
const BEFORE_CLAIM = ['unavailable', 'refused', 'cancelled'];
const AFTER_CLAIM = ['completed', 'failed', 'refused', 'cancelled', 'timed_out', UNKNOWN];
export const WORKBUDDY_FAILURE = ['unavailable', 'expired', 'refused', 'cancelled', 'failed', 'timed_out', UNKNOWN];

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const scopeHash = cwd => digest(process.platform === 'win32' ? cwd.toLowerCase() : cwd);

export function validateWorkBuddyContinuation(task) {
  if (task.workBuddyContinuationKey === undefined) return;
  if (typeof task.workBuddyContinuationKey !== 'string' || !KEY.test(task.workBuddyContinuationKey)
    || task.sessionId !== undefined || task.workBuddyContinuationKey === task.idempotencyKey) {
    throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS,
      'workBuddyContinuationKey must name an earlier WorkBuddy request and cannot accompany a DSH sessionId.');
  }
}

const keyProperty = { type: 'string', pattern: KEY.source, description: 'The original idempotency key in this instance or verified root.' };
const dispatchIdProperty = { type: 'string', format: 'uuid' };
const locator = { idempotencyKey: keyProperty, dispatchId: dispatchIdProperty };

export const workBuddyDispatchTools = [
  {
    name: 'get_workbuddy_dsf_dispatch',
    description: 'Read a WorkBuddy DSF handoff and its recorded outcome. Does not call WorkBuddy.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['idempotencyKey'], properties: { idempotencyKey: keyProperty } },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'claim_workbuddy_dsf_dispatch',
    description: 'Claim a pending WorkBuddy DSF handoff exactly once, in its original peak window. Call this just before the verified WorkBuddy run.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['idempotencyKey', 'dispatchId'], properties: locator },
    annotations: { readOnlyHint: false }
  },
  {
    name: 'finish_workbuddy_dsf_dispatch',
    description: 'Record a blocked pre-dispatch handoff or the actual WorkBuddy outcome. This does not start, wait for or cancel a WorkBuddy task.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['idempotencyKey', 'dispatchId', 'status'],
      properties: {
        ...locator,
        status: { type: 'string', enum: [...new Set([...BEFORE_CLAIM, ...AFTER_CLAIM])] },
        claimToken: { type: 'string', minLength: 43, maxLength: 43 },
        backendTaskId: { type: 'string', pattern: TASK_ID.source },
        backendSessionId: { type: 'string', pattern: TASK_ID.source },
        answer: { type: 'string', maxLength: 60000 }
      }
    },
    annotations: { readOnlyHint: false }
  }
];

// The Sol coordinator owns the external tool call. These records only
// authorize one attempt and retain its reported outcome, never a remote child.
export class WorkBuddyDispatch {
  constructor({ runtime, clock, redact }) {
    this.directory = path.join(runtime, 'workbuddy-dsf');
    this.clock = clock;
    this.redact = redact;
  }

  _file(key) {
    if (typeof key !== 'string' || !KEY.test(key)) throw Error('Invalid idempotencyKey.');
    return path.join(this.directory, digest(key) + '.json');
  }

  _read(key) {
    let record;
    try {
      const file = this._file(key);
      if (fs.lstatSync(this.directory).isSymbolicLink()) throw Error('WorkBuddy DSF dispatch directory cannot be a link.');
      if (!fs.lstatSync(file).isFile()) throw Error('WorkBuddy DSF dispatch record must be a regular file.');
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (record?.schema !== 1 || record.idempotency_key !== key || typeof record.dispatch_id !== 'string') {
      throw Error('WorkBuddy DSF dispatch record is invalid.');
    }
    return record;
  }

  _write(record) {
    const file = this._file(record.idempotency_key);
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  }

  _withLock(key, fn) {
    const file = this._file(key) + '.lock';
    const fd = fs.openSync(file, 'wx', 0o600);
    try { return fn(); }
    finally { fs.closeSync(fd); fs.unlinkSync(file); }
  }

  _result(record, flags = {}) {
    const { schema, fingerprint, cwd_hash, claim_hash, ...dispatch } = record;
    const status = dispatch.status;
    const admission_state = status === CLAIMED || status === UNKNOWN ? 'unknown'
      : dispatch.backend_task_id || status === 'completed' ? 'accepted'
      : record.claim_hash && status !== 'refused' ? 'unknown' : 'not_accepted';
    return {
      task_id: null, backend: WORKBUDDY_DSF.backend, status, admission_state,
      workbuddy_dispatch: { ...WORKBUDDY_DSF, ...dispatch }, ...flags
    };
  }

  lookup(key) {
    const record = this._read(key);
    return record ? this._result(record) : null;
  }

  get(key) {
    const result = this.lookup(key);
    if (!result) throw Error('No WorkBuddy DSF dispatch exists for this idempotency key.');
    return result;
  }

  replay(key, fingerprint) {
    const prior = this._read(key);
    if (!prior) return null;
    if (prior.fingerprint !== fingerprint) throw new RoutingConflictError('This idempotency key belongs to a different WorkBuddy DSF request.');
    return this._result(prior, { replayed: true });
  }

  offer(task, fingerprint, window) {
    const key = task.idempotencyKey;
    if (window.phase !== 'peak' || window.new_task_backend !== WORKBUDDY_DSF.backend) {
      throw Error('WorkBuddy DSF requires a current peak window in schedule mode 2.');
    }
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw Error('WorkBuddy DSF dispatch directory cannot be a link.');
    return this._withLock(key, () => {
      const prior = this.replay(key, fingerprint);
      if (prior) return prior;
      const cwd_hash = scopeHash(task.cwd);
      let continuation = null;
      if (task.workBuddyContinuationKey) {
        const owner = this._read(task.workBuddyContinuationKey);
        if (owner?.status !== 'completed' || !owner.backend_session_id || cwd_hash !== owner.cwd_hash) {
          throw new PreAdmissionRejection(AdmissionCode.SESSION_CONFLICT,
            'WorkBuddy continuation requires an earlier completed dispatch with a recorded WorkBuddy session in the same workspace.');
        }
        continuation = { dispatch_id: owner.dispatch_id, backend_session_id: owner.backend_session_id };
      }
      const record = {
        schema: 1, idempotency_key: key, dispatch_id: crypto.randomUUID(), fingerprint, cwd_hash,
        status: PENDING, reason_code: AdmissionCode.WORKBUDDY_DSF_PEAK,
        schedule_mode: window.mode, peak_started_at: window.hard_stop_at, expires_at: window.next_offpeak_at,
        permission_mode: task.permissionMode, capability: task.capability ?? 'default', continuation,
        created_at: new Date(this.clock()).toISOString(), claimed_at: null, finished_at: null
      };
      this._write(record);
      return this._result(record);
    });
  }

  _update({ idempotencyKey, dispatchId }, update) {
    // Missing records are queried before taking a lock. Existing records are
    // immutable except for the following transitions under this per-key lock.
    this.get(idempotencyKey);
    return this._withLock(idempotencyKey, () => {
      const record = this._read(idempotencyKey);
      if (record.dispatch_id !== dispatchId) throw Error('dispatchId does not match the recorded WorkBuddy DSF handoff.');
      return update(record);
    });
  }

  claim(args, scheduleStatus) {
    return this._update(args, record => {
      if (record.status !== PENDING) {
        return this._result(record, { claimed: false });
      }
      const window = scheduleStatus();
      if (window.new_task_backend !== WORKBUDDY_DSF.backend || window.hard_stop_at !== record.peak_started_at) {
        record.status = 'expired';
        record.finished_at = new Date(this.clock()).toISOString();
        this._write(record);
        return this._result(record, { claimed: false });
      }
      const claimToken = crypto.randomBytes(32).toString('base64url');
      record.status = CLAIMED;
      record.claim_hash = digest(claimToken);
      record.claimed_at = new Date(this.clock()).toISOString();
      this._write(record);
      return this._result(record, { claimed: true, claimToken });
    });
  }

  finish(args) {
    return this._update(args, record => {
      const { status, claimToken, backendTaskId, backendSessionId, answer } = args;
      if (record.claim_hash) {
        if (typeof claimToken !== 'string' || claimToken.length !== 43 || digest(claimToken) !== record.claim_hash) {
          throw Error('The original WorkBuddy DSF claim token is required to record its outcome.');
        }
        if (!AFTER_CLAIM.includes(status)) throw Error('Invalid post-dispatch WorkBuddy DSF status.');
      } else if (!BEFORE_CLAIM.includes(status) || claimToken !== undefined
        || backendTaskId !== undefined || backendSessionId !== undefined) {
        throw Error('An unclaimed handoff can only be recorded as unavailable, refused or cancelled.');
      }
      for (const value of [backendTaskId, backendSessionId]) {
        if (value !== undefined && (typeof value !== 'string' || !TASK_ID.test(value) || this.redact(value) !== value)) {
          throw Error('Invalid WorkBuddy task or session identifier.');
        }
      }
      if (answer !== undefined && (typeof answer !== 'string' || Buffer.byteLength(answer) > 60000)) {
        throw Error('answer must be at most 60000 UTF-8 bytes.');
      }
      if (record.status === status) return this._result(record, { replayed: true });
      if (![PENDING, CLAIMED, UNKNOWN].includes(record.status)) throw Error('WorkBuddy DSF outcome is already terminal.');
      if ((record.backend_task_id && backendTaskId && record.backend_task_id !== backendTaskId)
        || (record.backend_session_id && backendSessionId && record.backend_session_id !== backendSessionId)) {
        throw Error('WorkBuddy task or session ID does not match the recorded outcome.');
      }
      record.status = status;
      record.backend_task_id ??= backendTaskId ?? null;
      record.backend_session_id ??= backendSessionId ?? null;
      record.finished_at = new Date(this.clock()).toISOString();
      if (answer !== undefined) record.answer = this.redact(answer);
      this._write(record);
      return this._result(record);
    });
  }
}
