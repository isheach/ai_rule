import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_TOOL,
  CONFIRM_TOOL,
  FINISH_TOOL,
  TERRA_MODEL,
  TERRA_REASONING_EFFORT,
  TerraClient,
  TerraError
} from '../bridges/terra/client.mjs';

const USAGE = Object.freeze({
  input_tokens: 10,
  output_tokens: 5,
  total_tokens: 15,
  input_tokens_details: { cached_tokens: 1 },
  output_tokens_details: { reasoning_tokens: 2 }
});

function envelope(id, call, { model = TERRA_MODEL, effort = TERRA_REASONING_EFFORT, status = 'completed', usage = USAGE, output } = {}) {
  return {
    id: `resp_${id}`,
    object: 'response',
    created_at: 1760000000,
    model,
    status,
    reasoning: { effort },
    usage,
    output: output ?? [
      { type: 'reasoning', id: `rs_${id}`, encrypted_content: `encrypted_${id}`, summary: [] },
      {
        type: 'message', id: `msg_${id}`, role: 'assistant',
        content: [{ type: 'output_text', text: 'I will use one allowed tool.', annotations: [] }]
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
    const next = responses[served++];
    return typeof next === 'function' ? next(body) : next;
  }
  return { request, bodies, get count() { return served; } };
}

function assertContract(body) {
  assert.equal(body.model, TERRA_MODEL);
  assert.equal(body.reasoning.effort, TERRA_REASONING_EFFORT);
  assert.equal(body.store, false);
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.tool_choice, 'required');
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.ok(Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0);
  for (const field of ['previous_response_id', 'conversation', 'prompt_cache_key']) {
    assert.equal(Object.hasOwn(body, field), false);
  }
  assert.ok(Array.isArray(body.tools));
  for (const tool of body.tools) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.strict, true);
    assert.equal(tool.parameters.additionalProperties, false);
  }
  assert.equal(JSON.stringify(body).includes('sk-'), false);
}

test('confirm_terra_api performs one strict no-side-effect round', async () => {
  let callbacks = 0;
  const mock = transport([envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } })]);
  const client = new TerraClient({
    request: mock.request,
    actions: [{ name: 'inspect', effect: 'read', callback() { callbacks++; return { ok: true }; } }]
  });

  const result = await client.confirm();

  assert.equal(result.confirmed, true);
  assert.equal(result.model, TERRA_MODEL);
  assert.equal(result.response_id, 'resp_1');
  assert.equal(result.evidence.tool, CONFIRM_TOOL);
  assert.equal(result.usage.total_tokens, 15);
  assert.equal(callbacks, 0, 'confirmation must not run a local callback');
  assert.equal(mock.count, 1);
  assertContract(mock.bodies[0]);
  assert.deepEqual(mock.bodies[0].tools.map(tool => tool.name), [CONFIRM_TOOL]);
  assert.equal(mock.bodies[0].tools[0].parameters.properties.result.enum[0], 'ready');
});

test('run replays original reasoning/function_call items and gates write actions', async () => {
  const calls = [];
  const actions = [
    {
      name: 'inspect', effect: 'read', description: 'read local state',
      callback(...args) {
        assert.equal(args.length, 0, 'callbacks receive no model data');
        calls.push('inspect');
        return { ok: true, note: 'inspected' };
      }
    },
    { name: 'install', effect: 'write', requires: ['inspect'], callback() { calls.push('install'); return { ok: true }; } },
    { name: 'verify', effect: 'read', requires: ['install'], callback() { calls.push('verify'); return { ok: true }; } }
  ];
  const responses = [
    envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } }),
    envelope('2', { name: ACTION_TOOL, args: { action: 'inspect' } }),
    envelope('3', { name: ACTION_TOOL, args: { action: 'install' } }),
    envelope('4', { name: ACTION_TOOL, args: { action: 'verify' } }),
    envelope('5', { name: FINISH_TOOL, args: { report: 'Local inspect, install, and verify succeeded.' } })
  ];
  const mock = transport(responses);
  const client = new TerraClient({ request: mock.request, actions, allowWrite: true });

  const result = await client.run({ input: 'Inspect, install, and verify the fixture.' });

  assert.equal(result.status, 'finished');
  assert.equal(result.report, 'Local inspect, install, and verify succeeded.');
  assert.deepEqual(calls, ['inspect', 'install', 'verify']);
  assert.deepEqual(result.actions.map(receipt => receipt.action), ['inspect', 'install', 'verify']);
  assert.equal(result.actions[0].result.note, 'inspected');
  assert.equal(result.rounds.length, 5);
  assert.equal(result.usage.total_tokens, 75);
  assert.equal(mock.count, 5);
  mock.bodies.forEach(assertContract);

  const confirmCall = responses[0].output[2];
  const actionBody = mock.bodies[1];
  assert.ok(actionBody.input.some(item => item.type === 'reasoning' && item.encrypted_content === 'encrypted_1'));
  assert.ok(actionBody.input.some(item => item.type === 'function_call'
    && item.call_id === confirmCall.call_id && item.name === CONFIRM_TOOL));
  assert.ok(actionBody.input.some(item => item.type === 'function_call_output'
    && item.call_id === confirmCall.call_id));
  assert.deepEqual(
    actionBody.input.find(item => item.type === 'reasoning' && item.encrypted_content === 'encrypted_1'),
    responses[0].output[0]
  );

  const inspectCall = responses[1].output[2];
  const installBody = mock.bodies[2];
  const replayCall = installBody.input.findIndex(item => item.type === 'function_call'
    && item.call_id === inspectCall.call_id);
  const replayOutput = installBody.input.findIndex(item => item.type === 'function_call_output'
    && item.call_id === inspectCall.call_id);
  assert.ok(replayCall >= 0 && replayOutput > replayCall, 'call output must follow its replayed call');
  assert.ok(installBody.input.some(item => item.type === 'reasoning' && item.encrypted_content === 'encrypted_2'));
  assert.equal(
    installBody.input.some(item => item.type === 'function_call' && item.call_id === confirmCall.call_id),
    true,
    'earlier rounds stay in the stateless transcript'
  );
  assert.deepEqual(mock.bodies[1].tools.map(tool => tool.name), [ACTION_TOOL, FINISH_TOOL]);
});

for (const badRound of [1, 2, 3]) {
  test(`round ${badRound} rejects a returned model mismatch without further local effects`, async () => {
    let callbacks = 0;
    const actions = [{ name: 'inspect', effect: 'read', callback() { callbacks++; return { ok: true }; } }];
    const mismatch = { model: 'gpt-6.2-sol' };
    const responses = [
      envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } }, badRound === 1 ? mismatch : {}),
      envelope('2', { name: ACTION_TOOL, args: { action: 'inspect' } }, badRound === 2 ? mismatch : {}),
      envelope('3', { name: ACTION_TOOL, args: { action: 'inspect' } }, badRound === 3 ? mismatch : {})
    ];
    const mock = transport(responses);
    const client = new TerraClient({ request: mock.request, actions });

    await assert.rejects(client.run({ input: 'run' }), error => {
      assert.ok(error instanceof TerraError);
      assert.equal(error.code, 'TERRA_ROUTE_MISMATCH');
      return true;
    });
    assert.equal(mock.count, badRound, 'no automatic retry after a rejected envelope');
    assert.equal(callbacks, badRound === 3 ? 1 : 0);
  });
}

test('an action outside the finite enum is rejected with zero callbacks', async () => {
  let callbacks = 0;
  const actions = [{ name: 'inspect', effect: 'read', callback() { callbacks++; return { ok: true }; } }];
  const mock = transport([
    envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } }),
    envelope('2', { name: ACTION_TOOL, args: { action: 'shell' } })
  ]);
  const client = new TerraClient({ request: mock.request, actions });

  await assert.rejects(client.run({ input: 'run' }), error => {
    assert.equal(error.code, 'TERRA_ACTION_UNAUTHORIZED');
    assert.equal(error.state.actions.length, 0);
    return true;
  });
  assert.equal(callbacks, 0);
  assert.equal(mock.count, 2);
  const tool = mock.bodies[1].tools.find(entry => entry.name === ACTION_TOOL);
  assert.deepEqual(tool.parameters.properties.action.enum, ['inspect']);
});

test('a read-only run can finish with local evidence and no write action', async () => {
  const calls = [];
  const actions = [{
    name: 'inspect', effect: 'read',
    callback() { calls.push('inspect'); return { ok: true, evidence: 'fixture-present' }; }
  }];
  const mock = transport([
    envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } }),
    envelope('2', { name: ACTION_TOOL, args: { action: 'inspect' } }),
    envelope('3', { name: FINISH_TOOL, args: { report: 'The local inspect callback reported fixture-present.' } })
  ]);
  const client = new TerraClient({ request: mock.request, actions });

  const result = await client.run({ input: 'Read the fixture and report the local evidence.' });

  assert.equal(result.status, 'finished');
  assert.deepEqual(calls, ['inspect']);
  assert.deepEqual(result.actions, [{ action: 'inspect', effect: 'read', ok: true, result: { ok: true, evidence: 'fixture-present' } }]);
  assert.equal(result.report, 'The local inspect callback reported fixture-present.');
  assert.equal(result.rounds.length, 3);
  const tool = mock.bodies[1].tools.find(entry => entry.name === ACTION_TOOL);
  assert.deepEqual(tool.parameters.properties.action.enum, ['inspect']);
  assert.equal(mock.bodies[1].tools.some(entry => entry.name === ACTION_TOOL), true);
});

test('a declared write action is unavailable unless the caller opts in', async () => {
  const calls = [];
  const actions = [
    { name: 'inspect', effect: 'read', callback() { calls.push('inspect'); return { ok: true }; } },
    { name: 'install', effect: 'write', requires: ['inspect'], callback() { calls.push('install'); return { ok: true }; } }
  ];
  const mock = transport([
    envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } }),
    envelope('2', { name: ACTION_TOOL, args: { action: 'install' } })
  ]);
  const client = new TerraClient({ request: mock.request, actions });

  await assert.rejects(client.run({ input: 'run' }), error => {
    assert.equal(error.code, 'TERRA_ACTION_UNAUTHORIZED');
    return true;
  });
  assert.deepEqual(calls, []);
  const tool = mock.bodies[1].tools.find(entry => entry.name === ACTION_TOOL);
  assert.deepEqual(tool.parameters.properties.action.enum, ['inspect']);
});

test('an out-of-order action is rejected and its callback never runs', async () => {
  const calls = [];
  const actions = [
    { name: 'inspect', effect: 'read', callback() { calls.push('inspect'); return { ok: true }; } },
    { name: 'install', effect: 'write', requires: ['inspect'], callback() { calls.push('install'); return { ok: true }; } }
  ];
  const mock = transport([
    envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } }),
    envelope('2', { name: ACTION_TOOL, args: { action: 'install' } })
  ]);
  const client = new TerraClient({ request: mock.request, actions, allowWrite: true });

  await assert.rejects(client.run({ input: 'run' }), error => {
    assert.equal(error.code, 'TERRA_ACTION_OUT_OF_ORDER');
    assert.deepEqual(error.state.missing, ['inspect']);
    return true;
  });
  assert.deepEqual(calls, []);
  assert.equal(mock.count, 2);
});

test('a failed local result stops the run without retry or further effects', async () => {
  let callbacks = 0;
  const actions = [{
    name: 'inspect', effect: 'read',
    callback() { callbacks++; return { ok: false, code: 'LOCAL_DENIED' }; }
  }];
  const mock = transport([
    envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } }),
    envelope('2', { name: ACTION_TOOL, args: { action: 'inspect' } })
  ]);
  const client = new TerraClient({ request: mock.request, actions });

  await assert.rejects(client.run({ input: 'run' }), error => {
    assert.equal(error.code, 'TERRA_CALLBACK_FAILED');
    assert.equal(error.state.effectUnknown, false);
    assert.equal(error.state.actions.length, 0);
    return true;
  });
  assert.equal(callbacks, 1);
  assert.equal(mock.count, 2, 'a failed callback must not be retried');
});

test('an ambiguous local result is reported as unknown and never retried', async () => {
  let callbacks = 0;
  const actions = [{
    name: 'inspect', effect: 'read',
    callback() { callbacks++; return { note: 'no explicit status' }; }
  }];
  const mock = transport([
    envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } }),
    envelope('2', { name: ACTION_TOOL, args: { action: 'inspect' } })
  ]);
  const client = new TerraClient({ request: mock.request, actions });

  await assert.rejects(client.run({ input: 'run' }), error => {
    assert.equal(error.code, 'TERRA_CALLBACK_UNKNOWN');
    assert.equal(error.state.effectUnknown, true);
    return true;
  });
  assert.equal(callbacks, 1);
  assert.equal(mock.count, 2, 'an unknown local result must not be retried');
});

test('model-supplied extra parameters are rejected before any callback', async () => {
  let callbacks = 0;
  const actions = [{ name: 'inspect', effect: 'read', callback() { callbacks++; return { ok: true }; } }];
  const mock = transport([
    envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } }),
    envelope('2', { name: ACTION_TOOL, args: { action: 'inspect', path: 'C:\\Windows\\System32\\cmd.exe' } })
  ]);
  const client = new TerraClient({ request: mock.request, actions });

  await assert.rejects(client.run({ input: 'run' }), error => {
    assert.equal(error.code, 'TERRA_TOOL_ARGUMENTS');
    assert.equal(error.state.actions.length, 0);
    return true;
  });
  assert.equal(callbacks, 0, 'model data must never become a callback argument');
  assert.equal(mock.count, 2);
});

test('an interrupted transport is not retried after a local effect', async () => {
  const calls = [];
  const actions = [{
    name: 'inspect', effect: 'read',
    callback() { calls.push('inspect'); return { ok: true }; }
  }];
  const mock = transport([
    envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } }),
    envelope('2', { name: ACTION_TOOL, args: { action: 'inspect' } }),
    () => { throw new Error('socket closed'); }
  ]);
  const client = new TerraClient({ request: mock.request, actions });

  await assert.rejects(client.run({ input: 'run' }), error => {
    assert.equal(error.code, 'TERRA_RESPONSE_UNKNOWN');
    assert.equal(error.state.usageUnknown, true);
    assert.deepEqual(error.state.actions.map(receipt => receipt.action), ['inspect']);
    return true;
  });
  assert.deepEqual(calls, ['inspect']);
  assert.equal(mock.count, 3, 'the unknown request must not be replayed');
});

for (const [label, mutate, code] of [
  ['response.id', response => { response.id = 'not-a-response'; }, 'TERRA_INVALID_RESPONSE'],
  ['completion status', response => { response.status = 'incomplete'; }, 'TERRA_INCOMPLETE'],
  ['usage metadata', response => { response.usage = { input_tokens: 1, output_tokens: 2 }; }, 'TERRA_INCOMPLETE'],
  ['reasoning encryption', response => { response.output[0].encrypted_content = ''; }, 'TERRA_REASONING_UNENCRYPTED'],
  ['function call count', response => {
    response.output.push({
      type: 'function_call', id: 'fc_extra', call_id: 'call_extra',
      name: CONFIRM_TOOL, arguments: '{"result":"ready"}', status: 'completed'
    });
  }, 'TERRA_PARALLEL_TOOLS']
]) {
  test(`the confirmation envelope rejects an invalid ${label}`, async () => {
    let callbacks = 0;
    const response = envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } });
    mutate(response);
    const mock = transport([response]);
    const client = new TerraClient({
      request: mock.request,
      actions: [{ name: 'inspect', effect: 'read', callback() { callbacks++; return { ok: true }; } }]
    });

    await assert.rejects(client.confirm(), error => {
      assert.ok(error instanceof TerraError);
      assert.equal(error.code, code);
      return true;
    });
    assert.equal(callbacks, 0);
    assert.equal(mock.count, 1);
  });
}

test('confirmation must return exactly the ready result', async () => {
  let callbacks = 0;
  const mock = transport([envelope('1', { name: CONFIRM_TOOL, args: { result: 'ok' } })]);
  const client = new TerraClient({
    request: mock.request,
    actions: [{ name: 'inspect', effect: 'read', callback() { callbacks++; return { ok: true }; } }]
  });

  await assert.rejects(client.confirm(), error => {
    assert.equal(error.code, 'TERRA_CONFIRMATION_INVALID');
    assert.equal(error.state.confirmed, false);
    return true;
  });
  assert.equal(callbacks, 0);
});

test('cumulative usage is bounded before the next local callback', async () => {
  let callbacks = 0;
  const usage = { input_tokens: 60, output_tokens: 0, total_tokens: 60 };
  const mock = transport([
    envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } }, { usage }),
    envelope('2', { name: ACTION_TOOL, args: { action: 'inspect' } }, { usage })
  ]);
  const client = new TerraClient({
    request: mock.request,
    actions: [{ name: 'inspect', effect: 'read', callback() { callbacks++; return { ok: true }; } }],
    limits: { max_total_tokens: 100 }
  });

  await assert.rejects(client.run({ input: 'run' }), error => {
    assert.equal(error.code, 'TERRA_USAGE_LIMIT');
    assert.equal(error.state.usage.total_tokens, 120);
    return true;
  });
  assert.equal(callbacks, 0);
  assert.equal(mock.count, 2);
});
