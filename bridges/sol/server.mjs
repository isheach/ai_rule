import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { redact } from '../dsh/core.mjs';
import { resolveContext } from '../pool/context.mjs';
import { loadSolConfig, object, openAIEnvironment, SERVICE } from './config.mjs';
import { ResponsesClient } from './responses.mjs';
import { SolService } from './service.mjs';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const text = { type: 'string' };
const num = { type: 'integer' };
const choices = (...values) => ({ type: typeof values[0] === 'number' ? 'integer' : 'string', enum: values });
const source = choices('subscription', 'api');
const task = { idempotencyKey: text, taskId: text };
const handoff = {
  ...task, coordinatorMode: source, backend: choices('DSH', 'WorkBuddy DSF', 'HY4', 'A'), goal: text, cwd: text,
  permissionMode: choices('read-only', 'workspace-write'), authorizationNote: text, constraints: text, contextSummary: text,
  acceptance: text, timeoutMs: num, capability: choices('default', 'text-only', 'workspace-read', 'workspace-write'),
  writeScopes: { type: 'array', items: { type: 'object' } }, writes: { type: 'array', items: { type: 'object' } },
  commands: { type: 'array', items: text }
};
delete handoff.taskId;
const requireHandoff = ['idempotencyKey', 'backend', 'goal', 'cwd', 'permissionMode', 'acceptance'];
const tool = (name, description, properties = {}, required = [], readOnlyHint = false) => ({
  name, description, inputSchema: { type: 'object', properties: { context: text, ...properties }, required: ['context', ...required], additionalProperties: false },
  annotations: { readOnlyHint }
});
const TOOLS = [
  tool('get_sol_coordinator_mode', 'Read the selected Sol source for this verified Codex root, without an API call.', {}, [], true),
  tool('set_sol_coordinator_mode', 'Set this verified Codex root’s source for future work only, without an API call.', { mode: source }, ['mode']),
  tool('get_sol_schedule', 'Read the DSH root pool schedule and current phase.', {}, [], true),
  tool('set_sol_schedule', 'Apply an explicitly requested root-pool schedule mode, including to active DSH workers in this root.', { scheduleMode: choices(1, 2, 3) }, ['scheduleMode']),
  tool('start_sol_coordination', 'Start independent OpenAI API Sol planning and execution delegation. Save both returned task ID and the original idempotency key.', handoff, requireHandoff),
  tool('run_sol_coordination', 'Start and wait for one API Sol coordination. Use the stable key to recover an interrupted call.', handoff, requireHandoff),
  tool('get_sol_coordination', 'Read the original API coordination receipt by its root-scoped idempotency key.', task, ['idempotencyKey'], true),
  tool('wait_sol_coordination', 'Wait up to 60000 ms for existing coordination; never re-dispatch work.', { ...task, waitMs: num }, ['idempotencyKey'], true),
  tool('cancel_sol_coordination', 'Request cancellation of this connection’s originally owned coordination and report the confirmed outcome.', task, ['idempotencyKey'])
];

function validate(tool, args) {
  object(args, Object.keys(tool.inputSchema.properties), 'MCP arguments');
  for (const key of tool.inputSchema.required) if (!Object.hasOwn(args, key)) throw Error(`Missing ${key}.`);
  for (const [key, value] of Object.entries(args)) {
    const { type, enum: allowed } = tool.inputSchema.properties[key];
    const matches = type === 'integer' ? Number.isSafeInteger(value) : type === 'array' ? Array.isArray(value) : typeof value === type;
    if (!matches || (allowed && !allowed.includes(value))) throw Error(`Invalid ${key}.`);
  }
}

export function startSolServer({ configPath, stdin = process.stdin, stdout = process.stdout, fetchImpl, clock, sessionsRoot } = {}) {
  const config = loadSolConfig(configPath);
  const credential = openAIEnvironment(config, process.env, { remove: true });
  const responses = new ResponsesClient({ config, credential, fetchImpl });
  const service = new SolService({ config, responses, clock });
  const runs = new Map();
  let initialized = false;
  let input = '';
  let closing = false;
  const send = value => { if (!stdout.destroyed) stdout.write(JSON.stringify(value) + '\n'); };
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const error = (id, code, message) => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  async function call(name, args, id) {
    if (closing) throw Error('The coordinator is shutting down.');
    const selected = TOOLS.find(tool => tool.name === name);
    if (!selected) throw Error('Unknown Sol coordinator tool.');
    validate(selected, args);
    const { rootId } = resolveContext({ config: config.contextConfig, reference: args.context, purpose: SERVICE, sessionsRoot });
    const { context, idempotencyKey: key, taskId } = args;
    if (name === 'get_sol_coordinator_mode') return service.mode(rootId);
    if (name === 'set_sol_coordinator_mode') return service.setMode(rootId, args.mode);
    if (name === 'get_sol_schedule') return service.schedule(rootId);
    if (name === 'set_sol_schedule') return service.setSchedule(rootId, args.scheduleMode);
    if (name === 'get_sol_coordination') return service.get(rootId, key, taskId);
    if (name === 'cancel_sol_coordination') return service.cancel(rootId, key, taskId);
    if (name === 'wait_sol_coordination') {
      const wait = args.waitMs ?? 25000;
      if (wait < 0 || wait > 60000) throw Error('waitMs must be 0..60000.');
      return service.wait(rootId, key, taskId, wait);
    }
    const taskArgs = { ...args };
    delete taskArgs.context;
    const started = service.start(rootId, taskArgs);
    if (name !== 'run_sol_coordination' || started.status !== 'running' || started.replayed) return started;
    runs.set(id, { rootId, key, taskId: started.task_id });
    try { return await service.wait(rootId, key, started.task_id, started.timeout_ms + 12000); }
    finally { runs.delete(id); }
  }

  async function dispatch(message) {
    const { id, method, params = {} } = message ?? {};
    if (message?.jsonrpc !== '2.0' || typeof method !== 'string') return error(id, -32600, 'Invalid MCP request.');
    if (id === undefined) {
      if (method === 'notifications/cancelled') {
        const run = runs.get(params.requestId);
        if (run) await service.cancel(run.rootId, run.key, run.taskId);
      }
      return;
    }
    if (method === 'initialize') {
      initialized = true;
      const protocolVersion = PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
      return reply(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: SERVICE, version: '1.0.0' } });
    }
    if (method === 'ping') return reply(id, {});
    if (!initialized) return error(id, -32002, 'Initialize the MCP connection first.');
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method !== 'tools/call') return error(id, -32601, 'Unsupported MCP method.');
    try {
      const result = await call(params.name, params.arguments ?? {}, id);
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
    } catch (cause) {
      return reply(id, { isError: true, content: [{ type: 'text', text: responses.sanitize(cause.message).slice(0, 2000) }] });
    }
  }

  async function shutdown() {
    if (closing) return;
    closing = true;
    stdin.pause();
    const deadline = setTimeout(() => process.exit(1), 30000);
    try {
      await service.close();
      process.exit(service.pool.hasLiveChildren() || service.active.size ? 1 : 0);
    } catch { process.exit(1); }
    finally { clearTimeout(deadline); }
  }

  stdin.setEncoding('utf8');
  stdin.on('data', chunk => {
    if (closing) return;
    input += chunk;
    if (Buffer.byteLength(input) > 512000) { error(null, -32600, 'MCP input exceeds the local limit.'); void shutdown(); return; }
    for (let end; (end = input.indexOf('\n')) >= 0;) {
      const line = input.slice(0, end);
      input = input.slice(end + 1);
      if (!line.trim()) continue;
      try { void dispatch(JSON.parse(line)).catch(() => error(null, -32603, 'MCP request could not be completed.')); }
      catch { error(null, -32700, 'Invalid MCP JSON.'); }
    }
  });
  stdin.once('end', shutdown);
  stdout.once('error', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return service;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--config') throw Error('Usage: server.mjs --config ABS');
    startSolServer({ configPath: process.argv[3] });
  } catch (error) {
    process.stderr.write('Sol coordinator startup failed: ' + redact(error.message).slice(0, 1600) + '\n');
    process.exitCode = 1;
  }
}
