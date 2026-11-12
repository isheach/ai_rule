import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { TaskManager, runtimeDefault, runtimeForInstance, serverNameForInstance, validateInstanceName, validateTask, pathKey } from '../bridges/dsh/core.mjs';
import { validateSchedule, OFFPEAK_DEFAULT } from '../bridges/dsh/schedule.mjs';
import { buildPlan, verifyInstallation } from '../scripts/manage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mock = path.join(root, 'tests', 'mock-dsh.mjs');
const cli = { command: process.execPath, prefix: [mock] };
const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), `ai-rule-${prefix}-`));
const task = (cwd, prompt = 'ok', key = 'test-1') => ({ cwd, prompt, idempotencyKey: key, timeoutMs: 5000 });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

test('instance names have stable, distinct runtimes and reject Windows aliases', () => {
  assert.equal(runtimeForInstance('default'), runtimeDefault());
  assert.notEqual(pathKey(runtimeForInstance('alpha')), pathKey(runtimeForInstance('bravo')));
  assert.equal(serverNameForInstance('alpha'), 'dsh-opencode-go-alpha');
  for (const bad of ['Alpha', 'default', 'con', 'lpt1', 'alpha.', '-alpha', 'alpha-', 'a b', '']) assert.throws(() => validateInstanceName(bad));
  assert.equal(validateInstanceName('a'), 'a');
  assert.equal(validateInstanceName('alpha-2'), 'alpha-2');
});

test('one runtime cannot be shared by two named instances, including path aliases', () => {
  const runtime = temp('identity');
  const manager = new TaskManager({ cli, runtime, instance: 'alpha' });
  assert.equal(manager.status().instance, 'alpha');
  assert.equal(manager.status().mcp_server_name, 'dsh-opencode-go-alpha');
  assert.throws(() => new TaskManager({ cli, runtime: path.join(runtime, '.'), instance: 'bravo' }), /belongs to DSH instance "alpha"/);
  const same = new TaskManager({ cli, runtime: path.join(runtime, '.'), instance: 'alpha' });
  assert.equal(pathKey(same.runtime), pathKey(manager.runtime));
  if (process.platform === 'win32') {
    assert.throws(() => new TaskManager({ cli, runtime: runtime.toUpperCase(), instance: 'bravo' }), /belongs to DSH instance "alpha"/);
  }
});

test('independent instances run mock DSH children with overlapping lifetimes', async () => {
  const check = () => ({ version: 'mock', configured_route: {} });
  const alpha = new TaskManager({ cli, runtime: temp('parallel-a'), instance: 'alpha', check });
  const bravo = new TaskManager({ cli, runtime: temp('parallel-b'), instance: 'bravo', check });
  const [a, b] = await Promise.all([
    alpha.start(task(temp('cwd-a'), 'sleep:800', 'parallel-a')),
    bravo.start(task(temp('cwd-b'), 'sleep:800', 'parallel-b'))
  ]);
  const [af, bf] = await Promise.all([alpha.wait(a.task_id, 5000), bravo.wait(b.task_id, 5000)]);
  assert.equal(af.status, 'completed');
  assert.equal(bf.status, 'completed');
  assert.equal(af.instance, 'alpha');
  assert.equal(bf.instance, 'bravo');
  assert.notEqual(af.task_id, bf.task_id);
  assert.notEqual(af.pid, bf.pid);
  assert.ok(Date.parse(af.finished_at) >= Date.parse(bf.started_at) && Date.parse(bf.finished_at) >= Date.parse(af.started_at), 'child lifetimes did not overlap');
  assert.equal(fs.existsSync(path.join(alpha.runtime, 'active.lock')), false);
  assert.equal(fs.existsSync(path.join(bravo.runtime, 'active.lock')), false);
});

test('same idempotency key is isolated across instances and idempotent inside one', async () => {
  const alpha = new TaskManager({ cli, runtime: temp('key-a'), instance: 'alpha' });
  const bravo = new TaskManager({ cli, runtime: temp('key-b'), instance: 'bravo' });
  const at = task(temp('key-cwd-a'), 'ok', 'shared-key');
  const bt = task(temp('key-cwd-b'), 'ok', 'shared-key');
  const [a, b] = [await alpha.start(at), await bravo.start(bt)];
  assert.notEqual(a.task_id, b.task_id);
  assert.equal((await alpha.start(at)).task_id, a.task_id);
  await assert.rejects(bravo.start({ ...bt, prompt: 'different work' }), /different arguments/);
  assert.equal((await alpha.wait(a.task_id, 5000)).status, 'completed');
  assert.equal((await bravo.wait(b.task_id, 5000)).status, 'completed');
});

test('foreign task IDs cannot be read, waited on or cancelled in another instance', async () => {
  const alpha = new TaskManager({ cli, runtime: temp('foreign-a'), instance: 'alpha' });
  const bravo = new TaskManager({ cli, runtime: temp('foreign-b'), instance: 'bravo' });
  const record = await alpha.start({ ...task(temp('foreign-cwd'), 'hang', 'foreign-1'), timeoutMs: 10000 });
  assert.throws(() => bravo.get(record.task_id), /not found in DSH instance "bravo"/);
  assert.throws(() => bravo.cancel(record.task_id), /not found in DSH instance "bravo"/);
  await assert.rejects(bravo.wait(record.task_id, 0), /not found in DSH instance "bravo"/);
  assert.equal(alpha.get(record.task_id).status, 'running');
  alpha.cancel(record.task_id);
  assert.equal((await alpha.wait(record.task_id, 5000)).status, 'cancelled');
});

test('a non-owning bridge can read a disconnected receipt but cannot cancel or duplicate it', async () => {
  const runtime = temp('disconnect');
  const owner = new TaskManager({ cli, runtime, instance: 'alpha' });
  const record = await owner.start({ ...task(temp('disconnect-cwd'), 'hang', 'disconnect-1'), timeoutMs: 10000 });
  const observer = new TaskManager({ cli, runtime, instance: 'alpha' });
  const seen = observer.get(record.task_id);
  assert.equal(seen.status, 'unknown_after_disconnect');
  assert.match(seen.warning, /does not own this task/);
  assert.equal(observer.cancel(record.task_id).status, 'unknown_after_disconnect');
  await assert.rejects(observer.start({ ...task(temp('disconnect-other'), 'ok', 'disconnect-2') }), /Exclusive lock exists/);
  assert.equal(owner.get(record.task_id).status, 'running');
  owner.cancel(record.task_id);
  assert.equal((await owner.wait(record.task_id, 5000)).status, 'cancelled');
});

test('legacy default receipts and idempotency files remain readable and replayable', async () => {
  const runtime = temp('legacy'), cwd = temp('legacy-cwd'), id = crypto.randomUUID(), key = 'legacy-key';
  const validated = validateTask(task(cwd, 'ok', key));
  const receipt = {
    task_id: id, backend: 'dsh', status: 'completed', cwd: validated.cwd, session_id: 'legacy-session',
    started_at: '2026-11-01T00:00:00.000Z', finished_at: '2026-11-01T00:00:01.000Z', native_tool_calls: 0
  };
  fs.mkdirSync(path.join(runtime, id), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'requests'), { recursive: true });
  fs.writeFileSync(path.join(runtime, id, 'RUN_RECEIPT.json'), JSON.stringify(receipt));
  fs.writeFileSync(path.join(runtime, 'requests', `${digest(key)}.json`), JSON.stringify({ task_id: id, fingerprint: digest(JSON.stringify(validated)) }));
  const manager = new TaskManager({ cli, runtime });
  const read = manager.get(id);
  assert.equal(read.instance, 'default');
  assert.equal(read.instance_source, 'legacy_default');
  assert.equal(read.status, 'completed');
  const replay = await manager.start(task(cwd, 'ok', key));
  assert.equal(replay.task_id, id);
  assert.equal(manager.get(id).task_id, id);
});

test('session resume is confined to the owning instance and cwd', async () => {
  const cwd = temp('session-cwd'), manager = new TaskManager({ cli, runtime: temp('session-a'), instance: 'alpha' });
  const first = await manager.start(task(cwd, 'ok', 'session-1'));
  const firstFinal = await manager.wait(first.task_id, 5000);
  const sessionId = firstFinal.session_id;
  assert.ok(sessionId);
  const other = new TaskManager({ cli, runtime: temp('session-b'), instance: 'bravo' });
  await assert.rejects(other.start({ ...task(cwd, 'ok', 'session-2'), sessionId }), /Unknown sessionId|another DSH instance/);
  assert.equal(fs.existsSync(path.join(other.runtime, 'active.lock')), false);
  await assert.rejects(manager.start({ ...task(temp('session-other-cwd'), 'ok', 'session-3'), sessionId }), /bound to cwd/);
  await assert.rejects(manager.start({ ...task(cwd, 'ok', 'session-4'), sessionId: 'invented-session' }), /Unknown sessionId/);
  const resumed = await manager.start({ ...task(cwd, 'ok', 'session-5'), sessionId });
  const resumedFinal = await manager.wait(resumed.task_id, 5000);
  assert.equal(resumedFinal.status, 'completed');
  assert.equal(resumedFinal.session_id, sessionId);
  assert.equal(resumedFinal.session_resume, true);
});

test('peak admission and budget checks are evaluated per instance', async () => {
  const cfg = validateSchedule(OFFPEAK_DEFAULT);
  const peak = new TaskManager({ cli, runtime: temp('peak'), instance: 'peak', schedule: cfg, clock: () => new Date('2026-11-09T01:30:00Z') });
  const free = new TaskManager({ cli, runtime: temp('free'), instance: 'free' });
  await assert.rejects(peak.start(task(temp('peak-cwd'), 'ok', 'peak-1')), /blocked by the offpeak schedule/);
  const result = await free.start(task(temp('free-cwd'), 'ok', 'free-1'));
  assert.equal((await free.wait(result.task_id, 5000)).status, 'completed');
  const budget = new TaskManager({ cli, runtime: temp('budget'), instance: 'budget', schedule: cfg, clock: () => new Date('2026-11-09T00:47:00Z') });
  await assert.rejects(budget.start({ ...task(temp('budget-cwd'), 'ok', 'budget-1'), timeoutMs: 720000 }), /budget|window/);
});

test('a scheduled hard stop terminates only that instance child', async () => {
  const cfg = validateSchedule(OFFPEAK_DEFAULT);
  const begin = Date.now(), base = Date.parse('2026-11-09T00:00:00Z');
  const clock = () => new Date(base + (Date.now() - begin) * 300000);
  const scheduled = new TaskManager({ cli, runtime: temp('stop-a'), instance: 'scheduled', schedule: cfg, clock, scheduleTickMs: 5 });
  const free = new TaskManager({ cli, runtime: temp('stop-b'), instance: 'free' });
  const a = await scheduled.start({ ...task(temp('stop-cwd-a'), 'hang', 'stop-1'), timeoutMs: 10000 });
  const b = await free.start({ ...task(temp('stop-cwd-b'), 'hang', 'stop-2'), timeoutMs: 10000 });
  const stopped = await scheduled.wait(a.task_id, 4000);
  assert.equal(stopped.status, 'schedule_stopped');
  assert.equal(stopped.stop_reason, 'scheduled_peak');
  assert.equal(free.get(b.task_id).status, 'running');
  free.cancel(b.task_id);
  assert.equal((await free.wait(b.task_id, 5000)).status, 'cancelled');
});

test('installer adds named services and preserves legacy managed and unmanaged services', () => {
  const home = temp('installer'), ch = path.join(home, '.codex'); fs.mkdirSync(ch);
  fs.writeFileSync(path.join(ch, 'config.toml'), [
    'model = "keep"',
    '',
    '# BEGIN isheach/ai_rule managed',
    '[mcp_servers.hy4-workbuddy]',
    'command = "old"',
    '# END isheach/ai_rule managed',
    '',
    '[mcp_servers.unrelated]',
    'command = "keep"',
    ''
  ].join('\n'));
  const built = buildPlan({ home, codexHome: ch, enableDsh: true, dshEntry: mock, offpeakSchedule: true, dshInstances: ['alpha', 'bravo'] });
  const config = built.plan.find(x => x.file === path.join(ch, 'config.toml')).data;
  assert.ok(config.includes('[mcp_servers.dsh-opencode-go]'));
  assert.ok(config.includes('[mcp_servers.dsh-opencode-go-alpha]'));
  assert.ok(config.includes('[mcp_servers.dsh-opencode-go-bravo]'));
  assert.ok(config.includes('[mcp_servers.hy4-workbuddy]'));
  assert.ok(config.includes('[mcp_servers.unrelated]'));
  assert.equal((config.match(/\[mcp_servers\.dsh-opencode-go\]/g) || []).length, 1);
  const script = path.join(root, 'scripts', 'manage.mjs');
  const run = spawnSync(process.execPath, [script, '--home', home, '--enable-dsh', '--dsh-instance', 'alpha', '--dsh-instance', 'bravo', '--dsh-entry', mock, '--offpeak-schedule', '--apply'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const checks = verifyInstallation({ home, codexHome: ch });
  assert.equal(checks.dsh_instance_count, 3);
  assert.equal(checks.dsh_instances_unique, true);
  assert.equal(checks.dsh_runtimes_unique, true);
  assert.equal(checks.dsh_instance_identity_valid, true);
  assert.equal(checks.dsh_schedule_consistent, true);
  assert.equal(checks.dsh_schedule_config_valid, true);
  assert.equal(checks.dsh_structure_valid, true);
  assert.deepEqual(checks.dsh_instances.map(x => x.instance), ['default', 'alpha', 'bravo']);
  const removed = buildPlan({ home, codexHome: ch, removeDshInstances: ['alpha'] });
  const withoutAlpha = removed.plan.find(x => x.file === path.join(ch, 'config.toml')).data;
  assert.ok(!withoutAlpha.includes('[mcp_servers.dsh-opencode-go-alpha]'));
  assert.ok(withoutAlpha.includes('[mcp_servers.dsh-opencode-go-bravo]'));
  assert.ok(withoutAlpha.includes('[mcp_servers.dsh-opencode-go]'));
  assert.ok(withoutAlpha.includes('[mcp_servers.unrelated]'));
  assert.throws(() => buildPlan({ home, codexHome: ch, enableDsh: true, dshEntry: mock, dshInstances: ['alpha', 'alpha'] }), /Duplicate/);
  assert.throws(() => buildPlan({ home, codexHome: ch, enableDsh: true, dshEntry: mock, dshInstances: ['Alpha'] }), /lowercase/);
  assert.throws(() => buildPlan({ home, codexHome: ch, removeDshInstances: ['missing'] }), /not registered/);
});

test('adding a named instance preserves the existing default runtime, write flag and custom schedule', () => {
  const home = temp('preserve'), ch = path.join(home, '.codex'); fs.mkdirSync(ch);
  const customRuntime = path.join(home, 'legacy-runtime');
  const customSchedule = path.join(home, 'custom.schedule.json');
  fs.writeFileSync(customSchedule, '{}');
  const defaultArgs = [path.join(root, 'bridges', 'dsh', 'server.mjs'), '--dsh-entry', mock, '--allow-write', '--runtime', customRuntime, '--schedule-config', customSchedule];
  fs.writeFileSync(path.join(ch, 'config.toml'), [
    'model = "keep"',
    '# BEGIN isheach/ai_rule managed',
    '[mcp_servers.dsh-opencode-go]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify(defaultArgs)}`,
    'enabled = true',
    '[mcp_servers.hy4-workbuddy]',
    'command = "old"',
    '# END isheach/ai_rule managed',
    ''
  ].join('\n'));
  const built = buildPlan({ home, codexHome: ch, enableDsh: true, dshEntry: mock, dshInstances: ['alpha'] });
  const config = built.plan.find(x => x.file === path.join(ch, 'config.toml')).data;
  assert.ok(config.includes(JSON.stringify(defaultArgs)), 'default registration was rewritten');
  assert.ok(config.includes('--runtime') && config.includes(JSON.stringify(customRuntime)));
  assert.ok(config.includes('--allow-write'));
  assert.ok(config.includes(JSON.stringify(customSchedule)));
  const alphaLine = config.split('\n').find(line => line.includes('dsh-opencode-go-alpha')) || '';
  assert.match(alphaLine, /dsh-opencode-go-alpha/);
  assert.ok(config.includes('"--instance","alpha"'));
  assert.ok(config.includes('--schedule-config'));
  const alphaSection = config.split(/(?=^\[mcp_servers\.[^\].]+\]\s*$)/m).find(section => section.includes('[mcp_servers.dsh-opencode-go-alpha]')) || '';
  assert.ok(!alphaSection.includes('--allow-write'), 'new named instance should stay read-only by default');
  const defaultPlan = built.dshInstances.find(x => x.instance === 'default');
  assert.equal(defaultPlan.preserved, true);
  assert.equal(pathKey(defaultPlan.runtime), pathKey(customRuntime));
  assert.throws(() => buildPlan({ home, codexHome: ch, enableDsh: true, dshEntry: mock, dshInstances: ['bravo'], offpeakSchedule: true }), /must not silently rewrite/);
});

test('a named stdio MCP process exposes its instance identity and scoped status', async () => {
  const runtime = temp('mcp'); const p = spawn(process.execPath, [path.join(root, 'bridges', 'dsh', 'server.mjs'), '--dsh-entry', mock, '--runtime', runtime, '--instance', 'echo'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let seq = 0, buffer = ''; const pending = new Map();
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', data => { buffer += data; let pos; while ((pos = buffer.indexOf('\n')) >= 0) { const v = JSON.parse(buffer.slice(0, pos)); buffer = buffer.slice(pos + 1); pending.get(v.id)?.(v); pending.delete(v.id); } });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => reject(Error('MCP test timeout')), 10000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'dsh-opencode-go-echo');
    assert.equal(init.result.serverInfo.instance, 'echo');
    assert.equal(init.result.serverInfo.version, '0.3.0');
    const status = JSON.parse((await rpc('tools/call', { name: 'get_dsh_bridge_status', arguments: {} })).result.content[0].text);
    assert.equal(status.instance, 'echo');
    assert.equal(status.mcp_server_name, 'dsh-opencode-go-echo');
    assert.equal(status.max_concurrency, 1);
    assert.equal(status.lock_present, false);
  } finally { p.stdin.end(); await new Promise(resolve => p.on('close', resolve)); }
});
