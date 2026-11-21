import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sha256 } from '../bridges/hy4/policy.mjs';
import { validateSolConfig } from '../bridges/sol/config.mjs';
import { SolService } from '../bridges/sol/service.mjs';
import { WorkBuddyConnection } from '../bridges/sol/workbuddy.mjs';
import { loadProjectConfig, PROJECT_SERVER_ENTRY } from '../bridges/workbuddy/project-config.mjs';
import { allowProjectTool, prepareProjectTask } from '../bridges/workbuddy/project-policy.mjs';
import { WorkBuddyProjectService } from '../bridges/workbuddy/project-service.mjs';
import { buildPlan, verifyInstallation } from '../scripts/manage.mjs';
import { fakeProjectSdk } from './fake-workbuddy-project.mjs';

const filename = relative => fileURLToPath(new URL(relative, import.meta.url));
const model = 'deepseek-v4-flash';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'ai-rule-workbuddy-project-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dirs = { cwd: path.join(base, 'Research'), account: path.join(base, 'ExistingAccount'), home: path.join(base, 'home') };
  const cli = path.join(base, 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-headless.js');
  for (const dir of [...Object.values(dirs), path.dirname(cli)]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cli, '// offline fixture');
  const manifest = {
    schema: 1, workbuddy_cli: cli, cli_sha256: sha256('// offline fixture'), workbuddy_config_dir: dirs.account,
    runtime_dir: path.join(base, 'runtime'), projects: [{ id: 'control-research', root: dirs.cwd, allow_write: true, allow_commands: true }]
  };
  const configPath = path.join(base, 'workbuddy-project.json');
  const saveConfig = changes => fs.writeFileSync(configPath, JSON.stringify({ ...manifest, ...changes }));
  saveConfig({});
  const task = (key, overrides = {}) => ({
    projectId: 'control-research', cwd: dirs.cwd, idempotencyKey: key, permissionMode: 'workspace-write',
    prompt: JSON.stringify({ paper: key }), timeoutMs: 7000, ...overrides
  });
  return { base, ...dirs, cli, manifest, configPath, saveConfig, task };
}

function apiConfig(f) {
  return validateSolConfig({
    state_dir: path.join(f.base, 'coordination'), pool_config: path.join(f.base, 'pool.local.json'),
    openai: { model: 'gpt-6.2-sol', reasoning_effort: 'max', credential_source: 'windows-broker' },
    workbuddy: { project_config: f.configPath }
  }, { poolConfig: {
    pool_root: path.join(f.base, 'pool'), workspace_root: f.cwd, dsh_entry: filename('./mock-dsh.mjs'),
    schedule_config: filename('../config/offpeak.schedule.json'), allow_write: true
  } });
}

function offlineProjectArgs(f) { return [filename('./fake-workbuddy-project.mjs'), f.configPath]; }

test('one stdio project entry accepts two different papers and a subdirectory created after startup', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.configPath, 'utf8');
  const config = apiConfig(f);
  assert.equal(config.workbuddy.args[0], PROJECT_SERVER_ENTRY);
  const connection = new WorkBuddyConnection({ config: { ...config.workbuddy, args: offlineProjectArgs(f) }, sanitize: value => value });
  try {
    async function runPaper(paper) {
      const cwd = path.join(f.cwd, paper);
      fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(cwd, 'paper.m'), paper + ' script');
      fs.writeFileSync(path.join(cwd, 'inputs.csv'), paper + ' data');
      const request = f.task(paper, { cwd, prompt: JSON.stringify({ paper, script: 'paper.m', data: 'inputs.csv', output: 'report.txt' }) });
      const signal = AbortSignal.timeout(9000);
      const args = await connection.prepare(request, signal);
      assert.equal(args.projectId, 'control-research');
      assert.equal(Object.hasOwn(args, 'profile'), false);
      const result = await connection.run(args, signal);
      assert.equal(result.status, 'completed');
      assert.equal(result.configured_model, model);
      assert.equal(fs.readFileSync(path.join(cwd, 'report.txt'), 'utf8'), paper + ': ' + paper + ' script / ' + paper + ' data');
      const again = await connection.run(args, signal);
      assert.equal(again.task_id, result.task_id);
      assert.equal(again.session_id, result.session_id);
      return result;
    }
    const syran = await runPaper('SYRAN');
    const processId = connection.child.pid;
    const shirdel = await runPaper('Shirdel');
    assert.equal(connection.child.pid, processId);
    assert.notEqual(syran.session_id, shirdel.session_id);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), before);
    const signal = AbortSignal.timeout(9000);
    await assert.rejects(connection.prepare(f.task('outside', { cwd: f.base }), signal), /outside the selected approved WorkBuddy project/);
  } finally { await connection.close(); }
});

test('API Sol mode 2 claims and finishes the new WorkBuddy project entry at peak, then uses DSH in the valley', async t => {
  const f = fixture(t);
  const config = apiConfig(f);
  config.workbuddy.args = offlineProjectArgs(f);
  const script = 'new-paper.m';
  const output = 'results.txt';
  fs.writeFileSync(path.join(f.cwd, script), 'fixture script');
  let next = 0;
  let clock = new Date('2026-11-16T02:00:00.000Z');
  const responses = {
    readiness: async () => ({ ready: true }), sanitize: value => String(value),
    async request({ input }) {
      const delegated = input.some(item => item.type === 'function_call_output');
      const options = { plan: 'Run the fixture task', instructions: JSON.stringify({ paper: 'new paper', script, output }) };
      const args = delegated ? { verdict: 'accepted', report: 'Verified the completed fixture receipt.' } : options;
      const id = String(++next);
      return { evidence: { response_id: 'fixture-response-' + id, usage: null }, output: [
        { type: 'function_call', call_id: 'fixture-call-' + id, name: delegated ? 'finish_coordination' : 'delegate_work', arguments: JSON.stringify(args) }
      ] };
    }
  };
  const service = new SolService({ config, responses, clock: () => clock });
  const root = '00000000-0000-4000-8000-000000000609';
  const handoff = {
    backend: 'DSH', cwd: f.cwd, goal: 'Reproduce a new paper within the existing local project',
    permissionMode: 'workspace-write', authorizationNote: 'Existing fixture project grant', acceptance: 'Fixture receipt'
  };
  await service.setMode(root, 'api');
  service.setSchedule(root, 2);
  try {
    const started = await service.start(root, { ...handoff, idempotencyKey: 'new-research-at-peak',
      capability: 'workspace-write', writeScopes: [{ path: f.cwd, operations: ['create'] }] });
    const peak = await service.wait(root, started.idempotency_key, started.task_id, 10000);
    assert.equal(peak.status, 'completed', peak.message);
    assert.equal(peak.executor_backend, 'workbuddy-dsf');
    const [step] = peak.steps;
    const finished = service.pool.workBuddyFor(root).get(step.downstream_idempotency_key);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.workbuddy_dispatch.backend_task_id, step.receipt.task_id);
    assert.equal(fs.readFileSync(path.join(f.cwd, output), 'utf8'), 'new paper: fixture script / ');
    clock = new Date('2026-11-16T04:30:00.000Z');
    const valleyStarted = await service.start(root, { ...handoff, idempotencyKey: 'next-valley-research' });
    const valley = await service.wait(root, valleyStarted.idempotency_key, valleyStarted.task_id, 10000);
    assert.equal(valley.status, 'completed', valley.message);
    assert.equal(valley.executor_backend, 'dsh');
    assert.equal((await service.mode(root)).coordinator_mode, 'api');
    assert.equal(service.schedule(root).mode, 2);
  } finally { await service.close(); }
});

test('project admission rejects link escapes, a read-only grant, and a replaced CLI before a model prompt', async t => {
  const f = fixture(t);
  let prompts = 0;
  const service = new WorkBuddyProjectService({ configPath: f.configPath, sdk: fakeProjectSdk({ onPrompt: () => prompts++ }) });
  const outside = path.join(f.base, 'outside');
  fs.mkdirSync(outside);
  const link = path.join(f.cwd, 'link');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await service.status({ cwd: link })).reason_code, 'WORKBUDDY_PROJECT_OUTSIDE_GRANT');
  await assert.rejects(service.run(f.task('write-through-link', { cwd: link })), { code: 'WORKBUDDY_PROJECT_OUTSIDE_GRANT' });
  f.saveConfig({ projects: [{ id: 'control-research', root: f.cwd }] });
  assert.equal((await service.status({ cwd: f.cwd, permissionMode: 'workspace-write' })).reason_code, 'WORKBUDDY_PROJECT_READ_ONLY');
  assert.equal((await service.status({ cwd: f.cwd })).ready, true);
  fs.writeFileSync(f.cli, '// replaced executable');
  assert.equal((await service.status({ cwd: f.cwd })).reason_code, 'WORKBUDDY_CLI_PIN_MISMATCH');
  assert.equal(prompts, 0);
  assert.throws(() => {
    f.saveConfig({ runtime_dir: path.join(f.cwd, 'runtime') });
    loadProjectConfig(f.configPath);
  }, /separate from bridge config/);
});

test('project callback accepts normal MATLAB and Python launches and rejects outside operands and read-only shell', t => {
  const f = fixture(t);
  const task = prepareProjectTask(loadProjectConfig(f.configPath), f.task('scripts'));
  const dataDir = path.join(f.cwd, 'data');
  fs.mkdirSync(dataDir);
  const program = path.join(f.base, 'Program Files', 'MATLAB', 'bin', 'matlab.exe');
  fs.mkdirSync(path.dirname(program), { recursive: true });
  fs.writeFileSync(program, '');
  const matlab = `& '${program}' -batch "run('paper.m'); disp('done')"`;
  const python = 'python scripts.py --data data/inputs.csv';
  assert.equal(allowProjectTool(task, 'PowerShell', { command: matlab }, f.cwd), true);
  assert.equal(allowProjectTool(task, 'Bash', { command: python }, f.cwd), true);
  assert.equal(allowProjectTool(task, 'Bash', { command: python + ' | tee results' }, f.cwd), false);
  assert.equal(allowProjectTool(task, 'Bash', { command: 'python scripts.py ../outside.csv' }, f.cwd), false);
  assert.equal(allowProjectTool(task, 'Bash', { command: python, run_in_background: true }, f.cwd), false);
  const readonly = prepareProjectTask(loadProjectConfig(f.configPath), f.task('read-only', { permissionMode: 'read-only' }));
  assert.equal(allowProjectTool(readonly, 'PowerShell', { command: matlab }, f.cwd), false);
  assert.equal(allowProjectTool(readonly, 'Write', { file_path: 'out.txt', content: 'x' }, f.cwd), false);
});

test('same-key replay and original session scope survive a second process; an unknown submission retains its lock', async t => {
  const f = fixture(t);
  let prompts = 0;
  const sdk = fakeProjectSdk({ onPrompt: () => prompts++ });
  const first = new WorkBuddyProjectService({ configPath: f.configPath, sdk });
  const otherConnection = new WorkBuddyProjectService({ configPath: f.configPath, sdk });
  const started = first.run(f.task('original'));
  const duplicate = await otherConnection.run(f.task('original'));
  assert.equal(duplicate.replayed, true);
  assert.equal(duplicate.owner, false);
  assert.equal(duplicate.status, 'unknown_after_disconnect');
  const done = await started;
  assert.equal(done.status, 'completed');
  assert.equal(done.task_id, duplicate.task_id);
  assert.equal((await otherConnection.run(f.task('original'))).status, 'completed');
  await assert.rejects(otherConnection.run(f.task('original', { prompt: '{"paper":"different"}' })), { code: 'WORKBUDDY_IDEMPOTENCY_CONFLICT' });
  const revision = await otherConnection.run(f.task('revision', { sessionId: done.session_id }));
  assert.equal(revision.session_id, done.session_id);
  assert.equal((await otherConnection.run(f.task('wrong-scope', { sessionId: done.session_id, permissionMode: 'read-only' }))).reason_code, 'WORKBUDDY_SESSION_SCOPE');
  const unknown = await first.run(f.task('disconnect', { prompt: '{"paper":"paper","disconnect":true}' }));
  assert.equal(unknown.status, 'unknown_after_disconnect');
  assert.equal((await otherConnection.status({ cwd: f.cwd })).reason_code, 'WORKBUDDY_BUSY');
  assert.equal((await otherConnection.run(f.task('new-while-unknown'))).reason_code, 'WORKBUDDY_BUSY');
  assert.equal((await otherConnection.run(f.task('disconnect', { prompt: '{"paper":"paper","disconnect":true}' }))).task_id, unknown.task_id);
  assert.equal(prompts, 3);
});

test('a fixed model missing from the local SDK catalog cannot start a project task', async t => {
  const f = fixture(t);
  let prompts = 0;
  const sdk = fakeProjectSdk({ model: 'deepseek-v4.1-flash', onPrompt: () => prompts++ });
  const service = new WorkBuddyProjectService({ configPath: f.configPath, sdk });
  assert.equal((await service.status({ cwd: f.cwd })).reason_code, 'WORKBUDDY_SDK_MODEL_UNAVAILABLE');
  const result = await service.run(f.task('wrong-model'));
  assert.equal(result.status, 'refused');
  assert.equal(result.reason_code, 'WORKBUDDY_SDK_MODEL_UNAVAILABLE');
  assert.equal(prompts, 0);
});

test('one-time project install replaces only the explicitly selected legacy DSF registration and supports rollback', t => {
  const f = fixture(t);
  const codexHome = path.join(f.home, '.codex');
  fs.mkdirSync(codexHome);
  const localToml = path.join(codexHome, 'config.toml');
  const before = [
    '[mcp_servers.hy4-workbuddy]', 'command = "same-hy4"', '',
    '[ mcp_servers . "deepseek-v4-flash-workbuddy" ]', 'command = "old-dsf"', 'args = ["old-bridge.mjs"]', '',
    '[ mcp_servers . "deepseek-v4-flash-workbuddy" . env ]', 'WB_MODEL = "deepseek-v4-flash"', '',
    '# This comment belongs to DSH.', '[mcp_servers.dsh-opencode-go]', 'command = "same-dsh"', '',
    '# BEGIN isheach/ai_rule managed', '[mcp_servers.another-managed]', 'command = "same-managed"', '# END isheach/ai_rule managed', ''
  ].join('\n');
  fs.writeFileSync(localToml, before);
  const options = { home: f.home, codexHome, workbuddyProjectConfig: f.configPath };
  assert.throws(() => buildPlan(options), /explicit --replace-workbuddy-dsf/);
  const plan = buildPlan({ ...options, replaceWorkBuddyDsf: true }).plan.find(item => item.file === localToml);
  assert.match(plan.data, /project-server\.mjs/);
  assert.doesNotMatch(plan.data, /old-dsf|old-bridge|WB_MODEL/);
  assert.match(plan.data, /# This comment belongs to DSH\.\n\[mcp_servers\.dsh-opencode-go\]\ncommand = "same-dsh"/);
  assert.match(plan.data, /command = "same-hy4"/);
  assert.match(plan.data, /command = "same-managed"/);
  assert.equal(fs.readFileSync(localToml, 'utf8'), before);
  const install = (...args) => spawnSync(process.execPath, [filename('../scripts/manage.mjs'),
    '--home', f.home, '--codex-home', codexHome, ...args], { encoding: 'utf8' });
  const applied = install('--workbuddy-project-config', f.configPath, '--replace-workbuddy-dsf', '--apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(verifyInstallation(options).workbuddy_dsf_project.structure_valid, true);
  const backups = fs.readdirSync(path.join(codexHome, 'ai-rule-backups'));
  const restored = install('--rollback', path.join(codexHome, 'ai-rule-backups', backups[0], 'manifest.json'));
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(fs.readFileSync(localToml, 'utf8'), before);
  fs.writeFileSync(localToml, 'mcp_servers.deepseek-v4-flash-workbuddy.command = "inline"\n');
  assert.throws(() => buildPlan({ ...options, replaceWorkBuddyDsf: true }), /unsupported TOML form/);
});
