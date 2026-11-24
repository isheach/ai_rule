import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { redact } from '../dsh/core.mjs';
import { DSH_SCOPE_DESCRIPTION } from '../dsh/routing.mjs';
import { scheduleModeProperty } from '../dsh/schedule.mjs';
import { resolveContext } from '../pool/context.mjs';
import { DSH_TIMEOUT_MS, WAIT_MS, preferRun, validateWaitMs, waitForExisting } from '../task-lifecycle.mjs';
import { COORDINATOR_MODES, EXECUTION_BACKENDS, EXECUTION_PERMISSIONS, loadSolConfig, object, discardLegacyEnvironment, SERVICE } from './config.mjs';
import { ResponsesClient } from './responses.mjs';
import { SolService } from './service.mjs';
import { PURPOSES } from '../dispatch.mjs';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const text = { type: 'string' };
const choices = (...values) => ({ type: 'string', enum: values });
const source = choices(...COORDINATOR_MODES);
const task = { idempotencyKey: text, taskId: text };
const handoff = {
  ...task, coordinatorMode: source, backend: choices(...EXECUTION_BACKENDS), purpose: choices(...PURPOSES), goal: text, cwd: text,
  permissionMode: choices(...EXECUTION_PERMISSIONS), authorizationNote: text, constraints: text, contextSummary: text,
  acceptance: text, acceptTerraCharges: { type: 'boolean', description: 'Explicit billing consent for a specialist API Terra task. Required before the protected Terra client sends a response.' },
  acceptPeerCharges: { type: 'boolean', description: 'Explicit billing consent for Sol to call available Terra or Luna collaborators when this API coordination needs one. No calls are made merely by enabling consent.' },
  antigravityModel: { type: 'string', description: 'Optional host-approved Antigravity alias for writing. Omit for this host’s configured default alias.' },
  acceptAntigravityUsage: { type: 'boolean', description: 'Explicit approval to send supplied task text to the configured Google CLI route and use its entitlement. Required for a new Antigravity task.' },
  timeoutMs: { type: 'integer', minimum: DSH_TIMEOUT_MS.minimum, maximum: DSH_TIMEOUT_MS.maximum,
    description: 'Total coordination budget. The local API Sol configuration can impose a lower maximum and defines the default.' },
  capability: choices('default', 'text-only', 'workspace-read', 'workspace-write'),
  writeScopes: { type: 'array', items: { type: 'object' } }, writes: { type: 'array', items: { type: 'object' } },
  commands: { type: 'array', items: text }
};
delete handoff.taskId;
const requireHandoff = ['idempotencyKey', 'goal', 'cwd', 'permissionMode', 'acceptance'];
const tool = (name, description, properties = {}, required = [], readOnlyHint = false) => ({
  name, description, inputSchema: { type: 'object', properties: { context: text, ...properties }, required: ['context', ...required], additionalProperties: false },
  annotations: { readOnlyHint }
});
const TOOLS = [
  tool('get_sol_coordinator_mode', 'Read the selected Sol source for this verified Codex root, without an API call.', {}, [], true),
  tool('set_sol_coordinator_mode', 'Set this verified Codex root’s source for future work only, without an API call.', { mode: source }, ['mode']),
  tool('resolve_layer_dispatch', 'Resolve the layered model route for this root without a model call. Configured Antigravity handles writing; Terra handles host and image work.', {
    purpose: choices(...PURPOSES), backend: choices(...EXECUTION_BACKENDS)
  }, [], true),
  tool('get_antigravity_status', 'Read this host’s Antigravity configuration and approved aliases without starting the CLI.', {}, [], true),
  tool('list_antigravity_models', 'List model slugs available to this host’s configured Google credential route. Runs agy models without a generation request.', {}, [], true),
  tool('get_sol_schedule', 'Read the DSH root pool schedule and current phase.', {}, [], true),
  tool('set_sol_schedule', 'Apply an explicitly requested root-pool schedule mode, including to active DSH workers in this root.', { scheduleMode: scheduleModeProperty }, ['scheduleMode']),
  tool('start_sol_coordination', `Start API Sol coordination or configured Antigravity writing. Keep the returned task ID and original idempotency key. ${DSH_SCOPE_DESCRIPTION}`, handoff, requireHandoff),
  tool('run_sol_coordination', `Start and wait for API Sol coordination or configured Antigravity writing. ${preferRun('start_sol_coordination', 'wait_sol_coordination')} Recover an interrupted call with the original idempotency key. ${DSH_SCOPE_DESCRIPTION}`, handoff, requireHandoff),
  tool('get_sol_coordination', 'Read the original API coordination receipt by its root-scoped idempotency key.', task, ['idempotencyKey'], true),
  tool('wait_sol_coordination', `Wait for existing coordination in this verified root. ${waitForExisting}`, { ...task, waitMs: WAIT_MS }, ['idempotencyKey'], true),
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

export function startSolServer({ configPath, stdin = process.stdin, stdout = process.stdout, callBroker, clock, sessionsRoot, dispatch = {} } = {}) {
  const config = loadSolConfig(configPath);
  discardLegacyEnvironment(config);
  const antigravityKey = config.antigravity?.credentialSource === 'gemini-api-key' ? process.env.GEMINI_API_KEY : undefined;
  if (config.antigravity?.credentialSource === 'gemini-api-key') {
    // The key belongs only to the configured CLI. Do not leave it available
    // for DSH, a WorkBuddy adapter, or the OpenAI broker helper to inherit.
    for (const name of Object.keys(process.env)) if (name.toUpperCase() === 'GEMINI_API_KEY') delete process.env[name];
  }
  const responses = new ResponsesClient({ config, callBroker });
  const service = new SolService({ config, responses, clock, dispatch: { ...dispatch, antigravityKey } });
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
    if (name === 'get_antigravity_status') return service.antigravityStatus();
    if (name === 'list_antigravity_models') return service.listAntigravityModels();
    if (name === 'resolve_layer_dispatch') return service.resolve(rootId, {
      ...(args.purpose === undefined ? {} : { purpose: args.purpose }),
      ...(args.backend === undefined ? {} : { backend: args.backend })
    });
    if (name === 'get_sol_schedule') return service.schedule(rootId);
    if (name === 'set_sol_schedule') return service.setSchedule(rootId, args.scheduleMode);
    if (name === 'get_sol_coordination') return service.get(rootId, key, taskId);
    if (name === 'cancel_sol_coordination') return service.cancel(rootId, key, taskId);
    if (name === 'wait_sol_coordination') {
      const wait = args.waitMs ?? WAIT_MS.default;
      validateWaitMs(wait);
      return service.wait(rootId, key, taskId, wait);
    }
    const taskArgs = { ...args };
    delete taskArgs.context;
    const started = await service.start(rootId, taskArgs);
    if (name !== 'run_sol_coordination' || started.status !== 'running' || started.replayed) return started;
    runs.set(id, { rootId, key, taskId: started.task_id });
    try { return await service.wait(rootId, key, started.task_id, started.timeout_ms + 12000); }
    finally { runs.delete(id); }
  }

  async function dispatchMessage(message) {
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
      try { void dispatchMessage(JSON.parse(line)).catch(() => error(null, -32603, 'MCP request could not be completed.')); }
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
