import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { configuredRoute, ROUTE, validateTask, redact, dshArgs, TaskManager, preflight } from '../bridges/dsh/core.mjs';
import { mergeBlock, buildPlan, verifyInstallation } from '../scripts/manage.mjs';
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
test('workspace-write default and shell-free argument vector', () => {
  const cwd = temp(), t = validateTask(task(cwd, '中文 " ; & $()'));
  assert.equal(t.permissionMode, 'workspace-write');
  assert.equal(dshArgs(t)[dshArgs(t).indexOf('--permission-mode') + 1], 'workspace-write');
  assert.equal(dshArgs(t).at(-1), '-');
  assert.ok(!dshArgs(t).includes(t.prompt));
});
test('explicit read-only and the installation permission cap are respected', () => {
  const t = task(temp());
  assert.throws(() => validateTask({ ...t, permissionMode: 'workspace-write' }, false), /configured read-only/);
  assert.equal(validateTask(t, false).permissionMode, 'read-only');
  const readOnly = validateTask({ ...t, permissionMode: 'read-only' });
  assert.equal(dshArgs(readOnly)[dshArgs(readOnly).indexOf('--permission-mode') + 1], 'read-only');
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
  assert.equal(result.usesOverride, true);
  assert.equal(result.plan[0].file, path.join(ch, 'AGENTS.override.md'));
  assert.ok(result.plan[0].data.startsWith('Existing override'));
  assert.ok(result.plan.every(item => item.file !== path.join(ch, 'config.toml')));
});
test('DSH registration detects existing unmanaged same-name service', () => {
  const home = temp(), ch = path.join(home, '.codex'); fs.mkdirSync(ch);
  fs.writeFileSync(path.join(ch, 'config.toml'), '[mcp_servers.dsh-opencode-go]\ncommand="old"\n');
  assert.throws(() => buildPlan({ home, codexHome: ch, enableDsh: true, dshEntry: mock }), /already exists/);
});
test('installer applies and verifies the Skill with locally resolvable references, then rolls it back', t => {
  const home = temp(), script = path.join(root, 'scripts', 'manage.mjs');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = (...a) => spawnSync(process.execPath, [script, '--home', home, '--codex-home', path.join(home, '.codex'), ...a], { encoding: 'utf8' });
  const skill = path.join(home, '.agents', 'skills', 'multi-agent-dispatch');
  const agents = path.join(home, '.codex', 'AGENTS.md');
  assert.equal(run().status, 0);
  assert.equal(fs.existsSync(agents), false);
  assert.equal(fs.existsSync(skill), false);
  assert.equal(run('--apply').status, 0);
  assert.match(run('--apply').stdout, /already up to date/);
  const sourceReferences = path.join(root, 'skills', 'multi-agent-dispatch', 'references');
  const references = fs.readdirSync(sourceReferences).filter(name => name.endsWith('.md')).sort();
  const installedFiles = [path.join(skill, 'SKILL.md'), ...references.map(name => path.join(skill, 'references', name))];
  const linked = new Set();
  for (const file of installedFiles) {
    assert.ok(fs.statSync(file).isFile(), file);
    const contents = fs.readFileSync(file, 'utf8');
    for (const match of contents.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)) {
      const link = path.resolve(path.dirname(file), match[1]);
      assert.ok(!path.relative(skill, link).startsWith('..'), `Link escapes installed Skill: ${link}`);
      assert.ok(fs.statSync(link).isFile(), link);
      linked.add(link);
    }
  }
  assert.ok(linked.has(path.join(skill, 'references', 'latex-minimal.md')));
  assert.ok(linked.has(path.join(skill, 'references', 'research-reproducibility.md')));
  const verification = run('--verify');
  assert.equal(verification.status, 0, verification.stderr || verification.stdout);
  assert.equal(JSON.parse(verification.stdout).rules_current, true);

  const backups = path.join(home, '.codex', 'ai-rule-backups');
  const manifest = path.join(backups, fs.readdirSync(backups)[0], 'manifest.json');
  const reference = path.join(skill, 'references', 'research-reproducibility.md');
  const originalReference = fs.readFileSync(reference);
  fs.appendFileSync(reference, '\nA local edit\n');
  const changed = run('--verify');
  assert.equal(changed.status, 1);
  assert.equal(JSON.parse(changed.stdout).rules_current, false);
  assert.match(run('--rollback', manifest).stderr, /Changed since installation/);
  fs.writeFileSync(reference, originalReference);
  const missingReference = path.join(skill, 'references', 'latex-minimal.md');
  const originalMissingReference = fs.readFileSync(missingReference);
  fs.rmSync(missingReference);
  const missing = run('--verify');
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).rules_current, false);
  fs.writeFileSync(missingReference, originalMissingReference);
  assert.equal(run('--rollback', manifest).status, 0);
  assert.equal(fs.existsSync(agents), false);
  for (const file of installedFiles) assert.equal(fs.existsSync(file), false, file);
});
test('installer protects existing Skill reference files and rejects a redirected reference directory', t => {
  const home = temp(), target = temp();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const skill = path.join(home, '.agents', 'skills', 'multi-agent-dispatch');
  const references = path.join(skill, 'references');
  fs.mkdirSync(references, { recursive: true });
  const localReference = path.join(references, 'dsh.md');
  fs.writeFileSync(localReference, 'Existing unrelated reference\n');
  assert.throws(() => buildPlan({ home, codexHome: path.join(home, '.codex') }), /Existing unrelated Skill file/);
  assert.equal(fs.readFileSync(localReference, 'utf8'), 'Existing unrelated reference\n');
  fs.rmSync(references, { recursive: true });
  fs.symlinkSync(target, references, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => buildPlan({ home, codexHome: path.join(home, '.codex') }), /directory without symbolic links/);
  assert.deepEqual(fs.readdirSync(target), []);
});
test('opt-in Sol installer provisions from legacy DSH, preserves services and active runtime, and verifies and rolls back offline', t => {
  const home = temp(), codexHome = path.join(home, '.codex'), cwd = path.join(home, 'approved workspace');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const legacyRuntime = path.join(home, 'legacy dsh runtime');
  for (const directory of [codexHome, cwd, legacyRuntime]) fs.mkdirSync(directory);
  const legacyLock = path.join(legacyRuntime, 'active.lock');
  fs.writeFileSync(legacyLock, 'foreign active task');
  const original = 'model = "keep"\n[profiles.project]\nmodel = "keep-project"\n'
    + '[mcp_servers.deepseek-v4-flash-workbuddy]\ncommand = "keep-workbuddy"\n'
    + '[mcp_servers.deepseek-v4-flash-workbuddy.env]\nLOCAL_ONLY = "dont-print-fixture"\n';
  const calendar = path.join(root, 'config', 'offpeak.schedule.json');
  const dshBridge = path.join(root, 'bridges', 'dsh', 'server.mjs');
  const legacy = '[mcp_servers.dsh-opencode-go]\ncommand = ' + JSON.stringify(process.execPath)
    + '\nargs = ' + JSON.stringify([dshBridge, '--dsh-entry', mock, '--read-only', '--runtime', legacyRuntime, '--schedule-config', calendar]);
  const named = '[mcp_servers.dsh-opencode-go-bravo]\ncommand = "kept"\nargs = '
    + JSON.stringify([dshBridge, '--instance', 'bravo', '--schedule-config', calendar]);
  const originalConfig = mergeBlock(original, legacy + '\n\n' + named, 'toml');
  const configFile = path.join(codexHome, 'config.toml');
  fs.writeFileSync(configFile, originalConfig);
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts', 'manage.mjs'), '--home', home, '--codex-home', codexHome, ...args], {
    encoding: 'utf8', env: { ...process.env, SOL_OPENAI_API_KEY: 'fixture-key-do-not-print' }
  });
  const options = ['--sol-workspace-root', cwd, '--sol-model', 'gpt-6.2-sol', '--sol-reasoning-effort', 'max'];
  const preview = run(...options);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /PLAN ONLY/);
  assert.doesNotMatch(preview.stdout, /dont-print-fixture|fixture-key-do-not-print/);
  const solDir = path.join(codexHome, 'ai-rule-sol');
  assert.equal(fs.existsSync(solDir), false);
  assert.equal(fs.readFileSync(configFile, 'utf8'), originalConfig);
  const applied = run('--apply', ...options);
  assert.equal(applied.status, 0, applied.stderr);
  const installed = fs.readFileSync(configFile, 'utf8');
  assert.ok(installed.startsWith(original));
  assert.ok(installed.includes(legacy));
  assert.ok(installed.includes(named));
  assert.match(installed, /env_vars = \["CODEX_HOME"\]/);
  assert.doesNotMatch(installed, /SOL_OPENAI_API_KEY/);
  assert.doesNotMatch(installed, /fixture-key-do-not-print/);
  const localPool = JSON.parse(fs.readFileSync(path.join(solDir, 'pool.local.json'), 'utf8'));
  assert.equal(localPool.allow_write, false);
  assert.equal(localPool.schedule_config, calendar);
  assert.equal(localPool.dsh_entry, mock);
  assert.notEqual(localPool.pool_root, legacyRuntime);
  assert.match(run('--apply', ...options).stdout, /already up to date/);
  const verify = run('--verify');
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  const checks = JSON.parse(verify.stdout);
  assert.deepEqual(checks.sol_coordinator, { registered: true, managed: true, structure_valid: true });
  assert.equal(checks.live_model_call_performed, false);
  const invalid = installed.replace(/(\[mcp_servers\.sol-coordinator\]\n)command = .+/, '$1command = "wrong-command"');
  fs.writeFileSync(configFile, invalid);
  assert.equal(verifyInstallation({ home, codexHome }).sol_coordinator.structure_valid, false);
  const backups = path.join(codexHome, 'ai-rule-backups');
  const manifest = path.join(backups, fs.readdirSync(backups)[0], 'manifest.json');
  assert.equal(run('--rollback', manifest).status, 1);
  fs.writeFileSync(configFile, installed);
  assert.equal(run('--rollback', manifest).status, 0);
  assert.equal(fs.readFileSync(configFile, 'utf8'), originalConfig);
  assert.equal(fs.readFileSync(legacyLock, 'utf8'), 'foreign active task');
  assert.equal(fs.existsSync(path.join(solDir, 'coordinator.local.json')), false);
  assert.equal(fs.existsSync(path.join(solDir, 'pool.local.json')), false);
});

test('Sol setup reuses an existing approved root-pool and leaves manual coordinator registration alone', t => {
  const home = temp(), codexHome = path.join(home, '.codex'), cwd = path.join(home, 'approved');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(codexHome);
  fs.mkdirSync(cwd);
  const poolFile = path.join(home, 'existing-pool.local.json');
  const poolConfig = { workspace_root: cwd, pool_root: path.join(home, 'pool'), allow_write: false,
    dsh_entry: mock, schedule_config: path.join(root, 'config', 'offpeak.schedule.json') };
  fs.writeFileSync(poolFile, JSON.stringify(poolConfig));
  const poolBridge = path.join(root, 'bridges', 'pool', 'server.mjs');
  const toml = '["mcp_servers" . \'dsh-root-pool\' ]\ncommand = ' + JSON.stringify(process.execPath)
    + '\nargs = [\n  ' + [poolBridge, '--config', poolFile, '--read-only'].map(value => JSON.stringify(value)).join(',\n  ') + ',\n]\n';
  const definition = path.join(codexHome, 'config.toml');
  fs.writeFileSync(definition, toml);
  const planOptions = { home, codexHome, solWorkspaceRoot: cwd, solModel: 'gpt-6.2-sol', solReasoningEffort: 'max' };
  const { plan } = buildPlan(planOptions);
  assert.equal(plan.some(item => item.file.endsWith('pool.local.json')), false);
  const generated = plan.find(item => item.file.endsWith('coordinator.local.json'));
  assert.equal(JSON.parse(generated.data).pool_config, fs.realpathSync(poolFile));
  assert.ok(plan.find(item => item.file === definition).data.startsWith(toml));
  const explicit = path.join(home, 'explicit.local.json');
  fs.writeFileSync(explicit, generated.data);
  const explicitPlan = buildPlan({ home, codexHome, solCoordinatorConfig: explicit });
  assert.equal(explicitPlan.solCoordinatorConfig, fs.realpathSync(explicit));
  assert.equal(explicitPlan.plan.some(item => item.file === explicit), false);
  const legacy = JSON.parse(generated.data);
  delete legacy.openai.credential_source;
  legacy.openai.api_key_env = 'PRIVATE_SOL_API_KEY';
  fs.writeFileSync(explicit, JSON.stringify(legacy));
  const migration = buildPlan({ home, codexHome, solCoordinatorConfig: explicit });
  assert.deepEqual(JSON.parse(migration.plan.find(item => item.file === fs.realpathSync(explicit)).data), JSON.parse(generated.data));
  assert.doesNotMatch(migration.plan.find(item => item.file === definition).data, /PRIVATE_SOL_API_KEY/);
  assert.equal(JSON.parse(fs.readFileSync(explicit)).openai.api_key_env, 'PRIVATE_SOL_API_KEY');
  legacy.openai.project_env = 'SOL_OPENAI_PROJECT_ID';
  fs.writeFileSync(explicit, JSON.stringify(legacy));
  assert.throws(() => buildPlan({ home, codexHome, solCoordinatorConfig: explicit }), /Preserve the existing project/);
  fs.appendFileSync(definition, "\n[ mcp_servers . 'sol-coordinator' ]\ncommand = 'unchanged'\n");
  assert.throws(() => buildPlan(planOptions), /Unmanaged MCP sol-coordinator/);
  assert.match(fs.readFileSync(definition, 'utf8'), /unchanged/);
});
test('Windows PowerShell wrapper forwards Sol preview options without writes', { skip: process.platform !== 'win32' }, t => {
  const home = temp(), codexHome = path.join(home, '.codex-test'), cwd = path.join(home, 'approved workspace');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(cwd);
  const wrapper = path.join(root, 'scripts', 'install.ps1');
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', wrapper,
    '-CodexHome', codexHome, '-SolWorkspaceRoot', cwd, '-DshEntry', mock,
    '-SolModel', 'gpt-6.2-sol', '-SolReasoningEffort', 'max'
  ], { encoding: 'utf8', env: { ...process.env, USERPROFILE: home }, windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  assert.match(result.stdout, /PLAN ONLY/);
  assert.match(result.stdout, /coordinator\.local\.json/);
  assert.match(result.stdout, /No files changed/);
  assert.equal(fs.existsSync(codexHome), false);
  assert.equal(fs.existsSync(path.join(home, '.agents')), false);
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
  const p = spawn(process.execPath, [path.join(root, 'bridges', 'dsh', 'server.mjs'), '--dsh-entry', mock, '--runtime', runtime, '--read-only'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    const list = await rpc('tools/list');
    assert.ok(list.result.tools.some(tool => tool.name === 'set_dsh_task_schedule'));
    const denied = await rpc('tools/call', { name: 'start_dsh_task', arguments: { ...task(cwd), permissionMode: 'workspace-write' } });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /configured read-only/);
    assert.equal(denied.result.structuredContent.error.code, AdmissionCode.PERMISSION_REFUSED);
    assert.equal(denied.result.structuredContent.error.admission_state, 'not_accepted');
    assert.equal(denied.result.structuredContent.error.fallback_eligible, false);
    const start = await rpc('tools/call', { name: 'start_dsh_task', arguments: task(cwd) });
    const id = JSON.parse(start.result.content[0].text).task_id;
    const wait = await rpc('tools/call', { name: 'wait_dsh_task', arguments: { taskId: id, waitMs: 5000 } });
    const receipt = JSON.parse(wait.result.content[0].text);
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.permission_mode, 'read-only');
  } finally { p.stdin.end(); await new Promise(resolve => p.on('close', resolve)); }
});
test('pre-admission failures carry structured codes and admit no task', async () => {
  const cwd = temp();
  const m = new TaskManager({ cli, runtime: temp(), allowWrite: false });
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
    const result = await rpc('tools/call', { name: 'start_dsh_task', arguments: { ...task(cwd), scheduleEnabled: true } });
    assert.equal(result.result.isError, true);
    assert.equal(result.result.structuredContent.error.code, AdmissionCode.SCHEDULE_GATE);
    assert.equal(result.result.structuredContent.error.admission_state, 'not_accepted');
    assert.equal(result.result.structuredContent.error.fallback_eligible, true);
    assert.equal(result.result.structuredContent.error.details.phase, 'peak');
    assert.equal(typeof result.result.structuredContent.error.details.hard_stop_at, 'string');
    const unrestricted = await rpc('tools/call', { name: 'run_dsh_task', arguments: task(cwd, 'ok', 'other-conversation') });
    assert.equal(JSON.parse(unrestricted.result.content[0].text).status, 'completed');
  } finally { p.stdin.end(); await new Promise(resolve => p.on('close', resolve)); }
});

