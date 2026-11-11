import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { scheduleSnapshot, scheduleTaskPreamble } from './schedule.mjs';

export const ROUTE = Object.freeze({ provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' });
export const VERSION = '0.2.0';
const MAX_OUTPUT = 2 * 1024 * 1024;
const now = () => new Date().toISOString();
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const runtimeDefault = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'state'), 'ai_rule', 'dsh');

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
  if (!['read-only', 'workspace-write'].includes(permissionMode)) throw Error('Only read-only and workspace-write are supported.');
  if (permissionMode === 'workspace-write' && (!allowWrite || typeof input.authorizationNote !== 'string' || !input.authorizationNote.trim())) {
    throw Error('Workspace writes require local --allow-write enablement AND an explicit user-approval reference in authorizationNote.');
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
  constructor({ cli, runtime = runtimeDefault(), allowWrite = false, check = preflight, schedule = null, clock = () => new Date(), scheduleTickMs = 15000 } = {}) {
    this.cli = cli;
    this.runtime = path.resolve(runtime);
    this.allowWrite = allowWrite;
    this.check = check;
    this.schedule = schedule;
    this.clock = clock;
    this.scheduleTickMs = scheduleTickMs;
    this.active = null;
    this.pending = new Map();
    fs.mkdirSync(this.runtime, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(this.runtime, 'requests'), { recursive: true, mode: 0o700 });
  }
  scheduleStatus() { return scheduleSnapshot(this.schedule, this.clock()); }
  status() {
    return { schedule: this.scheduleStatus(), bridge_version: VERSION, backend: 'dsh', profile: 'headless', expected_route: ROUTE, active_task_id: this.active?.record.task_id || null,
      allow_workspace_write: this.allowWrite, max_concurrency: 1, runtime: this.runtime,
      transport: 'stdio', starts_opencode_cli: false, os_sandbox_attested: false,
      lock_present: fs.existsSync(path.join(this.runtime, 'active.lock')), credential_contents_read_by_bridge: false };
  }
  receiptPath(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw Error('Invalid task ID.');
    return path.join(this.runtime, id, 'RUN_RECEIPT.json');
  }
  get(id) {
    const record = readJSON(this.receiptPath(id));
    if (['starting', 'running', 'cancelling'].includes(record.status) && this.active?.record.task_id !== id) {
      record.status = 'unknown_after_disconnect';
      record.warning = 'Another bridge may own this task, or its owner stopped. Do not restart automatically; inspect the local lock and processes.';
    }
    return record;
  }
  async start(input) {
    const task = validateTask(input, this.allowWrite);
    const fingerprint = digest(JSON.stringify(task));
    const requestFile = path.join(this.runtime, 'requests', `${digest(task.idempotencyKey)}.json`);
    if (fs.existsSync(requestFile)) {
      const old = readJSON(requestFile);
      if (old.fingerprint !== fingerprint) throw Error('Idempotency key already used with different arguments.');
      return this.get(old.task_id);
    }
    if (this.active) throw Error(`DSH is busy with ${this.active.record.task_id}; wait rather than start a duplicate.`);
    const window = this.scheduleStatus();
    if (!window.accept_new_tasks) throw Error(`DSH offpeak schedule blocks new tasks (${window.phase}); next offpeak at ${window.next_offpeak_at || 'see schedule status'}.`);
    if (window.enabled && window.reject_if_budget_exceeds_window && this.clock().getTime() + task.timeoutMs + 60000 >= Date.parse(window.hard_stop_at)) throw Error('Task timeout budget exceeds the remaining offpeak window (plus 60s margin). Shorten the budget or use the next offpeak window.');
    const lock = path.join(this.runtime, 'active.lock');
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch { throw Error(`Exclusive lock exists: ${lock}. Do not delete it until the owner and child processes have been checked.`); }
    let record;
    try {
      fs.writeFileSync(fd, JSON.stringify({ owner_pid: process.pid, started_at: now() }));
      fs.closeSync(fd); fd = undefined;
      const verified = this.check(this.cli);
      const id = crypto.randomUUID();
      const dir = path.join(this.runtime, id);
      fs.mkdirSync(dir, { mode: 0o700 });
      record = { task_id: id, backend: 'dsh', ...verified, requested_route: ROUTE, actual_route: null,
        schedule_at_start: window.enabled ? { hard_stop_at: window.hard_stop_at, stop_new_at: window.stop_new_at, timezone: window.timezone, resume_automatically: false } : null,
        session_id: task.sessionId || null, cwd: task.cwd, permission_mode: task.permissionMode, approval_policy: 'never',
        user_authorization_note: redact(task.authorizationNote || ''), prompt_sha256: digest(task.prompt), status: 'starting', started_at: now(),
        finished_at: null, pid: null, exit_code: null, timed_out: false, native_tool_calls: 0, final_reason: null,
        answer: '', diagnostics: [], receipt_path: this.receiptPath(id), files_changed: null, verification: 'not_yet_reviewed' };
      writeJSON(record.receipt_path, record);
      fs.writeFileSync(requestFile, JSON.stringify({ task_id: id, fingerprint }), { flag: 'wx', mode: 0o600 });
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
        if (event.type === 'session' && typeof event.sessionId === 'string') record.session_id = event.sessionId.slice(0, 160);
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
        fs.rmSync(lock, { force: true });
        this.active = null;
        active.finishPromise(record);
        this.pending.delete(id);
      });
      child.stdin.end(scheduleTaskPreamble(window) + task.prompt);
      return { ...record };
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (!this.active) fs.rmSync(lock, { force: true });
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
