import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DispatchBlockedError,
  TERRA_MODEL,
  TERRA_REASONING_EFFORT,
  dispatchLayeredTask,
  resolveDispatch,
  runApiTerraTask
} from '../bridges/dispatch.mjs';
import {
  ACTION_TOOL,
  CONFIRM_TOOL,
  FINISH_TOOL,
  TerraClient
} from '../bridges/terra/client.mjs';

// The API path must validate an action receipt against the name/effect pairs
// that runApiTerraTask actually approved and handed to the factory, not against
// the per-capability DEFAULT_EFFECTS table and not against the receipt itself.

const ACTION_FOR = Object.freeze({
  computer_operation: 'computer_operation',
  acceptance: 'inspect_acceptance',
  image_generation: 'generate_image',
  image_recognition: 'recognize_image'
});

function envelope(id, call) {
  return {
    id: `resp_${id}`,
    object: 'response',
    created_at: 1760000000,
    model: TERRA_MODEL,
    status: 'completed',
    reasoning: { effort: TERRA_REASONING_EFFORT },
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    output: [
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

function transport(envelopes) {
  let index = 0;
  const bodies = [];
  return {
    bodies,
    get count() { return index; },
    async request(body) {
      bodies.push(body);
      if (index >= envelopes.length) throw Error('unexpected Terra request');
      return envelopes[index++];
    }
  };
}

function round(id, tool) {
  return {
    response_id: `resp_${id}`,
    model: TERRA_MODEL,
    status: 'completed',
    reasoning_effort: TERRA_REASONING_EFFORT,
    tool,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  };
}

function finishedResult({ actions, actionRounds = actions.length, report = 'Finished from local evidence.' }) {
  const rounds = [round('confirm', CONFIRM_TOOL)];
  for (let index = 0; index < actionRounds; index++) rounds.push(round(`action_${index}`, ACTION_TOOL));
  rounds.push(round('finish', FINISH_TOOL));
  return { status: 'finished', confirmed: true, model: TERRA_MODEL, report, actions, rounds };
}

test('explicitly authorized write acceptance passes in workspace-write and preserves the write receipt', async () => {
  let hostRuns = 0;
  let factoryActions = null;
  const hostResult = { ok: true, source: 'host-fixture', verdict: 'accepted' };
  const mock = transport([
    envelope('accept_write_1', { name: CONFIRM_TOOL, args: { result: 'ready' } }),
    envelope('accept_write_2', { name: ACTION_TOOL, args: { action: 'inspect_acceptance' } }),
    envelope('accept_write_3', { name: FINISH_TOOL, args: { report: 'Accepted from the host receipt.' } })
  ]);

  const receipt = await dispatchLayeredTask({
    source: 'api',
    purpose: 'acceptance',
    prompt: 'Accept the completed local work.',
    permissionMode: 'workspace-write'
  }, {
    capabilities: {
      acceptance: {
        effect: 'write',
        run: async () => {
          hostRuns++;
          return hostResult;
        }
      }
    },
    terraFactory({ actions, allowWrite }) {
      factoryActions = actions;
      assert.equal(allowWrite, true);
      assert.deepEqual(actions.map(action => [action.name, action.effect]),
        [['inspect_acceptance', 'write']]);
      return new TerraClient({ request: mock.request, actions, allowWrite });
    }
  });

  assert.equal(hostRuns, 1);
  assert.equal(mock.count, 3);
  assert.deepEqual(factoryActions.map(action => [action.name, action.effect]),
    [['inspect_acceptance', 'write']]);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.actions.length, 1);
  assert.equal(receipt.actions[0].action, 'inspect_acceptance');
  assert.equal(receipt.actions[0].effect, 'write');
  assert.equal(receipt.actions[0].ok, true);
  assert.deepEqual(receipt.actions[0].result, hostResult,
    'the actual local write-acceptance result is preserved');
});

test('explicitly authorized read computer_operation is not judged by its default write effect', async () => {
  let hostRuns = 0;
  const hostResult = { ok: true, source: 'host-fixture', checks: { present: true } };
  const mock = transport([
    envelope('read_check_1', { name: CONFIRM_TOOL, args: { result: 'ready' } }),
    envelope('read_check_2', { name: ACTION_TOOL, args: { action: 'computer_operation' } }),
    envelope('read_check_3', { name: FINISH_TOOL, args: { report: 'The read-only check passed.' } })
  ]);

  const receipt = await dispatchLayeredTask({
    source: 'api',
    purpose: 'computer_operation',
    prompt: 'Check the computer state without changing it.',
    permissionMode: 'read-only'
  }, {
    capabilities: {
      computer_operation: {
        effect: 'read',
        run: async () => {
          hostRuns++;
          return hostResult;
        }
      }
    },
    terraFactory({ actions, allowWrite }) {
      assert.equal(allowWrite, false);
      return new TerraClient({ request: mock.request, actions, allowWrite });
    }
  });

  assert.equal(hostRuns, 1);
  assert.equal(mock.count, 3);
  assert.equal(receipt.actions.length, 1);
  assert.equal(receipt.actions[0].action, 'computer_operation');
  assert.equal(receipt.actions[0].effect, 'read');
  assert.deepEqual(receipt.actions[0].result, hostResult);
});

test('an explicitly write-declared acceptance is blocked before the factory without workspace-write', async () => {
  let factoryCalls = 0;
  let hostRuns = 0;

  await assert.rejects(dispatchLayeredTask({
    source: 'api',
    purpose: 'acceptance',
    prompt: 'Accept the completed local work.'
  }, {
    capabilities: {
      acceptance: {
        effect: 'write',
        run: async () => {
          hostRuns++;
          return { ok: true };
        }
      }
    },
    terraFactory() {
      factoryCalls++;
      throw Error('the factory must not be called before write authorization');
    }
  }), error => {
    assert.ok(error instanceof DispatchBlockedError);
    assert.equal(error.code, 'DISPATCH_PERMISSION_REQUIRED');
    return true;
  });

  assert.equal(factoryCalls, 0, 'no Terra client is constructed before authorization');
  assert.equal(hostRuns, 0, 'the host capability never runs before authorization');
});

test('a receipt effect different from the authorized effect is rejected even when it matches the default', async () => {
  const cases = [
    {
      label: 'acceptance authorized write but receipt claims read',
      purpose: 'acceptance',
      authorized: 'write',
      receipt: 'read',
      allowWrite: true
    },
    {
      label: 'computer_operation authorized read but receipt claims write',
      purpose: 'computer_operation',
      authorized: 'read',
      receipt: 'write',
      allowWrite: false
    }
  ];

  for (const entry of cases) {
    const plan = resolveDispatch({ source: 'api', purpose: entry.purpose });
    await assert.rejects(runApiTerraTask({
      plan,
      prompt: 'Use the selected host capability.',
      capabilities: {
        [entry.purpose]: { effect: entry.authorized, run: async () => ({ ok: true }) }
      },
      allowWrite: entry.allowWrite,
      terraClient: {
        async run() {
          return finishedResult({
            actions: [{
              action: ACTION_FOR[entry.purpose],
              effect: entry.receipt,
              ok: true,
              result: { ok: true }
            }]
          });
        }
      }
    }), error => {
      assert.ok(error instanceof DispatchBlockedError, entry.label);
      assert.equal(error.code, 'DISPATCH_TERRA_ACTION_INVALID', entry.label);
      assert.match(error.message,
        new RegExp(`reported effect ${entry.receipt}, not ${entry.authorized}`), entry.label);
      return true;
    });
  }
});

test('the authorized snapshot is taken before the factory and cannot be relaxed by it', async () => {
  const plan = resolveDispatch({ source: 'api', purpose: 'acceptance' });

  await assert.rejects(runApiTerraTask({
    plan,
    prompt: 'Accept the completed local work.',
    capabilities: {
      acceptance: { effect: 'write', run: async () => ({ ok: true }) }
    },
    allowWrite: true,
    terraFactory({ actions }) {
      actions[0].effect = 'read';
      return {
        async run() {
          return finishedResult({
            actions: [{
              action: 'inspect_acceptance',
              effect: 'read',
              ok: true,
              result: { ok: true }
            }]
          });
        }
      };
    }
  }), error => {
    assert.ok(error instanceof DispatchBlockedError);
    assert.equal(error.code, 'DISPATCH_TERRA_ACTION_INVALID');
    return true;
  });
});

test('a missing local receipt is still rejected after an authorized action', async () => {
  const plan = resolveDispatch({ source: 'api', purpose: 'acceptance' });

  await assert.rejects(runApiTerraTask({
    plan,
    prompt: 'Accept the completed local work.',
    capabilities: {
      acceptance: { effect: 'write', run: async () => ({ ok: true }) }
    },
    allowWrite: true,
    terraClient: {
      async run() {
        return finishedResult({ actions: [], actionRounds: 0 });
      }
    }
  }), error => {
    assert.ok(error instanceof DispatchBlockedError);
    assert.equal(error.code, 'DISPATCH_TERRA_ACTION_MISSING');
    assert.deepEqual(error.missing_actions, ['inspect_acceptance']);
    return true;
  });
});
