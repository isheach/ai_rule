#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORKBUDDY_DSF } from './dispatch.mjs';
import { projectLookupSchema, projectRunSchema, projectStatusSchema } from './project-policy.mjs';
import { WorkBuddyProjectService } from './project-service.mjs';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LOOKUP = 'get_workbuddy_task';
const tools = [
  { name: WORKBUDDY_DSF.status_tool, inputSchema: projectStatusSchema, annotations: { readOnlyHint: true },
    description: 'Check the fixed WorkBuddy DSF model and existing project grant for a cwd. Does not send a model prompt.' },
  { name: WORKBUDDY_DSF.run_tool, inputSchema: projectRunSchema, annotations: { readOnlyHint: false },
    description: 'Run a bounded WorkBuddy DSF task inside an already approved project. Use the returned project ID and a stable task key.' },
  { name: LOOKUP, inputSchema: projectLookupSchema, annotations: { readOnlyHint: true },
    description: 'Read the original WorkBuddy project task by key, without submitting work.' }
];

export function startWorkBuddyProjectServer({ configPath, stdin = process.stdin, stdout = process.stdout, sdk } = {}) {
  const service = new WorkBuddyProjectService({ configPath, sdk });
  const requests = new Map();
  const dispatches = new Set();
  let initialized = false;
  let closing = false;
  let input = '';
  const send = message => { if (!stdout.destroyed) stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); };
  const error = (id, code, message) => send({ id: id ?? null, error: { code, message } });

  async function dispatch(message) {
    const { id, method, params = {} } = message ?? {};
    if (message?.jsonrpc !== '2.0' || typeof method !== 'string') return error(id, -32600, 'Invalid MCP request.');
    if (id === undefined) {
      if (method === 'notifications/cancelled') requests.get(params.requestId)?.abort();
      return;
    }
    if (method === 'initialize') {
      initialized = true;
      const protocolVersion = PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
      return send({ id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: WORKBUDDY_DSF.server_name, version: '1.0.0' } } });
    }
    if (method === 'ping') return send({ id, result: {} });
    if (!initialized) return error(id, -32002, 'Initialize the MCP connection first.');
    if (method === 'tools/list') return send({ id, result: { tools } });
    if (method !== 'tools/call' || !tools.some(tool => tool.name === params.name)) return error(id, -32601, 'Unsupported WorkBuddy MCP method or tool.');
    if (requests.has(id)) return error(id, -32600, 'An in-flight request already uses this ID.');
    const controller = new AbortController();
    requests.set(id, controller);
    try {
      const args = params.arguments ?? {};
      let data;
      if (params.name === WORKBUDDY_DSF.status_tool) {
        data = await service.status(args, AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]));
      } else if (params.name === WORKBUDDY_DSF.run_tool) {
        data = await service.run(args, controller.signal);
      } else data = service.get(args);
      send({ id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data } });
    } catch (cause) {
      const known = /^WORKBUDDY_[A-Z0-9_]+$/.test(cause.code ?? '');
      const message = known ? cause.message : 'The WorkBuddy project request could not be completed. Keep the original key.';
      send({ id, result: { isError: true, content: [{ type: 'text', text: message }] } });
    } finally { requests.delete(id); }
  }

  async function shutdown() {
    if (closing) return;
    closing = true;
    stdin.pause();
    for (const controller of requests.values()) controller.abort();
    const deadline = setTimeout(() => process.exit(1), 30000);
    try { await Promise.allSettled([service.close(), ...dispatches]); }
    finally { clearTimeout(deadline); }
    if (stdin === process.stdin) process.exit(0);
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
      try {
        const work = dispatch(JSON.parse(line)).catch(() => error(null, -32603, 'WorkBuddy MCP request failed.'));
        dispatches.add(work);
        void work.then(() => dispatches.delete(work));
      }
      catch { error(null, -32700, 'Invalid MCP JSON.'); }
    }
  });
  stdin.once('end', shutdown);
  stdout.once('error', shutdown);
  if (stdin === process.stdin) {
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
  return service;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--config') throw Error('Pass --config with the local WorkBuddy project JSON path.');
    startWorkBuddyProjectServer({ configPath: process.argv[3] });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
