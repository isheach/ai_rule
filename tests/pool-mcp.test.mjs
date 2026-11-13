import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256File } from '../bridges/hy4/manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fakeAcp = path.join(root, 'tests', 'fake-codebuddy-acp.mjs');
const mockDsh = path.join(root, 'tests', 'mock-dsh.mjs');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-rule-pool-mcp-'));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OFFPEAK = '2026-11-16T00:30:00.000Z';
const PEAK = '2026-11-16T02:00:00.000Z';
const HOOK_SHELL = (() => {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']
    : ['/bin/bash', '/bin/sh'];
  return candidates.find(value => { try { return fs.statSync(value).isFile(); } catch { return false; } }) ?? null;
})();
const COMMAND_TOOL = process.platform === 'win32' ? 'PowerShell' : 'Bash';
const EXACT_COMMAND = 'Write-Output HY4_OK';
const COMMANDS_TEST = Boolean(HOOK_SHELL) && process.env.HY4_TEST_COMMANDS === '1';

function writeRollout(base, child, parent) {
  const day = path.join(base, 'sessions', '2026', '11', '16');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-11-16T00-00-00-${child}.jsonl`),
    JSON.stringify({ type: 'session_meta', payload: { id: child, source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } }) + '\n');
  fs.writeFileSync(path.join(day, `rollout-2026-11-16T00-00-01-${parent}.jsonl`),
    JSON.stringify({ type: 'session_meta', payload: { id: parent, source: 'vscode', originator: 'codex_work_desktop' } }) + '\n');
}

function fixture({ clock = OFFPEAK, hy4 = false, runningCap = 3, acpMode = 'normal', allowWrite = false, allowCommands = false } = {}) {
  const base = temp();
  const child = id(41), parent = id(42);
  writeRollout(base, child, parent);
  const workspace = path.join(base, 'workspace'); fs.mkdirSync(workspace);
  const schedule = path.join(base, 'schedule.json');
  fs.writeFileSync(schedule, JSON.stringify({
    enabled: true, timezone: 'Asia/Shanghai', weekdayPeakWindows: ['09:00-12:00', '14:00-18:00'],
    stopNewTasksBeforePeakMinutes: 10, checkpointNoticeMinutes: 5,
    rejectTaskIfBudgetExceedsWindow: true, hardStopAtPeak: true, resumeAutomatically: false
  }));
  const config = {
    pool_root: path.join(base, 'pool'), dsh_entry: mockDsh, schedule_config: schedule,
    workspace_root: workspace, context_dir: path.join(base, 'contexts'), allow_write: allowWrite,
    running_cap: runningCap, ttl_hours: 24
  };
  if (hy4) {
    const configDir = path.join(base, 'hy4-config'), hy4Workspace = path.join(base, 'hy4-workspace');
    fs.mkdirSync(configDir); fs.mkdirSync(hy4Workspace);
    fs.writeFileSync(path.join(configDir, 'mode.txt'), acpMode);
    const manifest = path.join(base, 'hy4-manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({
      schema: 1, node_path: process.execPath, cli_entry: fakeAcp, config_dir: configDir,
      workspace_root: workspace, expected_version: '2.184.0', expected_entry_sha256: sha256File(fakeAcp),
      internet_environment: 'internal',
      ...(allowWrite ? { allow_workspace_write: true } : {}),
      ...(allowCommands ? { allow_commands: true, hook_shell_path: HOOK_SHELL } : {})
    }));
    config.hy4_manifest = manifest;
    config.fallback_authorization_ref = 'test-pool-approval';
  }
  const configPath = path.join(base, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { base, child, parent, workspace, config, configPath, clock };
}

function run(file, args, env) {
  const p = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '', err = '';
  p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
  return new Promise(resolve => p.on('close', code => resolve({ code, out, err })));
}

async function issueContext(f, child = f.child) {
  const result = await run(path.join(root, 'tests', 'pool-context-fixture.mjs'),
    ['--config', f.configPath, '--clock', f.clock], { CODEX_HOME: f.base, CODEX_THREAD_ID: child });
  assert.equal(result.code, 0, result.err);
  return JSON.parse(result.out).context_ref;
}

function mcpClient(child) {
  let buffer = '', seq = 0;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let pos;
    while ((pos = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const idValue = ++seq;
    const timer = setTimeout(() => { pending.delete(idValue); reject(Error(`MCP timeout: ${method}`)); }, 20000);
    pending.set(idValue, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: idValue, method, params }) + '\n');
  });
  return {
    rpc,
    async init() { return rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pool-test', version: '1' } }); },
    async call(name, args) {
      const message = await rpc('tools/call', { name, arguments: args });
      assert.ok(message.result, JSON.stringify(message.error));
      let parsed;
      try { parsed = JSON.parse(message.result.content[0].text); } catch { parsed = null; }
      if (message.result.isError) {
        if (message.result.structuredContent?.error) {
          const error = Error(message.result.content[0].text);
          error.code = message.result.structuredContent.error.code;
          error.admission_state = message.result.structuredContent.error.admission_state;
          error.structured = message.result.structuredContent;
          throw error;
        }
        // A JSON status receipt (cancel/unknown/failed) is a domain result, not
        // a typed protocol/admission error. Non-JSON text is a tool error.
        if (!parsed || typeof parsed !== 'object') throw Error(message.result.content[0].text);
      }
      return { ...message.result, parsed };
    }
  };
}

async function startServer(f, clock = f.clock, extra = []) {
  const child = spawn(process.execPath, [path.join(root, 'tests', 'pool-mcp-fixture.mjs'),
    '--config', f.configPath, '--clock', clock, '--sessions-root', path.join(f.base, 'sessions'), ...extra],
  { env: { ...process.env, CODEX_HOME: f.base }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', d => stderr += d);
  const client = mcpClient(child);
  await client.init();
  return { child, client, get stderr() { return stderr; } };
}

async function stop(server) {
  if (server.child.exitCode !== null) return;
  server.child.stdin.end();
  await Promise.race([
    new Promise(resolve => server.child.once('close', resolve)),
    new Promise(resolve => setTimeout(resolve, 8000))
  ]);
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

function taskDirs(f, backend = 'dsh') {
  const state = JSON.parse(fs.readFileSync(path.join(f.config.pool_root, 'bindings.json'), 'utf8'));
  const binding = state.roots[f.parent];
  if (!binding) return [];
  const dir = path.join(binding.runtime_path, backend);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[a-f0-9-]{36}$/i.test(entry.name))
    .map(entry => entry.name);
}

async function waitForBinding(f, predicate, timeoutMs = 8000) {
  const file = path.join(f.config.pool_root, 'bindings.json');
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      last = state.roots[f.parent];
      if (last && predicate(last)) return last;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`binding did not reach the expected state: ${JSON.stringify(last)}`);
}

test('local helper issues only an opaque, short-lived context from a synthetic CODEX_HOME', async () => {
  const f = fixture();
  const env = { CODEX_HOME: f.base, CODEX_THREAD_ID: f.child };
  const issued = await run(path.join(root, 'bridges', 'pool', 'cli.mjs'), ['context', '--config', f.configPath], env);
  assert.equal(issued.code, 0, issued.err);
  const out = JSON.parse(issued.out);
  assert.match(out.context_ref, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(out.root_chat_id, undefined);
  assert.ok(!issued.out.includes('lease'));
  const verified = await run(path.join(root, 'bridges', 'pool', 'cli.mjs'),
    ['verify-context', '--config', f.configPath, '--context', out.context_ref], env);
  assert.equal(verified.code, 0, verified.err);
  assert.equal(JSON.parse(verified.out).root_chat_id, f.parent);
});

test('actual stdio MCP: initialize/list/status/run, replay does not start a second task', async () => {
  const f = fixture();
  const context = await issueContext(f);
  const server = await startServer(f);
  try {
    const listed = await server.client.rpc('tools/list', {});
    const names = listed.result.tools.map(tool => tool.name);
    for (const name of ['get_pool_status', 'start_pool_task', 'run_pool_task', 'get_pool_task', 'wait_pool_task', 'cancel_pool_task']) {
      assert.ok(names.includes(name), name);
    }
    const status = await server.client.call('get_pool_status', { context });
    assert.equal(status.parsed.schedule.enabled, true);
    assert.equal(status.parsed.schedule.phase, 'offpeak');
    assert.equal(status.parsed.write_enabled, false);
    assert.ok(!JSON.stringify(status.parsed).includes('lease'));

    const args = { context, prompt: 'first pooled task', cwd: f.workspace, idempotencyKey: 'same-key', timeoutMs: 5000 };
    const first = await server.client.call('run_pool_task', args);
    assert.equal(first.parsed.status, 'completed');
    assert.match(first.parsed.task_id, /^[a-f0-9-]{36}$/);
    assert.equal(first.parsed.receipt.receipt_path, undefined);
    assert.equal(first.parsed.receipt.runtime, undefined);
    assert.ok(!JSON.stringify(first.parsed).includes(f.config.pool_root));
    const second = await server.client.call('run_pool_task', args);
    assert.equal(second.parsed.task_id, first.parsed.task_id);
    assert.equal(second.parsed.status, 'completed');
    assert.equal(second.parsed.replayed, true);
    assert.equal(taskDirs(f).length, 1);
    const state = JSON.parse(fs.readFileSync(path.join(f.config.pool_root, 'bindings.json'), 'utf8'));
    assert.equal(state.roots[f.parent].state, 'idle');
    assert.ok(!JSON.stringify(state).includes('first pooled task'));
  } finally { await stop(server); }
});

test('actual stdio MCP: same-root continuation, root2 isolation and parallel runtimes', async () => {
  const f = fixture();
  const child2 = id(51), parent2 = id(52);
  writeRollout(f.base, child2, parent2);
  const context1 = await issueContext(f);
  const context2 = await issueContext(f, child2);
  const server = await startServer(f);
  try {
    const first = await server.client.call('run_pool_task', { context: context1, prompt: 'root one', cwd: f.workspace, idempotencyKey: 'root1-key', timeoutMs: 5000 });
    assert.equal(first.parsed.status, 'completed');
    const sessionId = first.parsed.receipt.session_id;
    assert.ok(sessionId);
    const continued = await server.client.call('run_pool_task', {
      context: context1, prompt: 'continuation', cwd: f.workspace, idempotencyKey: 'root1-cont',
      sessionId, timeoutMs: 5000
    });
    assert.equal(continued.parsed.status, 'completed');
    assert.equal(continued.parsed.receipt.session_resume, true);

    const other = await server.client.call('run_pool_task', { context: context2, prompt: 'root two', cwd: f.workspace, idempotencyKey: 'root2-key', timeoutMs: 5000 });
    assert.equal(other.parsed.status, 'completed');
    assert.notEqual(other.parsed.task_id, first.parsed.task_id);

    for (const method of ['get_pool_task', 'cancel_pool_task']) {
      await assert.rejects(() => server.client.call(method, { context: context2, taskId: first.parsed.task_id }), /not mapped|No routing decision/i);
    }
    const state = JSON.parse(fs.readFileSync(path.join(f.config.pool_root, 'bindings.json'), 'utf8'));
    assert.ok(state.roots[f.parent] && state.roots[parent2]);
    assert.notEqual(state.roots[f.parent].runtime_path, state.roots[parent2].runtime_path);
    assert.equal(state.roots[f.parent].state, 'idle');
    assert.equal(state.roots[parent2].state, 'idle');
  } finally { await stop(server); }
});

test('actual stdio MCP: peak schedule rejects before admission with no Hy4 fallback and no capacity leak', async () => {
  const f = fixture({ clock: PEAK });
  const context = await issueContext(f);
  const server = await startServer(f, PEAK);
  try {
    const args = { context, prompt: 'blocked', cwd: f.workspace, idempotencyKey: 'peak-key', timeoutMs: 5000 };
    await assert.rejects(() => server.client.call('run_pool_task', args), error => {
      assert.equal(error.admission_state, 'not_accepted');
      assert.ok(['DSH_SCHEDULE_GATE', 'DSH_PERMISSION_REFUSED'].includes(error.code));
      return true;
    });
    await assert.rejects(() => server.client.call('run_pool_task', args), /already not_accepted|no resubmission/i);
    assert.equal(taskDirs(f).length, 0);
    const state = JSON.parse(fs.readFileSync(path.join(f.config.pool_root, 'bindings.json'), 'utf8'));
    assert.equal(state.roots[f.parent].state, 'idle');
    assert.equal(state.roots[f.parent].active_task_id, null);
  } finally { await stop(server); }
});

test('actual stdio MCP: proven pre-admission schedule gate uses the HY4 fixture once', async () => {
  const f = fixture({ clock: PEAK, hy4: true });
  const context = await issueContext(f);
  const server = await startServer(f, PEAK);
  try {
    const result = await server.client.call('run_pool_task', {
      context, prompt: 'fallback task', cwd: f.workspace, idempotencyKey: 'hy4-key',
      capability: 'text-only', timeoutMs: 5000
    });
    assert.equal(result.parsed.status, 'completed');
    assert.equal(result.parsed.backend, 'hy4');
    assert.equal(result.parsed.receipt.answer, 'HY4_OK');
    assert.equal(taskDirs(f, 'dsh').length, 0);
    const binding = JSON.parse(fs.readFileSync(path.join(f.config.pool_root, 'bindings.json'), 'utf8')).roots[f.parent];
    const hy4Files = fs.readdirSync(path.join(binding.runtime_path, 'hy4', 'requests')).filter(name => name.endsWith('.json'));
    assert.equal(hy4Files.length, 1);
    const state = JSON.parse(fs.readFileSync(path.join(f.config.pool_root, 'bindings.json'), 'utf8'));
    assert.equal(state.roots[f.parent].state, 'idle');
    assert.equal(state.roots[f.parent].active_backend, null);
  } finally { await stop(server); }
});

test('actual stdio MCP: normalized writeScopes reach the pooled HY4 fallback and create a file', async () => {
  const f = fixture({ clock: PEAK, hy4: true, allowWrite: true, acpMode: 'write-create' });
  const context = await issueContext(f);
  const server = await startServer(f, PEAK, ['--allow-write']);
  try {
    const result = await server.client.call('run_pool_task', {
      context, prompt: 'pooled native write', cwd: f.workspace, idempotencyKey: 'pool-write-scope',
      timeoutMs: 6000, capability: 'workspace-write', permissionMode: 'workspace-write',
      authorizationNote: 'pool write approval', writeScopes: [{ path: f.workspace, operations: ['create'] }]
    });
    assert.equal(result.parsed.status, 'completed');
    assert.equal(result.parsed.backend, 'hy4');
    assert.equal(result.parsed.receipt.write_scope_count, 1);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'created.txt'), 'utf8'), 'CREATED\n');
    const state = JSON.parse(fs.readFileSync(path.join(f.config.pool_root, 'bindings.json'), 'utf8'));
    assert.equal(state.roots[f.parent].state, 'idle');
  } finally { await stop(server); }
});

test('actual stdio MCP: exact command rules reach the pooled HY4 fallback only with local enablement', { skip: !COMMANDS_TEST }, async () => {
  const f = fixture({ clock: PEAK, hy4: true, allowWrite: true, allowCommands: true, acpMode: 'command-allow' });
  const context = await issueContext(f);
  const server = await startServer(f, PEAK, ['--allow-write']);
  try {
    const result = await server.client.call('run_pool_task', {
      context, prompt: 'pooled native command', cwd: f.workspace, idempotencyKey: 'pool-command',
      timeoutMs: 6000, capability: 'workspace-write', permissionMode: 'workspace-write',
      authorizationNote: 'pool command approval', commands: [EXACT_COMMAND]
    });
    assert.equal(result.parsed.status, 'completed');
    assert.equal(result.parsed.receipt.command_count, 1);
    assert.equal(result.parsed.receipt.command_tool, COMMAND_TOOL);
    assert.equal(result.parsed.receipt.allowed_operations, 1);
    assert.equal(result.parsed.receipt.completed_operations, 1);
  } finally { await stop(server); }
});

test('actual stdio MCP: the owning server cancels only its child and releases the exact task', async () => {
  const f = fixture();
  const context = await issueContext(f);
  const server = await startServer(f);
  try {
    const started = await server.client.call('start_pool_task', {
      context, prompt: 'hang', cwd: f.workspace, idempotencyKey: 'owner-cancel', timeoutMs: 60000
    });
    const taskId = started.parsed.task_id;
    const cancelled = await server.client.call('cancel_pool_task', { context, taskId });
    assert.equal(cancelled.parsed.cancelled, true);
    assert.equal(cancelled.parsed.owner, true);
    assert.equal(cancelled.parsed.status, 'cancelled');
    const state = JSON.parse(fs.readFileSync(path.join(f.config.pool_root, 'bindings.json'), 'utf8'));
    assert.equal(state.roots[f.parent].state, 'idle');
    assert.equal(state.roots[f.parent].active_task_id, null);
  } finally { await stop(server); }
});

test('actual stdio MCP: start without get/wait settles terminal and running_cap=1 admits the next task', async () => {
  const f = fixture({ runningCap: 1 });
  const context = await issueContext(f);
  const server = await startServer(f);
  try {
    const first = await server.client.call('start_pool_task', {
      context, prompt: 'p0\n\nsleep:400', cwd: f.workspace, idempotencyKey: 'p0-first', timeoutMs: 5000
    });
    assert.equal(first.parsed.status, 'accepted');
    const taskId = first.parsed.task_id;
    // Deliberately no get/wait: the live server attaches to the backend's own
    // finished promise and settles the reservation independently.
    await waitForBinding(f, binding => binding.state === 'idle', 8000);
    const observed = await server.client.call('get_pool_task', { context, taskId });
    assert.equal(observed.parsed.status, 'completed');
    const second = await server.client.call('run_pool_task', {
      context, prompt: 'next task', cwd: f.workspace, idempotencyKey: 'p0-second', timeoutMs: 5000
    });
    assert.equal(second.parsed.status, 'completed');
    assert.notEqual(second.parsed.task_id, taskId);
    assert.equal(taskDirs(f).length, 2);
  } finally { await stop(server); }
});

test('actual stdio MCP: overlapping accepted lifetimes, independent runtimes and cross-root denial', async () => {
  const f = fixture();
  const child2 = id(61), parent2 = id(62);
  writeRollout(f.base, child2, parent2);
  const context1 = await issueContext(f);
  const context2 = await issueContext(f, child2);
  const server = await startServer(f);
  try {
    const one = await server.client.call('start_pool_task', {
      context: context1, prompt: 'one\n\nsleep:4000', cwd: f.workspace, idempotencyKey: 'overlap-1', timeoutMs: 12000
    });
    const two = await server.client.call('start_pool_task', {
      context: context2, prompt: 'two\n\nsleep:4000', cwd: f.workspace, idempotencyKey: 'overlap-2', timeoutMs: 12000
    });
    assert.equal(one.parsed.status, 'accepted');
    assert.equal(two.parsed.status, 'accepted');
    assert.notEqual(one.parsed.task_id, two.parsed.task_id);
    const own = await server.client.call('get_pool_task', { context: context1, taskId: one.parsed.task_id });
    assert.ok(['starting', 'running', 'accepted'].includes(own.parsed.status));
    for (const method of ['get_pool_task', 'wait_pool_task', 'cancel_pool_task']) {
      await assert.rejects(() => server.client.call(method, { context: context2, taskId: one.parsed.task_id }), /not mapped|No routing decision/i);
    }
    const state = JSON.parse(fs.readFileSync(path.join(f.config.pool_root, 'bindings.json'), 'utf8'));
    assert.equal(state.roots[f.parent].state, 'active');
    assert.equal(state.roots[parent2].state, 'active');
    assert.notEqual(state.roots[f.parent].runtime_path, state.roots[parent2].runtime_path);
    const waitedOne = await server.client.call('wait_pool_task', { context: context1, taskId: one.parsed.task_id, waitMs: 10000 });
    assert.equal(waitedOne.parsed.status, 'completed');
    const waitedTwo = await server.client.call('wait_pool_task', { context: context2, taskId: two.parsed.task_id, waitMs: 10000 });
    assert.equal(waitedTwo.parsed.status, 'completed');
    await waitForBinding(f, binding => binding.state === 'idle', 8000);
    const state2 = JSON.parse(fs.readFileSync(path.join(f.config.pool_root, 'bindings.json'), 'utf8'));
    assert.equal(state2.roots[f.parent].state, 'idle');
    assert.equal(state2.roots[parent2].state, 'idle');
  } finally { await stop(server); }
});

test('actual stdio MCP: new cwd gets a fresh session in the same instance, original session plus other cwd is refused', async () => {
  const f = fixture();
  const sub = path.join(f.workspace, 'sub'); fs.mkdirSync(sub);
  const context = await issueContext(f);
  const server = await startServer(f);
  try {
    const first = await server.client.call('run_pool_task', {
      context, prompt: 'session base', cwd: f.workspace, idempotencyKey: 'session-base', timeoutMs: 5000
    });
    assert.equal(first.parsed.status, 'completed');
    const sessionId = first.parsed.receipt.session_id;
    assert.ok(sessionId);
    const fresh = await server.client.call('run_pool_task', {
      context, prompt: 'fresh cwd', cwd: sub, idempotencyKey: 'session-fresh', timeoutMs: 5000
    });
    assert.equal(fresh.parsed.status, 'completed');
    assert.notEqual(fresh.parsed.receipt.session_id, sessionId);
    assert.equal(fresh.parsed.receipt.session_resume, false);
    const binding = JSON.parse(fs.readFileSync(path.join(f.config.pool_root, 'bindings.json'), 'utf8')).roots[f.parent];
    const raw = JSON.parse(fs.readFileSync(path.join(binding.runtime_path, 'dsh', fresh.parsed.task_id, 'RUN_RECEIPT.json'), 'utf8'));
    assert.equal(raw.instance, binding.dsh_instance);
    await assert.rejects(() => server.client.call('run_pool_task', {
      context, prompt: 'wrong cwd resume', cwd: sub, idempotencyKey: 'session-bad', sessionId, timeoutMs: 5000
    }), error => {
      assert.equal(error.code, 'DSH_SESSION_CONFLICT');
      assert.equal(error.admission_state, 'not_accepted');
      return true;
    });
    const state = JSON.parse(fs.readFileSync(path.join(f.config.pool_root, 'bindings.json'), 'utf8'));
    assert.equal(state.roots[f.parent].state, 'idle');
    assert.equal(taskDirs(f).length, 2);
  } finally { await stop(server); }
});

test('actual stdio MCP: a second live server is a non-owner and cannot cancel or free the pin', async () => {
  const f = fixture();
  const context = await issueContext(f);
  const serverA = await startServer(f);
  let taskId = null;
  try {
    const started = await serverA.client.call('start_pool_task', {
      context, prompt: 'hang', cwd: f.workspace, idempotencyKey: 'two-servers', timeoutMs: 60000
    });
    taskId = started.parsed.task_id;
    const serverB = await startServer(f);
    try {
      const snapshot = await serverB.client.call('cancel_pool_task', { context, taskId });
      assert.equal(snapshot.parsed.cancelled, false);
      assert.equal(snapshot.parsed.owner, false);
      assert.equal(snapshot.parsed.status, 'unknown_after_disconnect');
      const status = await serverB.client.call('get_pool_status', { context });
      assert.equal(status.parsed.root.state, 'active');
      assert.equal(status.parsed.root.active_task_id, taskId);
    } finally { await stop(serverB); }
    const cancelled = await serverA.client.call('cancel_pool_task', { context, taskId });
    assert.equal(cancelled.parsed.cancelled, true);
    assert.equal(cancelled.parsed.owner, true);
    const state = JSON.parse(fs.readFileSync(path.join(f.config.pool_root, 'bindings.json'), 'utf8'));
    assert.equal(state.roots[f.parent].state, 'idle');
  } finally { await stop(serverA); }
});
