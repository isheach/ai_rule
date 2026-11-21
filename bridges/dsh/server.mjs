#!/usr/bin/env node
// Minimal, dependency-free stdio MCP server. No HTTP listener and no shell command strings.
import { TaskManager, discoverDsh, redact, VERSION, normalizeInstanceName, serverNameForInstance } from './core.mjs';
import { PreAdmissionRejection, RoutingConflictError } from './routing.mjs';
import { loadSchedule, ScheduleMode, scheduleModeProperty, selectScheduleMode } from './schedule.mjs';
import { workBuddyDispatchTools, WORKBUDDY_FAILURE } from '../workbuddy/dispatch.mjs';
import { DSH_TIMEOUT_MS, WAIT_MS, preferRun, waitForExisting } from '../task-lifecycle.mjs';
import { PURPOSES, hostHandoff, resolveDispatch } from '../dispatch/policy.mjs';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
function option(name) { const i = argv.indexOf(name); if (i < 0) return undefined; if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw Error(`Missing value for ${name}`); return argv[i + 1]; }
let instance;
let manager;
try {
  instance = normalizeInstanceName(option('--instance'));
  const calendar = option('--schedule-config') ?? fileURLToPath(new URL('../../config/offpeak.schedule.json', import.meta.url));
  manager = new TaskManager({
    cli: discoverDsh(option('--dsh-entry')), runtime: option('--runtime'), instance,
    allowWrite: !argv.includes('--read-only'), schedule: loadSchedule(calendar), scheduleDefaultEnabled: false
  });
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
    timeoutMs: DSH_TIMEOUT_MS,
    permissionMode: { type: 'string', enum: ['read-only', 'workspace-write'], description: 'Defaults to workspace-write unless this bridge is configured read-only.' },
    authorizationNote: { type: 'string', description: 'Optional audit reference to the user’s task authorization.' },
    scheduleEnabled: { type: 'boolean', description: 'Legacy task-level selector. False selects mode 1 and true selects mode 3. Supply only one schedule selector.' },
    scheduleMode: scheduleModeProperty,
    workBuddyContinuationKey: { type: 'string', description: 'Continue a recorded WorkBuddy DSF session in the same workspace, only during a peak in mode 2.' },
    sessionId: { type: 'string', description: `Resume a DSH session recorded by ${scoped} from the SAME cwd; never use an invented or foreign ID.` },
    purpose: { type: 'string', enum: PURPOSES, description: 'Explicit task purpose. Omitted means general; prompt keywords never select a purpose.' },
    backend: { type: 'string', enum: ['DSH', 'WorkBuddy DSF', 'Terra'], description: 'Explicit supported backend. Omit to use the purpose default (DSH for general, Terra for a specialist purpose).' }
  }
};
const idSchema = { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId: { type: 'string', description: `Task ID scoped to ${scoped}` } } };
const tools = [
  { name: 'resolve_layer_dispatch', description: 'Resolve the layered route for this subscription host without launching a model. General work -> gpt-6.2-sol max; specialist work -> gpt-6.1-terra max.', inputSchema: { type: 'object', additionalProperties: false, properties: { purpose: { type: 'string', enum: PURPOSES }, backend: { type: 'string', enum: ['DSH', 'WorkBuddy DSF', 'Terra'] } } }, annotations: { readOnlyHint: true } },
  { name: 'get_dsh_schedule_status', description: `Local phase and admission gate for ${scoped} Omit scheduleMode for the active/default mode, or supply one to preview. No model call.`, inputSchema: { type: 'object', additionalProperties: false, properties: { scheduleMode: scheduleModeProperty } }, annotations: { readOnlyHint: true } },
  {
    name: 'set_dsh_task_schedule',
    description: `Change the schedule for the active child owned by this ${scoped} process. Other tasks retain their own setting.`,
    inputSchema: { ...idSchema, oneOf: [{ required: ['enabled'] }, { required: ['scheduleMode'] }],
      properties: { ...idSchema.properties, enabled: { type: 'boolean' }, scheduleMode: scheduleModeProperty } },
    annotations: { readOnlyHint: false }
  },
  { name: 'get_dsh_bridge_status', description: `Local readiness, instance identity and active task for ${scoped} Does not call a model or reveal credentials.`, inputSchema: { type: 'object', additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'start_dsh_task', description: `Submit a native DSH task in ${scoped} for an early task ID or later intervention. DSH owns execution and monitoring. Mode 2 can return a pending WorkBuddy DSF handoff at peak.`, inputSchema: taskSchema, annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'run_dsh_task', description: `Submit a native DSH task in ${scoped} and wait internally for its receipt. ${preferRun('start_dsh_task', 'wait_dsh_task')} Mode 2 can return a pending WorkBuddy DSF handoff at peak. This entry has no HY4 adapter.`, inputSchema: taskSchema, annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'get_dsh_task', description: `Read a task receipt from ${scoped} completed means agent-loop completion, NOT independent acceptance of the project result.`, inputSchema: idSchema, annotations: { readOnlyHint: true } },
  { name: 'wait_dsh_task', description: `Wait on the original MCP task ID in ${scoped} ${waitForExisting}`, inputSchema: { ...idSchema, properties: { ...idSchema.properties, waitMs: WAIT_MS } }, annotations: { readOnlyHint: true } },
  { name: 'cancel_dsh_task', description: `Cancel only a task owned by this ${scoped} process. Attempts to terminate its process tree; inspect the receipt afterwards.`, inputSchema: idSchema, annotations: { readOnlyHint: false, destructiveHint: true } },
  ...workBuddyDispatchTools
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
  if (name === 'resolve_layer_dispatch') {
    return resolveDispatch({
      source: 'subscription',
      ...(args.purpose === undefined ? {} : { purpose: args.purpose }),
      ...(args.backend === undefined ? {} : { backend: args.backend })
    });
  }
  if (name === 'get_dsh_schedule_status') {
    return manager.scheduleStatus(args.scheduleMode === undefined ? undefined : selectScheduleMode(args.scheduleMode));
  }
  if (name === 'set_dsh_task_schedule') {
    if (args.scheduleMode === undefined && args.enabled === undefined) throw Error('scheduleMode or enabled is required.');
    return manager.setTaskSchedule(args.taskId, selectScheduleMode(args.scheduleMode, args.enabled));
  }
  if (name === 'get_workbuddy_dsf_dispatch') return manager.workBuddy.get(args.idempotencyKey);
  if (name === 'claim_workbuddy_dsf_dispatch') {
    return manager.workBuddy.claim(args, () => manager.scheduleStatus(ScheduleMode.WORKBUDDY_AT_PEAK));
  }
  if (name === 'finish_workbuddy_dsf_dispatch') return manager.workBuddy.finish(args);
  if (name === 'get_dsh_task') return manager.get(args.taskId);
  if (name === 'wait_dsh_task') return manager.wait(args.taskId, args.waitMs ?? WAIT_MS.default);
  if (name === 'cancel_dsh_task') return manager.cancel(args.taskId);
  let task = args;
  if (name === 'start_dsh_task' || name === 'run_dsh_task') {
    const plan = resolveDispatch({
      source: 'subscription',
      ...(args.purpose === undefined ? {} : { purpose: args.purpose }),
      ...(args.backend === undefined ? {} : { backend: args.backend })
    });
    task = { ...args };
    delete task.purpose;
    delete task.backend;
    // Only the default/general DSH layer is executable in this bridge. A
    // specialist purpose is handed to the host's real native Terra entry; an
    // explicit WorkBuddy backend is handed to the already registered WorkBuddy
    // service. Neither is silently executed as DSH.
    if (plan.layer !== 'coordinator' || plan.executor.backend !== 'dsh') return hostHandoff(plan);
  }
  const record = await manager.start(task);
  if (name === 'start_dsh_task' || record.workbuddy_dispatch) return record;
  if (!record.replayed) inFlight.set(requestId, record.task_id);
  try {
    while (manager.pending.has(record.task_id)) await manager.wait(record.task_id, WAIT_MS.maximum);
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
    const failureStatuses = result.workbuddy_dispatch ? WORKBUDDY_FAILURE : ['failed', 'timed_out', 'cancelled', 'schedule_stopped'];
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: failureStatuses.includes(result.status) } });
  } catch (e) {
    const result = { isError: true, content: [{ type: 'text', text: redact(e.message) }] };
    // Additive structured contract for new clients. The text item remains the
    // v0.3.0-compatible error channel and is never converted into success.
    if (e instanceof PreAdmissionRejection || e instanceof RoutingConflictError) {
      result.structuredContent = { error: {
        code: e.code,
        admission_state: e.admission_state,
        fallback_eligible: e.fallback_eligible === true,
        details: e.details ?? {}
      } };
    }
    send({ jsonrpc: '2.0', id, result });
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
