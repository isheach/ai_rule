import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveDispatch } from '../bridges/dispatch.mjs';
import { issueContext } from '../bridges/pool/context.mjs';
import { validateSolConfig } from '../bridges/sol/config.mjs';
import { ResponsesClient } from '../bridges/sol/responses.mjs';
import { SolService } from '../bridges/sol/service.mjs';
import { solEnvironmentNames } from '../scripts/sol-install.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const fixtureBinary = fileURLToPath(new URL('./fake-antigravity.mjs', import.meta.url));
const root = '00000000-0000-4000-8000-000000000720';
const otherRoot = '00000000-0000-4000-8000-000000000721';

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'ai-rule-agy-test-'));
  const cwd = path.join(dir, 'project');
  const agyRuntime = path.join(dir, 'agy');
  const modelsFile = path.join(dir, 'models.json');
  const eventsFile = path.join(dir, 'events.jsonl');
  fs.mkdirSync(cwd);
  fs.mkdirSync(agyRuntime);
  const enterprise = options.enterprise === true;
  const auth = enterprise ? 'enterprise-adc' : 'gemini-api-key';
  const adcFile = path.join(dir, 'mock-adc.json');
  if (enterprise) fs.writeFileSync(adcFile, '{}');
  const writeModelSettings = defaultAlias => fs.writeFileSync(modelsFile, JSON.stringify({
    default_model: defaultAlias,
    models: { draft: { id: 'fixture-draft' }, research: { id: 'fixture-research', effort: 'high' } }
  }));
  writeModelSettings('draft');
  const sourceConfig = {
    state_dir: path.join(dir, 'sol-state'),
    pool_config: path.join(dir, 'pool.json'),
    openai: { model: 'gpt-6.2-sol', reasoning_effort: 'max', credential_source: 'windows-broker' },
    limits: { task_timeout_ms: 12000 },
    ...(options.unconfigured ? {} : { antigravity: { binary: process.execPath,
      runtime_dir: agyRuntime, models_file: modelsFile, credential_source: auth,
      ...(enterprise ? { adc_credentials_file: adcFile } : {}) } })
  };
  const poolConfig = {
    pool_root: path.join(dir, 'pool'), dsh_entry: path.join(repo, 'tests', 'mock-dsh.mjs'),
    schedule_config: path.join(repo, 'config', 'offpeak.schedule.json'), workspace_root: cwd, allow_write: true
  };
  const config = validateSolConfig(sourceConfig, { poolConfig });
  const configPath = path.join(dir, 'coordination.json');
  fs.writeFileSync(configPath, JSON.stringify(sourceConfig));
  fs.writeFileSync(sourceConfig.pool_config, JSON.stringify(poolConfig));
  const launches = [];
  const service = new SolService({
    config, responses: options.callBroker ? new ResponsesClient({ config, callBroker: options.callBroker }) : {
      sanitize: value => value,
      readiness: () => assert.fail('Antigravity writing and model discovery use no OpenAI broker request')
    },
    dispatch: {
      antigravityKey: options.missingKey ? undefined : 'offline-fixture-google-key',
      antigravitySpawn(binary, args, spawnOptions) {
        assert.equal(binary, fs.realpathSync(process.execPath));
        assert.ok(path.relative(agyRuntime, spawnOptions.cwd).startsWith('text-'));
        assert.equal(spawnOptions.shell, false);
        launches.push([...args]);
        return spawn(binary, [fixtureBinary, ...args], { ...spawnOptions, env: { ...spawnOptions.env,
          AGY_FIXTURE_BEHAVIOR: options.behavior ?? '', AGY_FIXTURE_EVENTS: eventsFile, AGY_FIXTURE_AUTH: enterprise ? 'enterprise' : 'key' } });
      }
    }
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function input(key = 'text', extra = {}) {
    return { idempotencyKey: key, goal: 'Draft a short reply.', acceptance: 'Give a standalone text answer.',
      contextSummary: 'Only these approved facts.', purpose: 'writing', cwd, permissionMode: 'read-only',
      acceptAntigravityUsage: true, ...extra };
  }
  async function run(key, extra) {
    const started = await service.start(root, input(key, extra));
    return started.status === 'running' ? service.wait(root, key, started.task_id, 13000) : started;
  }
  const events = () => fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { service, config, configPath, eventsFile, dir, cwd, launches, writeModelSettings, input, events, run };
}

test('official CLI catalog and pinned text tasks share one interface across Sol sources and reload model aliases', async t => {
  const f = fixture(t);
  assert.equal(f.service.resolve(root, { purpose: 'writing' }).executor.backend, 'antigravity');
  assert.equal(f.service.resolve(root, { purpose: 'computer_operation' }).executor.backend, 'terra');
  assert.equal(f.service.resolve(root, { purpose: 'writing', backend: 'Terra' }).executor.backend, 'terra');
  assert.equal(f.service.antigravityStatus().ready, null);
  assert.deepEqual(solEnvironmentNames(f.config), ['CODEX_HOME', 'GEMINI_API_KEY']);
  assert.equal(f.launches.length, 0);
  const listing = await f.service.listAntigravityModels();
  assert.deepEqual(listing.available_models.map(model => model.id), ['fixture-draft', 'fixture-research']);
  assert.equal(listing.evidence_source, 'agy models');
  assert.deepEqual(f.launches, [['--version'], ['models']]);
  assert.deepEqual(f.events(), []);
  const started = await f.service.start(root, f.input('original'));
  f.writeModelSettings('research');
  const second = await f.run('second', { coordinatorMode: 'api' });
  const first = await f.service.wait(root, 'original', started.task_id, 13000);
  assert.equal(first.status, 'completed', first.message);
  assert.equal(second.status, 'completed', second.message);
  assert.equal(first.coordinator_mode, 'subscription');
  assert.equal(second.coordinator_mode, 'api');
  assert.equal(first.report, 'Draft from fixture-draft.');
  assert.equal(second.report, 'Draft from fixture-research.');
  assert.equal(first.antigravity.provider_model, 'unverified');
  assert.equal(second.antigravity.cli_selected_model, 'fixture-research');
  const requests = new Map(f.events().map(event => [event.model, event]));
  assert.equal(requests.size, 2);
  assert.equal(requests.get('fixture-research').effort, 'high');
  assert.ok(requests.get('fixture-draft').prompt.includes('Only these approved facts.'));
  assert.ok(!requests.get('fixture-draft').prompt.includes(f.cwd));
  const replay = await f.run('original', { coordinatorMode: 'api' });
  assert.equal(replay.task_id, first.task_id);
  assert.equal(replay.coordinator_mode, 'subscription');
  assert.equal(replay.antigravity.requested_model, 'fixture-draft');
  assert.equal(replay.replayed, true);
  assert.equal(f.events().length, 2);
  assert.throws(() => f.service.get(otherRoot, 'original', first.task_id), /not found/);
});

test('Antigravity refuses scope, absent approval and unknown aliases without dispatch', async t => {
  const f = fixture(t);
  assert.equal((await f.run('unapproved', { acceptAntigravityUsage: false })).error_code, 'ANTIGRAVITY_USAGE_CONSENT_REQUIRED');
  assert.equal((await f.run('writes', { permissionMode: 'workspace-write' })).error_code, 'ANTIGRAVITY_TEXT_ONLY');
  assert.equal((await f.run('files', { capability: 'workspace-read' })).error_code, 'ANTIGRAVITY_TEXT_ONLY');
  assert.equal((await f.run('bad-alias', { antigravityModel: 'not-approved' })).error_code, 'ANTIGRAVITY_MODEL_UNAPPROVED');
  assert.throws(() => resolveDispatch({ purpose: 'image_generation', backend: 'Antigravity' }), { code: 'DISPATCH_BACKEND_PURPOSE_CONFLICT' });
  assert.deepEqual(f.launches, []);
  const old = fixture(t, { unconfigured: true });
  assert.equal(old.service.resolve(root, { purpose: 'writing' }).executor.backend, 'terra');
  assert.equal((await old.run('new', { backend: 'Antigravity' })).error_code, 'ANTIGRAVITY_NOT_CONFIGURED');
  const noKey = fixture(t, { missingKey: true });
  assert.equal(noKey.service.antigravityStatus().code, 'ANTIGRAVITY_AUTH_MISSING');
  assert.equal((await noKey.run('no-key')).error_code, 'ANTIGRAVITY_AUTH_MISSING');
  assert.deepEqual(noKey.launches, []);
});

test('CLI evidence gates prompt handoff and preserves uncertain originals without fallback', async t => {
  for (const behavior of ['unsafe', 'wrong-model', 'tool', 'partial']) {
    await t.test(behavior, async t => {
      const f = fixture(t, { behavior });
      const result = await f.run('run');
      const preflight = ['unsafe', 'wrong-model'].includes(behavior);
      assert.equal(result.status, preflight ? 'blocked' : 'unknown_after_disconnect', result.message);
      assert.equal(f.events().length, preflight ? 0 : 1);
      assert.equal(result.usage_unknown, !preflight);
      assert.equal((await f.run('run')).task_id, result.task_id);
      assert.equal(f.launches.length, 3);
    });
  }
});

test('enterprise ADC is a separate explicit CLI credential route', async t => {
  const f = fixture(t, { enterprise: true });
  assert.deepEqual(solEnvironmentNames(f.config), ['CODEX_HOME']);
  const result = await f.run('enterprise', { antigravityModel: 'research' });
  assert.equal(result.status, 'completed', result.message);
  assert.equal(result.antigravity.credential_source, 'enterprise-adc');
  assert.equal(result.antigravity.requested_model, 'fixture-research');
});

test('protected Sol delegates an approved standalone text subtask through its existing peer tool', async t => {
  let opens = 0;
  const f = fixture(t, { callBroker({ op, body }) {
    const route = { model: 'gpt-6.2-sol', reasoning_effort: 'max' };
    if (op === 'status') return { ok: true, status: 200, body: { ...route, ready: true,
      sol_tools: ['confirm_sol_api', 'delegate_work', 'delegate_peer', 'finish_coordination'] } };
    assert.equal(op, 'response');
    const n = ++opens;
    const peerTool = body.tools.find(tool => tool.name === 'delegate_peer');
    assert.deepEqual(peerTool.parameters.properties.peer.enum, ['antigravity']);
    if (n === 1) f.writeModelSettings('research');
    else {
      const reply = JSON.parse(body.input.at(-1).output);
      assert.equal(reply.report, 'Draft from fixture-draft.');
      assert.equal(reply.usage_source, 'antigravity');
      assert.equal(reply.usage.total_tokens, 48);
    }
    return { ok: true, status: 200, body: {
      id: `resp_${n}`, model: body.model, reasoning: body.reasoning, status: 'completed',
      usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
      output: [{ type: 'function_call', name: n === 1 ? 'delegate_peer' : 'finish_coordination', call_id: `call_${n}`,
        arguments: JSON.stringify(n === 1
          ? { peer: 'antigravity', goal: 'Write the relevant paragraph.', acceptance: 'Standalone text.', contextSummary: 'Approved paragraph facts.' }
          : { verdict: 'accepted', report: 'The text subtask produced the paragraph.' }) }]
    } };
  } });
  const result = await f.run('coordinated', { coordinatorMode: 'api', entryStructure: 'sol', purpose: 'general', capability: 'text-only',
    constraints: 'Omit the registered case name.' });
  assert.equal(result.status, 'completed', result.message);
  assert.equal(result.entry_structure, 'sol');
  assert.equal(result.peer_results[0].antigravity.requested_model, 'fixture-draft');
  assert.equal(result.peer_results[0].usage.total_tokens, 48);
  assert.equal(result.usage.total_tokens, 20);
  assert.equal(opens, 2);
  const [{ prompt }] = f.events();
  assert.ok(prompt.includes('Approved paragraph facts.'));
  assert.ok(prompt.includes('Omit the registered case name.'));
  assert.ok(!prompt.includes('Only these approved facts.'));
  assert.ok(!prompt.includes(f.cwd));
});

test('an older broker without peer-tool evidence cannot silently accept an Antigravity child', async t => {
  const f = fixture(t, { callBroker({ op }) {
    assert.equal(op, 'status');
    return { ok: true, status: 200, body: { model: 'gpt-6.2-sol', reasoning_effort: 'max', ready: true } };
  } });
  const result = await f.run('older-broker', { coordinatorMode: 'api', purpose: 'general', capability: 'text-only' });
  assert.equal(result.error_code, 'ANTIGRAVITY_PEER_TOOL_UNAVAILABLE');
  assert.deepEqual(f.launches, []);
});

test('the stdio MCP exposes scoped Antigravity status, catalog and text without forwarding its credential to the broker', async t => {
  const f = fixture(t);
  const codexHome = path.join(f.dir, 'codex-home');
  const sessionsRoot = path.join(codexHome, 'sessions');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.writeFileSync(path.join(sessionsRoot, `rollout-2026-11-24T00-00-00-${root}.jsonl`),
    JSON.stringify({ type: 'session_meta', payload: { id: root, source: 'vscode' } }) + '\n');
  const { context_ref: context } = issueContext({
    config: f.config.contextConfig, env: { CODEX_THREAD_ID: root }, sessionsRoot, purpose: 'sol-coordinator'
  });
  const serverURL = new URL('../bridges/sol/server.mjs', import.meta.url).href;
  const script = `
    import { spawn } from 'node:child_process';
    import { startSolServer } from ${JSON.stringify(serverURL)};
    startSolServer({
      configPath: process.argv[1],
      callBroker({ op }) {
        if (op !== 'status' || process.env.GEMINI_API_KEY !== undefined) throw Error('Unexpected broker access.');
        return { ok: true, status: 200, body: { ready: true, model: 'gpt-6.2-sol', reasoning_effort: 'max' } };
      },
      dispatch: { antigravitySpawn(binary, args, options) {
        return spawn(binary, [${JSON.stringify(fixtureBinary)}, ...args], {
          ...options, env: { ...options.env, AGY_FIXTURE_EVENTS: ${JSON.stringify(f.eventsFile)} }
        });
      } }
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.configPath], {
    env: { ...process.env, CODEX_HOME: codexHome, GEMINI_API_KEY: 'offline-fixture-google-key' }, stdio: ['pipe', 'pipe', 'inherit']
  });
  const closed = once(child, 'close');
  t.after(async () => {
    child.stdin.end();
    await closed;
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  async function rpc(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
    const next = await lines.next();
    assert.equal(next.done, false, 'MCP subprocess ended before responding');
    const reply = JSON.parse(next.value);
    assert.equal(reply.id, id);
    assert.ok(reply.result, JSON.stringify(reply.error));
    return reply.result;
  }
  await rpc('initialize', { protocolVersion: '2025-06-18' });
  const call = async (name, args = {}) => {
    const result = await rpc('tools/call', { name, arguments: { ...args, context } });
    assert.equal(result.isError, undefined, result.content[0].text);
    return result.structuredContent;
  };
  assert.ok((await rpc('tools/list', {})).tools.some(tool => tool.name === 'list_antigravity_models'));
  assert.equal((await call('get_sol_coordinator_mode')).broker_status, 'ready');
  assert.equal((await call('get_antigravity_status')).ready, null);
  fs.unlinkSync(f.config.antigravity.modelsFile);
  const catalog = await call('list_antigravity_models');
  assert.equal(catalog.configured_models.length, 0);
  assert.equal(catalog.model_config_issue, 'ANTIGRAVITY_MODEL_CONFIG_INVALID');
  assert.equal(catalog.available_models.length, 2);
  f.writeModelSettings('research');
  const result = await call('run_sol_coordination', f.input('mcp'));
  assert.equal(result.status, 'completed', result.message);
  assert.equal(result.antigravity.requested_model, 'fixture-research');
  assert.equal(f.events().length, 1);
});
