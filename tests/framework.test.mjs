import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { configuredRoute, ROUTE, validateTask, redact, dshArgs, TaskManager, preflight } from '../bridges/dsh/core.mjs';
import { mergeBlock, buildPlan } from '../scripts/manage.mjs';
import { AdmissionCode, PreAdmissionRejection } from '../bridges/dsh/routing.mjs';
import { validateSchedule } from '../bridges/dsh/schedule.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mock = path.join(root, 'tests', 'mock-dsh.mjs');
const cli = { command: process.execPath, prefix: [mock] };
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-rule-test-'));
const task = (cwd, prompt = 'ok', key = 'test-1') => ({ cwd, prompt, idempotencyKey: key, timeoutMs: 1000 });

test('route parser ignores unrelated web search route', () => {
  assert.deepEqual(configuredRoute("- id: agent-default-model\n  config:\n    provider: opencode-go\n    model: deepseek-v4.1-flash\n    reasoningEffort: max\n- id: web\n  config:\n    searchProvider: deepseek-official"), ROUTE);
  assert.throws(() => configuredRoute('- id: something-else'), /Cannot locate/);
});
test('preflight checks mock CLI flags and route without paid call', () => { assert.equal(preflight(cli).configured_route.provider, 'opencode-go'); });
test('read-only default and shell-free argument vector', () => {
  const cwd = temp(), t = validateTask(task(cwd, '中文 " ; & $()'));
  assert.equal(t.permissionMode, 'read-only'); assert.equal(dshArgs(t).at(-1), '-');
  assert.ok(!dshArgs(t).includes(t.prompt));
});
test('write permission has two gates and rejects unsupported modes', () => {
  const t = { ...task(temp()), permissionMode: 'workspace-write', authorizationNote: 'user-approved-test' };
  assert.throws(() => validateTask(t), /local --allow-write/);
  assert.equal(validateTask(t, true).permissionMode, 'workspace-write');
  assert.throws(() => validateTask({ ...t, authorizationNote: '' }, true));
  assert.throws(() => validateTask({ ...t, permissionMode: 'auto' }, true));
});
test('task input rejects relative directories, unknown keys and invalid timeout', () => {
  const t = task(temp());
  assert.throws(() => validateTask({ ...t, cwd: '.' }));
  assert.throws(() => validateTask({ ...t, timeoutMs: 0 }));
  assert.throws(() => validateTask({ ...t, model: 'another-model' }));
});
test('redaction removes recognizable keys and bearer headers', () => {
  assert.ok(!redact('sk-abcdefghijklmnop Bearer abcdefg ?token=abcde').includes('abcdefghijklmnop'));
  assert.ok(!redact('Bearer abcdefg').includes('abcdefg'));
});
test('managed block merge is idempotent and preserves existing settings', () => {
  const input = 'model = "keep-me"\n[mcp_servers.old]\ncommand = "keep"\n';
  const a = mergeBlock(input, '[mcp_servers.new]\ncommand = "new"', 'toml');
  assert.equal(mergeBlock(a, '[mcp_servers.new]\ncommand = "new"', 'toml'), a);
  assert.ok(a.startsWith(input));
  assert.throws(() => mergeBlock('# BEGIN isheach/ai_rule managed\n', '', 'toml'));
});
test('installer respects active global override and does not alter native models', () => {
  const home = temp(), ch = path.join(home, '.codex'); fs.mkdirSync(ch);
  fs.writeFileSync(path.join(ch, 'AGENTS.override.md'), 'Existing override\n');
  fs.writeFileSync(path.join(ch, 'config.toml'), 'model = "local-model"\n');
  const result = buildPlan({ home, codexHome: ch });
  assert.equal(result.usesOverride, true); assert.equal(result.plan.length, 2);
  assert.ok(result.plan[0].data.startsWith('Existing override'));
});
test('DSH registration detects existing unmanaged same-name service', () => {
  const home = temp(), ch = path.join(home, '.codex'); fs.mkdirSync(ch);
  fs.writeFileSync(path.join(ch, 'config.toml'), '[mcp_servers.dsh-opencode-go]\ncommand="old"\n');
  assert.throws(() => buildPlan({ home, codexHome: ch, enableDsh: true, dshEntry: mock }), /already exists/);
});
test('installer preview, apply, idempotence and safe rollback', () => {
  const home = temp(), script = path.join(root, 'scripts', 'manage.mjs');
  const run = (...a) => spawnSync(process.execPath, [script, '--home', home, ...a], { encoding: 'utf8' });
  assert.equal(run().status, 0); assert.ok(!fs.existsSync(path.join(home, '.codex', 'AGENTS.md')));
  assert.equal(run('--apply').status, 0); assert.match(run('--apply').stdout, /already up to date/);
  const backups = path.join(home, '.codex', 'ai-rule-backups');
  const manifest = path.join(backups, fs.readdirSync(backups)[0], 'manifest.json');
  assert.equal(run('--rollback', manifest).status, 0);
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'AGENTS.md')));
});
test('completed receipt, tool count, no thinking/tool payload logs, idempotence', async () => {
  const cwd = temp(), runtime = temp(); const m = new TaskManager({ cli, runtime });
  const a = await m.start(task(cwd)); const result = await m.wait(a.task_id, 5000);
  assert.equal(result.status, 'completed'); assert.equal(result.native_tool_calls, 1); assert.equal(result.actual_route, null);
  const log = fs.readFileSync(result.receipt_path, 'utf8'); assert.ok(!log.includes('MOCK-REASONING')); assert.ok(!log.includes('MOCK-TOOL-'));
  assert.equal((await m.start(task(cwd))).task_id, a.task_id);
  await assert.rejects(m.start(task(cwd, 'other')), /different arguments/);
});
test('exit 0 without completed final is not success', async () => {
  for (const prompt of ['fail', 'nofinal']) {
    const m = new TaskManager({ cli, runtime: temp() }); const a = await m.start(task(temp(), prompt));
    assert.equal((await m.wait(a.task_id, 5000)).status, 'failed');
  }
});
test('timeout kills worker and clears owned lock', async () => {
  const runtime = temp(); const m = new TaskManager({ cli, runtime });
  const a = await m.start(task(temp(), 'hang')); const result = await m.wait(a.task_id, 5000);
  assert.equal(result.status, 'timed_out'); assert.ok(!fs.existsSync(path.join(runtime, 'active.lock')));
});
test('explicit cancel, busy protection and cross-process lock refusal', async () => {
  const runtime = temp(), cwd = temp(); const m = new TaskManager({ cli, runtime });
  const a = await m.start({ ...task(cwd, 'hang'), timeoutMs: 10000 });
  await assert.rejects(m.start(task(cwd, 'ok', 'other')), /busy/);
  const other = new TaskManager({ cli, runtime }); await assert.rejects(other.start(task(cwd, 'ok', 'other')), /lock exists/);
  m.cancel(a.task_id); assert.equal((await m.wait(a.task_id, 5000)).status, 'cancelled');
});
test('stdio MCP initialize, list, call and asynchronous wait', async () => {
  const runtime = temp(), cwd = temp();
  const p = spawn(process.execPath, [path.join(root, 'bridges', 'dsh', 'server.mjs'), '--dsh-entry', mock, '--runtime', runtime], { stdio: ['pipe', 'pipe', 'pipe'] });
  let seq = 0, buffer = ''; const pending = new Map();
  p.stdout.setEncoding('utf8'); p.stdout.on('data', data => { buffer += data; let pos; while ((pos = buffer.indexOf('\n')) >= 0) { const v = JSON.parse(buffer.slice(0, pos)); buffer = buffer.slice(pos + 1); pending.get(v.id)?.(v); pending.delete(v.id); } });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => reject(Error('MCP test timeout')), 10000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'dsh-opencode-go');
    const list = await rpc('tools/list'); assert.equal(list.result.tools.length, 7);
    const denied = await rpc('tools/call', { name: 'start_dsh_task', arguments: { ...task(cwd), permissionMode: 'workspace-write' } });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /Workspace writes require/);
    assert.equal(denied.result.structuredContent.error.code, AdmissionCode.PERMISSION_REFUSED);
    assert.equal(denied.result.structuredContent.error.admission_state, 'not_accepted');
    assert.equal(denied.result.structuredContent.error.fallback_eligible, false);
    const start = await rpc('tools/call', { name: 'start_dsh_task', arguments: task(cwd) });
    const id = JSON.parse(start.result.content[0].text).task_id;
    const wait = await rpc('tools/call', { name: 'wait_dsh_task', arguments: { taskId: id, waitMs: 5000 } });
    assert.equal(JSON.parse(wait.result.content[0].text).status, 'completed');
  } finally { p.stdin.end(); await new Promise(resolve => p.on('close', resolve)); }
});
test('pre-admission failures carry structured codes and admit no task', async () => {
  const cwd = temp();
  const m = new TaskManager({ cli, runtime: temp() });
  await assert.rejects(m.start({ ...task(cwd), permissionMode: 'workspace-write', authorizationNote: 'ref' }), e =>
    e instanceof PreAdmissionRejection && e.code === AdmissionCode.PERMISSION_REFUSED && e.admission_state === 'not_accepted' && e.fallback_eligible === false);

  const peak = new TaskManager({
    cli, runtime: temp(),
    schedule: validateSchedule({ enabled: true, weekdayPeakWindows: ['09:00-12:00', '14:00-18:00'] }),
    clock: () => new Date('2026-11-13T02:00:00.000Z')
  });
  await assert.rejects(peak.start(task(cwd, 'ok', 'peak-1')), e =>
    e.code === AdmissionCode.SCHEDULE_GATE && e.details.phase === 'peak' && e.fallback_eligible === true);
  assert.ok(!fs.existsSync(path.join(peak.runtime, 'active.lock')));

  const masked = new TaskManager({
    cli, runtime: temp(),
    schedule: validateSchedule({ enabled: true, weekdayPeakWindows: ['09:00-12:00', '14:00-18:00'] }),
    clock: () => new Date('2026-11-13T02:00:00.000Z')
  });
  const foreignLock = path.join(masked.runtime, 'active.lock');
  fs.writeFileSync(foreignLock, JSON.stringify({ schema: 1, owner_pid: 999999, task_id: 'foreign-live', started_at: new Date().toISOString() }));
  await assert.rejects(masked.start(task(cwd, 'ok', 'lock-mask')), e =>
    e.code === AdmissionCode.LOCKED && e.fallback_eligible === false && e.details.owner_task_id === 'foreign-live');
  assert.ok(fs.existsSync(foreignLock));
  assert.equal(fs.readFileSync(foreignLock, 'utf8').includes('foreign-live'), true);

  const busy = new TaskManager({ cli, runtime: temp() });
  const active = await busy.start({ ...task(cwd, 'hang', 'busy-1'), timeoutMs: 10000 });
  await assert.rejects(busy.start(task(cwd, 'ok', 'busy-2')), e =>
    e.code === AdmissionCode.BUSY && e.details.active_task_id === active.task_id && e.fallback_eligible === false);
  busy.cancel(active.task_id);
  assert.equal((await busy.wait(active.task_id, 5000)).status, 'cancelled');
});
test('live mock MCP schedule rejection carries safe structured metadata', {
  skip: (() => {
    const local = new Date(Date.now() + 8 * 3600e3);
    const day = local.getUTCDay(), minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
    return day === 0 || day === 6 || minutes >= 23 * 60 + 58;
  })()
}, async () => {
  const runtime = temp(), cwd = temp();
  const scheduleFile = path.join(temp(), 'schedule.json');
  fs.writeFileSync(scheduleFile, JSON.stringify({
    enabled: true, stopNewTasksBeforePeakMinutes: 0, weekdayPeakWindows: ['00:00-23:59']
  }));
  const p = spawn(process.execPath, [path.join(root, 'bridges', 'dsh', 'server.mjs'), '--dsh-entry', mock,
    '--runtime', runtime, '--schedule-config', scheduleFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  let seq = 0, buffer = ''; const pending = new Map();
  p.stdout.setEncoding('utf8'); p.stdout.on('data', data => {
    buffer += data; let pos;
    while ((pos = buffer.indexOf('\n')) >= 0) {
      const v = JSON.parse(buffer.slice(0, pos)); buffer = buffer.slice(pos + 1);
      pending.get(v.id)?.(v); pending.delete(v.id);
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => reject(Error('MCP test timeout')), 10000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const result = await rpc('tools/call', { name: 'start_dsh_task', arguments: task(cwd) });
    assert.equal(result.result.isError, true);
    assert.equal(result.result.structuredContent.error.code, AdmissionCode.SCHEDULE_GATE);
    assert.equal(result.result.structuredContent.error.admission_state, 'not_accepted');
    assert.equal(result.result.structuredContent.error.fallback_eligible, true);
    assert.equal(result.result.structuredContent.error.details.phase, 'peak');
    assert.equal(typeof result.result.structuredContent.error.details.hard_stop_at, 'string');
  } finally { p.stdin.end(); await new Promise(resolve => p.on('close', resolve)); }
});

