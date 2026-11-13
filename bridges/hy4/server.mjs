#!/usr/bin/env node
// Opt-in HY4 ACP endpoint. It is additive and must not be registered by default.
import { Hy4AcpManager, canonicalWithin } from './acp.mjs';
import { loadManifest } from './manifest.mjs';
import { RoutingCoordinator, PreAdmissionRejection, Hy4UnavailableError, AdmissionCode } from '../dsh/routing.mjs';
import { TaskManager, discoverDsh, redact } from '../dsh/core.mjs';
import { loadSchedule } from '../dsh/schedule.mjs';
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
  if (path.resolve(dsh.runtime) === path.resolve(manager.runtime)) throw Error('HY4 and DSH runtimes must remain physically separate.');
  const authRef = option('--fallback-authorization');
  const authorization = authRef ? {
    schema: 1, enabled: true, authorization_ref: authRef, scope: 'pre_admission_only', max_attempts: 1
  } : null;
  routing = new RoutingCoordinator({
    runtime: option('--routing-runtime') ?? `${manager.runtime}-routing`,
    dsh: { submit: task => dsh.start(task) },
    hy4: manager,
    authorization,
    liveMcpDispatchWired: true
  });
  coordinator = routing;
} catch (error) {
  console.error(`HY4 bridge startup failed: ${redact(error.message)}`);
  process.exit(1);
}

const taskSchema = {
  type: 'object', additionalProperties: false, required: ['prompt', 'cwd', 'idempotencyKey'], properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 60000 },
    cwd: { type: 'string' },
    idempotencyKey: { type: 'string', description: 'Stable key scoped to this opt-in HY4/routing runtime. New revision requires a new key.' },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 900000, default: 600000 },
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
const idSchema = { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId: { type: 'string' } } };
const keySchema = { type: 'object', additionalProperties: false, required: ['idempotencyKey'], properties: { idempotencyKey: { type: 'string' } } };
const tools = [
  { name: 'get_hy4_bridge_status', description: 'ACP/CodeBuddy Hy4 readiness and route descriptor without sending a prompt. Also reports DSH-first fallback policy state. No credentials.', inputSchema: { type: 'object', additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'start_hy4_task', description: 'Explicit HY4 task through the pinned CodeBuddy ACP hy4free model. Requires capability text-only, workspace-read or workspace-write; workspace-write needs local enablement, cwd, authorizationNote and writeScopes/writes/commands. No DSH fallback.', inputSchema: taskSchema, annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'run_hy4_task', description: 'Explicit HY4 ACP task; waits for its terminal receipt. Same explicit capability/scope contract; no model fallback and no automatic retry.', inputSchema: taskSchema, annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'get_hy4_task', description: 'Read an owned HY4 task receipt without resubmitting.', inputSchema: idSchema, annotations: { readOnlyHint: true } },
  { name: 'wait_hy4_task', description: 'Wait for an HY4 task up to 60 seconds.', inputSchema: { ...idSchema, properties: { ...idSchema.properties, waitMs: { type: 'integer', minimum: 0, maximum: 60000, default: 25000 } } }, annotations: { readOnlyHint: true } },
  { name: 'cancel_hy4_task', description: 'Cancel only an HY4 task owned by this bridge process. No stale PID killing.', inputSchema: idSchema, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'start_routed_task', description: 'DSH-first task with the explicitly authorized pre-admission-only HY4 fallback policy. Returns an auditable routing decision.', inputSchema: taskSchema, annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'run_routed_task', description: 'DSH-first task and wait; HY4 only after a qualifying pre-admission rejection and explicit authorization.', inputSchema: taskSchema, annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'get_routed_decision', description: 'Read a routing decision by idempotency key; no model call.', inputSchema: keySchema, annotations: { readOnlyHint: true } },
  { name: 'get_routed_task', description: 'Read the accepted DSH or HY4 task receipt for a routing decision by idempotency key.', inputSchema: keySchema, annotations: { readOnlyHint: true } },
  { name: 'wait_routed_task', description: 'Wait on the accepted DSH or HY4 task for a routing decision by idempotency key.', inputSchema: { ...keySchema, properties: { ...keySchema.properties, waitMs: { type: 'integer', minimum: 0, maximum: 60000, default: 25000 } } }, annotations: { readOnlyHint: true } },
  { name: 'cancel_routed_task', description: 'Cancel the owned backend task for a routing decision; no cross-owner kill.', inputSchema: keySchema, annotations: { readOnlyHint: false, destructiveHint: true } }
];
let initialized = false, input = '', shuttingDown = false;
const inFlight = new Map();
const send = value => { if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(value) + '\n'); };
const error = (id, code, message) => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message: redact(message) } });

const TERMINAL = new Set(['completed', 'failed', 'unknown', 'timed_out', 'cancelled', 'refused', 'schedule_stopped', 'not_accepted']);

async function waitTerminal(waitFn, taskId, timeoutMs) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let receipt;
  do {
    receipt = await waitFn(taskId, 60000);
    if (TERMINAL.has(receipt.status)) return receipt;
  } while (Date.now() < deadline);
  return receipt;
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
    return { hy4: hy4Status, routing: coordinator.status(), dsh: { instance: dsh.instance, active_task_id: dsh.active?.record.task_id ?? null, allow_workspace_write: false } };
  }
  if (name === 'get_hy4_task') return manager.get(args.taskId);
  if (name === 'wait_hy4_task') return manager.wait(args.taskId, args.waitMs ?? 25000);
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
    const receipt = name === 'wait_routed_task'
      ? (decision.selected_backend === 'hy4' ? await manager.wait(decision.task_id, args.waitMs ?? 25000) : await dsh.wait(decision.task_id, args.waitMs ?? 25000))
      : (decision.selected_backend === 'hy4' ? manager.get(decision.task_id) : dsh.get(decision.task_id));
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
    const decision = await coordinator.submit(args, {
      sessionMode: 'HY4', taskCapability: args.capability,
      allowWorkspaceWrite: args.capability === 'workspace-write' && manager.manifest.allow_workspace_write === true
    });
    if (name === 'start_hy4_task') return decision;
    inFlight.set(requestId, { backend: 'hy4', taskId: decision.task_id });
    try {
      const receipt = await waitTerminal((id, ms) => manager.wait(id, ms), decision.task_id, args.timeoutMs ?? 600000);
      return { decision, receipt, status: receipt.status };
    } finally { inFlight.delete(requestId); }
  }
  if (name === 'start_routed_task' || name === 'run_routed_task') {
    if (!scheduleProvided) throw new PreAdmissionRejection(AdmissionCode.PERMISSION_REFUSED, 'Routed DSH tasks require an explicit --schedule-config; refusing to bypass the peak schedule.');
    assertScopedCwd(args);
    const decision = await coordinator.submit(args, {
      sessionMode: 'DSH', taskCapability: args.capability ?? 'default',
      allowWorkspaceWrite: args.capability === 'workspace-write' && manager.manifest.allow_workspace_write === true
    });
    if (name === 'start_routed_task') return decision;
    inFlight.set(requestId, { backend: decision.selected_backend, taskId: decision.task_id });
    try {
      const receipt = decision.selected_backend === 'hy4'
        ? await waitTerminal((id, ms) => manager.wait(id, ms), decision.task_id, args.timeoutMs ?? 600000)
        : await waitTerminal((id, ms) => dsh.wait(id, ms), decision.task_id, args.timeoutMs ?? 600000);
      return { decision, receipt, status: receipt.status, selected_backend: decision.selected_backend };
    } finally { inFlight.delete(requestId); }
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
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: ['failed', 'unknown', 'timed_out', 'cancelled', 'refused', 'schedule_stopped', 'not_accepted'].includes(result.status) } });
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
