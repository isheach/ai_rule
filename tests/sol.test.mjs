import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { issueContext } from '../bridges/pool/context.mjs';
import { loadSolConfig } from '../bridges/sol/config.mjs';
import { ResponsesClient } from '../bridges/sol/responses.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootOne = '00000000-0000-4000-8000-000000000601';
const rootTwo = '00000000-0000-4000-8000-000000000602';
const childOne = '00000000-0000-4000-8000-000000000603';
const fixtureKey = 'sol-offline-fixture-value';
const model = 'gpt-6.2-sol';
const effort = 'max';
const peak = '2026-11-16T02:00:00.000Z';
const offpeak = '2026-11-16T00:30:00.000Z';
const script = name => path.join(repo, 'tests', name);
const countRuns = filename => fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];

function delegate(instructions = 'Read the authorized folder and return actual verification.') {
  return { name: 'delegate_work', args: { plan: 'Verify the result from the executor', instructions } };
}
function finish(report = 'Verified the delegate receipt.') {
  return { name: 'finish_coordination', args: { verdict: 'accepted', report } };
}
function callResult(sequence, call, extra = {}) {
  const id = String(sequence);
  return {
    id: 'resp_' + id, model, reasoning: { effort }, status: 'completed',
    usage: { input_tokens: 25, output_tokens: 20, total_tokens: 45,
      input_tokens_details: { cached_tokens: 1, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 5 } },
    output: [
      { type: 'reasoning', id: 'rs_' + id, encrypted_content: 'opaque-reasoning-' + id, summary: [] },
      { type: 'message', id: 'msg_' + id, role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'Planning', annotations: [] }] },
      { type: 'function_call', id: 'fc_' + id, call_id: 'call_' + id, name: call.name, arguments: JSON.stringify(call.args), status: 'completed' }
    ], ...extra
  };
}

async function fixture(t, onResponse, { clock = offpeak, workbuddy = false, limits = {} } = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ai-rule-sol-'));
  const codexHome = path.join(base, 'codex');
  const sessions = path.join(codexHome, 'sessions', '2026', '11', '16');
  fs.mkdirSync(sessions, { recursive: true });
  for (const [id, source] of [[rootOne, 'vscode'], [rootTwo, 'codex_work_desktop'], [childOne, { subagent: { thread_spawn: { parent_thread_id: rootOne } } }]]) {
    fs.writeFileSync(path.join(sessions, `rollout-2026-11-16T00-00-00-${id}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id, source } }) + '\nSECRET-ROLLOUT-BODY-IGNORED\n');
  }
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const dshRuns = path.join(base, 'dsh-runs.jsonl');
  const buddyRuns = path.join(base, 'wb-runs.jsonl');
  const poolConfig = path.join(base, 'pool.json');
  fs.writeFileSync(poolConfig, JSON.stringify({
    pool_root: path.join(base, 'pool'), dsh_entry: script('mock-dsh.mjs'), schedule_config: path.join(repo, 'config', 'offpeak.schedule.json'),
    workspace_root: workspace, allow_write: false, running_cap: 3
  }));
  const configPath = path.join(base, 'sol.json');
  const config = {
    state_dir: path.join(base, 'coordination'), pool_config: poolConfig,
    openai: { model, reasoning_effort: effort, api_key_env: 'SOL_OPENAI_API_KEY', project_env: 'SOL_OPENAI_PROJECT_ID' },
    limits: { task_timeout_ms: 12000, api_timeout_ms: 3000, ...limits },
    ...(workbuddy ? { workbuddy: { command: process.execPath, args: [script('fake-workbuddy-dsf.mjs')], cwd: repo,
      env_vars: ['SOL_TEST_WB_RUNS'], arguments: { task: 'task', cwd: 'directory', profile: 'profile', session: 'resumeSession' },
      profiles: { 'read-only': 'fixture-read-only' } } } : {})
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const env = { ...process.env, CODEX_HOME: codexHome, SOL_OPENAI_API_KEY: fixtureKey, SOL_OPENAI_PROJECT_ID: 'proj-fixture',
    OPENAI_API_KEY: 'other-offline-fixture-value', SOL_TEST_DSH_RUNS: dshRuns, SOL_TEST_WB_RUNS: buddyRuns, SOL_TEST_CLOCK: clock };
  const requests = [];
  const failures = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/responses');
      assert.equal(req.headers.authorization, 'Bearer ' + fixtureKey);
      assert.equal(req.headers['openai-project'], 'proj-fixture');
      assert.equal(body.model, model);
      assert.equal(body.reasoning.effort, effort);
      assert.equal(body.store, false);
      assert.equal(body.parallel_tool_calls, false);
      assert.equal(body.tool_choice, 'required');
      assert.deepEqual(body.include, ['reasoning.encrypted_content']);
      for (const field of ['temperature', 'previous_response_id', 'top_p', 'conversation', 'top_logprobs']) assert.equal(Object.hasOwn(body, field), false);
      assert.equal(JSON.stringify(body).includes('SECRET-ROLLOUT-BODY-IGNORED'), false);
      assert.equal(JSON.stringify(body).includes(fixtureKey), false);
      assert.ok(body.tools.every(tool => tool.strict === true && tool.parameters.additionalProperties === false));
      const result = await onResponse(requests.length, body, res);
      if (result === undefined) return;
      res.writeHead(result.http ?? 200, { 'Content-Type': 'application/json', 'x-request-id': `req_fixture_${requests.length}` });
      res.end(JSON.stringify(result.payload ?? result));
    } catch (error) {
      failures.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  env.SOL_TEST_RESPONSES_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  const peers = [];
  t.after(async () => {
    for (const peer of peers) await peer.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(base, { recursive: true, force: true });
    if (failures.length) throw failures[0];
  });
  function context(id = rootOne) {
    const issued = spawnSync(process.execPath, [path.join(repo, 'bridges', 'sol', 'cli.mjs'), 'context', '--config', configPath],
      { env: { ...env, CODEX_THREAD_ID: id }, encoding: 'utf8' });
    assert.equal(issued.status, 0, issued.stderr);
    return JSON.parse(issued.stdout).context_ref;
  }
  async function connect(extraEnv = {}) {
    const peer = await mcpPeer(configPath, { ...env, ...extraEnv });
    peers.push(peer);
    return peer;
  }
  return { connect, context, configPath, config, codexHome, workspace, requests, dshRuns, buddyRuns, base };
}

async function mcpPeer(configPath, env) {
  const child = spawn(process.execPath, [script('sol-mcp-fixture.mjs'), configPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const finished = once(child, 'close');
  const pending = new Map();
  let seq = 0;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { stderr += text; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const value = JSON.parse(line);
    pending.get(value.id)?.resolve(value);
    pending.delete(value.id);
  });
  child.on('close', code => {
    for (const entry of pending.values()) entry.reject(Error(`Sol MCP exited (${code}): ${stderr}`));
    pending.clear();
  });
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const call = async (name, args) => {
    const { result, error } = await rpc('tools/call', { name, arguments: args });
    if (error || result.isError) throw Error(error?.message ?? result.content[0].text);
    const value = JSON.parse(result.content[0].text);
    assert.deepEqual(result.structuredContent, value);
    return value;
  };
  const initialization = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(initialization.result.serverInfo.name, 'sol-coordinator');
  send({ method: 'notifications/initialized' });
  return { rpc, call, child, finished, async stop() {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    await finished;
  } };
}

function task(f, context, idempotencyKey, extra = {}) {
  return { context, idempotencyKey, backend: 'DSH', goal: 'Run the original approved fixture work.', cwd: f.workspace,
    permissionMode: 'read-only', constraints: 'Read only', contextSummary: 'Relevant approved memory for this task',
    acceptance: 'Return actual mock read and completion evidence.', ...extra };
}
const select = (peer, context, mode) => peer.call('set_sol_coordinator_mode', { context, mode });
const mode = (peer, context) => peer.call('get_sol_coordinator_mode', { context });
const schedule = (peer, context, scheduleMode) => peer.call('set_sol_schedule', { context, scheduleMode });
const run = (peer, args) => peer.call('run_sol_coordination', args);
const start = (peer, args) => peer.call('start_sol_coordination', args);
const find = (peer, context, idempotencyKey, taskId) => peer.call('get_sol_coordination', { context, idempotencyKey, ...(taskId ? { taskId } : {}) });
const wait = (peer, context, idempotencyKey, taskId) => peer.call('wait_sol_coordination', { context, idempotencyKey, taskId, waitMs: 10000 });
const cancel = (peer, context, idempotencyKey, taskId) => peer.call('cancel_sol_coordination', { context, idempotencyKey, taskId });

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() >= deadline) throw Error('Fixture condition did not arrive before its deadline.');
    await delay(25);
  }
}

function previousReceipt(body) {
  const response = body.input.at(-1);
  assert.equal(response.type, 'function_call_output');
  assert.equal(response.call_id, body.input.at(-2).call_id);
  assert.equal(body.input.at(-3).phase, 'commentary');
  assert.match(body.input.at(-4).encrypted_content, /^opaque-reasoning-/);
  return JSON.parse(response.output);
}

test('API Sol calls real pooled DSH, inspects and revises the original session with complete usage and lineage', async t => {
  const f = await fixture(t, (index, body) => {
    if (index === 1) {
      assert.ok(body.input[0].role === 'developer' && body.input[0].content.includes('contextSummary'));
      const handoff = JSON.parse(body.input[1].content);
      assert.equal(handoff.contextSummary, 'Relevant approved memory for this task');
      assert.equal(handoff.permissionMode, 'read-only');
      return callResult(index, delegate('First stage has incomplete verification.'));
    }
    const receipt = previousReceipt(body);
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.final_reason, 'completed');
    assert.equal(receipt.exit_code, 0);
    assert.equal(receipt.actual_route, null);
    assert.equal(receipt.configured_route.model, 'deepseek-v4.1-flash');
    assert.equal(receipt.native_tool_calls, 1);
    return callResult(index, index === 2 ? delegate('Run the newly required verification in the original session.') : finish());
  });
  const peer = await f.connect();
  const first = f.context(), second = f.context(rootTwo), child = f.context(childOne);
  assert.equal((await mode(peer, first)).coordinator_mode, 'subscription');
  assert.equal((await run(peer, task(f, first, 'native'))).status, 'not_dispatched');
  assert.equal(f.requests.length, 0);
  await select(peer, first, 'api');
  assert.equal((await mode(peer, child)).coordinator_mode, 'api');
  assert.equal((await mode(peer, second)).coordinator_mode, 'subscription');
  const args = task(f, first, 'loop');
  const result = await run(peer, args);
  assert.equal(result.status, 'completed', result.message);
  assert.equal(result.acceptance, 'accepted');
  assert.equal(result.coordinator_mode, 'api');
  assert.equal(result.executor_backend, 'dsh');
  assert.equal(result.responses.length, 3);
  assert.deepEqual(result.usage, { input_tokens: 75, output_tokens: 60, total_tokens: 135, cached_input_tokens: 3, cache_write_tokens: 6, reasoning_tokens: 15 });
  assert.equal(result.usage_unknown, false);
  assert.equal(result.steps.length, 2);
  assert.notEqual(result.steps[0].receipt.task_id, result.steps[1].receipt.task_id);
  assert.equal(result.steps[0].receipt.session_id, result.steps[1].receipt.session_id);
  assert.equal(result.steps[0].receipt.instance, result.steps[1].receipt.instance);
  assert.equal(result.steps[1].executed_via.service, 'PoolService');
  assert.equal((await find(peer, child, 'loop')).task_id, result.task_id);
  await assert.rejects(find(peer, second, 'loop'), /not found/);
  assert.deepEqual(countRuns(f.dshRuns).map(item => item.hasOpenAIKey), [false, false]);
  await select(peer, first, 'subscription');
  assert.equal((await run(peer, args)).replayed, true);
  await assert.rejects(run(peer, { ...args, goal: 'Different goal' }), /different frozen handoff/);
  assert.equal(f.requests.length, 3);
  const secondConnection = await f.connect();
  assert.equal((await mode(secondConnection, first)).coordinator_mode, 'subscription');
  assert.equal((await find(secondConnection, first, 'loop')).status, 'completed');
});

test('One-shot override and an in-flight source switch preserve the original owner, schedule and downstream job', async t => {
  const f = await fixture(t, (index, body) => callResult(index, index === 1 ? delegate('fixture-sleep:900') : finish(previousReceipt(body).status)));
  const peer = await f.connect();
  const other = await f.connect();
  const context = f.context();
  const foreign = f.context(rootTwo);
  await schedule(peer, context, 2);
  const args = task(f, context, 'one-shot', { coordinatorMode: 'api' });
  const original = await start(peer, args);
  assert.equal(original.status, 'running');
  assert.equal(original.schedule_at_start, 2);
  await until(() => countRuns(f.dshRuns).length);
  assert.equal((await mode(peer, context)).coordinator_mode, 'subscription');
  await select(peer, context, 'api');
  assert.equal((await run(peer, task(f, context, 'native-exception', { coordinatorMode: 'subscription' }))).status, 'not_dispatched');
  await select(peer, context, 'subscription');
  assert.equal((await other.call('get_sol_schedule', { context })).mode, 2);
  assert.equal((await start(other, args)).status, 'unknown_after_disconnect');
  assert.equal((await cancel(other, context, 'one-shot', original.task_id)).cancel_requested, false);
  await assert.rejects(cancel(peer, foreign, 'one-shot', original.task_id), /not found/);
  const final = await wait(peer, context, 'one-shot', original.task_id);
  assert.equal(final.status, 'completed', final.message);
  assert.equal(final.coordinator_mode, 'api');
  assert.equal(final.steps.length, 1);
  assert.equal(countRuns(f.dshRuns).length, 1);
  assert.equal(f.requests.length, 2);
});

test('Mode 2 real peak WorkBuddy offer is claimed, invoked through the original stdio and completed with a same-session revision', async t => {
  const f = await fixture(t, (index, body) => {
    if (index > 1) {
      const receipt = previousReceipt(body);
      assert.equal(receipt.backend, 'workbuddy-dsf');
      assert.equal(receipt.returned_model, 'deepseek-v4-flash');
      assert.equal(receipt.status, 'completed');
    }
    return callResult(index, index === 3 ? finish() : delegate());
  }, { clock: peak, workbuddy: true });
  const peer = await f.connect();
  const context = f.context();
  await schedule(peer, context, 2);
  const result = await run(peer, task(f, context, 'peak', { coordinatorMode: 'api' }));
  assert.equal(result.status, 'completed', result.message);
  assert.equal(result.executor_backend, 'workbuddy-dsf');
  assert.equal(result.steps.length, 2);
  assert.ok(result.steps.every(step => step.receipt.dispatch_id && step.executed_via.tool === 'run_workbuddy_task'));
  assert.equal(result.steps[0].receipt.session_id, result.steps[1].receipt.session_id);
  assert.notEqual(result.steps[0].receipt.dispatch_id, result.steps[1].receipt.dispatch_id);
  assert.equal(countRuns(f.dshRuns).length, 0);
  assert.deepEqual(countRuns(f.buddyRuns).map(item => item.hasOpenAIKey), [false, false]);
  assert.equal(f.requests.length, 3);
  assert.equal((await run(peer, task(f, context, 'peak'))).replayed, true);
  assert.equal(countRuns(f.buddyRuns).length, 2);
});

test('Explicit WorkBuddy does not route through DSH and original mode 3 gate does not bypass peak', async t => {
  const f = await fixture(t, (index, body) => callResult(index, index === 3 ? finish(previousReceipt(body).status) : delegate()),
    { clock: peak, workbuddy: true });
  const peer = await f.connect();
  const context = f.context();
  await select(peer, context, 'api');
  await schedule(peer, context, 3);
  const gated = await run(peer, task(f, context, 'gate'));
  assert.equal(gated.status, 'blocked', gated.message);
  assert.equal(gated.steps[0].receipt.dsh_pre_admission_code, 'DSH_SCHEDULE_GATE');
  assert.equal(gated.steps[0].receipt.schedule_phase, 'peak');
  assert.equal(countRuns(f.dshRuns).length, 0);
  const explicit = await run(peer, task(f, context, 'explicit-workbuddy', { backend: 'WorkBuddy DSF' }));
  assert.equal(explicit.status, 'completed', explicit.message);
  assert.equal(explicit.steps[0].schedule_dispatch, false);
  assert.equal(explicit.steps[0].receipt.backend, 'workbuddy-dsf');
  assert.equal(countRuns(f.buddyRuns).length, 1);
});

test('OpenAI 429, incomplete response, wrong route, unverified acceptance and extra tool arguments stop without an executor', async t => {
  const f = await fixture(t, index => {
    if (index === 1) return { http: 429, payload: { error: { code: 'insufficient_quota', type: 'insufficient_quota', message: 'do not repeat ' + fixtureKey } } };
    if (index === 2) return callResult(index, delegate(), { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });
    if (index === 3) return callResult(index, delegate(), { model: 'gpt-unauthorized' });
    if (index === 4) return callResult(index, finish('No real executor result.'));
    return callResult(index, { name: 'delegate_work', args: { ...delegate().args, cwd: '/outside', permissionMode: 'workspace-write' } });
  });
  const peer = await f.connect();
  const ctx = f.context();
  await select(peer, ctx, 'api');
  const throttled = await run(peer, task(f, ctx, '429'));
  assert.equal(throttled.status, 'blocked');
  assert.equal(throttled.error_code, 'OPENAI_HTTP_429');
  assert.equal(throttled.responses[0].error_code, 'insufficient_quota');
  assert.equal(throttled.responses[0].request_id, 'req_fixture_1');
  assert.ok(!JSON.stringify(throttled).includes(fixtureKey));
  const incomplete = await run(peer, task(f, ctx, 'incomplete'));
  assert.equal(incomplete.error_code, 'OPENAI_INCOMPLETE');
  assert.equal(incomplete.responses[0].incomplete_reason, 'max_output_tokens');
  assert.equal(incomplete.usage.total_tokens, 45);
  const mismatch = await run(peer, task(f, ctx, 'mismatch'));
  assert.equal(mismatch.error_code, 'OPENAI_ROUTE_MISMATCH');
  assert.equal(mismatch.responses[0].requested_model, model);
  assert.equal(mismatch.responses[0].returned_model, 'gpt-unauthorized');
  assert.match((await run(peer, task(f, ctx, 'no-evidence'))).message, /requires a completed executor receipt/);
  assert.match((await run(peer, task(f, ctx, 'misuse'))).message, /unsupported field/);
  await assert.rejects(run(peer, task(f, ctx, 'bad-cwd', { cwd: f.base })), /outside the approved/);
  await assert.rejects(run(peer, task(f, ctx, 'write', { permissionMode: 'workspace-write', authorizationNote: 'Permission requested' })), /configured read-only/);
  await assert.rejects(run(peer, task(f, ctx, 'creds', { contextSummary: fixtureKey })), /credential/);
  assert.equal((await run(peer, task(f, ctx, 'unsupported', { backend: 'A' }))).error_code, 'API_BACKEND_UNSUPPORTED');
  assert.equal(countRuns(f.dshRuns).length, 0);
  assert.equal(f.requests.length, 5);
});

test('Response replay and token limits preserve prior evidence without duplicate executor jobs', async t => {
  const f = await fixture(t, (index, body) => {
    if (index === 2) return callResult(1, delegate('Duplicate response must not dispatch.'));
    if (index === 4) {
      assert.equal(body.max_output_tokens, 955);
      return callResult(index, finish(previousReceipt(body).status), { usage: { input_tokens: 1000, output_tokens: 20, total_tokens: 1020 } });
    }
    return callResult(index, delegate());
  }, { limits: { max_total_tokens: 1000 } });
  const peer = await f.connect();
  const ctx = f.context();
  await select(peer, ctx, 'api');
  const duplicate = await run(peer, task(f, ctx, 'duplicate'));
  assert.equal(duplicate.error_code, 'OPENAI_DUPLICATE_RESPONSE');
  assert.equal(duplicate.responses[1].repeated_response_id, true);
  assert.equal(duplicate.usage_unknown, true);
  assert.equal(duplicate.usage.total_tokens, 45);
  assert.equal(duplicate.steps.length, 1);
  const threshold = await run(peer, task(f, ctx, 'threshold'));
  assert.equal(threshold.status, 'completed', threshold.message);
  assert.equal(threshold.token_threshold_exceeded, true);
  assert.equal(threshold.usage.total_tokens, 1065);
  assert.equal(countRuns(f.dshRuns).length, 2);
});

test('Cancellation belongs to the original coordinator and a disconnected owner cannot replay either API or DSH work', async t => {
  const f = await fixture(t, index => callResult(index, delegate(index === 1 ? 'fixture-hang' : 'fixture-sleep:1100')));
  const peer = await f.connect();
  const context = f.context();
  await select(peer, context, 'api');
  const original = await start(peer, task(f, context, 'cancel'));
  await until(() => countRuns(f.dshRuns).length);
  const stopped = await cancel(peer, context, 'cancel', original.task_id);
  assert.equal(stopped.status, 'cancelled', stopped.message);
  assert.equal(stopped.steps[0].receipt.status, 'cancelled');
  const args = task(f, context, 'disconnect');
  const disconnected = await start(peer, args);
  await until(() => countRuns(f.dshRuns).length === 2);
  peer.child.kill('SIGKILL');
  await peer.finished;
  const replacement = await f.connect();
  const observed = await find(replacement, context, 'disconnect', disconnected.task_id);
  assert.equal(observed.status, 'unknown_after_disconnect');
  assert.equal(observed.owner, false);
  assert.equal((await run(replacement, args)).replayed, true);
  assert.equal((await cancel(replacement, context, 'disconnect', disconnected.task_id)).cancel_requested, false);
  assert.equal(f.requests.length, 2);
  await delay(1150);
  assert.equal(countRuns(f.dshRuns).length, 2);
});

test('Missing credentials and disrupted HTTP never guess usage, switch source or resend requests', async t => {
  const f = await fixture(t, (_index, _body, res) => { res.destroy(); });
  const offline = await f.connect({ SOL_OPENAI_API_KEY: '' });
  const ctx = f.context();
  await select(offline, ctx, 'api');
  assert.equal((await run(offline, task(f, ctx, 'missing'))).error_code, 'OPENAI_CREDENTIALS_MISSING');
  assert.equal(f.requests.length, 0);
  const peer = await f.connect();
  const args = task(f, ctx, 'network');
  const result = await run(peer, args);
  assert.equal(result.error_code, 'OPENAI_RESPONSE_UNKNOWN');
  assert.equal(result.usage_unknown, true);
  assert.equal(result.usage.total_tokens, null);
  assert.equal((await mode(peer, ctx)).coordinator_mode, 'api');
  assert.equal((await run(peer, args)).replayed, true);
  assert.equal(f.requests.length, 1);
  assert.equal(countRuns(f.dshRuns).length, 0);
});

test('Coordinator context accepts verified roots but legacy pool contexts remain child-only and purpose-isolated', async t => {
  const f = await fixture(t, () => assert.fail('Context verification must not call OpenAI.'));
  const cfg = loadSolConfig(f.configPath);
  const sessionRoot = path.join(f.codexHome, 'sessions');
  assert.throws(() => issueContext({ config: cfg.pool, sessionsRoot: sessionRoot, env: { CODEX_THREAD_ID: rootOne } }), /subagent/);
  const legacy = issueContext({ config: cfg.contextConfig, sessionsRoot: sessionRoot, env: { CODEX_THREAD_ID: childOne } });
  const peer = await f.connect();
  await assert.rejects(mode(peer, legacy.context_ref), /different local service/);
  assert.equal((await mode(peer, f.context())).coordinator_mode, 'subscription');
  assert.equal(f.requests.length, 0);
});

test('Explicit API probe retains verified route and usage evidence when the strict tool call is missing', async t => {
  const f = await fixture(t, () => assert.fail('Probe uses its test-injected fetch implementation.'));
  const cfg = loadSolConfig(f.configPath);
  let answer = callResult(1, { name: 'confirm_sol_api', args: { result: 'ready' } });
  const client = new ResponsesClient({ config: cfg, credential: { key: fixtureKey, project: 'proj-fixture' },
    fetchImpl: async () => new Response(JSON.stringify(answer)) });
  const verified = await client.verify();
  assert.equal(verified.verified, true);
  assert.equal(verified.returned_model, model);
  assert.equal(verified.reasoning_effort, effort);
  answer = { ...answer, output: [] };
  await assert.rejects(client.verify(), error => error.evidence.usage.total_tokens === 45);
});
