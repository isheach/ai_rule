#!/usr/bin/env node
// Opt-in HY4 ACP endpoint. It is additive and must not be registered by default.
import { Hy4AcpManager, canonicalWithin } from './acp.mjs';
import { HY4_MODEL, loadManifest } from './manifest.mjs';
import { RoutingCoordinator, PreAdmissionRejection, Hy4UnavailableError, AdmissionCode, DSH_SCOPE_DESCRIPTION } from '../dsh/routing.mjs';
import { TaskManager, discoverDsh, redact } from '../dsh/core.mjs';
import { loadSchedule } from '../dsh/schedule.mjs';
import { DSH_TIMEOUT_MS, HY4_ACP_TIMEOUT_MS, WAIT_MS, preferRun, waitForExisting } from '../task-lifecycle.mjs';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
function option(name, required = false) {
  const i = argv.indexOf(name);
  if (i < 0) { if (required) throw Error(`Missing ${name}`); return undefined; }
  if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw Error(`Missing value for ${name}`);
  return argv[i + 1];
}
let manager, dsh, routing, coordinator, scheduleProvided;
try {
  const manifest = loadManifest(option('--hy4-manifest', true));
  manager = new Hy4AcpManager({ manifest, runtime: option('--runtime') });
  const schedulePath = option('--schedule-config');
  scheduleProvided = Boolean(schedulePath);
  dsh = new TaskManager({
    cli: discoverDsh(option('--dsh-entry', true)),
    runtime: option('--dsh-runtime', true),
    schedule: loadSchedule(schedulePath)
  });
  const dshRuntime = fs.realpathSync.native(dsh.runtime);
  const hy4Runtime = fs.realpathSync.native(manager.runtime);
  if (path.relative(dshRuntime, hy4Runtime) === '') throw Error('HY4 and DSH runtimes must remain physically separate.');
  const authRef = option('--fallback-authorization');
  const authorization = authRef ? {
    schema: 1, enabled: true, authorization_ref: authRef, scope: 'pre_admission_only', max_attempts: 1
  } : null;
  routing = new RoutingCoordinator({
    runtime: option('--routing-runtime') ?? `${manager.runtime}-routing`,
    dsh: { submit: (task, authorization) => dsh.start(task, authorization) },
    hy4: manager,
    authorization,
    liveMcpDispatchWired: true
  });
  coordinator = routing;
} catch (error) {
  console.error(`HY4 bridge startup failed: ${redact(error.message)}`);
  process.exit(1);
}
const workspaceWriteEnabled = manager.manifest.allow_workspace_write === true;

// This MCP route has historically supplied its own default through the router.
// Keep it for compatibility with existing request fingerprints.
const hy4TaskTimeout = { ...HY4_ACP_TIMEOUT_MS, default: HY4_ACP_TIMEOUT_MS.maximum };
const routedTaskSchema = {
  type: 'object', additionalProperties: false, required: ['prompt', 'cwd', 'idempotencyKey'], properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 60000 },
    cwd: { type: 'string' },
    idempotencyKey: { type: 'string', description: 'Stable key scoped to this opt-in HY4/routing runtime. New revision requires a new key.' },
    timeoutMs: { ...DSH_TIMEOUT_MS, description: `Budget for DSH. HY4 accepts a budget up to ${HY4_ACP_TIMEOUT_MS.maximum} ms if the task qualifies for fallback.` },
    permissionMode: { type: 'string', enum: ['read-only', 'workspace-write'], default: 'read-only' },
    capability: { type: 'string', enum: ['default', 'text-only', 'workspace-read', 'workspace-write'], default: 'default' },
    authorizationNote: { type: 'string', maxLength: 2000 },
    writeScopes: {
      type: 'array', maxItems: 32, items: {
        type: 'object', additionalProperties: false, required: ['path', 'operations'], properties: {
          path: { type: 'string' },
          operations: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'string', enum: ['create', 'replace', 'edit'] } }
        }
      }
    },
    writes: {
      type: 'array', maxItems: 32, items: {
        type: 'object', additionalProperties: false, required: ['path', 'mode'], properties: {
          path: { type: 'string' },
          mode: { type: 'string', enum: ['create', 'edit', 'write'] },
          content_sha256: { type: 'string' }
        }
      }
    },
    commands: { type: 'array', maxItems: 32, uniqueItems: true, items: { type: 'string' } }
  }
};
const hy4TaskSchema = { ...routedTaskSchema, properties: { ...routedTaskSchema.properties, timeoutMs: hy4TaskTimeout } };
const idSchema = { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId: { type: 'string' } } };
const keySchema = { type: 'object', additionalProperties: false, required: ['idempotencyKey'], properties: { idempotencyKey: { type: 'string' } } };
const tools = [
  { name: 'get_hy4_bridge_status', description: 'ACP/CodeBuddy Hy4 readiness and route descriptor without sending a prompt. Also reports DSH-first fallback policy state. No credentials.', inputSchema: { type: 'object', additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'start_hy4_task', description: `Submit an explicit CodeBuddy ACP ${HY4_MODEL} task for an early task ID or later intervention. Choose text-only, workspace-read or workspace-write. Writes require local enablement and the approved task scope.`, inputSchema: hy4TaskSchema, annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'run_hy4_task', description: `Submit an explicit CodeBuddy ACP ${HY4_MODEL} task and wait internally for its receipt. ${preferRun('start_hy4_task', 'wait_hy4_task')}`, inputSchema: hy4TaskSchema, annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'get_hy4_task', description: 'Read an owned HY4 task receipt without resubmitting.', inputSchema: idSchema, annotations: { readOnlyHint: true } },
  { name: 'wait_hy4_task', description: `Wait on the original HY4 task ID. ${waitForExisting}`, inputSchema: { ...idSchema, properties: { ...idSchema.properties, waitMs: WAIT_MS } }, annotations: { readOnlyHint: true } },
  { name: 'cancel_hy4_task', description: 'Cancel only an HY4 task owned by this bridge process. No stale PID killing.', inputSchema: idSchema, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'start_routed_task', description: `Submit a DSH-first mode 3 task for an early routing decision or later intervention. HY4 requires explicit authorization and a qualifying pre-admission rejection. ${DSH_SCOPE_DESCRIPTION}`, inputSchema: routedTaskSchema, annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'run_routed_task', description: `Submit a DSH-first mode 3 task and wait internally for its receipt. ${preferRun('start_routed_task', 'wait_routed_task')} ${DSH_SCOPE_DESCRIPTION}`, inputSchema: routedTaskSchema, annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'get_routed_decision', description: 'Read a routing decision by idempotency key; no model call.', inputSchema: keySchema, annotations: { readOnlyHint: true } },
  { name: 'get_routed_task', description: 'Read the accepted DSH or HY4 task receipt for a routing decision by idempotency key.', inputSchema: keySchema, annotations: { readOnlyHint: true } },
  { name: 'wait_routed_task', description: `Wait on the accepted DSH or HY4 task by the original idempotency key. ${waitForExisting}`, inputSchema: { ...keySchema, properties: { ...keySchema.properties, waitMs: WAIT_MS } }, annotations: { readOnlyHint: true } },
  { name: 'cancel_routed_task', description: 'Cancel the owned backend task for a routing decision; no cross-owner kill.', inputSchema: keySchema, annotations: { readOnlyHint: false, destructiveHint: true } }
];
let initialized = false, input = '', shuttingDown = false;
const inFlight = new Map();
const send = value => { if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(value) + '\n'); };
const error = (id, code, message) => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message: redact(message) } });

const TERMINAL = new Set(['completed', 'failed', 'unknown', 'unknown_after_disconnect', 'timed_out', 'cancelled', 'refused', 'schedule_stopped', 'not_accepted']);

async function waitForDecision(decision, timeoutMs, requestId) {
  const { selected_backend: backend, task_id: taskId } = decision;
  const executor = backend === 'hy4' ? manager : dsh;
  if (!decision.replayed && !decision.deduplicated) inFlight.set(requestId, { backend, taskId });
  const deadline = Date.now() + timeoutMs + 5000;
  try {
    while (true) {
      const waitMs = Math.min(WAIT_MS.maximum, Math.max(0, deadline - Date.now()));
      const receipt = await executor.wait(taskId, waitMs);
      if (TERMINAL.has(receipt.status) || waitMs === 0) return receipt;
    }
  } finally { inFlight.delete(requestId); }
}

function assertScopedCwd(args) {
  try { canonicalWithin(manager.manifest.workspace_root, args.cwd); }
  catch { throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS, 'Task cwd is outside the approved workspace root.'); }
}

async function call(name, args, requestId) {
  const schema = tools.find(x => x.name === name)?.inputSchema;
  if (!schema) throw Error(`Unknown tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('Tool arguments must be an object.');
  for (const key of Object.keys(args)) if (!(key in schema.properties)) throw Error(`Unknown argument: ${key}`);
  for (const key of schema.required || []) if (!(key in args)) throw Error(`Missing argument: ${key}`);

  if (name === 'get_hy4_bridge_status') {
    const hy4Status = await manager.probe();
    return { hy4: hy4Status, routing: coordinator.status(),
      dsh: { instance: dsh.instance, active_task_id: dsh.active?.record.task_id ?? null, allow_workspace_write: workspaceWriteEnabled && dsh.allowWrite } };
  }
  if (name === 'get_hy4_task') return manager.get(args.taskId);
  if (name === 'wait_hy4_task') return manager.wait(args.taskId, args.waitMs ?? WAIT_MS.default);
  if (name === 'cancel_hy4_task') return manager.cancel(args.taskId);
  if (name === 'get_routed_decision') {
    const decision = coordinator.get(args.idempotencyKey);
    if (!decision) throw Error('No routing decision for this idempotency key.');
    return { ...decision, status: decision.admission_state === 'accepted' ? 'accepted' : 'failed' };
  }
  if (name === 'get_routed_task' || name === 'wait_routed_task') {
    const decision = coordinator.get(args.idempotencyKey);
    if (!decision) throw Error('No routing decision for this idempotency key.');
    if (decision.admission_state !== 'accepted' || !decision.task_id) return { decision, receipt: null, status: 'failed' };
    const executor = decision.selected_backend === 'hy4' ? manager : dsh;
    const receipt = name === 'wait_routed_task'
      ? await executor.wait(decision.task_id, args.waitMs ?? WAIT_MS.default)
      : executor.get(decision.task_id);
    return { decision, receipt, status: receipt.status };
  }
  if (name === 'cancel_routed_task') {
    const decision = coordinator.get(args.idempotencyKey);
    if (!decision) throw Error('No routing decision for this idempotency key.');
    if (decision.admission_state !== 'accepted' || !decision.task_id) throw Error('Routing decision has no accepted task to cancel.');
    return decision.selected_backend === 'hy4'
      ? manager.cancel(decision.task_id)
      : dsh.cancel(decision.task_id);
  }
  if (name === 'start_hy4_task' || name === 'run_hy4_task') {
    if (!['text-only', 'workspace-read', 'workspace-write'].includes(args.capability)) throw new PreAdmissionRejection(AdmissionCode.PERMISSION_REFUSED, 'HY4 requires an explicit supported capability.');
    if (!manager.supports(args.capability)) throw new PreAdmissionRejection(AdmissionCode.PERMISSION_REFUSED, 'Requested HY4 capability is not enabled by local manifest policy.');
    if (args.capability === 'workspace-write' && (typeof args.authorizationNote !== 'string' || !args.authorizationNote.trim())) throw new PreAdmissionRejection(AdmissionCode.PERMISSION_REFUSED, 'Workspace-write requires explicit per-task authorizationNote.');
    assertScopedCwd(args);
    const timeoutMs = args.timeoutMs ?? hy4TaskTimeout.default;
    if (!Number.isInteger(timeoutMs) || timeoutMs < hy4TaskTimeout.minimum || timeoutMs > hy4TaskTimeout.maximum) {
      throw new PreAdmissionRejection(AdmissionCode.INVALID_PARAMS,
        `HY4 timeoutMs must be an integer ${hy4TaskTimeout.minimum}..${hy4TaskTimeout.maximum}.`);
    }
    const decision = await coordinator.submit({ ...args, timeoutMs }, {
      sessionMode: 'HY4', taskCapability: args.capability,
      allowWorkspaceWrite: args.capability === 'workspace-write' && workspaceWriteEnabled
    });
    if (name === 'start_hy4_task') return decision;
    const receipt = await waitForDecision(decision, timeoutMs, requestId);
    return { decision, receipt, status: receipt.status };
  }
  if (name === 'start_routed_task' || name === 'run_routed_task') {
    if (!scheduleProvided) throw new PreAdmissionRejection(AdmissionCode.PERMISSION_REFUSED, 'Routed DSH tasks require an explicit --schedule-config; refusing to bypass the peak schedule.');
    assertScopedCwd(args);
    const decision = await coordinator.submit(args, {
      sessionMode: 'DSH', taskCapability: args.capability ?? 'default',
      allowWorkspaceWrite: args.capability === 'workspace-write' && workspaceWriteEnabled
    });
    if (name === 'start_routed_task') return decision;
    const receipt = await waitForDecision(decision, args.timeoutMs ?? DSH_TIMEOUT_MS.default, requestId);
    return { decision, receipt, status: receipt.status, selected_backend: decision.selected_backend };
  }
  throw Error('Unsupported tool.');
}

async function dispatch(message) {
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(message?.id, -32600, 'Invalid JSON-RPC request.');
  const { id, method, params = {} } = message;
  if (id === undefined) {
    if (method === 'notifications/cancelled' && inFlight.has(params.requestId)) {
      const task = inFlight.get(params.requestId);
      if (task.backend === 'hy4') await manager.cancel(task.taskId, 'mcp_request_cancelled');
      else dsh.cancel(task.taskId, 'mcp_request_cancelled');
    }
    return;
  }
  if (method === 'initialize') {
    initialized = true;
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hy4-codebuddy-acp', version: '0.1.0' } } });
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (!initialized) return error(id, -32002, 'Initialize the MCP connection first.');
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
  if (method !== 'tools/call') return error(id, -32601, 'Method not supported.');
  try {
    const result = await call(params.name, params.arguments ?? {}, id);
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: TERMINAL.has(result.status) && result.status !== 'completed' } });
  } catch (e) {
    const result = { isError: true, content: [{ type: 'text', text: redact(e.message) }] };
    if (e instanceof PreAdmissionRejection || e instanceof Hy4UnavailableError || typeof e.code === 'string') {
      result.structuredContent = { error: { code: e.code || 'HY4_ERROR', admission_state: e.admission_state ?? 'unknown', details: e.details ?? {} } };
    }
    send({ jsonrpc: '2.0', id, result });
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const force = setTimeout(() => process.exit(1), 15000);
  await Promise.allSettled([manager.close(), dsh.close()]);
  clearTimeout(force);
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
