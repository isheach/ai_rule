import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITY_POLICY,
  DSH_MODEL,
  DSH_REASONING_EFFORT,
  DispatchBlockedError,
  DispatchPolicyError,
  PURPOSES,
  SOL_MODEL,
  SOL_REASONING_EFFORT,
  TERRA_MODEL,
  TERRA_REASONING_EFFORT,
  WORKBUDDY_MODEL,
  WORKBUDDY_REASONING_EFFORT,
  dispatchLayeredTask,
  resolveDispatch
} from '../bridges/dispatch.mjs';
import { loadSolConfig } from '../bridges/sol/config.mjs';
import { SolService } from '../bridges/sol/service.mjs';
import { ACTION_TOOL, CONFIRM_TOOL, FINISH_TOOL } from '../bridges/terra/client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mock = path.join(root, 'tests', 'mock-dsh.mjs');
const temp = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'ai-rule-layered-'));
const SPECIALISTS = PURPOSES.filter(purpose => purpose !== 'general');
const terraRound = (id, tool) => ({
  response_id: id,
  model: TERRA_MODEL,
  status: 'completed',
  reasoning_effort: TERRA_REASONING_EFFORT,
  tool,
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
});

test('policy matrix: both sources, every purpose, fixed model/effort pairs', () => {
  for (const source of ['subscription', 'api']) {
    const general = resolveDispatch({ source, purpose: 'general' });
    assert.equal(general.layer, 'coordinator');
    assert.equal(general.coordinator.model, SOL_MODEL);
    assert.equal(general.coordinator.reasoning_effort, SOL_REASONING_EFFORT);
    assert.equal(general.coordinator.transport, source === 'api' ? 'sol-coordinator' : 'native-subscription');
    assert.equal(general.executor.backend, 'dsh');
    assert.equal(general.executor.model, DSH_MODEL);
    assert.equal(general.executor.reasoning_effort, DSH_REASONING_EFFORT);
    assert.equal(general.backend_source, 'default');
    assert.deepEqual(general.capabilities.required, []);

    for (const purpose of SPECIALISTS) {
      const plan = resolveDispatch({ source, purpose });
      assert.equal(plan.layer, 'specialist', purpose);
      assert.equal(plan.coordinator, null, purpose);
      assert.equal(plan.executor.backend, 'terra', purpose);
      assert.equal(plan.executor.model, TERRA_MODEL, purpose);
      assert.equal(plan.executor.reasoning_effort, TERRA_REASONING_EFFORT, purpose);
      assert.equal(plan.executor.transport, source === 'api' ? 'protected-terra' : 'native-terra', purpose);
      assert.deepEqual(plan.capabilities.required, CAPABILITY_POLICY[purpose].required, purpose);
      assert.equal(plan.capabilities.keyword_matching, 'disabled', purpose);
    }
  }
  assert.equal(resolveDispatch({}).source, 'subscription');
  assert.equal(resolveDispatch({}).purpose, 'general');
  assert.equal(resolveDispatch({}).executor.backend, 'dsh');
});

test('explicit backend: WorkBuddy selectable, omitted stays DSH, incompatible choices fail closed', () => {
  const defaulted = resolveDispatch({ purpose: 'general' });
  assert.equal(defaulted.executor.backend, 'dsh');
  const explicitDsh = resolveDispatch({ purpose: 'general', backend: 'DSH' });
  assert.equal(explicitDsh.executor.backend, 'dsh');
  assert.equal(explicitDsh.backend_source, 'explicit');
  const workbuddy = resolveDispatch({ purpose: 'general', backend: 'WorkBuddy DSF' });
  assert.equal(workbuddy.executor.backend, 'workbuddy-dsf');
  assert.equal(workbuddy.executor.model, WORKBUDDY_MODEL);
  assert.equal(workbuddy.executor.server_name, 'deepseek-v4-flash-workbuddy');
  assert.equal(workbuddy.backend_source, 'explicit');

  // A prompt keyword is not part of the resolver and cannot change the route.
  const keyword = resolveDispatch({ purpose: 'general', prompt: 'Draw an image and recognize the screenshot, then write a novel.' });
  assert.equal(keyword.executor.backend, 'dsh');
  assert.equal(keyword.layer, 'coordinator');

  assert.throws(() => resolveDispatch({ purpose: 'writing', backend: 'DSH' }), error => {
    assert.ok(error instanceof DispatchPolicyError);
    assert.equal(error.code, 'DISPATCH_BACKEND_PURPOSE_CONFLICT');
    return true;
  });
  assert.throws(() => resolveDispatch({ purpose: 'general', backend: 'Terra' }), /only for explicitly specialized/);
  assert.throws(() => resolveDispatch({ purpose: 'not-a-purpose' }), error => error.code === 'DISPATCH_PURPOSE_INVALID');
  assert.throws(() => resolveDispatch({ backend: 'not-a-backend' }), error => error.code === 'DISPATCH_BACKEND_INVALID');
});

test('public dispatch routes general work through the Sol coordinator before the selected DSF backend', async () => {
  const events = [];
  const dshRequests = [];
  const workbuddyRequests = [];
  const dsh = {
    async submit(request) {
      events.push('dsh');
      dshRequests.push(request);
      return {
        status: 'completed', backend: 'dsh', task_id: 'dsh-task',
        model: DSH_MODEL, reasoning_effort: DSH_REASONING_EFFORT, answer: 'dsh output'
      };
    }
  };
  const workbuddy = {
    async dispatch(request) {
      events.push('workbuddy');
      workbuddyRequests.push(request);
      return {
        status: 'completed', backend: 'workbuddy-dsf', task_id: 'wb-task',
        model: WORKBUDDY_MODEL, reasoning_effort: WORKBUDDY_REASONING_EFFORT, answer: 'workbuddy output'
      };
    }
  };
  const coordinator = {
    model: SOL_MODEL,
    reasoning_effort: SOL_REASONING_EFFORT,
    async coordinate(request) {
      events.push(['coordinator', request.source, request.backend.backend]);
      const result = await request.backend.submit({
        plan: request.plan, prompt: request.prompt, task: request.task,
        purpose: request.purpose, source: request.source
      });
      return {
        ...result,
        coordinator_model: request.model,
        coordinator_reasoning_effort: request.reasoning_effort
      };
    }
  };

  const general = await dispatchLayeredTask({
    purpose: 'general', prompt: 'Please draw an image and write a report.'
  }, { coordinator, dsh });
  assert.equal(general.selected_backend, 'dsh');
  assert.equal(general.model, DSH_MODEL, 'the actual executor model is preserved');
  assert.equal(general.coordinator_model, SOL_MODEL);
  assert.equal(general.dispatch.executor.model, DSH_MODEL);
  assert.deepEqual(events, [['coordinator', 'subscription', 'dsh'], 'dsh']);
  assert.equal(dshRequests.length, 1);

  events.length = 0;
  const explicit = await dispatchLayeredTask({
    purpose: 'general', backend: 'WorkBuddy DSF', prompt: 'General coordination with a drawing keyword.'
  }, { coordinator, workbuddy });
  assert.equal(explicit.selected_backend, 'workbuddy-dsf');
  assert.equal(explicit.model, WORKBUDDY_MODEL);
  assert.equal(explicit.dispatch.executor.model, WORKBUDDY_MODEL);
  assert.deepEqual(events, [['coordinator', 'subscription', 'workbuddy-dsf'], 'workbuddy']);
  assert.equal(workbuddyRequests.length, 1);

  let rawCalls = 0;
  const rawDsh = { async submit() { rawCalls++; return { status: 'completed' }; } };
  await assert.rejects(dispatchLayeredTask({ purpose: 'general', prompt: 'no coordinator' }, { dsh: rawDsh }), error => {
    assert.ok(error instanceof DispatchBlockedError);
    assert.equal(error.code, 'DISPATCH_COORDINATOR_MISSING');
    assert.deepEqual(error.missing_adapters, ['sol_coordinator']);
    return true;
  });
  assert.equal(rawCalls, 0, 'raw DSH is never invoked when Sol coordination is missing');

  await assert.rejects(dispatchLayeredTask({ purpose: 'general', prompt: 'no selected backend' }, { coordinator }), error => {
    assert.equal(error.code, 'DISPATCH_EXECUTOR_UNAVAILABLE');
    assert.deepEqual(error.missing_adapters, ['dsh']);
    return true;
  });

  await assert.rejects(dispatchLayeredTask({
    purpose: 'general', prompt: 'raw adapter is not Sol'
  }, { coordinator: rawDsh, dsh: rawDsh }), error => {
    assert.equal(error.code, 'DISPATCH_COORDINATOR_INVALID');
    assert.deepEqual(error.missing_adapters, ['sol_coordinator']);
    return true;
  });
  assert.equal(rawCalls, 0, 'a lower adapter without the coordinator entry is rejected');
});

test('subscription Terra uses only a real native host adapter and reports missing capabilities', async () => {
  const requests = [];
  const nativeTerra = {
    capabilities: ['computer_operation'],
    async dispatch(request) {
      requests.push(request);
      return { status: 'completed', model: TERRA_MODEL, reasoning_effort: 'max', text: 'native terra text' };
    }
  };
  const writing = await dispatchLayeredTask({
    source: 'subscription', purpose: 'writing', prompt: 'Write a short handoff.'
  }, { nativeTerra });
  assert.equal(writing.text, 'native terra text');
  assert.equal(writing.model, TERRA_MODEL);
  assert.equal(writing.transport, 'native-terra');
  assert.equal(requests[0].purpose, 'writing');
  assert.equal(requests[0].model, TERRA_MODEL);
  assert.equal(requests[0].reasoning_effort, 'max');

  await assert.rejects(dispatchLayeredTask({ source: 'subscription', purpose: 'writing', prompt: 'x' }), error => {
    assert.ok(error instanceof DispatchBlockedError);
    assert.equal(error.code, 'DISPATCH_NATIVE_TERRA_MISSING');
    assert.deepEqual(error.missing_adapters, ['native_terra_host_adapter']);
    return true;
  });

  const limitedHost = { capabilities: [], async dispatch() { throw Error('must not run'); } };
  await assert.rejects(dispatchLayeredTask({
    source: 'subscription', purpose: 'image_recognition', prompt: 'Inspect the provided opaque image reference.'
  }, { nativeTerra: limitedHost }), error => {
    assert.equal(error.code, 'DISPATCH_CAPABILITY_MISSING');
    assert.deepEqual(error.missing_capabilities, ['image_recognition']);
    return true;
  });

  // Raw image data is not exposed by default, even to a capability-bearing host.
  await assert.rejects(dispatchLayeredTask({
    source: 'subscription', purpose: 'image_recognition', prompt: 'Inspect.', task: { imageData: 'base64-not-forwarded' }
  }, { nativeTerra }), error => {
    assert.equal(error.code, 'DISPATCH_MEDIA_FORBIDDEN');
    return true;
  });
});

test('API Terra invokes the protected client path, returns usable text, and never fakes actions', async () => {
  const seen = [];
  const writingClient = {
    async status() { return { ready: true }; },
    async run({ input }) {
      seen.push(input);
      return {
        status: 'finished', confirmed: true, model: TERRA_MODEL,
        report: 'USABLE API TERRA WRITING', actions: [],
        rounds: [terraRound('resp_1', CONFIRM_TOOL), terraRound('resp_2', FINISH_TOOL)],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      };
    }
  };
  const writing = await dispatchLayeredTask({
    source: 'api', purpose: 'writing', prompt: 'Write the final text.'
  }, {
    terraFactory({ actions }) {
      assert.deepEqual(actions, []);
      return writingClient;
    }
  });
  assert.equal(writing.text, 'USABLE API TERRA WRITING');
  assert.equal(writing.model, TERRA_MODEL);
  assert.equal(writing.transport, 'protected-terra');
  assert.match(seen[0], /Write the final text/);

  let factoryCalls = 0;
  await assert.rejects(dispatchLayeredTask({
    source: 'api', purpose: 'image_generation', prompt: 'Generate an image.'
  }, { terraFactory() { factoryCalls++; return writingClient; } }), error => {
    assert.equal(error.code, 'DISPATCH_CAPABILITY_MISSING');
    assert.deepEqual(error.missing_capabilities, ['image_generation']);
    return true;
  });
  assert.equal(factoryCalls, 0);
  assert.equal(seen.length, 1);

  await assert.rejects(dispatchLayeredTask({
    source: 'api', purpose: 'image_generation', prompt: 'Generate an image.'
  }, {
    capabilities: { image_generation: { effect: 'write', run: async () => ({ ok: true }) } },
    terraFactory() { return writingClient; }
  }), error => {
    assert.equal(error.code, 'DISPATCH_PERMISSION_REQUIRED');
    return true;
  });

  let actionRan = null;
  const acceptance = await dispatchLayeredTask({
    source: 'api', purpose: 'acceptance', prompt: 'Accept the reported local work.'
  }, {
    capabilities: { acceptance: { effect: 'read', run: async () => { actionRan = 'local receipt'; return { ok: true, checked: true }; } } },
    terraFactory({ actions }) {
      assert.equal(actions.length, 1);
      assert.equal(actions[0].name, 'inspect_acceptance');
      assert.equal(actions[0].effect, 'read');
      return {
        async run() {
          const result = await actions[0].callback();
          assert.equal(result.ok, true);
          return {
            status: 'finished', confirmed: true, model: TERRA_MODEL,
            report: 'accepted from local receipt',
            actions: [{ action: 'inspect_acceptance', effect: 'read', ok: true, result }],
            rounds: [
              terraRound('resp_3', CONFIRM_TOOL),
              terraRound('resp_4', ACTION_TOOL),
              terraRound('resp_5', FINISH_TOOL)
            ]
          };
        }
      };
    }
  });
  assert.equal(actionRan, 'local receipt');
  assert.equal(acceptance.text, 'accepted from local receipt');
});

function makeSolFixture() {
  const base = temp();
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const poolFile = path.join(base, 'pool.json');
  fs.writeFileSync(poolFile, JSON.stringify({
    pool_root: path.join(base, 'pool'),
    dsh_entry: mock,
    schedule_config: path.join(root, 'config', 'offpeak.schedule.json'),
    workspace_root: workspace,
    allow_write: true
  }));
  const configFile = path.join(base, 'sol.json');
  fs.writeFileSync(configFile, JSON.stringify({
    state_dir: path.join(base, 'state'),
    pool_config: poolFile,
    openai: { model: SOL_MODEL, reasoning_effort: SOL_REASONING_EFFORT, credential_source: 'windows-broker' },
    limits: { task_timeout_ms: 12000 }
  }));
  return { base, workspace, config: loadSolConfig(configFile) };
}

test('Sol API entry: omitted backend resolves DSH, specialist Terra needs consent, capabilities are named, replay keeps owner', async t => {
  const f = makeSolFixture();
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  let factoryCalls = 0;
  const service = new SolService({
    config: f.config,
    responses: { readiness: async () => ({ ready: true }), sanitize: value => value },
    dispatch: {
      terraFactory({ actions, allowWrite }) {
        factoryCalls++;
        assert.deepEqual(actions, []);
        assert.equal(allowWrite, false);
        return {
          async status() { return { ready: true }; },
          async run() {
            return {
              status: 'finished', confirmed: true, model: TERRA_MODEL,
              report: 'API WRITING OUTPUT', actions: [],
              rounds: [terraRound('resp_sol_1', CONFIRM_TOOL), terraRound('resp_sol_2', FINISH_TOOL)],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            };
          }
        };
      }
    }
  });
  const rootId = '00000000-0000-4000-8000-000000000701';
  await service.setMode(rootId, 'api');
  const base = { idempotencyKey: 'writing', purpose: 'writing', goal: 'Write the requested note.', cwd: f.workspace,
    permissionMode: 'read-only', acceptance: 'Return usable text.' };

  const denied = await service.start(rootId, base);
  assert.equal(denied.status, 'blocked');
  assert.equal(denied.error_code, 'TERRA_BILLING_CONSENT_REQUIRED');
  assert.equal(factoryCalls, 0);

  const started = await service.start(rootId, { ...base, acceptTerraCharges: true });
  const completed = await service.wait(rootId, 'writing', started.task_id, 10000);
  assert.equal(completed.status, 'completed', completed.message);
  assert.equal(completed.executor_backend, 'terra');
  assert.equal(completed.model, TERRA_MODEL);
  assert.equal(completed.report, 'API WRITING OUTPUT');
  assert.equal(completed.steps[0].receipt.backend, 'terra');
  assert.equal(completed.requested_backend, 'Terra');
  assert.equal(factoryCalls, 1);

  const replay = await service.start(rootId, { ...base, acceptTerraCharges: true });
  assert.equal(replay.replayed, true);
  assert.equal(replay.task_id, completed.task_id);
  assert.equal(factoryCalls, 1);

  const missing = await service.start(rootId, {
    ...base, idempotencyKey: 'computer', purpose: 'computer_operation', goal: 'Operate the host.', acceptTerraCharges: true
  });
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.error_code, 'DISPATCH_CAPABILITY_MISSING');
  assert.deepEqual(missing.missing_capabilities, ['computer_operation']);
  assert.equal(factoryCalls, 1);

  const subscriptionRoot = '00000000-0000-4000-8000-000000000702';
  assert.equal((await service.mode(subscriptionRoot)).coordinator_mode, 'subscription');
  const native = await service.start(subscriptionRoot, { ...base, idempotencyKey: 'native' });
  assert.equal(native.status, 'not_dispatched');
  assert.equal(native.dispatch.source, 'subscription');
  assert.equal(native.dispatch.executor.model, TERRA_MODEL);
  await service.close();
});

async function mcpPeer(script, args) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let seq = 0, buffer = '', stderr = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { stderr += text; });
  child.stdout.on('data', data => {
    buffer += data;
    let pos;
    while ((pos = buffer.indexOf('\n')) >= 0) {
      const value = JSON.parse(buffer.slice(0, pos));
      buffer = buffer.slice(pos + 1);
      pending.get(value.id)?.(value);
      pending.delete(value.id);
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(Error(`MCP timeout: ${stderr}`)), 10000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'layered-test', version: '1' } });
  assert.equal(initialized.result.serverInfo.name, 'dsh-opencode-go');
  const call = async (name, argumentsValue) => {
    const reply = await rpc('tools/call', { name, arguments: argumentsValue });
    assert.equal(reply.result.isError, false, reply.result.content?.[0]?.text);
    return JSON.parse(reply.result.content[0].text);
  };
  const close = async () => {
    child.stdin.end();
    await new Promise(resolve => child.once('close', resolve));
  };
  return { call, close };
}

test('actual DSH MCP subscription entry: resolver works, specialist/WorkBuddy handoff, general keyword stays DSH', async t => {
  const runtime = temp(), cwd = temp();
  t.after(() => { fs.rmSync(runtime, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });
  const peer = await mcpPeer(path.join(root, 'bridges', 'dsh', 'server.mjs'), ['--dsh-entry', mock, '--runtime', runtime, '--read-only']);
  t.after(() => peer.close());

  const plan = await peer.call('resolve_layer_dispatch', { purpose: 'image_generation' });
  assert.equal(plan.layer, 'specialist');
  assert.equal(plan.executor.model, TERRA_MODEL);

  const specialist = await peer.call('start_dsh_task', {
    prompt: 'Generate an image.', cwd, idempotencyKey: 'specialist', purpose: 'image_generation'
  });
  assert.equal(specialist.status, 'native_handoff');
  assert.equal(specialist.selected_backend, 'terra');
  assert.equal(specialist.task_id, undefined);

  const workbuddy = await peer.call('start_dsh_task', {
    prompt: 'General coordination.', cwd, idempotencyKey: 'workbuddy', backend: 'WorkBuddy DSF'
  });
  assert.equal(workbuddy.status, 'not_dispatched');
  assert.equal(workbuddy.selected_backend, 'workbuddy-dsf');
  assert.equal(workbuddy.task_id, undefined);

  const started = await peer.call('start_dsh_task', {
    prompt: 'Draw an image, recognize it, and write a report.', cwd, idempotencyKey: 'general-keyword'
  });
  assert.equal(started.backend, 'dsh');
  const receipt = await peer.call('wait_dsh_task', { taskId: started.task_id, waitMs: 5000 });
  assert.equal(receipt.status, 'completed');

  const unknown = await peer.call('resolve_layer_dispatch', { purpose: 'writing', backend: 'Terra' });
  assert.equal(unknown.executor.backend, 'terra');
});

test('public resolver CLI is read-only and rejects unsupported choices', () => {
  const cli = path.join(root, 'bridges', 'dispatch', 'cli.mjs');
  const ok = spawnSync(process.execPath, [cli, 'resolve', '--source', 'api', '--purpose', 'writing'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const plan = JSON.parse(ok.stdout);
  assert.equal(plan.purpose, 'writing');
  assert.equal(plan.executor.model, TERRA_MODEL);
  assert.equal(plan.executor.transport, 'protected-terra');

  const bad = spawnSync(process.execPath, [cli, 'resolve', '--purpose', 'unknown'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stderr).code, 'DISPATCH_PURPOSE_INVALID');
  const conflict = spawnSync(process.execPath, [cli, 'resolve', '--purpose', 'writing', '--backend', 'DSH'], { encoding: 'utf8' });
  assert.equal(conflict.status, 2);
  assert.equal(JSON.parse(conflict.stderr).code, 'DISPATCH_BACKEND_PURPOSE_CONFLICT');
});
