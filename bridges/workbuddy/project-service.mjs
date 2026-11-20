import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../dsh/core.mjs';
import { samePath, sha256 } from '../hy4/policy.mjs';
import { limitText } from '../sol/config.mjs';
import { WORKBUDDY_DSF } from './dispatch.mjs';
import { ensureProjectRuntime, loadProjectConfig, PROJECT_CONTRACT, PROJECT_SESSION_ID, projectError, verifyProjectCli } from './project-config.mjs';
import { allowProjectTool, checkProjectArguments, prepareProjectTask, projectLookupSchema } from './project-policy.mjs';
import { executeProjectSdk, loadProjectSdk, probeProjectSdk } from './project-sdk.mjs';

const model = WORKBUDDY_DSF.model;
const TERMINAL = ['completed', 'failed', 'refused', 'cancelled', 'timed_out', 'unknown_after_disconnect'];
const now = () => new Date().toISOString();
const errorCode = error => /^WORKBUDDY_[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'WORKBUDDY_PROJECT_UNAVAILABLE';
const errorSummary = error => ({
  reason_code: errorCode(error),
  message: errorCode(error) === 'WORKBUDDY_PROJECT_UNAVAILABLE'
    ? 'The WorkBuddy project bridge could not verify its local executor.' : limitText(redact(error.message), 1000)
});

function readRecord(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 128000) throw Error('Invalid project receipt.');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw projectError('WORKBUDDY_RECEIPT_UNREADABLE', 'Keep the original task key. Its WorkBuddy record could not be read.');
  }
}

function createRecord(file, record) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function replaceRecord(file, record) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    createRecord(temp, record);
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

function scopeFingerprint(task) {
  return sha256(JSON.stringify({
    projectId: task.projectId, cwd: task.cwd, permissionMode: task.permissionMode, capability: task.capability,
    allowCommands: task.allowCommands, writes: task.writes, writeScopes: task.writeScopes, commands: task.commands
  }));
}

function taskFingerprint(task, scope) {
  return sha256(JSON.stringify({ scope, prompt: sha256(task.prompt), timeoutMs: task.timeoutMs,
    authorizationNote: task.authorizationNote ?? '', sessionId: task.sessionId ?? null }));
}

export class WorkBuddyProjectService {
  constructor({ configPath, sdk }) {
    this.initial = loadProjectConfig(configPath);
    ensureProjectRuntime(this.initial);
    this.sdk = sdk;
    this.active = new Map();
    this.closing = false;
    this.lock = this._file('active');
  }

  _reload() {
    const config = loadProjectConfig(this.initial.configPath);
    if (['runtimeDir', 'cliEntry', 'configDir'].some(field => !samePath(config[field], this.initial[field])) ||
      config.cliSha256 !== this.initial.cliSha256) {
      throw projectError('WORKBUDDY_RESTART_REQUIRED', 'A WorkBuddy installation setting changed. Reload this bridge after its active task ends.');
    }
    ensureProjectRuntime(config);
    return config;
  }

  _file(type, key) {
    const name = key === undefined ? type : `${type}-${sha256(key)}`;
    return path.join(this.initial.runtimeDir, name + '.json');
  }

  _receipt(key) {
    const record = readRecord(this._file('task', key));
    if (record && (record.schema !== 1 || record.idempotency_key !== key || record.model !== model)) {
      throw projectError('WORKBUDDY_RECEIPT_UNREADABLE', 'The recorded WorkBuddy task does not match its original key or model.');
    }
    return record;
  }

  _view(record, replayed = false) {
    const { schema, fingerprint, scope_hash, ...result } = record;
    const owner = this.active.has(record.idempotency_key);
    if (!owner && result.status === 'running') result.status = 'unknown_after_disconnect';
    return { ...result, owner, replayed };
  }

  get(args) {
    checkProjectArguments(args, projectLookupSchema);
    ensureProjectRuntime(this.initial);
    const record = this._receipt(args.idempotencyKey);
    if (!record) throw projectError('WORKBUDDY_TASK_NOT_FOUND', 'No WorkBuddy project task exists for this key.');
    return this._view(record);
  }

  async status(args, signal = AbortSignal.timeout(30000)) {
    const base = { model, project_contract: PROJECT_CONTRACT, ready: false };
    try {
      const config = this._reload();
      const task = prepareProjectTask(config, args, true);
      if (readRecord(this.lock)) throw projectError('WORKBUDDY_BUSY', 'The original WorkBuddy task still owns this project runtime.');
      await verifyProjectCli(config);
      this.sdk ??= await loadProjectSdk();
      const proof = await probeProjectSdk({ config, cwd: task.cwd, signal, ...this.sdk });
      if (proof?.model !== model) throw projectError('WORKBUDDY_MODEL_MISMATCH', 'The local SDK did not confirm the fixed WorkBuddy model.');
      return { ...base, ready: true, project_id: task.projectId, permission_mode: task.permissionMode, commands_enabled: task.allowCommands };
    } catch (error) { return { ...base, ...errorSummary(error) }; }
  }

  async run(args, requestSignal) {
    if (this.closing) throw projectError('WORKBUDDY_CLOSING', 'The WorkBuddy project bridge is shutting down.');
    const config = this._reload();
    const task = prepareProjectTask(config, args);
    const key = task.idempotencyKey;
    const scopeHash = scopeFingerprint(task);
    const fingerprint = taskFingerprint(task, scopeHash);
    const replay = record => {
      if (record.fingerprint !== fingerprint) {
        throw projectError('WORKBUDDY_IDEMPOTENCY_CONFLICT', 'The same WorkBuddy task key already belongs to a different request.');
      }
      return this._view(record, true);
    };
    const record = this._receipt(key);
    if (record) return replay(record);
    try { createRecord(this.lock, { schema: 1, pid: process.pid, task_key_hash: sha256(key), created_at: now() }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const winner = this._receipt(key);
      if (winner) return replay(winner);
      return { status: 'refused', model, reason_code: 'WORKBUDDY_BUSY' };
    }
    let releaseLock = true;
    try {
      const winner = this._receipt(key);
      if (winner) return replay(winner);
      if (task.sessionId) {
        const session = readRecord(this._file('session', task.sessionId));
        if (session?.schema !== 1 || session.model !== model || session.scope_hash !== scopeHash) {
          return { status: 'refused', model, reason_code: 'WORKBUDDY_SESSION_SCOPE' };
        }
      }
      const taskRecord = {
        schema: 1, model, project_id: task.projectId, permission_mode: task.permissionMode, fingerprint, scope_hash: scopeHash,
        idempotency_key: key, task_id: crypto.randomUUID(), status: 'running', started_at: now(), finished_at: null
      };
      // A lost terminal receipt must not be mistaken for an idle service.
      releaseLock = false;
      createRecord(this._file('task', key), taskRecord);
      const controller = new AbortController();
      const timeoutSignal = AbortSignal.timeout(task.timeoutMs);
      const signal = AbortSignal.any([controller.signal, timeoutSignal, ...(requestSignal ? [requestSignal] : [])]);
      const active = { controller };
      this.active.set(key, active);
      active.done = this._execute({ config, task, taskRecord, signal, timeoutSignal });
      const result = await active.done;
      releaseLock = result.status !== 'unknown_after_disconnect';
      return result;
    } finally {
      this.active.delete(key);
      if (releaseLock) fs.unlinkSync(this.lock);
    }
  }

  async _execute({ config, task, taskRecord, signal, timeoutSignal }) {
    let sent = false;
    try {
      await verifyProjectCli(config);
      this.sdk ??= await loadProjectSdk();
      if (signal.aborted) throw projectError('WORKBUDDY_STOPPED', 'The WorkBuddy task stopped before dispatch.');
      const result = await executeProjectSdk({
        config, task, signal, ...this.sdk,
        allowTool: (tool, input, cwd) => allowProjectTool(task, tool, input, cwd),
        onSend: sessionId => {
          const current = prepareProjectTask(this._reload(), taskArguments(task));
          if (scopeFingerprint(current) !== taskRecord.scope_hash) {
            throw projectError('WORKBUDDY_PROJECT_CHANGED', 'The WorkBuddy project grant changed before the task was sent.');
          }
          if (typeof sessionId !== 'string' || !PROJECT_SESSION_ID.test(sessionId) || redact(sessionId) !== sessionId) {
            throw projectError('WORKBUDDY_INVALID_SESSION', 'The WorkBuddy SDK did not supply a valid session handle.');
          }
          taskRecord.attempted_session_id = sessionId;
          replaceRecord(this._file('task', task.idempotencyKey), taskRecord);
          sent = true;
        }
      });
      if (sent && signal.aborted && ['timed_out', 'cancelled', 'unknown_after_disconnect'].includes(result.status)) {
        throw projectError('WORKBUDDY_ABORTED_AFTER_DISPATCH', 'The original WorkBuddy task stopped responding after dispatch. Verify its outcome before continuing.');
      }
      const sessionId = result.session_id;
      const validSession = typeof sessionId === 'string' && PROJECT_SESSION_ID.test(sessionId) && redact(sessionId) === sessionId &&
        (!task.sessionId || sessionId === task.sessionId);
      if (!TERMINAL.includes(result.status) || (result.status === 'completed' && (!sent || !validSession))) {
        throw projectError('WORKBUDDY_INVALID_RESULT', 'The WorkBuddy project executor did not verify its final result and session.');
      }
      if (result.status === 'completed') {
        const file = this._file('session', sessionId);
        if (!task.sessionId) createRecord(file, { schema: 1, model, scope_hash: taskRecord.scope_hash });
        taskRecord.session_id = sessionId;
      }
      taskRecord.status = result.status;
      if (result.reason_code) taskRecord.reason_code = errorCode({ code: result.reason_code });
      taskRecord.answer = limitText(redact(typeof result.answer === 'string' ? result.answer : ''), 24000);
    } catch (error) {
      taskRecord.status = sent ? 'unknown_after_disconnect' : timeoutSignal.aborted ? 'timed_out' : signal.aborted ? 'cancelled' : 'refused';
      Object.assign(taskRecord, errorSummary(error));
    }
    taskRecord.finished_at = now();
    replaceRecord(this._file('task', task.idempotencyKey), taskRecord);
    return this._view(taskRecord);
  }

  async close() {
    this.closing = true;
    const active = [...this.active.values()];
    for (const item of active) item.controller.abort();
    await Promise.allSettled(active.map(item => item.done));
  }
}

function taskArguments(task) {
  const { allowCommands, hasFileScope, ...args } = task;
  return args;
}
