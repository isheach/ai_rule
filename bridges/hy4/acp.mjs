import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HY4_MODEL, HY4_MODEL_NAME, HY4_PERMISSION_MODE, HY4_TOOLS_MODE, ACP_PROTOCOL_VERSION, loadManifest, sha256File } from './manifest.mjs';
import {
  DENY_READ, MAX_COMMANDS, canonicalDirectoryWithin, canonicalFileWithin as canonicalFile,
  commandAllowed, exactWriteFor, isInside, normalizeLocationPath, normalizeTaskAuthorization,
  pathKey, safeWriteMetadata, scopeAllows, sha256, taskFingerprint, writeOperation
} from './policy.mjs';
import { Hy4UnavailableError } from '../dsh/routing.mjs';

const MAX_STDOUT = 4 * 1024 * 1024;
const MAX_ANSWER = 60000;
const MAX_POLICY = 256 * 1024;
const SAFE_STOP_REASONS = new Set(['end_turn', 'refusal', 'cancelled', 'max_tokens', 'max_turn_requests']);
const CAPABILITY_TOOLS = Object.freeze({
  'text-only': '',
  'workspace-read': 'Read,Glob,Grep',
  'workspace-write': 'Read,Glob,Grep,Edit,Write'
});
const CAPABILITY_PERMISSION = Object.freeze({
  'text-only': HY4_PERMISSION_MODE,
  'workspace-read': HY4_PERMISSION_MODE,
  'workspace-write': 'default'
});
const COMMAND_TOOL = process.platform === 'win32' ? 'PowerShell' : 'Bash';
const COMMAND_SHELL = process.platform === 'win32' ? 'powershell' : 'bash';
const SAFE_ENV = ['SystemRoot', 'WINDIR', 'PATH', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
const TOOL_STATUS = new Set(['pending', 'in_progress', 'completed', 'failed', 'cancelled']);
const BENIGN_UPDATES = new Set(['agent_thought_chunk', 'plan', 'available_commands_update', 'usage_update', 'current_mode_update', 'session_info_update']);

const now = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const bashQuote = value => `'${String(value).replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
const hookScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'command-hook.mjs');

export function sanitizeText(value, limit = MAX_ANSWER) {
  return String(value ?? '')
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|api_key|key)=)[^&\s"']+/gi, '$1[REDACTED]')
    .slice(0, limit);
}

// Backwards-compatible names used by the existing adapter tests and server.
export function canonicalWithin(root, value) {
  return canonicalDirectoryWithin(root, value, 'cwd');
}
export function canonicalFileWithin(root, value) {
  return canonicalFile(root, value, 'path');
}

function hookCommand(manifest, policyFile) {
  return `${bashQuote(manifest.node_path)} ${bashQuote(hookScript)} --policy ${bashQuote(policyFile)}`;
}

function buildSettings(capability, policyFile, manifest) {
  const permissions = {
    deny: [...DENY_READ],
    ...(capability === 'workspace-write' ? { defaultMode: 'default', disableBypassPermissionsMode: 'disable' } : {})
  };
  const settings = { permissions };
  if (policyFile) {
    settings.disableAllHooks = false;
    settings.hooks = {
      PreToolUse: [{
        matcher: COMMAND_TOOL,
        hooks: [{ type: 'command', command: hookCommand(manifest, policyFile), timeout: 20 }]
      }]
    };
  } else {
    settings.disableAllHooks = true;
  }
  return settings;
}

class AcpProcess {
  constructor(manifest, cwd, capability = 'text-only', policyFile = null) {
    this.manifest = manifest;
    this.cwd = cwd;
    this.permissionMode = CAPABILITY_PERMISSION[capability];
    this.policyFile = policyFile;
    this.onPermission = null;
    this.pending = new Map();
    this.notifications = [];
    this.sessionId = null;
    this.closed = false;
    this.protocolError = null;
    this.permissionDenied = false;
    this.permissionDeniedCount = 0;
    this.permissionAllowedCount = 0;
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.seq = 0;
    this.buffer = '';
    const env = {};
    for (const key of SAFE_ENV) if (process.env[key]) env[key] = process.env[key];
    env.CODEBUDDY_CONFIG_DIR = manifest.config_dir;
    env.CODEBUDDY_INTERNET_ENVIRONMENT = manifest.internet_environment;
    env.DISABLE_AUTOUPDATER = '1';
    env.CODEBUDDY_DISABLE_AUTO_MEMORY = '1';
    env.CODEBUDDY_DISABLE_PARENT_MEMORY = '1';
    const tools = CAPABILITY_TOOLS[capability] ?? '';
    const withCommand = policyFile ? `${tools}${tools ? ',' : ''}${COMMAND_TOOL}` : tools;
    const settings = buildSettings(capability, policyFile, manifest);
    // Command tasks get only the injected --settings document. This keeps
    // unrelated repository/local/profile hooks out of the hook-enabled
    // process. Non-command tasks preserve the previously verified user source.
    const settingSources = policyFile ? '' : 'user';
    const args = [manifest.cli_entry, '--acp', '--tools', withCommand, '--strict-mcp-config', '--mcp-config',
      JSON.stringify({ mcpServers: {} }), '--setting-sources', settingSources, '--permission-mode', this.permissionMode,
      '--settings', JSON.stringify(settings), '--no-session-persistence'];
    this.child = spawn(manifest.node_path, args, {
      cwd, env, shell: false, windowsHide: true, detached: false, stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this._stdout(chunk));
    this.child.stderr.on('data', chunk => { this.stderrBytes += Buffer.byteLength(chunk); });
    this.child.stdin.on('error', () => {});
    this.child.on('error', error => this._failAll(error));
    this.child.on('close', () => { this.closed = true; this._failAll(Error('ACP process exited.')); });
  }

  _send(value) {
    if (this.closed || !this.child.stdin.writable) throw Error('ACP process is not writable.');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  _failAll(error) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }
  _respond(id, result, error) {
    try { this._send(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }); } catch {}
  }
  _protocolFailure(code, message) {
    this.protocolError = code;
    this.kill();
    this._failAll(Error(message));
  }
  _stdout(chunk) {
    this.stdoutBytes += Buffer.byteLength(chunk);
    if (this.stdoutBytes > MAX_STDOUT) {
      this.protocolError = 'HY4_OUTPUT_LIMIT';
      this.kill(); this._failAll(Error('ACP output limit exceeded.')); return;
    }
    this.buffer += chunk;
    let pos;
    while ((pos = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, pos); this.buffer = this.buffer.slice(pos + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { this._protocolFailure('HY4_INVALID_ACP_MESSAGE', 'ACP emitted invalid JSON.'); return; }
      if (!msg || typeof msg !== 'object') { this._protocolFailure('HY4_INVALID_ACP_MESSAGE', 'ACP emitted invalid message.'); return; }
      if (msg.id !== undefined && typeof msg.method === 'string') {
        if (msg.method === 'session/request_permission') {
          const params = msg.params ?? {};
          const options = Array.isArray(params.options) ? params.options : [];
          const rejectOption = options.find(x => x?.kind === 'reject_once' && typeof x.optionId === 'string')?.optionId ?? null;
          Promise.resolve(this.onPermission ? this.onPermission(params) : null).then(decision => {
            const selected = decision?.allow && typeof decision.optionId === 'string'
              ? options.find(x => x?.kind === 'allow_once' && x.optionId === decision.optionId)
              : null;
            if (selected) {
              this.permissionAllowedCount++;
              this._respond(msg.id, { outcome: { outcome: 'selected', optionId: selected.optionId } });
            } else {
              this.permissionDenied = true; this.permissionDeniedCount++;
              this._respond(msg.id, rejectOption
                ? { outcome: { outcome: 'selected', optionId: rejectOption } }
                : { outcome: { outcome: 'cancelled' } });
            }
          }).catch(() => {
            this.permissionDenied = true; this.permissionDeniedCount++;
            this._respond(msg.id, { outcome: { outcome: 'cancelled' } });
          });
        } else {
          this._protocolFailure('HY4_UNSUPPORTED_CLIENT_REQUEST', 'Unsupported ACP client request.');
          this._respond(msg.id, undefined, { code: -32601, message: 'Unsupported client request.' });
        }
        continue;
      }
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (!entry) continue;
        this.pending.delete(msg.id); clearTimeout(entry.timer);
        if (msg.error) entry.reject(Error(`ACP request failed: ${msg.error.code ?? 'error'}.`));
        else entry.resolve(msg.result ?? {});
        continue;
      }
      for (const listener of this.notifications) { try { listener(msg); } catch {} }
    }
  }
  request(method, params, timeoutMs) {
    if (this.closed) return Promise.reject(Error('ACP process is closed.'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`ACP request timed out: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this._send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  notify(method, params) { try { this._send({ jsonrpc: '2.0', method, params }); } catch {} }
  onNotification(listener) { this.notifications.push(listener); }
  async cancel(sessionId) {
    if (sessionId) this.notify('session/cancel', { sessionId });
    await sleep(100);
    this.kill();
    await this.waitExit(2000);
  }
  kill() {
    if (this.child.exitCode === null && !this.child.killed) { try { this.child.kill(); } catch {} }
  }
  waitExit(timeoutMs = 2000) {
    if (this.child.exitCode !== null) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(resolve, timeoutMs);
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
  async close() {
    if (this.closed) return;
    if (this.sessionId) this.notify('session/cancel', { sessionId: this.sessionId });
    try { this.child.stdin.end(); } catch {}
    await sleep(150);
    this.kill();
    await this.waitExit(2000);
  }
}

export class Hy4AcpManager {
  constructor({ manifest, runtime, clock = () => new Date(), maxTimeoutMs = 900000 } = {}) {
    this.manifest = manifest?.schema === 1 ? manifest : loadManifest(manifest);
    this.runtime = path.resolve(runtime ?? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'state'), 'ai_rule', 'hy4'));
    this.clock = clock;
    this.maxTimeoutMs = maxTimeoutMs;
    this.root = path.join(this.runtime, 'requests');
    this.policyRoot = path.join(this.runtime, 'command-policy');
    this.active = new Map();
    this.opening = new Set();
    this.closing = false;
    this.lastStatus = null;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  capabilities() {
    return { 'text-only': true, 'workspace-read': this.manifest.allow_workspace_read === true, 'workspace-write': this.manifest.allow_workspace_write === true };
  }
  supports(capability) { return this.capabilities()[capability] === true; }

  routeDescriptor() {
    return {
      backend: 'hy4', provider: 'codebuddy-acp', model: HY4_MODEL, model_name: HY4_MODEL_NAME,
      permission_mode: HY4_PERMISSION_MODE, tools: HY4_TOOLS_MODE,
      capabilities: this.capabilities(),
      commands_enabled: this.manifest.allow_commands === true,
      command_tool: this.manifest.allow_commands ? COMMAND_TOOL : null,
      command_shell: this.manifest.allow_commands ? COMMAND_SHELL : null,
      free_catalog_required: true,
      free_catalog_description: 'x0.00 credits',
      free_catalog_verified: false,
      billing_attestation: false,
      verified_capabilities: { 'text-only': false, 'workspace-read': false, 'workspace-write': false },
      verified_commands: false,
      adapter_version: '0.3.0'
    };
  }

  status() {
    return this.lastStatus ?? { ...this.routeDescriptor(), ready: false, reason_code: 'HY4_NOT_PROBED', checked_at: null };
  }

  _setStatus(ready, reason_code = null) {
    this.lastStatus = { ...this.routeDescriptor(), ready, reason_code, checked_at: now() };
    if (ready) {
      this.lastStatus.verified_capabilities['text-only'] = true;
      this.lastStatus.free_catalog_verified = true;
    }
    return this.lastStatus;
  }

  _env() {
    const env = {};
    for (const key of SAFE_ENV) if (process.env[key]) env[key] = process.env[key];
    env.CODEBUDDY_CONFIG_DIR = this.manifest.config_dir;
    env.CODEBUDDY_INTERNET_ENVIRONMENT = this.manifest.internet_environment;
    env.DISABLE_AUTOUPDATER = '1';
    env.CODEBUDDY_DISABLE_AUTO_MEMORY = '1';
    env.CODEBUDDY_DISABLE_PARENT_MEMORY = '1';
    return env;
  }

  verifyInstallation() {
    if (!fs.existsSync(this.manifest.cli_entry)) throw new Hy4UnavailableError('HY4 entry is missing.', { code: 'HY4_ENTRY_MISSING' });
    if (this.manifest.expected_entry_sha256 && sha256File(this.manifest.cli_entry) !== this.manifest.expected_entry_sha256) {
      throw new Hy4UnavailableError('HY4 entry hash does not match the local manifest.', { code: 'HY4_ENTRY_HASH_MISMATCH' });
    }
    const result = spawnSync(this.manifest.node_path, [this.manifest.cli_entry, '--version'], {
      cwd: this.manifest.workspace_root, env: this._env(), shell: false, windowsHide: true,
      encoding: 'utf8', timeout: 15000, maxBuffer: 4096
    });
    if (result.error || result.status !== 0) throw new Hy4UnavailableError('HY4 version check failed.', { code: 'HY4_VERSION_CHECK_FAILED' });
    if (String(result.stdout).trim() !== this.manifest.expected_version) {
      throw new Hy4UnavailableError('HY4 version does not match the local manifest.', { code: 'HY4_VERSION_MISMATCH' });
    }
  }

  async _handshake(proc, expectedMode = HY4_PERMISSION_MODE) {
    const init = await proc.request('initialize', { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} }, 20000);
    if (!init || init.protocolVersion !== ACP_PROTOCOL_VERSION) throw new Hy4UnavailableError('ACP protocol version mismatch.', { code: 'HY4_ACP_VERSION_MISMATCH' });
    const session = await proc.request('session/new', { cwd: proc.cwd, mcpServers: [] }, 30000);
    if (!session || typeof session.sessionId !== 'string' || !session.sessionId) throw new Hy4UnavailableError('ACP session was not created.', { code: 'HY4_SESSION_MISSING' });
    if (session.modes?.currentModeId !== expectedMode) throw new Hy4UnavailableError('ACP permission mode does not match the requested capability.', { code: 'HY4_PERMISSION_MISMATCH' });
    const modelConfig = Array.isArray(session.configOptions) ? session.configOptions.find(x => x?.id === 'model') : null;
    const configOptions = modelConfig && Array.isArray(modelConfig.options) ? modelConfig.options : null;
    const availableModels = Array.isArray(session.models?.availableModels) ? session.models.availableModels : null;
    const catalogSources = [];
    if (!configOptions && !availableModels) {
      throw new Hy4UnavailableError('ACP did not advertise a recognized hy4free catalog.', { code: 'HY4_FREE_CATALOG_UNVERIFIED' });
    }
    if (availableModels) {
      const entry = availableModels.find(model => model?.modelId === HY4_MODEL);
      if (!entry || entry.description !== 'x0.00 credits') {
        throw new Hy4UnavailableError('The official ACP availableModels entry for hy4free is missing or not advertised at x0.00 credits.', { code: 'HY4_FREE_CATALOG_UNVERIFIED' });
      }
      catalogSources.push('session.models.availableModels');
    }
    if (configOptions) {
      const entry = configOptions.find(model => model?.value === HY4_MODEL);
      if (!entry || entry.description !== 'x0.00 credits') {
        throw new Hy4UnavailableError('The official ACP model option for hy4free is missing or not advertised at x0.00 credits.', { code: 'HY4_FREE_CATALOG_UNVERIFIED' });
      }
      catalogSources.push('configOptions.model.options');
    }
    const selected = await proc.request('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: HY4_MODEL }, 20000);
    const current = selected?.model?.currentValue
      ?? (Array.isArray(selected?.configOptions) ? selected.configOptions.find(x => x?.id === 'model')?.currentValue : undefined)
      ?? selected?.currentValue;
    if (current !== HY4_MODEL) throw new Hy4UnavailableError('ACP did not confirm the hy4free pin.', { code: 'HY4_MODEL_CONFIRMATION_MISMATCH' });
    proc.sessionId = session.sessionId;
    return {
      sessionId: session.sessionId, model: HY4_MODEL, permission_mode: expectedMode,
      free_catalog_verified: true, free_catalog_sources: catalogSources
    };
  }

  async _open(cwd, capability = 'text-only', policyFile = null) {
    this.verifyInstallation();
    const proc = new AcpProcess(this.manifest, cwd, capability, policyFile);
    this.opening.add(proc);
    try {
      const handshake = await this._handshake(proc, CAPABILITY_PERMISSION[capability] ?? HY4_PERMISSION_MODE);
      this.opening.delete(proc);
      return { proc, ...handshake };
    } catch (error) {
      this.opening.delete(proc);
      await proc.close();
      throw error;
    }
  }

  async probe() {
    try {
      const { proc } = await this._open(this.manifest.workspace_root);
      await proc.close();
      return this._setStatus(true, null);
    } catch (error) {
      return this._setStatus(false, error.details?.code || error.code || 'HY4_ROUTE_UNVERIFIED');
    }
  }

  validate(input, capability = 'text-only') {
    if (!this.supports(capability)) throw new Hy4UnavailableError('Requested HY4 capability is not locally enabled.', { code: 'HY4_CAPABILITY_UNAVAILABLE' });
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Hy4UnavailableError('HY4 task must be an object.');
    const allowed = new Set(['prompt', 'cwd', 'idempotencyKey', 'timeoutMs', 'permissionMode', 'authorizationNote', 'writes', 'writeScopes', 'commands']);
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Hy4UnavailableError('Unsupported HY4 task field.');
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 60000) throw new Hy4UnavailableError('HY4 prompt must contain 1..60000 UTF-8 bytes.');
    if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(input.idempotencyKey)) throw new Hy4UnavailableError('Invalid HY4 idempotencyKey.');
    const permissionMode = input.permissionMode ?? 'read-only';
    if (capability === 'workspace-write') {
      if (permissionMode !== 'workspace-write' || typeof input.authorizationNote !== 'string' || !input.authorizationNote.trim()) {
        throw new Hy4UnavailableError('Workspace-write requires permissionMode workspace-write and an explicit authorizationNote.');
      }
    } else if (permissionMode !== 'read-only') {
      throw new Hy4UnavailableError('This capability is read-only; workspace-write was not selected.', { code: 'HY4_READ_ONLY_CAPABILITY' });
    }
    if (input.authorizationNote !== undefined && (typeof input.authorizationNote !== 'string' || Buffer.byteLength(input.authorizationNote) > 2000)) {
      throw new Hy4UnavailableError('authorizationNote must be a string up to 2000 UTF-8 bytes.');
    }
    const cwd = canonicalWithin(this.manifest.workspace_root, input.cwd);
    const timeoutMs = input.timeoutMs ?? 600000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > this.maxTimeoutMs) throw new Hy4UnavailableError('Invalid HY4 timeoutMs.');
    let authorization;
    try {
      authorization = normalizeTaskAuthorization({
        cwd, permissionMode, capability,
        writes: input.writes, writeScopes: input.writeScopes, commands: input.commands
      });
    } catch (error) {
      throw new Hy4UnavailableError(error.message, { code: 'HY4_INVALID_TASK' });
    }
    if (authorization.commands.length > MAX_COMMANDS) throw new Hy4UnavailableError('Too many HY4 commands.');
    if (authorization.commands.length > 0) {
      if (this.manifest.allow_commands !== true) throw new Hy4UnavailableError('Native commands are not enabled by the local HY4 manifest.', { code: 'HY4_COMMANDS_UNAVAILABLE' });
      if (!this.manifest.hook_shell_path || !fs.existsSync(this.manifest.hook_shell_path) || !fs.statSync(this.manifest.hook_shell_path).isFile()) {
        throw new Hy4UnavailableError('Native commands require an existing explicit local hook shell.', { code: 'HY4_COMMAND_HOOK_UNAVAILABLE' });
      }
      if (!fs.existsSync(hookScript)) throw new Hy4UnavailableError('The local command hook script is missing.', { code: 'HY4_COMMAND_HOOK_UNAVAILABLE' });
    }
    const task = {
      prompt: input.prompt, cwd, idempotencyKey: input.idempotencyKey, timeoutMs, permissionMode,
      authorizationNote: input.authorizationNote ?? null, capability,
      writes: authorization.writes, writeScopes: authorization.writeScopes, commands: authorization.commands
    };
    task.fingerprint = taskFingerprint({ ...task, backend: 'hy4' });
    return task;
  }

  _receiptPath(key) { return path.join(this.root, `${digest(`hy4:${key}`)}.json`); }
  _claimPath(key) { return path.join(this.root, `${digest(`hy4:${key}`)}.claim`); }

  _read(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw Error('HY4 receipt is unreadable; refusing to guess admission state.'); }
  }
  _write(file, record) {
    record.updated_at = now();
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  _claim(key, requestId) {
    const file = this._claimPath(key);
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (error) { throw new Hy4UnavailableError('A durable HY4 claim already exists; no retry is allowed.', { code: 'HY4_CLAIM_EXISTS', cause: error.code }); }
    try {
      fs.writeFileSync(fd, JSON.stringify({ schema: 1, request_id: requestId, state: 'dispatching', pid: process.pid, created_at: now() }) + '\n');
      fs.fsyncSync(fd);
    } finally { try { fs.closeSync(fd); } catch {} }
  }

  _writeCommandPolicy(taskId, task) {
    if (task.commands.length === 0) return null;
    if (!this.manifest.allow_commands || !this.manifest.hook_shell_path) {
      throw new Hy4UnavailableError('Native commands are not locally enabled.', { code: 'HY4_COMMANDS_UNAVAILABLE' });
    }
    const dir = this.policyRoot;
    if (isInside(task.cwd, dir)) throw new Hy4UnavailableError('The command policy must live outside the approved task cwd.', { code: 'HY4_COMMAND_POLICY_LOCATION' });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${digest(`command-policy:${taskId}`)}.json`);
    const policy = {
      schema: 1, task_id: taskId, cwd: task.cwd, command_tool: COMMAND_TOOL,
      commands: [...task.commands], created_at: now()
    };
    const bytes = JSON.stringify(policy, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > MAX_POLICY) throw new Hy4UnavailableError('Command policy is too large.', { code: 'HY4_COMMAND_POLICY_INVALID' });
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, bytes, { mode: 0o600 });
    fs.renameSync(temp, file);
    try { this._verifyCommandHook(file, task); }
    catch (error) { try { fs.unlinkSync(file); } catch {} throw error; }
    return file;
  }

  _verifyCommandHook(policyFile, task) {
    const command = hookCommand(this.manifest, policyFile);
    const run = payload => spawnSync(this.manifest.hook_shell_path, ['-c', command], {
      cwd: task.cwd, env: this._env(), shell: false, windowsHide: true, encoding: 'utf8',
      timeout: 20000, maxBuffer: 4096, input: JSON.stringify(payload)
    });
    const denied = run({
      hook_event_name: 'PreToolUse', tool_name: COMMAND_TOOL, cwd: task.cwd,
      tool_input: { command: '__hy4_hook_denied_probe__', cwd: task.cwd }
    });
    if (denied.error || denied.status !== 2) {
      throw new Hy4UnavailableError('The native command hook did not fail closed when verified.', { code: 'HY4_COMMAND_HOOK_UNVERIFIED' });
    }
    const allowed = run({
      hook_event_name: 'PreToolUse', tool_name: COMMAND_TOOL, cwd: task.cwd,
      tool_input: { command: task.commands[0], cwd: task.cwd }
    });
    if (allowed.error || allowed.status !== 0 || String(allowed.stdout ?? '').trim() !== '') {
      throw new Hy4UnavailableError('The native command hook did not accept the exact authorized command.', { code: 'HY4_COMMAND_HOOK_UNVERIFIED' });
    }
  }

  _removePolicy(policyFile) {
    if (!policyFile || !isInside(this.policyRoot, policyFile)) return;
    try { fs.unlinkSync(policyFile); } catch {}
  }

  // RoutingCoordinator adapter boundary.
  async submit(input) {
    const capability = input?.capability;
    if (!this.supports(capability)) throw new Hy4UnavailableError('HY4 capability is unavailable.', { code: 'HY4_CAPABILITY_UNAVAILABLE' });
    const { capability: _capability, ...task } = input;
    return this.start(task, capability);
  }

  async start(input, capability) {
    const declared = input && typeof input === 'object' && !Array.isArray(input) ? input.capability : undefined;
    if (declared !== undefined && !['text-only', 'workspace-read', 'workspace-write'].includes(declared)) {
      throw new Hy4UnavailableError('Invalid HY4 capability.', { code: 'HY4_CAPABILITY_UNAVAILABLE' });
    }
    if (capability !== undefined && declared !== undefined && declared !== capability) {
      throw new Hy4UnavailableError('Explicit HY4 capability conflicts with the task capability.', { code: 'HY4_CAPABILITY_CONFLICT' });
    }
    const chosenCapability = capability ?? declared ?? 'text-only';
    let task;
    try {
      const { capability: _declared, ...rest } = input ?? {};
      task = this.validate(rest, chosenCapability);
    }
    catch (error) {
      throw error instanceof Hy4UnavailableError ? error : new Hy4UnavailableError('HY4 task validation failed.', { code: 'HY4_INVALID_TASK' });
    }
    capability = chosenCapability;
    const receiptFile = this._receiptPath(task.idempotencyKey);
    const prior = this._read(receiptFile);
    if (prior) {
      if (typeof prior.task_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(prior.task_fingerprint)) {
        throw new Hy4UnavailableError('The prior HY4 receipt predates scope identity and cannot be replayed safely.', { code: 'HY4_IDEMPOTENCY_LEGACY_UNVERIFIABLE' });
      }
      if (prior.task_fingerprint !== task.fingerprint) throw new Hy4UnavailableError('Idempotency key already used with different HY4 arguments or scope.', { code: 'HY4_IDEMPOTENCY_CONFLICT' });
      return prior;
    }
    const requestId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    let policyFile = null;
    try { policyFile = this._writeCommandPolicy(taskId, task); }
    catch (error) { this._removePolicy(policyFile); throw error; }
    try { this._claim(task.idempotencyKey, requestId); }
    catch (error) { this._removePolicy(policyFile); throw error; }
    const metadata = safeWriteMetadata(task);
    const record = {
      schema: 2, task_id: taskId, backend: 'hy4', provider: 'codebuddy-acp', request_id: requestId,
      idempotency_key_sha256: digest(`hy4:${task.idempotencyKey}`), prompt_sha256: digest(task.prompt),
      task_fingerprint: task.fingerprint,
      free_catalog_verified: false,
      free_catalog_description: 'x0.00 credits',
      free_catalog_sources: null,
      cwd: task.cwd, permission_mode: task.permissionMode, capability,
      configured_model: HY4_MODEL, selected_model: null,
      tools: `${CAPABILITY_TOOLS[capability] || ''}${task.commands.length ? `${CAPABILITY_TOOLS[capability] ? ',' : ''}${COMMAND_TOOL}` : ''}`,
      state: 'starting', admission: 'not_sent', status: 'starting', started_at: now(), finished_at: null,
      pid: null, session_id: null, stop_reason: null, answer: '', answer_truncated: false, tool_events: 0,
      allowed_operations: 0, completed_operations: 0, denied_operations: 0, unconfirmed_operations: 0,
      auto_approved_operations: 0, observed_operations: 0,
      command_tool: task.commands.length ? COMMAND_TOOL : null,
      command_enforcement: task.commands.length ? 'pretooluse_hook_configured' : null,
      command_policy_sha256: task.commands.length ? digest(JSON.stringify(task.commands)) : null,
      ...metadata,
      error_code: null, verification: 'not_yet_reviewed'
    };
    this._write(receiptFile, record);
    let opened;
    try {
      opened = await this._open(task.cwd, capability, policyFile);
      if (this.closing) {
        await opened.proc.close();
        throw new Hy4UnavailableError('HY4 bridge is shutting down before prompt.', { code: 'HY4_SHUTDOWN_BEFORE_PROMPT' });
      }
      record.selected_model = opened.model;
      record.free_catalog_verified = opened.free_catalog_verified === true;
      record.free_catalog_sources = Array.isArray(opened.free_catalog_sources) ? [...opened.free_catalog_sources] : null;
      record.permission_mode = opened.permission_mode;
      record.acp_permission_mode = opened.permission_mode;
      record.task_permission_mode = task.permissionMode;
      record.session_id = opened.sessionId;
      record.pid = opened.proc.child.pid || null;
      record.state = 'accepted';
      record.admission = 'sending';
      record.status = 'running';
      this._write(receiptFile, record);
    } catch (error) {
      record.state = 'not_accepted';
      record.status = 'failed';
      record.error_code = error.details?.code || error.code || 'HY4_NOT_READY';
      record.finished_at = now();
      this._write(receiptFile, record);
      this._removePolicy(policyFile);
      if (opened) await opened.proc.close();
      throw error instanceof Hy4UnavailableError ? error : new Hy4UnavailableError('HY4 handshake failed before prompt.', { code: 'HY4_HANDSHAKE_FAILED' });
    }
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const active = {
      record, file: receiptFile, proc: opened.proc, finished, finish, done: false, capability, task,
      toolCalls: new Map(), decided: new Set(), exactWrites: new Map(),
      commands: new Set(task.commands), writes: task.writes, writeScopes: task.writeScopes,
      policyFile, allowedOperations: 0, completedOperations: 0, denied: 0, unconfirmed: 0,
      unclassified: 0, unverified: 0, failedTools: 0, failCode: null, abortTurn: null
    };
    for (const write of task.writes) active.exactWrites.set(pathKey(write.path), write);
    opened.proc.onPermission = params => this._permission(active, params);
    this.active.set(taskId, active);
    if (this.closing) {
      await this.cancel(taskId, 'bridge_shutdown');
      throw new Hy4UnavailableError('HY4 bridge is shutting down before prompt.', { code: 'HY4_SHUTDOWN_BEFORE_PROMPT' });
    }
    void this._run(active, task);
    this._setStatus(true, null);
    return { ...record };
  }

  _failActive(active, code) {
    if (!active.failCode) active.failCode = code;
    if (typeof active.abortTurn === 'function') active.abortTurn(code);
  }

  _locationPaths(event) {
    const locations = Array.isArray(event.locations) ? event.locations : [];
    const result = [];
    for (const location of locations) {
      const value = normalizeLocationPath(location);
      if (!value) return null;
      result.push(value);
    }
    return result;
  }

  _locationWithinCwd(active, value) {
    try {
      const target = canonicalFile(active.task.cwd, value, 'tool location');
      return { path: target, directory: false };
    } catch {
      try {
        const dir = canonicalDirectoryWithin(active.task.cwd, value, 'tool location');
        return { path: dir, directory: true };
      } catch { return null; }
    }
  }

  _rawWrite(active, event, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'HY4_WRITE_INPUT_MISSING' };
    for (const key of Object.keys(raw)) {
      if (!['file_path', 'path', 'content', 'old_string', 'new_string', 'replace_all'].includes(key)) {
        return { ok: false, code: 'HY4_WRITE_INPUT_CONFLICT' };
      }
    }
    const filePath = raw.file_path ?? raw.path;
    if (typeof filePath !== 'string') return { ok: false, code: 'HY4_WRITE_PATH_MISSING' };
    if (raw.file_path !== undefined && raw.path !== undefined && pathKey(raw.file_path) !== pathKey(raw.path)) {
      return { ok: false, code: 'HY4_WRITE_PATH_CONFLICT' };
    }
    if (raw.replace_all !== undefined && typeof raw.replace_all !== 'boolean') return { ok: false, code: 'HY4_WRITE_INPUT_CONFLICT' };
    let target;
    try { target = canonicalFile(active.task.cwd, filePath, 'write target'); }
    catch { return { ok: false, code: 'HY4_WRITE_PATH_REFUSED' }; }
    let exists;
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, code: 'HY4_WRITE_PATH_REFUSED' };
      exists = true;
    } catch (error) {
      if (error.code !== 'ENOENT') return { ok: false, code: 'HY4_WRITE_PATH_REFUSED' };
      exists = false;
    }
    const hasContent = typeof raw.content === 'string';
    const hasEdit = typeof raw.old_string === 'string' && typeof raw.new_string === 'string';
    if (hasContent === hasEdit) return { ok: false, code: 'HY4_WRITE_INPUT_CONFLICT' };
    if (hasEdit && raw.content !== undefined) return { ok: false, code: 'HY4_WRITE_INPUT_CONFLICT' };
    if (hasContent && (raw.old_string !== undefined || raw.new_string !== undefined)) return { ok: false, code: 'HY4_WRITE_INPUT_CONFLICT' };
    if (hasEdit && (!raw.old_string || raw.old_string === raw.new_string)) return { ok: false, code: 'HY4_WRITE_INPUT_CONFLICT' };
    const operation = writeOperation({ exists, content: raw.content, oldString: raw.old_string, newString: raw.new_string });
    if (!operation) return { ok: false, code: 'HY4_WRITE_INPUT_CONFLICT' };
    const locations = this._locationPaths(event);
    if (!locations || locations.length === 0) return { ok: false, code: 'HY4_WRITE_LOCATION_MISSING' };
    let matched = false;
    for (const location of locations) {
      const resolved = this._locationWithinCwd(active, location);
      if (!resolved || resolved.directory) return { ok: false, code: 'HY4_WRITE_LOCATION_OUTSIDE' };
      if (pathKey(resolved.path) === pathKey(target)) matched = true;
    }
    if (!matched) return { ok: false, code: 'HY4_WRITE_LOCATION_CONFLICT' };
    const exact = exactWriteFor(active.writes, target);
    if (exact) {
      const compatible = exact.mode === 'write' ? (operation === 'create' || operation === 'replace')
        : exact.mode === 'create' ? operation === 'create'
          : exact.mode === 'edit' ? operation === 'edit' : false;
      if (!compatible) return { ok: false, code: 'HY4_WRITE_MODE_REFUSED' };
      if (exact.content_sha256) {
        if (!hasContent) return { ok: false, code: 'HY4_WRITE_HASH_UNSUPPORTED' };
        if (digest(raw.content) !== exact.content_sha256) return { ok: false, code: 'HY4_WRITE_HASH_MISMATCH' };
      }
    } else if (!scopeAllows(active.writeScopes, target, operation)) {
      return { ok: false, code: 'HY4_WRITE_SCOPE_REFUSED' };
    }
    // Native Edit may create an absent path only when a directory scope
    // explicitly authorized create. A bare exact-file grant is not enough for
    // this ambiguous native shape.
    if (operation === 'create' && hasEdit && !scopeAllows(active.writeScopes, target, 'create')) {
      return { ok: false, code: 'HY4_EDIT_CREATE_SCOPE_REQUIRED' };
    }
    return { ok: true, target, operation, raw, content: hasContent ? raw.content : null };
  }

  _rawCommand(active, event, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'HY4_COMMAND_INPUT_MISSING' };
    for (const key of Object.keys(raw)) {
      if (!['command', 'cwd', 'description', 'timeout'].includes(key)) return { ok: false, code: 'HY4_COMMAND_INPUT_CONFLICT' };
    }
    if (!commandAllowed(active.task.commands, raw.command)) return { ok: false, code: 'HY4_COMMAND_NOT_AUTHORIZED' };
    if (raw.cwd !== undefined) {
      let cwd;
      try { cwd = canonicalDirectoryWithin(active.task.cwd, raw.cwd, 'command cwd'); }
      catch { return { ok: false, code: 'HY4_COMMAND_CWD_REFUSED' }; }
      if (pathKey(cwd) !== pathKey(active.task.cwd)) return { ok: false, code: 'HY4_COMMAND_CWD_REFUSED' };
    }
    const locations = this._locationPaths(event);
    if (locations === null) return { ok: false, code: 'HY4_COMMAND_LOCATION_INVALID' };
    for (const location of locations) {
      const resolved = this._locationWithinCwd(active, location);
      if (!resolved) return { ok: false, code: 'HY4_COMMAND_LOCATION_OUTSIDE' };
      if (!resolved.directory && pathKey(resolved.path) !== pathKey(active.task.cwd)) {
        // A file location is only acceptable when it is exactly the task cwd.
        return { ok: false, code: 'HY4_COMMAND_LOCATION_CONFLICT' };
      }
    }
    return { ok: true, raw };
  }

  _rawCallbackConflict(event, raw) {
    if (!event.rawInput || typeof event.rawInput !== 'object' || !raw || typeof raw !== 'object') return false;
    if (event.kind === 'edit') {
      const before = event.rawInput;
      if (before.content !== undefined && before.content !== raw.content) return true;
      if (before.old_string !== undefined && before.old_string !== raw.old_string) return true;
      if (before.new_string !== undefined && before.new_string !== raw.new_string) return true;
      if (before.replace_all !== undefined && before.replace_all !== raw.replace_all) return true;
      const beforePath = before.file_path ?? before.path;
      const afterPath = raw.file_path ?? raw.path;
      if (typeof beforePath === 'string' && typeof afterPath === 'string' && pathKey(beforePath) !== pathKey(afterPath)) return true;
    }
    if (event.kind === 'execute' && event.rawInput.command !== undefined && event.rawInput.command !== raw.command) return true;
    return false;
  }

  async _permission(active, params) {
    if (active.done || active.capability !== 'workspace-write') { active.record.denied_operations++; active.denied++; return null; }
    if (params?.sessionId !== active.record.session_id) { active.record.denied_operations++; active.denied++; this._failActive(active, 'HY4_PERMISSION_SESSION_MISMATCH'); return null; }
    const toolCall = params?.toolCall ?? {};
    const id = params?.toolCallId ?? toolCall.toolCallId;
    if (typeof id !== 'string' || !id) { active.record.denied_operations++; active.denied++; return null; }
    if (active.decided.has(id)) { active.record.denied_operations++; active.denied++; this._failActive(active, 'HY4_PERMISSION_DUPLICATE_CALLBACK'); return null; }
    const event = active.toolCalls.get(id);
    if (!event) { active.record.denied_operations++; active.denied++; this._failActive(active, 'HY4_PERMISSION_UNKNOWN_CALL'); return null; }
    if (toolCall.kind !== undefined && toolCall.kind !== event.kind) { active.record.denied_operations++; active.denied++; this._failActive(active, 'HY4_PERMISSION_KIND_CONFLICT'); return null; }
    if (!event.kind) { active.record.denied_operations++; active.denied++; this._failActive(active, 'HY4_PERMISSION_KIND_MISSING'); return null; }
    if (event.policyCode) {
      active.record.denied_operations++;
      active.denied++;
      active.record.error_code ||= event.policyCode;
      return null;
    }
    const options = Array.isArray(params.options) ? params.options : [];
    const option = options.find(x => x?.kind === 'allow_once' && typeof x.optionId === 'string');
    if (!option) { active.record.denied_operations++; active.denied++; return null; }
    const raw = toolCall.rawInput ?? event.rawInput;
    if (this._rawCallbackConflict(event, raw)) {
      active.record.denied_operations++; active.denied++;
      this._failActive(active, 'HY4_PERMISSION_RAW_CONFLICT');
      return null;
    }
    let decision;
    if (event.kind === 'edit') decision = this._rawWrite(active, event, raw);
    else if (event.kind === 'execute') decision = this._rawCommand(active, event, raw);
    else decision = { ok: false, code: 'HY4_PERMISSION_KIND_REFUSED' };
    if (!decision.ok) {
      active.record.denied_operations++; active.denied++;
      if (typeof decision.code === 'string' && /^(?:HY4_WRITE_PATH|HY4_WRITE_MODE|HY4_WRITE_SCOPE|HY4_WRITE_HASH|HY4_WRITE_LOCATION|HY4_EDIT_CREATE|HY4_COMMAND|HY4_PERMISSION)/.test(decision.code)) {
        // A confirmed out-of-policy callback is a terminal permission decision,
        // not a model-prose judgement. Do not kill the process before sending a
        // reject response; the normal refusal path will settle it.
        active.record.error_code ||= decision.code;
      }
      return null;
    }
    active.decided.add(id);
    event.decision = 'allowed';
    event.allowed = true;
    event.operation = decision.operation ?? 'execute';
    if (decision.target) event.target = decision.target;
    if (decision.raw) event.raw = decision.raw;
    active.allowedOperations++;
    active.record.allowed_operations++;
    return { allow: true, optionId: option.optionId };
  }

  _toolStatus(active, event, status, previousStatus) {
    if (previousStatus === status) return;
    if (previousStatus === 'completed' && status !== 'completed') {
      this._failActive(active, 'HY4_TOOL_STATUS_REGRESSION');
      return;
    }
    event.status = status;
    if (status === 'completed') this._completeTool(active, event);
    else if (status === 'failed' || status === 'cancelled') {
      event.terminal_noncompleted = true;
      active.failedTools++;
      if (event.allowed) active.unconfirmed++;
    }
  }

  _completeTool(active, event) {
    if (event.completed) return;
    if (!event.kind) { active.unclassified++; this._failActive(active, 'HY4_TOOL_KIND_MISSING'); return; }
    if (!['read', 'search', 'edit', 'execute'].includes(event.kind)) {
      // Provisional "other" metadata is tolerated while in flight, but a
      // terminal unclassified tool must never become a successful operation.
      active.unclassified++;
      this._failActive(active, 'HY4_TOOL_KIND_REFUSED');
      return;
    }
    if (event.kind === 'edit' || event.kind === 'execute') {
      if (!event.allowed) {
        if (event.kind === 'execute' && active.task.commands.length > 0 && active.policyFile) {
          active.record.auto_approved_operations++;
        } else {
          active.unverified++;
          active.record.unconfirmed_operations++;
          this._failActive(active, event.kind === 'edit' ? 'HY4_UNVERIFIED_WRITE' : 'HY4_UNVERIFIED_COMMAND');
          return;
        }
      }
      if (event.kind === 'edit') {
        const target = event.target;
        if (!target) { active.unclassified++; this._failActive(active, 'HY4_WRITE_TARGET_MISSING'); return; }
        try {
          const stat = fs.lstatSync(target);
          if (stat.isSymbolicLink() || !stat.isFile()) throw Error('not a regular file');
        } catch {
          active.unconfirmed++;
          active.record.unconfirmed_operations++;
          this._failActive(active, 'HY4_WRITE_NOT_CONFIRMED');
          return;
        }
        const exact = active.exactWrites.get(pathKey(target));
        if (exact?.content_sha256 && event.raw && typeof event.raw.content === 'string') {
          let actual;
          try { actual = digest(fs.readFileSync(target)); } catch { actual = null; }
          if (actual !== exact.content_sha256) {
            active.unconfirmed++;
            active.record.unconfirmed_operations++;
            this._failActive(active, 'HY4_WRITE_HASH_NOT_CONFIRMED');
            return;
          }
        }
      }
    }
    event.completed = true;
    active.completedOperations++;
    active.record.completed_operations++;
  }

  _mergeToolEvent(active, update) {
    if (typeof update.toolCallId !== 'string' || !update.toolCallId) {
      active.unclassified++;
      this._failActive(active, 'HY4_TOOLCALL_ID_MISSING');
      return null;
    }
    if (update.sessionUpdate === 'tool_call_update' && !active.toolCalls.has(update.toolCallId)) {
      active.unclassified++;
      this._failActive(active, 'HY4_TOOL_UPDATE_WITHOUT_CALL');
      return null;
    }
    const previous = active.toolCalls.get(update.toolCallId) ?? {};
    const merged = { ...previous };
    for (const key of ['kind', 'title', 'locations', 'rawInput', 'content', 'status']) {
      if (update[key] !== undefined) merged[key] = update[key];
    }
    if (merged.kind !== undefined && typeof merged.kind !== 'string') {
      active.unclassified++;
      this._failActive(active, 'HY4_TOOL_KIND_INVALID');
      return null;
    }
    if (merged.status !== undefined && !TOOL_STATUS.has(merged.status)) {
      active.unclassified++;
      this._failActive(active, 'HY4_TOOL_STATUS_INVALID');
      return null;
    }
    active.toolCalls.set(update.toolCallId, merged);
    if (merged.status !== undefined) this._toolStatus(active, merged, merged.status, previous.status);
    return merged;
  }

  _inspectEarly(active, event) {
    if (!event.kind) return;
    if (event.kind === 'edit') {
      if (event.rawInput === undefined) return;
      const decision = this._rawWrite(active, event, event.rawInput);
      if (!decision.ok) {
        // Keep the call pending for the normal permission callback so the
        // vendor receives a reject_once decision. If it completes without that
        // callback, _completeTool fails closed.
        event.policyCode = decision.code;
      }
    } else if (event.kind === 'execute') {
      if (event.rawInput === undefined) return;
      const decision = this._rawCommand(active, event, event.rawInput);
      if (!decision.ok) {
        event.policyCode = decision.code;
        this._failActive(active, decision.code);
      }
    } else if (event.kind === 'read' || event.kind === 'search') {
      const locations = this._locationPaths(event);
      if (locations === null) { this._failActive(active, 'HY4_READ_LOCATION_INVALID'); return; }
      for (const location of locations) {
        if (!this._locationWithinCwd(active, location)) { this._failActive(active, 'HY4_OUTSIDE_READ'); return; }
      }
      const rawPath = event.rawInput?.file_path ?? event.rawInput?.path;
      if (rawPath !== undefined) {
        try {
          const resolved = canonicalFile(active.task.cwd, rawPath, 'read path');
          if (!this._locationWithinCwd(active, resolved)) this._failActive(active, 'HY4_OUTSIDE_READ');
        } catch {
          try {
            const resolved = canonicalDirectoryWithin(active.task.cwd, rawPath, 'read path');
            if (!this._locationWithinCwd(active, resolved)) this._failActive(active, 'HY4_OUTSIDE_READ');
          } catch { this._failActive(active, 'HY4_OUTSIDE_READ'); }
        }
      }
    } else if (event.kind === 'other') {
      // Official ACP may stream provisional kind:other/in_progress metadata
      // before the real tool kind, locations and input arrive. Do not approve
      // it or fail the turn while it is provisional; _completeTool rejects an
      // unclassified terminal, and a later concrete kind is re-inspected.
      return;
    } else {
      this._failActive(active, 'HY4_TOOL_KIND_REFUSED');
    }
  }

  async _run(active, task) {
    const { record, proc, file } = active;
    const timer = setTimeout(() => { void this.cancel(record.task_id, 'timeout'); }, task.timeoutMs);
    const failTurn = code => {
      if (active.done) return;
      active.done = true;
      record.state = 'failed'; record.status = 'failed'; record.error_code = code;
      record.finished_at = now(); this._write(file, record);
      void proc.cancel(record.session_id).catch(() => {});
    };
    const onUpdate = msg => {
      if (active.done) return;
      // Only ACP session/update carries task progress. Other id-less
      // notifications are metadata/UI chatter and must not abort the turn.
      if (msg?.method !== 'session/update') return;
      const params = msg?.params;
      if (params?.sessionId && params.sessionId !== record.session_id) { failTurn('HY4_UNKNOWN_SESSION'); return; }
      const update = params?.update ?? msg?.update;
      if (!update || typeof update !== 'object' || Array.isArray(update)) { failTurn('HY4_INVALID_UPDATE'); return; }
      if (update.sessionUpdate === 'agent_message_chunk') {
        const content = update.content;
        const text = Array.isArray(content)
          ? content.filter(x => x?.type === 'text').map(x => x.text ?? '').join('')
          : content?.type === 'text' ? String(content.text ?? '') : '';
        if (text) record.answer = sanitizeText(record.answer + text);
        return;
      }
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        record.tool_events++;
        if (active.capability === 'text-only') { failTurn('HY4_UNEXPECTED_TOOL_EVENT'); return; }
        if (update.sessionUpdate === 'tool_call') {
          if (update.toolCallId === undefined) { failTurn('HY4_TOOLCALL_ID_MISSING'); return; }
          // ACP implementations may repeat the initial tool_call with more
          // optional details, including rawInput/locations arriving separately.
          // Only a new toolCallId is a new observed operation.
          if (!active.toolCalls.has(update.toolCallId)) record.observed_operations++;
        }
        const merged = this._mergeToolEvent(active, update);
        if (!merged || active.done) return;
        this._inspectEarly(active, merged);
        return;
      }
      if (update.sessionUpdate === 'config_option_update') {
        if (update.configId === 'model' && update.value !== undefined && update.value !== HY4_MODEL) { failTurn('HY4_RUNTIME_MODEL_MISMATCH'); return; }
        if (update.configId === 'mode' && update.value !== undefined && update.value !== proc.permissionMode) { failTurn('HY4_PERMISSION_CHANGED'); return; }
        const options = update.configOptions ?? (update.configOption ? [update.configOption] : []);
        for (const option of Array.isArray(options) ? options : []) {
          if (option?.id === 'model' && option.currentValue !== undefined && option.currentValue !== HY4_MODEL) { failTurn('HY4_RUNTIME_MODEL_MISMATCH'); return; }
          if (option?.id === 'mode' && option.currentValue !== undefined && option.currentValue !== proc.permissionMode) { failTurn('HY4_PERMISSION_CHANGED'); return; }
        }
        return;
      }
      if (BENIGN_UPDATES.has(update.sessionUpdate)) {
        const model = update._meta?.modelId ?? update.model?.currentValue ?? update.model?.value ?? update.model ?? update.currentModel;
        if (typeof model === 'string' && model !== HY4_MODEL) return failTurn('HY4_RUNTIME_MODEL_MISMATCH');
        const mode = update.currentModeId ?? update.modeId ?? update.mode?.currentModeId;
        if (typeof mode === 'string' && mode !== proc.permissionMode) return failTurn('HY4_PERMISSION_CHANGED');
        return;
      }
      failTurn('HY4_UNKNOWN_SESSION_UPDATE');
    };
    active.abortTurn = failTurn;
    proc.onNotification(onUpdate);
    try {
      const response = await proc.request('session/prompt', { sessionId: record.session_id, prompt: [{ type: 'text', text: task.prompt }] }, task.timeoutMs);
      if (active.done) return;
      const observed = response?._meta?.modelId ?? response?.model?.currentValue ?? response?.model ?? response?.currentModel;
      if (typeof observed === 'string' && observed !== HY4_MODEL) return failTurn('HY4_RUNTIME_MODEL_MISMATCH');
      const rawStop = typeof response?.stopReason === 'string' ? response.stopReason : 'unknown';
      const stop = SAFE_STOP_REASONS.has(rawStop) ? rawStop : 'unknown';
      record.stop_reason = stop;
      if (!SAFE_STOP_REASONS.has(rawStop)) return failTurn('HY4_UNEXPECTED_STOP_REASON');
      if (record.tool_events > 0 && active.capability === 'text-only') return failTurn('HY4_UNEXPECTED_TOOL_EVENT');
      if (active.failCode) return failTurn(active.failCode);
      if (active.unclassified > 0) return failTurn('HY4_UNKNOWN_TOOL_ACTIVITY');
      if (active.unverified > 0) return failTurn('HY4_UNVERIFIED_OPERATION');
      const incomplete = [...active.toolCalls.values()].filter(event => !event.kind || (!event.completed && !event.terminal_noncompleted));
      if (incomplete.length > 0) return failTurn('HY4_OPERATION_NOT_CONFIRMED');
      if (active.allowedOperations > active.completedOperations || active.unconfirmed > 0) {
        return failTurn('HY4_OPERATION_NOT_CONFIRMED');
      }
      if (proc.permissionDenied || active.denied > 0 || record.denied_operations > 0) {
        record.state = active.completedOperations > 0 ? 'partial' : 'refused';
        record.status = 'failed';
        record.error_code = record.error_code || (proc.permissionDenied ? 'HY4_PERMISSION_DENIED' : 'HY4_PARTIAL_DENIED_OPERATION');
        record.finished_at = now(); this._write(file, record);
        return;
      }
      if (active.failedTools > 0 && active.completedOperations === 0) return failTurn('HY4_TOOL_TERMINAL_FAILURE');
      if (stop === 'end_turn') { record.state = 'completed'; record.status = 'completed'; }
      else if (stop === 'refusal') { record.state = 'refused'; record.status = 'failed'; record.error_code = 'HY4_REFUSAL'; }
      else { record.state = 'failed'; record.status = 'failed'; record.error_code = `HY4_STOP_${stop}`; }
      record.answer_truncated = record.answer.length >= MAX_ANSWER;
      record.finished_at = now();
      this._write(file, record);
    } catch (error) {
      if (!active.done) {
        if (active.failCode) { record.state = 'failed'; record.status = 'failed'; record.error_code = active.failCode; }
        else if (proc.protocolError) { record.state = 'failed'; record.status = 'failed'; record.error_code = proc.protocolError; }
        else { record.state = 'unknown'; record.status = 'unknown'; record.error_code = 'HY4_UNKNOWN_AFTER_SEND'; }
        record.finished_at = now(); this._write(file, record);
      }
    } finally {
      clearTimeout(timer);
      this._removePolicy(active.policyFile);
      await proc.close();
      active.done = true;
      this.active.delete(record.task_id);
      active.finish(record);
    }
  }

  get(taskId) {
    if (typeof taskId !== 'string' || !/^[a-f0-9-]{36}$/.test(taskId)) throw Error('Invalid HY4 task ID.');
    for (const active of this.active.values()) if (active.record.task_id === taskId) return { ...active.record };
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const record = this._read(path.join(this.root, entry.name));
      if (record?.task_id === taskId) {
        if (['starting', 'accepted', 'running'].includes(record.state)) return { ...record, state: 'unknown', status: 'unknown', warning: 'Owner process is not active; do not retry.' };
        return record;
      }
    }
    throw Error(`HY4 task ${taskId} not found.`);
  }

  async wait(taskId, waitMs = 25000) {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60000) throw Error('waitMs must be 0..60000.');
    const active = [...this.active.values()].find(x => x.record.task_id === taskId);
    if (active) {
      let timer;
      await Promise.race([active.finished, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
      clearTimeout(timer);
    }
    return this.get(taskId);
  }

  async run(input, capability) {
    const started = await this.start(input, capability);
    const active = [...this.active.values()].find(x => x.record.task_id === started.task_id);
    if (active) await active.finished;
    return this.get(started.task_id);
  }

  async cancel(taskId, reason = 'user_cancelled') {
    const active = [...this.active.values()].find(x => x.record.task_id === taskId);
    if (!active || active.done) return this.get(taskId);
    active.record.state = 'cancelled'; active.record.status = 'cancelled';
    active.record.stop_reason = reason; active.record.finished_at = now();
    this._write(active.file, active.record);
    active.done = true;
    this._removePolicy(active.policyFile);
    await active.proc.cancel(active.record.session_id);
    this.active.delete(taskId);
    active.finish(active.record);
    return { ...active.record };
  }

  async close() {
    this.closing = true;
    for (const proc of [...this.opening]) await proc.close();
    for (const active of [...this.active.values()]) await this.cancel(active.record.task_id, 'bridge_shutdown');
  }
}

export function createHy4Manager(options) { return new Hy4AcpManager(options); }
