import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RootPool } from '../bridges/pool/core.mjs';
import { resolveRootFromRollout } from '../bridges/pool/host.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-rule-pool-'));
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const H = 'a'.repeat(64);
const reserve = (p, binding, key, taskId = null) => {
  const operationId = p.newOperationId();
  p.reserve(binding.handle, { operationId, idempotencyKey: key, requestHash: H });
  return { operationId, taskId };
};

test('atomic lowest-free allocation, cap, full handle and stable per-root runtime', () => {
  const p = new RootPool({ root: temp(), bindingCap: 2, concurrency: 3 });
  const a = p.allocate(id(1)), b = p.allocate(id(2));
  assert.equal(a.ordinal, 1); assert.equal(b.ordinal, 2);
  assert.ok(a.runtime_path !== b.runtime_path);
  assert.ok(fs.existsSync(path.join(a.runtime_path, 'dsh')));
  assert.ok(fs.existsSync(path.join(a.runtime_path, 'hy4')));
  assert.ok(fs.existsSync(path.join(a.runtime_path, 'routing')));
  assert.throws(() => p.allocate(id(3)), /cap/);
  const again = p.allocate(id(1));
  assert.equal(again.lease_id, a.lease_id);
});

test('running cap uses full progress reservation and finish releases capacity', () => {
  const p = new RootPool({ root: temp(), bindingCap: 8, concurrency: 2 });
  const a = p.allocate(id(1)), b = p.allocate(id(2)), c = p.allocate(id(3));
  const opA = reserve(p, a, 't1'), opB = reserve(p, b, 't2');
  assert.throws(() => reserve(p, c, 't3'), /capacity/);
  p.admit(a.handle, { operationId: opA.operationId, taskId: id(101), backend: 'dsh' });
  p.finish(a.handle, { operationId: opA.operationId, taskId: id(101) });
  assert.throws(() => p.finish(a.handle, { operationId: opA.operationId, taskId: id(101) }), /active/);
  const opA2 = reserve(p, a, 't1b');
  p.reject(a.handle, { operationId: opA2.operationId, idempotencyKey: 't1b' });
  p.reject(b.handle, { operationId: opB.operationId, idempotencyKey: 't2' });
  const opC = reserve(p, c, 't3');
  assert.equal(p.snapshot(c.handle).state, 'starting');
  p.reject(c.handle, { operationId: opC.operationId, idempotencyKey: 't3' });
});

test('idle TTL recycles ordinal only and invalidates stale generation/lease/operation', () => {
  let now = new Date('2026-11-13T00:00:00Z');
  const root = temp();
  const p = new RootPool({ root, bindingCap: 4, ttlHours: 24, clock: () => now });
  const old = p.allocate(id(1));
  const oldRuntime = old.runtime_path;
  const op = reserve(p, old, 't1');
  p.admit(old.handle, { operationId: op.operationId, taskId: id(101), backend: 'dsh' });
  p.finish(old.handle, { operationId: op.operationId, taskId: id(101) });
  now = new Date('2026-11-14T01:00:00Z');
  assert.equal(p.recycleExpired().recycled, 1);
  const fresh = p.allocate(id(2));
  assert.equal(fresh.ordinal, old.ordinal);
  assert.ok(fresh.generation > old.generation);
  assert.ok(fs.existsSync(oldRuntime));
  assert.ok(fresh.runtime_path !== oldRuntime);
  assert.throws(() => p.snapshot(old.handle), /not bound|stale/);
  assert.throws(() => p.reserve(old.handle, { operationId: p.newOperationId(), idempotencyKey: 't2', requestHash: H }), /not bound|stale/);
});

test('active/unknown pins root and consumes running capacity; observation does not refresh TTL', () => {
  let now = new Date('2026-11-13T00:00:00Z');
  const root = temp();
  const p = new RootPool({ root, bindingCap: 4, concurrency: 2, ttlHours: 1, clock: () => now });
  const a = p.allocate(id(1));
  const op = reserve(p, a, 't1');
  p.admit(a.handle, { operationId: op.operationId, taskId: id(101), backend: 'dsh' });
  assert.throws(() => p.reserve(a.handle, { operationId: p.newOperationId(), idempotencyKey: 't2', requestHash: H }), /active|starting/);
  now = new Date('2026-11-13T05:00:00Z');
  assert.equal(p.recycleExpired().recycled, 0);
  const unknown = p.markUnknown(a.handle, { operationId: op.operationId, taskId: id(101) });
  assert.equal(unknown.state, 'unknown');
  assert.throws(() => p.allocate(id(1)), /unknown/);
  assert.equal(p.snapshot(a.handle).state, 'unknown');
  assert.throws(() => p.snapshot({ ...a.handle, generation: 999 }), /generation/);
  assert.throws(() => p.snapshot({ ...a.handle, ordinal: 99 }), /ordinal/);
  assert.throws(() => p.finish(a.handle, { operationId: op.operationId, taskId: id(101) }), /active/);
});

test('delayed same-lease mutation with a different task proof is refused', () => {
  const p = new RootPool({ root: temp(), bindingCap: 4, concurrency: 3 });
  const a = p.allocate(id(1));
  const first = reserve(p, a, 'key-1');
  p.admit(a.handle, { operationId: first.operationId, taskId: id(101), backend: 'dsh' });
  p.finish(a.handle, { operationId: first.operationId, taskId: id(101) });
  const second = reserve(p, a, 'key-2');
  p.admit(a.handle, { operationId: second.operationId, taskId: id(102), backend: 'dsh' });
  assert.throws(() => p.finish(a.handle, { operationId: first.operationId, taskId: id(102) }), /operation/);
  assert.throws(() => p.finish(a.handle, { operationId: second.operationId, taskId: id(101) }), /task/);
  assert.equal(p.snapshot(a.handle).state, 'active');
  p.finish(a.handle, { operationId: second.operationId, taskId: id(102) });
});

test('host resolver follows only the exact child session_meta parent link', () => {
  const sessions = temp(), child = id(9), parent = id(8);
  const day = path.join(sessions, '2026', '11', '13'); fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-2026-11-13T00-00-00-${child}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: child, source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } }) + '\n');
  fs.writeFileSync(path.join(day, `rollout-2026-11-13T00-00-01-${parent}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: parent, source: 'vscode', originator: 'codex_work_desktop' } }) + '\n');
  assert.equal(resolveRootFromRollout({ sessionsRoot: sessions, childId: child }).rootChatId, parent);
  assert.throws(() => resolveRootFromRollout({ sessionsRoot: sessions, childId: id(7) }), /not found|missing/);
});

test('pooled run CLI starts real mock DSH in root runtime and releases only after terminal', async () => {
  const child = id(21), parent = id(22), base = temp();
  const sessions = path.join(base, 'sessions'), day = path.join(sessions, '2026', '11', '13');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-11-13T00-00-00-${child}.jsonl`),
    JSON.stringify({ type: 'session_meta', payload: { id: child, source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } }) + '\n');
  fs.writeFileSync(path.join(day, `rollout-2026-11-13T00-00-01-${parent}.jsonl`),
    JSON.stringify({ type: 'session_meta', payload: { id: parent, source: 'vscode', originator: 'codex_work_desktop' } }) + '\n');
  const workspace = path.join(base, 'workspace'); fs.mkdirSync(workspace);
  const schedule = path.join(base, 'schedule.json');
  fs.writeFileSync(schedule, JSON.stringify({
    enabled: true, timezone: 'Asia/Shanghai', weekdayPeakWindows: ['00:00-00:01'],
    stopNewTasksBeforePeakMinutes: 0, checkpointNoticeMinutes: 5,
    rejectTaskIfBudgetExceedsWindow: false, hardStopAtPeak: true, resumeAutomatically: false
  }));
  const config = path.join(base, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ pool_root: path.join(base, 'pool'), dsh_entry: path.join(rootDir, 'tests', 'mock-dsh.mjs'), schedule_config: schedule, workspace_root: workspace }));
  const input = path.join(base, 'input.json');
  fs.writeFileSync(input, JSON.stringify({ action: 'run', prompt: 'pooled', cwd: workspace, idempotencyKey: 'pool-run-1', timeoutMs: 5000 }));
  const p = spawn(process.execPath, [path.join(rootDir, 'bridges', 'pool', 'exec.mjs'), '--config', config, '--input', input], {
    env: { ...process.env, CODEX_THREAD_ID: child, CODEX_HOME: base }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  p.stdout.on('data', d => stdout += d); p.stderr.on('data', d => stderr += d);
  const code = await new Promise(resolve => p.on('close', resolve));
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout.trim());
  assert.equal(result.status, 'completed');
  assert.match(result.task_id, /^[a-f0-9-]{36}$/);
  assert.ok(!stdout.includes('lease'));
  const state = JSON.parse(fs.readFileSync(path.join(base, 'pool', 'bindings.json'), 'utf8'));
  assert.equal(state.roots[parent].state, 'idle');
  assert.ok(fs.existsSync(state.roots[parent].runtime_path));
});
