#!/usr/bin/env node
// Minimal, dependency-free stdio MCP server. No HTTP listener and no shell command strings.
import { TaskManager, discoverDsh, redact, VERSION, normalizeInstanceName, serverNameForInstance } from './core.mjs';
import { loadSchedule } from './schedule.mjs';

const argv = process.argv.slice(2);
function option(name) { const i = argv.indexOf(name); if (i < 0) return undefined; if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw Error(`Missing value for ${name}`); return argv[i + 1]; }
let instance;
let manager;
try {
  instance = normalizeInstanceName(option('--instance'));
  manager = new TaskManager({ cli: discoverDsh(option('--dsh-entry')), runtime: option('--runtime'), instance,
    allowWrite: argv.includes('--allow-write'), schedule: loadSchedule(option('--schedule-config')) });
} catch (error) {
  console.error(`DSH bridge startup failed: ${redact(error.message)}`);
  process.exit(1);
}
const serverName = serverNameForInstance(instance);
const scoped = `Bridge instance "${instance}" (${serverName}).`;
const taskSchema = {
  type: 'object', additionalProperties: false, required: ['prompt', 'cwd', 'idempotencyKey'], properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 60000 }, cwd: { type: 'string' },
    idempotencyKey: { type: 'string', description: `Stable unique key for this task revision in ${scoped} Reuse only for retrying the SAME submission.` },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 3600000, default: 900000 },
    permissionMode: { type: 'string', enum: ['read-only', 'workspace-write'], default: 'read-only' },
    authorizationNote: { type: 'string', description: 'Reference to the user approval; cannot substitute for actual approval.' },
    sessionId: { type: 'string', description: `Resume a DSH session recorded by ${scoped} from the SAME cwd; never use an invented or foreign ID.` }
  }
};
const idSchema = { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId: { type: 'string', description: `Task ID scoped to ${scoped}` } } };
const tools = [
  { name: 'get_dsh_schedule_status', description: `Local schedule phase, admission gate, next hard stop and offpeak time for ${scoped} No model call.`, inputSchema: { type: 'object', additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'get_dsh_bridge_status', description: `Local readiness, instance identity and active task for ${scoped} Does not call a model or reveal credentials.`, inputSchema: { type: 'object', additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'start_dsh_task', description: `Start the native DSH headless agent through the configured OpenCode Go route in ${scoped} Returns task ID. Sol Max delegates execution; DSH owns tool work and self-monitoring. Does not start OpenCode CLI.`, inputSchema: taskSchema, annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'run_dsh_task', description: `Run one bounded DSH task in ${scoped} and wait internally until its final receipt. Prefer for no-intervention tasks when host MCP timeout safely covers the budget; otherwise use start+wait. Peak schedule may block or stop work. No model fallback.`, inputSchema: taskSchema, annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'get_dsh_task', description: `Read a task receipt from ${scoped} completed means agent-loop completion, NOT independent acceptance of the project result.`, inputSchema: idSchema, annotations: { readOnlyHint: true } },
  { name: 'wait_dsh_task', description: `Event-driven wait for ${scoped} up to 60 seconds, without model polling or duplicate execution. Repeat only after timeout, or use the host native wait when available.`, inputSchema: { ...idSchema, properties: { ...idSchema.properties, waitMs: { type: 'integer', minimum: 0, maximum: 60000, default: 25000 } } }, annotations: { readOnlyHint: true } },
  { name: 'cancel_dsh_task', description: `Cancel only a task owned by this ${scoped} process. Attempts to terminate its process tree; inspect the receipt afterwards.`, inputSchema: idSchema, annotations: { readOnlyHint: false, destructiveHint: true } }
];
let initialized = false, input = '', shuttingDown = false;
const inFlight = new Map();
const send = value => { if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(value) + '\n'); };
const error = (id, code, message) => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message: redact(message) } });
async function call(name, args, requestId) {
  const schema = tools.find(x => x.name === name)?.inputSchema;
  if (!schema) throw Error(`Unknown tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('Tool arguments must be an object.');
  for (const key of Object.keys(args)) if (!(key in schema.properties)) throw Error(`Unknown argument: ${key}`);
  for (const key of schema.required || []) if (!(key in args)) throw Error(`Missing argument: ${key}`);
  if (name === 'get_dsh_bridge_status') return manager.status();
  if (name === 'get_dsh_schedule_status') return manager.scheduleStatus();
  if (name === 'get_dsh_task') return manager.get(args.taskId);
  if (name === 'wait_dsh_task') return manager.wait(args.taskId, args.waitMs ?? 25000);
  if (name === 'cancel_dsh_task') return manager.cancel(args.taskId);
  const record = await manager.start(args);
  if (name === 'start_dsh_task') return record;
  inFlight.set(requestId, record.task_id);
  try {
    while (manager.pending.has(record.task_id)) await manager.wait(record.task_id, 60000);
    return manager.get(record.task_id);
  } finally { inFlight.delete(requestId); }
}
async function dispatch(message) {
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(message?.id, -32600, 'Invalid JSON-RPC request.');
  const { id, method, params = {} } = message;
  if (id === undefined) {
    if (method === 'notifications/cancelled') {
      const taskId = inFlight.get(params.requestId);
      if (taskId) manager.cancel(taskId, 'mcp_request_cancelled');
    }
    return;
  }
  if (method === 'initialize') {
    const supported = ['2024-11-05', '2025-03-26', '2025-06-18'];
    initialized = true;
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: supported.includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: serverName, version: VERSION, instance } } });
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (!initialized) return error(id, -32002, 'Initialize the MCP connection first.');
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
  if (method !== 'tools/call') return error(id, -32601, 'Method not supported.');
  try {
    const result = await call(params.name, params.arguments ?? {}, id);
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: ['failed', 'timed_out', 'cancelled', 'schedule_stopped'].includes(result.status) } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: redact(e.message) }] } });
  }
}
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // An MCP disconnect does not leave an intentionally detached model worker.
  const forceExit = setTimeout(() => process.exit(1), 15000);
  await manager.close();
  clearTimeout(forceExit);
  process.exit(0);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (Buffer.byteLength(input) > 512000) { error(null, -32600, 'Input size limit exceeded.'); void shutdown(); return; }
  let pos;
  while ((pos = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, pos); input = input.slice(pos + 1);
    if (!line.trim()) continue;
    try { void dispatch(JSON.parse(line)).catch(e => error(null, -32603, e.message)); }
    catch { error(null, -32700, 'Invalid JSON.'); }
  }
});
process.stdin.on('end', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdout.on('error', shutdown);
