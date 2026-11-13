import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { scheduleSnapshot, scheduleTaskPreamble } from './schedule.mjs';
import { AdmissionCode, PreAdmissionRejection } from './routing.mjs';

export const ROUTE = Object.freeze({ provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' });
export const VERSION = '0.3.0';
export const INSTANCE_DEFAULT = 'default';
export const INSTANCE_SERVER_PREFIX = 'dsh-opencode-go';
const MAX_OUTPUT = 2 * 1024 * 1024;
const SESSION_ACTIVE = new Set(['starting', 'running', 'cancelling']);
const WINDOWS_RESERVED = new Set(['con', 'prn', 'aux', 'nul', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap(n => [`com${n}`, `lpt${n}`])]);
const now = () => new Date().toISOString();
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const sleepSync = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export const runtimeBase = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'state'), 'ai_rule');
export const runtimeDefault = () => path.join(runtimeBase(), 'dsh');

// The default instance deliberately keeps the historical path and MCP server
// name. Named instances use a sibling root so legacy default data is untouched.
export function validateInstanceName(value) {
  if (typeof value !== 'string' || !value) throw Error('DSH instance name must be a nonempty lowercase ASCII name.');
  if (value === INSTANCE_DEFAULT) throw Error('"default" is reserved for the existing dsh-opencode-go service; choose another instance name.');
  if (value !== value.trim() || /[. ]$/.test(value)) throw Error('DSH instance name must not have leading/trailing whitespace or a trailing dot.');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(value)) throw Error('DSH instance name must match [a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?; use lowercase ASCII, digits and inner hyphens only.');
  if (WINDOWS_RESERVED.has(value)) throw Error(`DSH instance name "${value}" is a reserved Windows device name.`);
  return value;
}
export function normalizeInstanceName(value = INSTANCE_DEFAULT) {
  if (value === undefined || value === null || value === '') return INSTANCE_DEFAULT;
  if (value === INSTANCE_DEFAULT) return INSTANCE_DEFAULT;
  return validateInstanceName(value);
}
export function runtimeForInstance(instance = INSTANCE_DEFAULT) {
  const name = normalizeInstanceName(instance);
  return name === INSTANCE_DEFAULT ? runtimeDefault() : path.join(runtimeBase(), 'dsh-instances', name);
}
export function serverNameForInstance(instance = INSTANCE_DEFAULT) {
  const name = normalizeInstanceName(instance);
  return name === INSTANCE_DEFAULT ? INSTANCE_SERVER_PREFIX : `${INSTANCE_SERVER_PREFIX}-${name}`;
}
export function instanceFromServerName(serverName) {
  if (serverName === INSTANCE_SERVER_PREFIX) return INSTANCE_DEFAULT;
  const prefix = `${INSTANCE_SERVER_PREFIX}-`;
  if (typeof serverName !== 'string' || !serverName.startsWith(prefix)) return null;
  return validateInstanceName(serverName.slice(prefix.length));
}

// Resolve a path for actual file operations (preserves display case).
export function resolvedPath(value) {
  const resolved = path.resolve(value);
  try { return (fs.realpathSync.native || fs.realpathSync)(resolved); } catch { return resolved; }
}
// Stable comparison key: on Windows paths, case, separators and short/alias
// names must not create a second apparent instance domain.
export function pathKey(value) {
  const resolved = resolvedPath(value);
  return process.platform === 'win32' ? resolved.replace(/\//g, '\\').toLowerCase() : resolved;
}

// Best-effort redaction, not a secret scanning guarantee. Never read credential files.
export function redact(value) {
  let text = String(value);
  for (const [key, val] of Object.entries(process.env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key) && val && val.length >= 8) text = text.split(val).join('[REDACTED]');
  }
  return text.replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|api_key|key)=)[^&\s"']+/gi, '$1[REDACTED]');
}
export function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function writeJSON(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function discoverDsh(explicitEntry) {
  if (explicitEntry) {
    const entry = fs.realpathSync(explicitEntry);
    if (!/\.(?:mjs|cjs|js)$/i.test(entry)) throw Error('DSH entry must be the installed JavaScript CLI, not a .cmd/.ps1 shim.');
    return { command: process.execPath, prefix: [entry] };
  }
  const dirs = [...(process.env.PATH || '').split(path.delimiter), path.dirname(process.execPath)];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  for (const dir of dirs.filter(Boolean)) {
    for (const root of [path.join(dir, 'node_modules'), path.resolve(dir, '..', 'lib', 'node_modules')]) {
      const pkg = path.join(root, '@deepseek-ai', 'dsh', 'package.json');
      if (!fs.existsSync(pkg)) continue;
      const meta = readJSON(pkg);
      const bin = typeof meta.bin === 'string' ? meta.bin : meta.bin?.dsh;
      if (bin) return discoverDsh(path.resolve(path.dirname(pkg), bin));
    }
    const exe = path.join(dir, process.platform === 'win32' ? 'dsh.exe' : 'dsh');
    if (fs.existsSync(exe)) {
      const target = fs.realpathSync(exe);
      if (/\.(?:mjs|cjs|js)$/i.test(target)) return discoverDsh(target);
      if (process.platform !== 'win32' || target.endsWith('.exe')) return { command: target, prefix: [] };
    }
  }
  throw Error('DSH not found. Install it separately or pass --dsh-entry <installed CLI .js/.mjs>. Existing profiles are not changed.');
}
function probe(cli, args) {
  const result = spawnSync(cli.command, [...cli.prefix, ...args], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024
  });
  if (result.error || result.status !== 0) throw Error(`DSH probe failed: ${redact(result.error?.message || result.stderr || 'nonzero exit').slice(0, 2000)}`);
  return result.stdout;
}
export function configuredRoute(text) {
  const rows = text.split(/(?=^\s*- id:)/m);
  const row = rows.find(x => /^\s*- id:\s*['"]?agent-default-model['"]?\s*$/m.test(x));
  if (!row) throw Error('Cannot locate agent-default-model in --dump-config; refusing to guess the provider.');
  const get = name => row.match(new RegExp(`^\\s+${name}:\\s*['"]?([^\\s'"#]+)`, 'm'))?.[1];
  return { provider: get('provider'), model: get('model'), reasoningEffort: get('reasoningEffort') };
}
export function preflight(cli) {
  const version = probe(cli, ['--version']).trim();
  const help = probe(cli, ['--profile', 'headless', '--help']);
  for (const flag of ['--json', '--permission-mode', '--approval-policy']) {
    if (!help.includes(flag)) throw Error(`Installed DSH does not advertise ${flag}; no automatic upgrade is performed.`);
  }
  const route = configuredRoute(probe(cli, ['--profile', 'headless', '--dump-config']));
  for (const key of Object.keys(ROUTE)) if (route[key] !== ROUTE[key]) throw Error(`Headless ${key} mismatch: expected ${ROUTE[key]}, got ${route[key] || '(absent)'}.`);
  return { version, configured_route: route, actual_provider_attestation: 'not_available', billing_verification: 'not_available' };
}
export function validateTask(input, allowWrite = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Task must be an object.');
  const allowed = new Set(['prompt', 'cwd', 'idempotencyKey', 'timeoutMs', 'permissionMode', 'authorizationNote', 'sessionId']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw Error(`Unknown task field: ${key}`);
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 60000) throw Error('prompt must contain 1..60000 UTF-8 bytes.');
  if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) throw Error('cwd must be an absolute existing directory.');
  const cwd = fs.realpathSync(input.cwd);
  if (!fs.statSync(cwd).isDirectory()) throw Error('cwd is not a directory.');
  if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(input.idempotencyKey)) throw Error('idempotencyKey must contain 1..100 safe ASCII characters.');
  const permissionMode = input.permissionMode ?? 'read-only';
  if (!['read-only', 'workspace-write'].includes(permissionMode)) {
    throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'Only read-only and workspace-write are supported.');
  }
  if (permissionMode === 'workspace-write' && (!allowWrite || typeof input.authorizationNote !== 'string' || !input.authorizationNote.trim())) {
    throw new PreAdmissionRejection(AdmissionCode.PERMISSION_REFUSED,
      'Workspace writes require local --allow-write enablement AND an explicit user-approval reference in authorizationNote.');
  }
  const timeoutMs = input.timeoutMs ?? 900000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) throw Error('timeoutMs must be an integer between 1000 and 3600000.');
  if (input.sessionId !== undefined && (typeof input.sessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(input.sessionId))) throw Error('Invalid sessionId.');
  return { ...input, cwd, permissionMode, timeoutMs };
}
export function dshArgs(task) {
  return ['--profile', 'headless', '--permission-mode', task.permissionMode, '--approval-policy', 'never', '--json',
    ...(task.sessionId ? ['--session-id', task.sessionId] : []), '-'];
}
function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const result = spawnSync(exe, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, timeout: 10000, stdio: 'ignore' });
    if (result.status !== 0 && child.exitCode === null) child.kill();
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

export class TaskManager {
  constructor({ cli, runtime, instance = INSTANCE_DEFAULT, allowWrite = false, check = preflight, schedule = null, clock = () => new Date(), scheduleTickMs = 15000 } = {}) {
    this.cli = cli;
    this.instance = normalizeInstanceName(instance);
    this.runtime = path.resolve(runtime ?? runtimeForInstance(this.instance));
    this.allowWrite = allowWrite;
    this.check = check;
    this.schedule = schedule;
    this.clock = clock;
    this.scheduleTickMs = scheduleTickMs;
    this.active = null;
    this.pending = new Map();
    fs.mkdirSync(this.runtime, { recursive: true, mode: 0o700 });
    this.runtime = resolvedPath(this.runtime);
    fs.mkdirSync(path.join(this.runtime, 'requests'), { recursive: true, mode: 0o700 });
    this.instanceMetadataPath = path.join(this.runtime, 'instance.json');
    this.ensureInstanceMetadata();
  }
  mcpServerName() { return serverNameForInstance(this.instance); }
  ensureInstanceMetadata() {
    const expected = { schema: 1, instance: this.instance, runtime: this.runtime, bridge: INSTANCE_SERVER_PREFIX, bridge_version: VERSION };
    try {
      const fd = fs.openSync(this.instanceMetadataPath, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(expected, null, 2) + '\n'); } finally { fs.closeSync(fd); }
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let meta;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { meta = readJSON(this.instanceMetadataPath); break; }
      catch (error) { if (attempt === 19) throw Error(`Cannot read DSH instance metadata ${this.instanceMetadataPath}: ${redact(error.message)}`); sleepSync(10); }
    }
    if (!meta || meta.schema !== 1 || typeof meta.instance !== 'string') throw Error(`Invalid DSH instance metadata at ${this.instanceMetadataPath}; refusing to reuse a shared runtime.`);
    if (meta.instance !== this.instance) throw Error(`Runtime ${this.runtime} belongs to DSH instance "${meta.instance}", not "${this.instance}". Each named instance needs its own runtime; do not point two instances at one path.`);
  }
  scheduleStatus() { return scheduleSnapshot(this.schedule, this.clock()); }
  lockInfo() {
    const lock = path.join(this.runtime, 'active.lock');
    if (!fs.existsSync(lock)) return null;
    try {
      const owner = readJSON(lock);
      return {
        owner_pid: Number.isInteger(owner.owner_pid) ? owner.owner_pid : null,
        task_id: typeof owner.task_id === 'string' ? owner.task_id : null,
        instance: typeof owner.instance === 'string' ? owner.instance : null,
        started_at: typeof owner.started_at === 'string' ? owner.started_at : null,
        owned_by_this_bridge: owner.owner_pid === process.pid
      };
    } catch { return { unreadable: true, owned_by_this_bridge: false }; }
  }
  status() {
    const lock = this.lockInfo();
    return { instance: this.instance, instance_id: `dsh:${this.instance}`, mcp_server_name: this.mcpServerName(),
      bridge_version: VERSION, bridge_pid: process.pid, backend: 'dsh', profile: 'headless', expected_route: ROUTE,
      active_task_id: this.active?.record.task_id || null, allow_workspace_write: this.allowWrite, max_concurrency: 1,
      runtime: this.runtime, instance_metadata_path: this.instanceMetadataPath, transport: 'stdio', starts_opencode_cli: false,
      os_sandbox_attested: false, lock_present: Boolean(lock), lock_owner: lock,
      credential_contents_read_by_bridge: false, schedule: this.scheduleStatus() };
  }
  receiptPath(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw Error(`Invalid task ID for DSH instance "${this.instance}".`);
    return path.join(this.runtime, id, 'RUN_RECEIPT.json');
  }
  notFound(id) {
    return Error(`Task ${id} not found in DSH instance "${this.instance}" (runtime ${this.runtime}). Task IDs, idempotency keys and sessions are scoped to one instance; do not query another instance or reuse its receipt.`);
  }
  get(id) {
    const file = this.receiptPath(id);
    let record;
    try { record = readJSON(file); }
    catch (error) {
      if (error.code === 'ENOENT') throw this.notFound(id);
      throw Error(`Cannot read receipt for task ${id} in DSH instance "${this.instance}": ${redact(error.message)}`);
    }
    if (record.instance !== undefined) {
      if (record.instance !== this.instance) throw Error(`Task ${id} belongs to DSH instance "${record.instance}", not "${this.instance}". Refusing cross-instance access.`);
      record = { ...record };
    } else if (this.instance === INSTANCE_DEFAULT) {
      // v0.2.0 receipts predate instance metadata and belong to the legacy default runtime.
      record = { ...record, instance: this.instance, instance_source: 'legacy_default' };
    } else {
      throw Error(`Receipt for task ${id} has no instance ownership and cannot be read by named instance "${this.instance}". Do not copy runtime data between instances.`);
    }
    if (SESSION_ACTIVE.has(record.status) && this.active?.record.task_id !== id) {
      record.status = 'unknown_after_disconnect';
      record.warning = `Bridge instance "${this.instance}" does not own this task's child process. Another bridge may own it, or its owner stopped. Do not restart automatically; inspect the instance lock and processes.`;
    }
    return record;
  }
  sessionIndexPath() { return path.join(this.runtime, 'sessions.json'); }
  readSessionIndex() {
    const file = this.sessionIndexPath();
    if (!fs.existsSync(file)) return { schema: 1, sessions: Object.create(null) };
    let data;
    try { data = readJSON(file); }
    catch (error) { throw Error(`Session ownership index ${file} is unreadable (${redact(error.message)}); refusing to guess session ownership.`); }
    if (!data || data.schema !== 1 || !data.sessions || typeof data.sessions !== 'object' || Array.isArray(data.sessions)) {
      throw Error(`Session ownership index ${file} has an unsupported format; refusing to resume sessions.`);
    }
    const sessions = Object.create(null);
    for (const [key, value] of Object.entries(data.sessions)) sessions[key] = value;
    return { schema: 1, sessions };
  }
  writeSessionIndex(index) { writeJSON(this.sessionIndexPath(), index); }
  findLegacySessionOwner(sessionId, cwd) {
    let found = null;
    for (const entry of fs.readdirSync(this.runtime, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      let record;
      try { record = readJSON(path.join(this.runtime, entry.name, 'RUN_RECEIPT.json')); } catch { continue; }
      if (record.session_id !== sessionId) continue;
      if (record.instance !== undefined && record.instance !== this.instance) {
        throw Error(`Session ${sessionId} is recorded for DSH instance "${record.instance}", not "${this.instance}". Refusing cross-instance takeover.`);
      }
      if (record.instance === undefined && this.instance !== INSTANCE_DEFAULT) {
        throw Error(`Receipt ${entry.name} has no instance ownership; named instance "${this.instance}" will not claim it. Do not copy legacy runtime data into a named instance.`);
      }
      if (typeof record.cwd !== 'string' || pathKey(record.cwd) !== pathKey(cwd)) {
        throw Error(`Session ${sessionId} is bound to a different cwd in this runtime; resume it only from the original cwd and instance.`);
      }
      if (SESSION_ACTIVE.has(record.status)) {
        throw Error(`Session ${sessionId} belongs to task ${entry.name} recorded as ${record.status}. That task may still be running; inspect the instance lock before resuming, and do not start a duplicate.`);
      }
      found ||= { instance: this.instance, cwd, owner_task_id: record.task_id || entry.name, last_task_id: record.task_id || entry.name, created_at: record.started_at || now(), updated_at: now() };
    }
    return found;
  }
  assertSessionOwnership(task) {
    if (!task.sessionId) return null;
    const index = this.readSessionIndex();
    const sessionId = task.sessionId;
    if (Object.hasOwn(index.sessions, sessionId)) {
      const entry = index.sessions[sessionId];
      if (!entry || entry.instance !== this.instance) throw Error(`Session ${sessionId} belongs to another DSH instance. Start a new task in "${this.instance}" instead of reusing a foreign session.`);
      if (typeof entry.cwd !== 'string' || pathKey(entry.cwd) !== pathKey(task.cwd)) throw Error(`Session ${sessionId} is bound to cwd ${entry.cwd}, not ${task.cwd}. Resume only in the original cwd and instance.`);
      const ownerId = entry.last_task_id || entry.owner_task_id;
      if (ownerId && ownerId !== this.active?.record.task_id) {
        let owner;
        try { owner = readJSON(this.receiptPath(ownerId)); } catch {}
        if (owner && SESSION_ACTIVE.has(owner.status)) throw Error(`Session ${sessionId} is owned by task ${ownerId} recorded as ${owner.status}. Inspect that task and the instance lock before resuming; do not duplicate it.`);
      }
      return entry;
    }
    const legacy = this.findLegacySessionOwner(sessionId, task.cwd);
    if (!legacy) throw Error(`Unknown sessionId for DSH instance "${this.instance}". A new DSH task gets a fresh UUID; resume only a session_id returned by this instance's own receipt, in the same cwd. Do not invent IDs or copy them from another instance.`);
    index.sessions[sessionId] = legacy;
    this.writeSessionIndex(index);
    return legacy;
  }
  claimSession(sessionId, taskId, cwd, requestedSessionId) {
    const index = this.readSessionIndex();
    const existing = Object.hasOwn(index.sessions, sessionId) ? index.sessions[sessionId] : null;
    if (existing) {
      if (existing.instance !== this.instance) throw Error(`DSH returned session ${sessionId}, already owned by instance "${existing.instance}"; refusing cross-instance takeover.`);
      if (typeof existing.cwd !== 'string' || pathKey(existing.cwd) !== pathKey(cwd)) throw Error(`DSH returned session ${sessionId}, already bound to a different cwd; refusing to overwrite its ownership.`);
      const owner = existing.last_task_id || existing.owner_task_id;
      if (owner !== taskId && !requestedSessionId) throw Error(`DSH returned existing session ${sessionId} for a new task without --session-id; refusing automatic takeover.`);
      existing.last_task_id = taskId;
      existing.updated_at = now();
      index.sessions[sessionId] = existing;
    } else {
      index.sessions[sessionId] = { instance: this.instance, cwd, owner_task_id: taskId, last_task_id: taskId, created_at: now(), updated_at: now() };
    }
    this.writeSessionIndex(index);
  }
  releaseLock(taskId = null) {
    const lock = path.join(this.runtime, 'active.lock');
    try {
      const owner = readJSON(lock);
      if (owner.owner_pid !== process.pid) return;
      if (owner.task_id && taskId && owner.task_id !== taskId) return;
      fs.rmSync(lock, { force: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      // Leave an unreadable or foreign lock in place for human inspection.
    }
  }
  async start(input) {
    let task;
    try { task = validateTask(input, this.allowWrite); }
    catch (error) {
      if (error instanceof PreAdmissionRejection) throw error;
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, error.message, { details: { stage: 'validate' } });
    }
    const fingerprint = digest(JSON.stringify(task));
    const requestFile = path.join(this.runtime, 'requests', `${digest(task.idempotencyKey)}.json`);
    if (fs.existsSync(requestFile)) {
      const old = readJSON(requestFile);
      if (old.fingerprint !== fingerprint) throw Error(`Idempotency key already used with different arguments in DSH instance "${this.instance}".`);
      return this.get(old.task_id);
    }
    if (this.active) {
      throw new PreAdmissionRejection(AdmissionCode.BUSY,
        `DSH instance "${this.instance}" is busy with ${this.active.record.task_id}; wait rather than start a duplicate.`,
        { details: { active_task_id: this.active.record.task_id } });
    }
    // Acquire the exclusive lock BEFORE the schedule gate. A live/unknown lock
    // must never be masked by an eligible schedule rejection.
    const lock = path.join(this.runtime, 'active.lock');
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch {
      const owner = this.lockInfo();
      const detail = owner?.unreadable ? 'lock content is unreadable' : `owner_pid=${owner?.owner_pid ?? 'unknown'} task_id=${owner?.task_id ?? 'unknown'}`;
      throw new PreAdmissionRejection(AdmissionCode.LOCKED,
        `Exclusive lock exists for DSH instance "${this.instance}": ${lock} (${detail}). Do not delete it until the owner and child processes have been checked.`,
        { details: { owner_pid: owner?.owner_pid ?? null, owner_task_id: owner?.task_id ?? null } });
    }
    let window;
    let record;
    try {
      fs.writeFileSync(fd, JSON.stringify({ schema: 1, instance: this.instance, runtime: this.runtime, owner_pid: process.pid, task_id: null, started_at: now() }));
      fs.closeSync(fd); fd = undefined;
      let sessionOwner;
      try { sessionOwner = this.assertSessionOwnership(task); }
      catch (error) {
        if (error instanceof PreAdmissionRejection) throw error;
        throw new PreAdmissionRejection(AdmissionCode.SESSION_CONFLICT, error.message, { details: { stage: 'session' } });
      }
      // Session ownership is proven before the schedule can produce an
      // apparently eligible rejection. Idempotent reads still happen above.
      window = this.scheduleStatus();
      if (!window.accept_new_tasks) {
        throw new PreAdmissionRejection(AdmissionCode.SCHEDULE_GATE,
          `DSH instance "${this.instance}" is blocked by the offpeak schedule (${window.phase}); next offpeak at ${window.next_offpeak_at || 'see schedule status'}.`,
          { details: { phase: window.phase, next_offpeak_at: window.next_offpeak_at, hard_stop_at: window.hard_stop_at } });
      }
      if (window.enabled && window.reject_if_budget_exceeds_window && this.clock().getTime() + task.timeoutMs + 60000 >= Date.parse(window.hard_stop_at)) {
        throw new PreAdmissionRejection(AdmissionCode.SCHEDULE_GATE,
          'Task timeout budget exceeds the remaining offpeak window (plus 60s margin). Shorten the budget or use the next offpeak window.',
          { details: { phase: window.phase, gate: 'budget_exceeds_window', next_offpeak_at: window.next_offpeak_at, hard_stop_at: window.hard_stop_at } });
      }
      let verified;
      try { verified = this.check(this.cli); }
      catch (error) {
        if (error instanceof PreAdmissionRejection) throw error;
        throw new PreAdmissionRejection(AdmissionCode.PREFLIGHT_FAILED, error.message, { details: { stage: 'preflight' } });
      }
      const id = crypto.randomUUID();
      const dir = path.join(this.runtime, id);
      fs.mkdirSync(dir, { mode: 0o700 });
      record = { task_id: id, instance: this.instance, instance_id: `dsh:${this.instance}`, runtime: this.runtime, backend: 'dsh', ...verified,
        requested_route: ROUTE, actual_route: null,
        schedule_at_start: window.enabled ? { hard_stop_at: window.hard_stop_at, stop_new_at: window.stop_new_at, timezone: window.timezone, resume_automatically: false } : null,
        session_id: task.sessionId || null, session_resume: Boolean(task.sessionId), session_owner_task_id: sessionOwner?.owner_task_id || null,
        cwd: task.cwd, permission_mode: task.permissionMode, approval_policy: 'never', user_authorization_note: redact(task.authorizationNote || ''),
        prompt_sha256: digest(task.prompt), status: 'starting', started_at: now(), finished_at: null, pid: null, exit_code: null, timed_out: false,
        native_tool_calls: 0, final_reason: null, answer: '', diagnostics: [], receipt_path: this.receiptPath(id), files_changed: null, verification: 'not_yet_reviewed' };
      writeJSON(record.receipt_path, record);
      fs.writeFileSync(requestFile, JSON.stringify({ task_id: id, fingerprint }), { flag: 'wx', mode: 0o600 });
      fs.writeFileSync(lock, JSON.stringify({ schema: 1, instance: this.instance, runtime: this.runtime, owner_pid: process.pid, task_id: id, started_at: record.started_at }));
      let finishPromise;
      const finished = new Promise(resolve => { finishPromise = resolve; });
      const active = { record, child: null, stopReason: null, finished, finishPromise, scheduleTimer: null };
      this.active = active;
      this.pending.set(id, finished);
      const child = spawn(this.cli.command, [...this.cli.prefix, ...dshArgs(task)], {
        cwd: task.cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']
      });
      active.child = child;
      record.pid = child.pid || null;
      record.status = 'running';
      writeJSON(record.receipt_path, record);
      const scheduleTick = () => {
        if (this.active?.record.task_id !== id) return;
        const current = this.scheduleStatus();
        if (current.phase === 'peak') { this.cancel(id, 'scheduled_peak'); return; }
        const until = Date.parse(current.hard_stop_at) - this.clock().getTime();
        active.scheduleTimer = setTimeout(scheduleTick, Math.max(5, Math.min(this.scheduleTickMs, until)));
      };
      if (this.schedule) scheduleTick();
      let stdout = '', stderr = '', total = 0, sawFinal = false;
      const persist = () => writeJSON(record.receipt_path, record);
      const diagnostic = line => { record.diagnostics.push(redact(line).slice(0, 1000)); record.diagnostics = record.diagnostics.slice(-12); };
      const onLine = line => {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch { diagnostic('Non-JSON stdout from DSH; content not retained.'); return; }
        if (!event || typeof event !== 'object' || Array.isArray(event)) { diagnostic('Invalid DSH JSON event; cancelling.'); this.cancel(id, 'invalid_dsh_event'); return; }
        if (event.type === 'thinking') return;
        if (event.type === 'session' && typeof event.sessionId === 'string') {
          const sessionId = event.sessionId.slice(0, 160);
          try {
            this.claimSession(sessionId, id, task.cwd, Boolean(task.sessionId));
            record.session_id = sessionId;
          } catch (error) {
            diagnostic(error.message);
            this.cancel(id, 'session_conflict');
            return;
          }
        }
        if (event.type === 'tool_call') record.native_tool_calls++;
        if (event.type === 'error') diagnostic(event.message || event.code || 'DSH error');
        if (event.type === 'final') {
          sawFinal = true;
          record.final_reason = typeof event.reason?.kind === 'string' ? event.reason.kind : null;
          record.answer = redact(event.text || '').slice(0, 60000);
          record.answer_truncated = String(event.text || '').length > 60000;
        }
        // No prompts, tool arguments/results, or reasoning are written to bridge logs.
        if (['session', 'tool_call', 'final', 'error'].includes(event.type)) persist();
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        total += Buffer.byteLength(chunk);
        if (total > MAX_OUTPUT) { diagnostic('Output limit exceeded.'); this.cancel(id, 'output_limit'); return; }
        stdout += chunk;
        let pos;
        while ((pos = stdout.indexOf('\n')) >= 0) { onLine(stdout.slice(0, pos)); stdout = stdout.slice(pos + 1); }
      });
      child.stderr.on('data', chunk => {
        stderr += chunk;
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });
      child.stdin.on('error', error => diagnostic(`stdin: ${error.message}`));
      child.on('error', error => diagnostic(error.message));
      const timer = setTimeout(() => this.cancel(id, 'timeout'), task.timeoutMs);
      child.on('close', (code, signal) => {
        try {
          clearTimeout(timer);
          if (active.scheduleTimer) clearTimeout(active.scheduleTimer);
          if (stdout.trim() && total <= MAX_OUTPUT) onLine(stdout);
          for (const line of stderr.split(/\r?\n/).filter(x => /^dsh:|error|failed|missing/i.test(x))) diagnostic(line);
          record.exit_code = code;
          record.signal = signal;
          record.finished_at = now();
          record.timed_out = active.stopReason === 'timeout';
          record.stop_reason = active.stopReason || null;
          record.status = active.stopReason ? (active.stopReason === 'timeout' ? 'timed_out' : active.stopReason === 'scheduled_peak' ? 'schedule_stopped' : active.stopReason === 'invalid_dsh_event' ? 'failed' : 'cancelled')
            : code === 0 && sawFinal && record.final_reason === 'completed' ? 'completed' : 'failed';
          if (!sawFinal) diagnostic('No terminal JSON final event; success is not asserted.');
          persist();
        } catch (error) {
          diagnostic(`close handling: ${error.message}`);
          try { persist(); } catch {}
        } finally {
          this.releaseLock(id);
          this.active = null;
          active.finishPromise(record);
          this.pending.delete(id);
        }
      });
      child.stdin.end(scheduleTaskPreamble(window) + task.prompt);
      return { ...record };
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      // A failed precheck/reservation has no record or active task yet; release only the lock this attempt created.
      if (record && this.active?.record.task_id === record.task_id && !this.active.child) {
        this.active = null;
        this.pending.delete(record.task_id);
        this.releaseLock(record.task_id);
      } else if (!this.active) {
        this.releaseLock(record?.task_id ?? null);
      }
      throw error;
    }
  }
  cancel(id, reason = 'user_cancelled') {
    if (this.active?.record.task_id !== id) return this.get(id);
    this.active.stopReason ??= reason;
    this.active.record.status = 'cancelling';
    writeJSON(this.active.record.receipt_path, this.active.record);
    killTree(this.active.child);
    return { ...this.active.record };
  }
  async wait(id, waitMs = 25000) {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60000) throw Error('waitMs must be 0..60000.');
    const pending = this.pending.get(id);
    if (pending) {
      let timer;
      await Promise.race([pending, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
      clearTimeout(timer);
    }
    return this.get(id);
  }
  async close() {
    const active = this.active;
    if (active) { this.cancel(active.record.task_id, 'bridge_shutdown'); await active.finished; }
  }
}
