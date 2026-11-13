#!/usr/bin/env node
// Opt-in stdio MCP endpoint for the root-chat DSH pool. No HTTP listener, no
// model API, no per-request process. One TaskManager/Hy4AcpManager/coordinator
// per verified root stays in this connection for its whole lifetime.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPoolConfig, PoolService } from './service.mjs';
import { resolveContext } from './context.mjs';
import { loadSchedule } from '../dsh/schedule.mjs';
import { PreAdmissionRejection, RoutingConflictError } from '../dsh/routing.mjs';
import { redact } from '../dsh/core.mjs';

const FAILURE = new Set(['failed', 'timed_out', 'cancelled', 'schedule_stopped', 'refused', 'unknown', 'unknown_after_disconnect', 'not_accepted']);
const safeText = value => redact(value).replace(/[A-Za-z]:\\[^\s"']+/g, '<local-path>');
function publicReceipt(value) {
  if (!value || typeof value !== 'object') return value ?? null;
  const copy = { ...value };
  for (const key of ['runtime', 'receipt_path', 'instance_metadata_path', 'instance', 'cwd', 'pid', 'lock_owner']) delete copy[key];
  return copy;
}
function publicResult(value) {
  if (!value || typeof value !== 'object') return value;
  const copy = { ...value };
  if ('receipt' in copy) copy.receipt = publicReceipt(copy.receipt);
  return copy;
}

const contextProperty = {
  type: 'string', minLength: 43, maxLength: 43,
  description: 'Opaque short-lived reference issued by bridges/pool/cli.mjs context. It is routing context, not authentication; no rootId/lease argument is accepted.'
};
const locatorProperties = {
  context: contextProperty,
  idempotencyKey: { type: 'string', description: 'Durable task identity for this root. Preferred lookup key.' },
  taskId: { type: 'string', description: 'Direct task ID only when it is mapped to this same root by a routing decision.' }
};
const taskProperties = {
  context: contextProperty,
  prompt: { type: 'string', minLength: 1, maxLength: 60000 },
  cwd: { type: 'string' },
  idempotencyKey: { type: 'string' },
  timeoutMs: { type: 'integer', minimum: 1000, maximum: 3600000, default: 900000 },
  permissionMode: { type: 'string', enum: ['read-only', 'workspace-write'], default: 'read-only' },
  capability: { type: 'string', enum: ['default', 'text-only', 'workspace-read', 'workspace-write'], default: 'default' },
  authorizationNote: { type: 'string', maxLength: 2000 },
  sessionId: { type: 'string' },
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
};
const tools = [
  {
    name: 'get_pool_status',
    description: 'Local pooled-DSH status for this root. Read-only: never creates a binding, spawns a model or refreshes idle TTL. Omit context for server-level counts.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { context: contextProperty } },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'start_pool_task',
    description: 'Start a DSH-first task in this root. DSH is attempted first; HY4 is used only after a proven pre-admission schedule rejection when locally authorized and ready. Returns a durable task ID. No model API and no cross-root fallback.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['context', 'prompt', 'cwd', 'idempotencyKey'], properties: taskProperties },
    annotations: { readOnlyHint: false, openWorldHint: true }
  },
  {
    name: 'run_pool_task',
    description: 'Start and wait internally for one bounded pooled task in this root. Same DSH-first/pre-admission-HY4 policy and schedule hard stop; no automatic resume.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['context', 'prompt', 'cwd', 'idempotencyKey'], properties: taskProperties },
    annotations: { readOnlyHint: false, openWorldHint: true }
  },
  {
    name: 'get_pool_task',
    description: 'Read a pooled task by durable idempotency key, or by task ID only when mapped to this root. Does not start or mutate work.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['context'], properties: locatorProperties },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'wait_pool_task',
    description: 'Event-driven wait up to 60 seconds on an already accepted pooled task. No resubmission and no model call.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['context'],
      properties: { ...locatorProperties, waitMs: { type: 'integer', minimum: 0, maximum: 60000, default: 25000 } }
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'cancel_pool_task',
    description: 'Cancel only a backend child owned by this stdio server and only for this context root. Non-owner requests are read-only snapshots; no kill, finish or lease mutation.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['context'], properties: locatorProperties },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }
];

function validateArgs(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('Tool arguments must be an object.');
  for (const key of Object.keys(args)) if (!(key in tool.inputSchema.properties)) throw Error(`Unknown argument: ${key}`);
  for (const key of tool.inputSchema.required || []) if (!(key in args)) throw Error(`Missing argument: ${key}`);
  if ((tool.name === 'get_pool_task' || tool.name === 'wait_pool_task' || tool.name === 'cancel_pool_task')
    && !args.idempotencyKey && !args.taskId) throw Error('idempotencyKey or taskId is required.');
}

export async function startPoolServer({
  configPath, allowWrite = false, clock = () => new Date(), schedule, stdin = process.stdin, stdout = process.stdout,
  sessionsRoot, env = process.env
} = {}) {
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) throw Error('--config must be an absolute path');
  const config = loadPoolConfig(configPath);
  const selectedSchedule = schedule ?? loadSchedule(config.schedule_config);
  const service = new PoolService({ config, schedule: selectedSchedule, allowWriteCli: allowWrite, clock, sessionsRoot });
  let initialized = false, shuttingDown = false, input = '';
  const inFlight = new Map();
  const send = value => { if (!stdout.destroyed) stdout.write(JSON.stringify(value) + '\n'); };
  const sendError = (id, code, message) => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message: safeText(message) } });

  const contextFor = reference => resolveContext({ config, reference, sessionsRoot, clock });

  async function call(name, args, requestId) {
    if (shuttingDown) throw Error('pool server is shutting down; no new work is admitted');
    const tool = tools.find(item => item.name === name);
    if (!tool) throw Error(`Unknown tool: ${name}`);
    validateArgs(tool, args);
    let rootId = null;
    if (args.context !== undefined) rootId = contextFor(args.context).rootId;
    if (name === 'get_pool_status') return service.status(rootId);
    if (!rootId) throw Error('A verified root context is required.');
    if (name === 'get_pool_task') return service.get(rootId, { idempotencyKey: args.idempotencyKey, taskId: args.taskId });
    if (name === 'wait_pool_task') return service.wait(rootId, { idempotencyKey: args.idempotencyKey, taskId: args.taskId }, args.waitMs ?? 25000);
    if (name === 'cancel_pool_task') return service.cancel(rootId, { idempotencyKey: args.idempotencyKey, taskId: args.taskId });
    const task = { ...args };
    delete task.context;
    if (name === 'start_pool_task') {
      const result = await service.submit(rootId, task);
      if (result.task_id && !result.replayed && !result.deduplicated) inFlight.set(requestId, { rootId, taskId: result.task_id, cancellable: true });
      return result;
    }
    const result = await service.run(rootId, task, accepted => {
      if (accepted.task_id && !accepted.replayed && !accepted.deduplicated) inFlight.set(requestId, { rootId, taskId: accepted.task_id, cancellable: true });
    });
    return result;
  }

  async function dispatch(message) {
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return sendError(message?.id, -32600, 'Invalid JSON-RPC request.');
    const { id, method, params = {} } = message;
    if (id === undefined) {
      if (method === 'notifications/cancelled') {
        const owned = inFlight.get(params.requestId);
        if (owned && owned.cancellable && !owned.cancelled) {
          owned.cancelled = true;
          try { await service.cancel(owned.rootId, { taskId: owned.taskId }); } catch {}
          inFlight.delete(params.requestId);
        }
      }
      return;
    }
    if (method === 'initialize') {
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18'];
      initialized = true;
      return send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: supported.includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'dsh-root-pool', version: '0.4.0', transport: 'stdio', default_backend: 'dsh' }
        }
      });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (!initialized) return sendError(id, -32002, 'Initialize the MCP connection first.');
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
    if (method !== 'tools/call') return sendError(id, -32601, 'Method not supported.');
    try {
      const result = await call(params.name, params.arguments ?? {}, id);
      send({
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(publicResult(result)) }],
          isError: FAILURE.has(result.status)
        }
      });
      inFlight.delete(id);
    } catch (error) {
      const result = { isError: true, content: [{ type: 'text', text: safeText(error.message) }] };
      if (error instanceof PreAdmissionRejection || error instanceof RoutingConflictError || typeof error.code === 'string') {
        result.structuredContent = {
          error: {
            code: error.code ?? 'POOL_ERROR',
            admission_state: error.admission_state ?? 'not_accepted',
            fallback_eligible: error.fallback_eligible === true,
            details: error.details ?? {}
          }
        };
      }
      send({ jsonrpc: '2.0', id, result });
      inFlight.delete(id);
    }
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const force = setTimeout(() => process.exit(1), 15000);
    try { await service.close(); } catch {}
    clearTimeout(force);
    // Never report a clean exit while a child owned by this live server can
    // still be running. Unknown/pinned pool state is preserved in that case.
    if (service.hasLiveChildren()) process.exit(1);
    process.exit(0);
  }

  stdin.setEncoding('utf8');
  stdin.on('data', chunk => {
    input += chunk;
    if (Buffer.byteLength(input) > 512000) { sendError(null, -32600, 'Input size limit exceeded.'); void shutdown(); return; }
    let pos;
    while ((pos = input.indexOf('\n')) >= 0) {
      const line = input.slice(0, pos); input = input.slice(pos + 1);
      if (!line.trim()) continue;
      try { void dispatch(JSON.parse(line)).catch(error => sendError(null, -32603, error.message)); }
      catch { sendError(null, -32700, 'Invalid JSON.'); }
    }
  });
  stdin.on('end', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  stdout.on('error', shutdown);
  return service;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf('--config');
  const configPath = index >= 0 ? argv[index + 1] : undefined;
  startPoolServer({ configPath, allowWrite: argv.includes('--allow-write') }).catch(error => {
    console.error(`pool MCP startup failed: ${redact(error.message)}`);
    process.exit(1);
  });
}
