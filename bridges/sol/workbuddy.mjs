import { spawn } from 'node:child_process';
import { WORKBUDDY_DSF } from '../workbuddy/dispatch.mjs';
import { limitText, SAFE_ID } from './config.mjs';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PASSTHROUGH = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']);
const TERMINAL = ['completed', 'failed', 'refused', 'cancelled', 'timed_out', 'unknown_after_disconnect'];
const resultData = result => result?.structuredContent ?? JSON.parse(result?.content?.find(item => item.type === 'text')?.text ?? 'null');

function stdioEnv(config) {
  const allowed = new Set([...PASSTHROUGH, ...config.envVars]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
  return { ...env, WB_MODEL: WORKBUDDY_DSF.model, WB_SKIP_PERMISSIONS: 'false' };
}

function validateArguments(args, schema) {
  if (schema?.type !== 'object' || !schema.properties || (schema.required ?? []).some(key => !Object.hasOwn(args, key))) {
    throw Error('The installed WorkBuddy run schema does not match the locally configured argument mapping.');
  }
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(schema.properties, key)) throw Error('A configured WorkBuddy argument is missing from the installed run schema.');
    const rule = schema.properties[key];
    if (!rule || (rule.type === 'integer' ? !Number.isInteger(value) : rule.type !== typeof value)
      || (Array.isArray(rule.enum) && !rule.enum.includes(value)) || (rule.const !== undefined && rule.const !== value)
      || (typeof value === 'string' && ((rule.minLength && value.length < rule.minLength) || (rule.maxLength && value.length > rule.maxLength)
        || (rule.pattern && !new RegExp(rule.pattern).test(value))))
      || (typeof value === 'number' && ((rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum)))) {
      throw Error('A configured WorkBuddy argument or profile is incompatible with the installed run schema.');
    }
  }
}

export class WorkBuddyConnection {
  constructor({ config, sanitize }) {
    this.config = config;
    this.sanitize = sanitize;
    this.pending = new Map();
    this.sequence = 0;
    this.input = '';
    this.child = null;
    this.ready = null;
    this.closed = false;
  }

  _fail() {
    this.closed = true;
    this.input = '';
    for (const entry of this.pending.values()) entry.reject(Error('The WorkBuddy stdio connection ended before a response was received.'));
  }

  _send(message) {
    if (this.closed || !this.child?.stdin.writable) throw Error('WorkBuddy stdio is unavailable.');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  async _rpc(method, params, signal, onSent) {
    if (signal.aborted) throw Error('The WorkBuddy call was stopped before dispatch.');
    const id = ++this.sequence;
    let stop;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      stop = () => {
        try { this._send({ method: 'notifications/cancelled', params: { requestId: id } }); } catch { /* remote outcome remains unknown */ }
        reject(Error('The WorkBuddy call was interrupted before its outcome was confirmed.'));
      };
      signal.addEventListener('abort', stop, { once: true });
      try { this._send({ id, method, params }); onSent?.(); } catch (error) { reject(error); }
    });
    try { return await response; }
    finally { this.pending.delete(id); signal.removeEventListener('abort', stop); }
  }

  async _connect(signal) {
    if (this.ready) return this.ready;
    const child = spawn(this.config.command, this.config.args, { cwd: this.config.cwd, env: stdioEnv(this.config),
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    child.once('error', () => this._fail());
    child.once('close', () => this._fail());
    child.stdin.on('error', () => this._fail());
    child.stdout.on('error', () => this._fail());
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.closed) return;
      this.input += chunk;
      if (Buffer.byteLength(this.input) > 384000) return this._fail();
      for (let end; (end = this.input.indexOf('\n')) >= 0;) {
        const line = this.input.slice(0, end);
        this.input = this.input.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { return this._fail(); }
        if (message?.jsonrpc !== '2.0') return this._fail();
        const entry = this.pending.get(message.id);
        if (!entry) continue;
        if (message.error) entry.reject(Error('The WorkBuddy MCP request returned an error.'));
        else entry.resolve(message.result);
      }
    });
    const initialization = await this._rpc('initialize', { protocolVersion: PROTOCOLS[0], capabilities: {},
      clientInfo: { name: 'sol-coordinator', version: '1.0.0' } }, signal);
    if (!initialization?.capabilities?.tools || !PROTOCOLS.includes(initialization.protocolVersion)) {
      throw Error('The configured WorkBuddy server did not provide a supported stdio tool interface.');
    }
    this._send({ method: 'notifications/initialized' });
    const list = await this._rpc('tools/list', {}, signal);
    const status = list?.tools?.find(tool => tool.name === WORKBUDDY_DSF.status_tool);
    const run = list?.tools?.find(tool => tool.name === WORKBUDDY_DSF.run_tool);
    if (!status || !run) throw Error('The WorkBuddy MCP server does not advertise the required DSF tools.');
    validateArguments({}, status.inputSchema);
    this.ready = run.inputSchema;
    return this.ready;
  }

  async prepare(task, signal) {
    const profile = this.config.profiles[task.permissionMode];
    if (!profile || task.capability !== 'default' || task.writes?.length || task.writeScopes?.length || task.commands?.length) {
      throw Error('The original WorkBuddy task permission and scope have no compatible configured DSF profile.');
    }
    const readinessSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const schema = await this._connect(readinessSignal);
    const fields = this.config.statusFields;
    const status = await this._rpc('tools/call', { name: WORKBUDDY_DSF.status_tool, arguments: {} }, readinessSignal);
    const proof = resultData(status);
    if (status?.isError || proof?.[fields.ready] !== true || proof?.[fields.model] !== WORKBUDDY_DSF.model) {
      throw Error('The WorkBuddy status does not confirm readiness and the fixed deepseek-v4-flash model.');
    }
    const names = this.config.arguments;
    const args = { [names.task]: task.prompt, [names.cwd]: task.cwd, [names.profile]: profile };
    if (names.timeoutMs) args[names.timeoutMs] = task.timeoutMs;
    if (task.sessionId) {
      if (!names.session) throw Error('The configured WorkBuddy interface has no verified continuation argument.');
      args[names.session] = task.sessionId;
    }
    validateArguments(args, schema);
    return args;
  }

  async run(args, signal, onSent) {
    const result = await this._rpc('tools/call', { name: WORKBUDDY_DSF.run_tool, arguments: args }, signal, onSent);
    if (result?.isError) throw Error('WorkBuddy reported a tool error without a confirmed outcome.');
    const value = resultData(result);
    const fields = this.config.resultFields;
    const status = value?.[fields.status];
    const taskId = value?.[fields.taskId];
    const sessionId = value?.[fields.sessionId];
    const answer = value?.[fields.answer];
    const validId = id => typeof id === 'string' && SAFE_ID.test(id) && this.sanitize(id) === id;
    if (!TERMINAL.includes(status) || (fields.model && value?.[fields.model] !== undefined && value[fields.model] !== WORKBUDDY_DSF.model)
      || (status === 'completed' && !validId(taskId)) || (taskId != null && !validId(taskId))
      || (sessionId != null && !validId(sessionId)) || (answer != null && typeof answer !== 'string')) {
      throw Error('WorkBuddy returned an unverified task outcome, task identifier or model.');
    }
    return { status, task_id: taskId ?? null, session_id: sessionId ?? null, answer: limitText(this.sanitize(answer ?? ''), 24000),
      backend: WORKBUDDY_DSF.backend, configured_model: WORKBUDDY_DSF.model, returned_model: fields.model ? value[fields.model] ?? null : null };
  }

  async close() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
}
