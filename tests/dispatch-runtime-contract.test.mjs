import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DSH_MODEL,
  DSH_REASONING_EFFORT,
  SOL_MODEL,
  SOL_REASONING_EFFORT,
  TERRA_MODEL,
  TERRA_REASONING_EFFORT,
  WORKBUDDY_MODEL,
  WORKBUDDY_REASONING_EFFORT,
  DispatchBlockedError,
  dispatchLayeredTask,
  resolveDispatch,
  runApiTerraTask,
  runNativeTerraTask
} from '../bridges/dispatch.mjs';
import {
  ACTION_TOOL,
  CONFIRM_TOOL,
  FINISH_TOOL,
  TerraClient
} from '../bridges/terra/client.mjs';

const USAGE = Object.freeze({
  input_tokens: 10,
  output_tokens: 5,
  total_tokens: 15,
  input_tokens_details: { cached_tokens: 1 },
  output_tokens_details: { reasoning_tokens: 2 }
});

function envelope(id, call, {
  model = TERRA_MODEL,
  effort = TERRA_REASONING_EFFORT,
  status = 'completed'
} = {}) {
  return {
    id: `resp_${id}`,
    object: 'response',
    created_at: 1760000000,
    model,
    status,
    reasoning: { effort },
    usage: { ...USAGE },
    output: [
      { type: 'reasoning', id: `rs_${id}`, encrypted_content: `encrypted_${id}`, summary: [] },
      {
        type: 'message', id: `msg_${id}`, role: 'assistant',
        content: [{ type: 'output_text', text: 'Using one allowed tool.', annotations: [] }]
      },
      {
        type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`,
        name: call.name, arguments: JSON.stringify(call.args), status: 'completed'
      }
    ]
  };
}

function transport(responses) {
  const bodies = [];
  let served = 0;
  async function request(body) {
    bodies.push(body);
    if (served >= responses.length) throw new Error('unexpected Terra request');
    return responses[served++];
  }
  return { request, bodies, get count() { return served; } };
}

async function acceptanceProducerResult() {
  const mock = transport([
    envelope('accept_1', { name: CONFIRM_TOOL, args: { result: 'ready' } }),
    envelope('accept_2', { name: ACTION_TOOL, args: { action: 'inspect_acceptance' } }),
    envelope('accept_3', { name: FINISH_TOOL, args: { report: 'The local receipt was inspected.' } })
  ]);
  const client = new TerraClient({
    request: mock.request,
    actions: [{
      name: 'inspect_acceptance',
      effect: 'read',
      callback: async () => ({ ok: true, source: 'host-fixture', checks: { present: true } })
    }]
  });
  return { result: await client.run({ input: 'Inspect the host receipt.' }), mock };
}

test('real TerraClient writing result has no top-level reasoning_effort and keeps the complete text', async () => {
  const completeText = 'The complete generated text.\n' + '§'.repeat(4000) + '\nEND OF TEXT';
  const mock = transport([
    envelope('write_1', { name: CONFIRM_TOOL, args: { result: 'ready' } }),
    envelope('write_2', { name: FINISH_TOOL, args: { report: completeText } })
  ]);
  const client = new TerraClient({ request: mock.request });
  const raw = await client.run({ input: 'Write the complete text.' });

  assert.equal(Object.hasOwn(raw, 'reasoning_effort'), false);
  assert.equal(raw.model, TERRA_MODEL);
  assert.equal(raw.status, 'finished');
  assert.equal(raw.confirmed, true);
  assert.deepEqual(raw.rounds.map(round => round.tool), [CONFIRM_TOOL, FINISH_TOOL]);
  assert.deepEqual(raw.rounds.map(round => round.response_id), ['resp_write_1', 'resp_write_2']);
  assert.deepEqual(raw.rounds.map(round => round.model), [TERRA_MODEL, TERRA_MODEL]);
  assert.deepEqual(raw.rounds.map(round => round.reasoning_effort),
    [TERRA_REASONING_EFFORT, TERRA_REASONING_EFFORT]);

  const plan = resolveDispatch({ source: 'api', purpose: 'writing' });
  const receipt = await runApiTerraTask({
    plan,
    prompt: 'Write the complete text.',
    terraClient: { async run() { return raw; } }
  });

  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.model, TERRA_MODEL);
  assert.equal(receipt.returned_model, TERRA_MODEL);
  assert.equal(receipt.reasoning_effort, TERRA_REASONING_EFFORT);
  assert.equal(receipt.returned_reasoning_effort, TERRA_REASONING_EFFORT);
  assert.equal(receipt.requested_reasoning_effort, TERRA_REASONING_EFFORT);
  assert.equal(receipt.text, completeText);
  assert.equal(receipt.report, completeText);
  assert.deepEqual(receipt.actions, []);
  assert.deepEqual(receipt.response_ids, ['resp_write_1', 'resp_write_2']);
  assert.deepEqual(receipt.rounds, raw.rounds);
});

const NON_WRITING = [
  ['computer_operation', 'computer_operation', true],
  ['acceptance', 'inspect_acceptance', false],
  ['image_generation', 'generate_image', true],
  ['image_recognition', 'recognize_image', false]
];

for (const [purpose, actionName, allowWrite] of NON_WRITING) {
  test(`a model-only finish is rejected for ${purpose}`, async () => {
    let capabilityRuns = 0;
    const plan = resolveDispatch({ source: 'api', purpose });
    const mock = transport([
      envelope(`finish_${purpose}_1`, { name: CONFIRM_TOOL, args: { result: 'ready' } }),
      envelope(`finish_${purpose}_2`, { name: FINISH_TOOL, args: { report: 'I finished without acting.' } })
    ]);
    const client = new TerraClient({ request: mock.request });

    await assert.rejects(runApiTerraTask({
      plan,
      prompt: 'Use the selected host capability.',
      capabilities: {
        [purpose]: {
          run: async () => { capabilityRuns++; return { ok: true }; }
        }
      },
      allowWrite,
      terraClient: client
    }), error => {
      assert.ok(error instanceof DispatchBlockedError);
      assert.equal(error.code, 'DISPATCH_TERRA_ACTION_MISSING');
      assert.deepEqual(error.missing_actions, [actionName]);
      return true;
    });
    assert.equal(capabilityRuns, 0);
    assert.equal(mock.count, 2);
  });
}

for (const [purpose, actionName, allowWrite] of NON_WRITING) {
  test(`a real ${purpose} action receipt is preserved and accepted`, async () => {
    let capabilityRuns = 0;
    let receivedActions = null;
    const hostResult = {
      ok: true,
      source: 'host-fixture',
      capability: purpose,
      evidence: { receipt: `${purpose}-receipt`, checked: [1, 2, 3] }
    };
    const plan = resolveDispatch({ source: 'api', purpose });
    const mock = transport([
      envelope(`action_${purpose}_1`, { name: CONFIRM_TOOL, args: { result: 'ready' } }),
      envelope(`action_${purpose}_2`, { name: ACTION_TOOL, args: { action: actionName } }),
      envelope(`action_${purpose}_3`, { name: FINISH_TOOL, args: { report: `Finished ${purpose}.` } })
    ]);

    const receipt = await runApiTerraTask({
      plan,
      prompt: 'Use the selected host capability.',
      capabilities: {
        [purpose]: {
          run: async () => { capabilityRuns++; return hostResult; }
        }
      },
      allowWrite,
      terraFactory({ actions }) {
        receivedActions = actions;
        return new TerraClient({ request: mock.request, actions, allowWrite });
      }
    });

    assert.equal(capabilityRuns, 1);
    assert.deepEqual(receivedActions.map(action => action.name), [actionName]);
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.actions.length, 1);
    assert.equal(receipt.actions[0].action, actionName);
    assert.equal(receipt.actions[0].effect, allowWrite ? 'write' : 'read');
    assert.equal(receipt.actions[0].ok, true);
    assert.deepEqual(receipt.actions[0].result, hostResult,
      'the real local action result is preserved, not replaced by model text');
    assert.deepEqual(receipt.rounds.map(round => round.tool),
      [CONFIRM_TOOL, ACTION_TOOL, FINISH_TOOL]);
    assert.deepEqual(receipt.response_ids,
      [`resp_action_${purpose}_1`, `resp_action_${purpose}_2`, `resp_action_${purpose}_3`]);
    assert.equal(receipt.rounds[1].model, TERRA_MODEL);
    assert.equal(receipt.rounds[1].reasoning_effort, TERRA_REASONING_EFFORT);
  });
}

test('round evidence rejects missing confirmation, route mismatches, duplicate IDs and false action evidence', async () => {
  const { result: valid } = await acceptanceProducerResult();
  const plan = resolveDispatch({ source: 'api', purpose: 'acceptance' });
  const capabilities = { acceptance: { run: async () => ({ ok: true }) } };

  const cases = [
    ['missing confirmation', value => { value.rounds.shift(); }, 'DISPATCH_TERRA_EVIDENCE_INVALID'],
    ['wrong round model', value => { value.rounds[1].model = 'gpt-6.2-sol'; }, 'DISPATCH_TERRA_ROUTE_MISMATCH'],
    ['wrong round effort', value => { value.rounds[1].reasoning_effort = 'high'; }, 'DISPATCH_TERRA_ROUTE_MISMATCH'],
    ['duplicate response ID', value => { value.rounds[2].response_id = value.rounds[1].response_id; }, 'DISPATCH_TERRA_EVIDENCE_INVALID'],
    ['missing finish round', value => { value.rounds.pop(); }, 'DISPATCH_TERRA_INCOMPLETE'],
    ['finish in the middle', value => { value.rounds[1].tool = FINISH_TOOL; }, 'DISPATCH_TERRA_EVIDENCE_INVALID'],
    ['receipt count mismatch', value => { value.actions = []; }, 'DISPATCH_TERRA_EVIDENCE_INVALID'],
    ['failed receipt', value => { value.actions[0].ok = false; }, 'DISPATCH_TERRA_ACTION_INVALID'],
    ['failed local result', value => { value.actions[0].result.ok = false; }, 'DISPATCH_TERRA_ACTION_INVALID'],
    ['top-level label conflict', value => { value.reasoning_effort = 'high'; }, 'DISPATCH_TERRA_ROUTE_MISMATCH'],
    ['unexpected action', value => {
      value.rounds.splice(value.rounds.length - 1, 0, {
        response_id: 'resp_accept_extra',
        model: TERRA_MODEL,
        status: 'completed',
        reasoning_effort: TERRA_REASONING_EFFORT,
        tool: ACTION_TOOL,
        usage: { ...USAGE }
      });
      value.actions.push({ action: 'generate_image', effect: 'write', ok: true, result: { ok: true } });
    }, 'DISPATCH_TERRA_ACTION_INVALID']
  ];

  for (const [label, mutate, code] of cases) {
    const value = structuredClone(valid);
    mutate(value);
    await assert.rejects(runApiTerraTask({
      plan,
      prompt: 'Accept the local work.',
      capabilities,
      terraClient: { async run() { return value; } }
    }), error => {
      assert.ok(error instanceof DispatchBlockedError, label);
      assert.equal(error.code, code, label);
      return true;
    });
  }
});

test('a true TerraClient action failure is propagated and never reported as completion', async () => {
  let capabilityRuns = 0;
  const plan = resolveDispatch({ source: 'api', purpose: 'acceptance' });
  const mock = transport([
    envelope('fail_1', { name: CONFIRM_TOOL, args: { result: 'ready' } }),
    envelope('fail_2', { name: ACTION_TOOL, args: { action: 'inspect_acceptance' } })
  ]);

  await assert.rejects(runApiTerraTask({
    plan,
    prompt: 'Accept the local work.',
    capabilities: {
      acceptance: {
        run: async () => {
          capabilityRuns++;
          return { ok: false, reason: 'host refused the read' };
        }
      }
    },
    terraFactory({ actions }) {
      return new TerraClient({ request: mock.request, actions });
    }
  }), error => {
    assert.equal(error.code, 'TERRA_CALLBACK_FAILED');
    assert.match(error.message, /reported failure/);
    return true;
  });
  assert.equal(capabilityRuns, 1);
  assert.equal(mock.count, 2);
});

test('native Terra preserves actual model, effort, capabilities and local action results', async () => {
  const plan = resolveDispatch({ source: 'subscription', purpose: 'acceptance' });
  const seen = [];
  const nativeTerra = {
    capabilities: ['acceptance'],
    async dispatch(request) {
      seen.push(request);
      return {
        status: 'completed',
        model: TERRA_MODEL,
        reasoning_effort: TERRA_REASONING_EFFORT,
        text: 'The native host inspected the receipt.',
        actions: [{
          action: 'inspect_acceptance',
          effect: 'read',
          ok: true,
          result: { ok: true, source: 'native-host', checks: { present: true } }
        }]
      };
    }
  };

  const receipt = await runNativeTerraTask({ plan, prompt: 'Accept the local work.', nativeTerra });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, TERRA_MODEL);
  assert.equal(seen[0].reasoning_effort, TERRA_REASONING_EFFORT);
  assert.deepEqual(seen[0].required_capabilities, ['acceptance']);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.model, TERRA_MODEL);
  assert.equal(receipt.reasoning_effort, TERRA_REASONING_EFFORT);
  assert.equal(receipt.returned_model, TERRA_MODEL);
  assert.equal(receipt.returned_reasoning_effort, TERRA_REASONING_EFFORT);
  assert.equal(receipt.text, 'The native host inspected the receipt.');
  assert.deepEqual(receipt.actions, nativeTerraResultActions());
});

function nativeTerraResultActions() {
  return [{
    action: 'inspect_acceptance',
    effect: 'read',
    ok: true,
    result: { ok: true, source: 'native-host', checks: { present: true } }
  }];
}

test('native Terra fails closed on missing identity, capabilities and action evidence', async () => {
  const plan = resolveDispatch({ source: 'subscription', purpose: 'acceptance' });
  let calls = 0;
  const valid = {
    status: 'completed',
    model: TERRA_MODEL,
    reasoning_effort: TERRA_REASONING_EFFORT,
    text: 'accepted',
    actions: [{ action: 'inspect_acceptance', effect: 'read', ok: true, result: { ok: true } }]
  };

  await assert.rejects(runNativeTerraTask({
    plan,
    prompt: 'Accept.',
    nativeTerra: {
      capabilities: [],
      async dispatch() { calls++; return valid; }
    }
  }), error => {
    assert.equal(error.code, 'DISPATCH_CAPABILITY_MISSING');
    assert.deepEqual(error.missing_capabilities, ['acceptance']);
    return true;
  });
  assert.equal(calls, 0);

  for (const [label, result, code] of [
    ['missing model', { ...valid, model: undefined }, 'DISPATCH_TERRA_ROUTE_MISMATCH'],
    ['wrong model', { ...valid, model: 'gpt-6.2-sol' }, 'DISPATCH_TERRA_ROUTE_MISMATCH'],
    ['missing effort', { ...valid, reasoning_effort: undefined }, 'DISPATCH_TERRA_ROUTE_MISMATCH'],
    ['wrong effort', { ...valid, reasoning_effort: 'high' }, 'DISPATCH_TERRA_ROUTE_MISMATCH'],
    ['missing action', { ...valid, actions: [] }, 'DISPATCH_TERRA_ACTION_MISSING'],
    ['failed action', {
      ...valid,
      actions: [{ action: 'inspect_acceptance', effect: 'read', ok: false, result: { ok: false } }]
    }, 'DISPATCH_TERRA_ACTION_INVALID']
  ]) {
    await assert.rejects(runNativeTerraTask({
      plan,
      prompt: 'Accept.',
      nativeTerra: {
        capabilities: ['acceptance'],
        async dispatch() { return result; }
      }
    }), error => {
      assert.equal(error.code, code, label);
      return true;
    });
  }
});

test('native Terra writing returns the complete text without fabricated actions', async () => {
  const plan = resolveDispatch({ source: 'subscription', purpose: 'writing' });
  const completeText = 'Complete native text.\n' + 'x'.repeat(3000);
  const receipt = await runNativeTerraTask({
    plan,
    prompt: 'Write.',
    nativeTerra: {
      capabilities: [],
      async dispatch() {
        return {
          status: 'completed',
          model: TERRA_MODEL,
          reasoning_effort: TERRA_REASONING_EFFORT,
          text: completeText
        };
      }
    }
  });
  assert.equal(receipt.text, completeText);
  assert.equal(receipt.report, completeText);
  assert.deepEqual(receipt.actions, []);
  assert.equal(receipt.model, TERRA_MODEL);
  assert.equal(receipt.reasoning_effort, TERRA_REASONING_EFFORT);
});

test('generic dispatch requires a Sol coordinator for both sources and hands it the selected backend', async () => {
  const events = [];
  const dshCalls = [];
  const workbuddyCalls = [];
  const dsh = {
    async submit(request) {
      events.push('dsh');
      dshCalls.push(request);
      return {
        status: 'completed', backend: 'dsh', task_id: 'dsh-real', model: DSH_MODEL,
        reasoning_effort: DSH_REASONING_EFFORT, answer: 'dsh actual output'
      };
    }
  };
  const workbuddy = {
    async dispatch(request) {
      events.push('workbuddy');
      workbuddyCalls.push(request);
      return {
        status: 'completed', backend: 'workbuddy-dsf', task_id: 'wb-real', model: WORKBUDDY_MODEL,
        reasoning_effort: WORKBUDDY_REASONING_EFFORT, answer: 'workbuddy actual output'
      };
    }
  };
  const coordinator = {
    async coordinate(request) {
      events.push(['coordinator', request.source, request.backend.backend]);
      assert.equal(request.model, SOL_MODEL);
      assert.equal(request.reasoning_effort, SOL_REASONING_EFFORT);
      return request.backend.submit({
        plan: request.plan, prompt: request.prompt, task: request.task,
        purpose: request.purpose, source: request.source
      });
    }
  };

  const api = await dispatchLayeredTask({
    source: 'api', purpose: 'general', prompt: 'Coordinate the API task.'
  }, { coordinator, dsh });
  assert.deepEqual(events, [['coordinator', 'api', 'dsh'], 'dsh']);
  assert.equal(dshCalls.length, 1);
  assert.equal(api.model, DSH_MODEL, 'the actual DSH model is not overwritten by the Sol label');
  assert.equal(api.reasoning_effort, DSH_REASONING_EFFORT);
  assert.equal(api.selected_backend, 'dsh');
  assert.equal(api.requested_model, DSH_MODEL);
  assert.equal(api.requested_coordinator.model, SOL_MODEL);
  assert.equal(api.route_evidence.coordinator.actually_executed, 'unverified');
  assert.equal(api.route_evidence.downstream.calls[0].task_id, 'dsh-real');
  assert.equal(api.route_evidence.downstream.calls[0].returned_model, DSH_MODEL);

  events.length = 0;
  const subscription = await dispatchLayeredTask({
    source: 'subscription', purpose: 'general', backend: 'WorkBuddy DSF',
    prompt: 'Coordinate the subscription task.'
  }, { coordinator, workbuddy });
  assert.deepEqual(events, [['coordinator', 'subscription', 'workbuddy-dsf'], 'workbuddy']);
  assert.equal(workbuddyCalls.length, 1);
  assert.equal(subscription.model, WORKBUDDY_MODEL);
  assert.equal(subscription.reasoning_effort, WORKBUDDY_REASONING_EFFORT);
  assert.equal(subscription.selected_backend, 'workbuddy-dsf');

  const routeOnly = await dispatchLayeredTask({ prompt: 'Check the route evidence.' }, {
    dsh, coordinator: { coordinate: () => ({ status: 'completed', requested_model: SOL_MODEL }) }
  });
  assert.equal(routeOnly.route_evidence.coordinator.actually_executed, 'unverified');
  assert.equal(routeOnly.route_evidence.downstream.actually_executed, 'unverified');
});

test('generic dispatch fails closed without a coordinator, selected backend, or coordinator entry', async () => {
  let dshCalls = 0;
  let coordinatorCalls = 0;
  const dsh = {
    async submit() {
      dshCalls++;
      return { status: 'completed', model: DSH_MODEL };
    }
  };
  const coordinator = {
    async coordinate() {
      coordinatorCalls++;
      return { status: 'completed', model: DSH_MODEL };
    }
  };

  for (const options of [{ dsh }, { dsh, coordinator: undefined }, {}]) {
    await assert.rejects(dispatchLayeredTask({
      purpose: 'general', prompt: 'No coordinator.'
    }, options), error => {
      assert.equal(error.code, 'DISPATCH_COORDINATOR_MISSING');
      assert.deepEqual(error.missing_adapters, ['sol_coordinator']);
      return true;
    });
  }
  assert.equal(dshCalls, 0);

  await assert.rejects(dispatchLayeredTask({
    purpose: 'general', prompt: 'No selected backend.'
  }, { coordinator }), error => {
    assert.equal(error.code, 'DISPATCH_EXECUTOR_UNAVAILABLE');
    assert.deepEqual(error.missing_adapters, ['dsh']);
    return true;
  });
  assert.equal(coordinatorCalls, 0);

  await assert.rejects(dispatchLayeredTask({
    purpose: 'general', prompt: 'Raw adapter is not Sol.'
  }, { coordinator: dsh, dsh }), error => {
    assert.equal(error.code, 'DISPATCH_COORDINATOR_INVALID');
    assert.deepEqual(error.missing_adapters, ['sol_coordinator']);
    return true;
  });
  assert.equal(dshCalls, 0);
});

test('a lower adapter is accepted only when it actually implements the coordinator entry', async () => {
  const calls = [];
  const owner = {
    async coordinate(request) {
      calls.push('coordinate');
      return request.backend.submit({
        plan: request.plan, prompt: request.prompt, task: request.task,
        purpose: request.purpose, source: request.source
      });
    },
    async submit(request) {
      calls.push('submit');
      assert.equal(request.purpose, 'general');
      return {
        status: 'completed', backend: 'dsh', task_id: 'owner-real',
        model: DSH_MODEL, reasoning_effort: DSH_REASONING_EFFORT
      };
    }
  };

  const receipt = await dispatchLayeredTask({
    source: 'subscription', purpose: 'general', prompt: 'Owner entry task.'
  }, { coordinator: owner, dsh: owner });
  assert.deepEqual(calls, ['coordinate', 'submit']);
  assert.equal(receipt.model, DSH_MODEL);
  assert.equal(receipt.backend, 'dsh');
});
