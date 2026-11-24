import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveDispatch, dispatchLayeredTask, SOL_MODEL, SOL_REASONING_EFFORT, DSH_MODEL, DSH_REASONING_EFFORT } from '../bridges/dispatch.mjs';
import { runDispatchCli } from '../bridges/dispatch/cli.mjs';

const cwd = path.resolve('approved-project');
const parentTask = overrides => ({
  cwd, idempotencyKey: 'entry-parent', permissionMode: 'read-only', capability: 'workspace-read', timeoutMs: 5000,
  acceptAntigravityUsage: true, antigravityModel: 'draft', ...overrides
});
const baseInput = overrides => ({
  source: 'subscription', purpose: 'general', prompt: 'Coordinate this approved task.', task: parentTask(), ...overrides
});
const receipt = (overrides = {}) => ({
  agent_id: 'sol-native-agent', returned_model: SOL_MODEL,
  returned_reasoning_effort: SOL_REASONING_EFFORT, ...overrides
});
const dshAdapter = (calls = []) => ({
  async submit(request) {
    calls.push(request);
    return { status: 'completed', task_id: 'dsh-task-1', model: DSH_MODEL,
      reasoning_effort: DSH_REASONING_EFFORT, answer: 'DSH output' };
  }
});

test('resolve defaults to Astra, accepts explicit structures, and rejects invalid values', () => {
  assert.equal(resolveDispatch({}).entry_structure, 'astra');
  assert.equal(resolveDispatch({ entryStructure: 'astra' }).entry_structure, 'astra');
  assert.equal(resolveDispatch({ entryStructure: 'sol' }).entry_structure, 'sol');
  assert.throws(() => resolveDispatch({ entryStructure: 'luna' }), { code: 'DISPATCH_ENTRY_STRUCTURE_INVALID' });
  assert.throws(() => resolveDispatch({ entry_caller: 'user' }), { code: 'DISPATCH_INPUT_INVALID' });

  const output = [], errors = [];
  const exitCode = runDispatchCli(['resolve', '--entry-structure', 'sol', '--source', 'subscription', '--purpose', 'general'], {
    stdout: { write(value) { output.push(value); } }, stderr: { write(value) { errors.push(value); } }
  });
  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(output[0]).entry_structure, 'sol');
  assert.equal(errors.length, 0);

  const invalidErrors = [];
  assert.equal(runDispatchCli(['resolve', '--entry-structure', 'luna'], {
    stdout: { write() {} }, stderr: { write(value) { invalidErrors.push(value); } }
  }), 2);
  assert.equal(JSON.parse(invalidErrors[0]).code, 'DISPATCH_ENTRY_STRUCTURE_INVALID');
});

test('legacy default and explicit Astra continue through the existing coordinator', async () => {
  for (const entryStructure of [undefined, 'astra']) {
    let standardCalls = 0, directCalls = 0;
    const input = baseInput(entryStructure ? { entryStructure } : {});
    const result = await dispatchLayeredTask(input, {
      dsh: dshAdapter(),
      nativeDirectSol: { async coordinate() { directCalls++; assert.fail('Astra must keep the existing coordinator path.'); } },
      coordinator: {
        identity: { role: 'astra' },
        async coordinate() {
          standardCalls++;
          return { status: 'completed', report: 'Astra coordinator result.', coordinator_receipt: receipt() };
        }
      }
    });
    assert.equal(standardCalls, 1);
    assert.equal(directCalls, 0);
    assert.equal(result.entry_structure, 'astra');
    assert.equal(result.entry_caller.role, 'astra');
    assert.equal(result.direct_entry.status, 'not_requested');
  }
});

test('subscription Sol structure requires nativeDirectSol and never falls back to Astra or DSF', async () => {
  let genericCalls = 0, dshCalls = 0;
  await assert.rejects(dispatchLayeredTask(baseInput({ entryStructure: 'sol' }), {
    coordinator: { async coordinate() { genericCalls++; return { status: 'completed' }; } },
    dsh: { async submit() { dshCalls++; return { status: 'completed' }; } }
  }), { code: 'DISPATCH_DIRECT_SOL_UNAVAILABLE' });
  assert.equal(genericCalls, 0);
  assert.equal(dshCalls, 0);
});

test('a trusted Astra caller is blocked before native Sol or downstream execution', async () => {
  let solCalls = 0, genericCalls = 0, dshCalls = 0;
  await assert.rejects(dispatchLayeredTask(baseInput({ entryStructure: 'sol' }), {
    nativeDirectSol: {
      identity: { role: 'astra' },
      async coordinate() { solCalls++; return { status: 'completed', coordinator_receipt: receipt() }; }
    },
    coordinator: { async coordinate() { genericCalls++; } },
    dsh: { async submit() { dshCalls++; } }
  }), error => {
    assert.equal(error.code, 'DISPATCH_DIRECT_SOL_ASTRA_CALLER');
    assert.equal(error.entry_caller.role, 'astra');
    assert.equal(error.direct_entry.status, 'unverified');
    assert.equal(error.direct_entry.reason, 'astra_caller_observed');
    return true;
  });
  assert.equal(solCalls, 0);
  assert.equal(genericCalls, 0);
  assert.equal(dshCalls, 0);
});

test('direct Sol receipt must prove its real ID, model and reasoning effort', async t => {
  for (const badReceipt of [
    receipt({ returned_model: 'gpt-6-luna' }),
    receipt({ returned_reasoning_effort: undefined }),
    receipt({ agent_id: 'sk-0123456789abcdef0123456789abcdef' })
  ]) {
    await t.test(JSON.stringify(badReceipt), async () => {
      let nativeCalls = 0, genericCalls = 0;
      const result = await dispatchLayeredTask(baseInput({ entryStructure: 'sol' }), {
        nativeDirectSol: {
          identity: { role: 'host' },
          async coordinate() {
            nativeCalls++;
            return { status: 'completed', report: 'Unverified Sol receipt.', coordinator_receipt: badReceipt };
          }
        },
        coordinator: { async coordinate() { genericCalls++; assert.fail('Wrong evidence must not fall back.'); } },
        dsh: dshAdapter()
      });
      assert.equal(nativeCalls, 1);
      assert.equal(genericCalls, 0);
      assert.equal(result.status, 'blocked');
      assert.equal(result.error_code, 'DISPATCH_DIRECT_SOL_EVIDENCE');
      assert.equal(result.direct_entry.status, 'unverified');
      assert.equal(result.entry_caller.role, 'host');
    });
  }
});

test('missing trusted caller identity leaves direct entry unverified but preserves model evidence', async () => {
  const result = await dispatchLayeredTask(baseInput({ entryStructure: 'sol' }), {
    nativeDirectSol: {
      async coordinate() { return { status: 'completed', report: 'Result.', coordinator_receipt: receipt() }; }
    },
    dsh: dshAdapter()
  });
  assert.equal(result.entry_caller.role, 'unverified');
  assert.equal(result.direct_entry.status, 'unverified');
  assert.equal(result.direct_entry.model_evidence, 'verified');
  assert.equal(result.direct_entry.returned_model, SOL_MODEL);
  assert.equal(result.direct_entry.returned_reasoning_effort, SOL_REASONING_EFFORT);
});

test('native direct Sol coordinates a real DSH call and an injected Antigravity text peer', async () => {
  const downstreamCalls = [], agyCalls = [], directCalls = [];
  const result = await dispatchLayeredTask(baseInput({ entryStructure: 'sol' }), {
    nativeDirectSol: {
      identity: { role: 'host' },
      async coordinate(args) {
        directCalls.push(args);
        const execution = await args.backend.submit({ purpose: 'general', source: args.source, prompt: 'Use selected DSF.' });
        assert.equal(execution.status, 'completed');
        const peer = await args.delegatePeer({ peer: 'antigravity', idempotencyKey: 'draft-peer',
          goal: 'Draft one paragraph.', acceptance: 'Return standalone text.', contextSummary: 'Approved notes.' });
        assert.equal(peer.status, 'completed');
        return { status: 'completed', report: 'Sol accepted the downstream results.',
          coordinator_receipt: receipt() };
      }
    },
    coordinator: { async coordinate() { assert.fail('The direct Sol entry must not use the generic coordinator.'); } },
    dsh: dshAdapter(downstreamCalls),
    nativeAntigravity: { async dispatch(args) {
      agyCalls.push(args);
      assert.equal(args.request.peer, 'antigravity');
      assert.equal(args.request.purpose, 'writing');
      return { status: 'completed', task_id: 'agy-text-task', report: 'A drafted paragraph.',
        antigravity: { model_alias: 'draft', requested_model: 'models/gemini-2.5-pro' } };
    } }
  });
  assert.equal(directCalls.length, 1);
  assert.equal(downstreamCalls.length, 1);
  assert.equal(agyCalls.length, 1);
  assert.equal(result.entry_structure, 'sol');
  assert.equal(result.entry_caller.role, 'host');
  assert.equal(result.direct_entry.status, 'verified');
  assert.equal(result.direct_entry.agent_id, 'sol-native-agent');
  assert.equal(result.direct_entry.returned_model, SOL_MODEL);
  assert.equal(result.direct_entry.returned_reasoning_effort, SOL_REASONING_EFFORT);
  assert.equal(result.peer_results[0].peer, 'antigravity');
  assert.equal(result.peer_results[0].coordinator_mode, 'subscription');
  if (result.route_evidence) {
    assert.equal(result.route_evidence.downstream.calls[0].returned_model, DSH_MODEL);
    assert.equal(result.route_evidence.coordinator.returned_reasoning_effort, SOL_REASONING_EFFORT);
  }
});

test('API Sol structure uses the existing coordinator and reports direct entry evidence without a native adapter', async () => {
  let directCalls = 0, apiCalls = 0;
  const result = await dispatchLayeredTask(baseInput({ source: 'api', entryStructure: 'sol' }), {
    coordinator: {
      identity: { role: 'host' },
      async coordinate() {
        apiCalls++;
        return { status: 'completed', report: 'API Sol result.', coordinator_receipt: receipt(),
          entry_caller: { role: 'unverified', evidence_source: 'verified_codex_context', thread_id: 'child', thread_kind: 'child' },
          direct_entry: { status: 'verified', model_evidence: 'verified', evidence_source: 'api_response_receipt' },
          route_evidence: { coordinator: { actually_executed: 'observed', evidence_source: 'protected_responses_receipt' } } };
      }
    },
    nativeDirectSol: { async coordinate() { directCalls++; assert.fail('API uses the existing coordinator adapter.'); } },
    dsh: dshAdapter()
  });
  assert.equal(apiCalls, 1);
  assert.equal(directCalls, 0);
  assert.equal(result.entry_structure, 'sol');
  assert.deepEqual(result.entry_caller, {
    role: 'unverified', evidence_source: 'verified_codex_context', thread_id: 'child', thread_kind: 'child'
  });
  assert.equal(result.direct_entry.status, 'verified');
  assert.equal(result.direct_entry.evidence_source, 'api_response_receipt');
  assert.deepEqual(result.route_evidence, {
    coordinator: { actually_executed: 'observed', evidence_source: 'protected_responses_receipt' }
  });
});

test('API Sol metadata is unverified when the service supplies no structured entry receipt', async () => {
  const result = await dispatchLayeredTask(baseInput({ source: 'api', entryStructure: 'sol' }), {
    coordinator: {
      identity: { role: 'host' },
      async coordinate() { return { status: 'completed', report: 'API Sol result.' }; }
    },
    dsh: dshAdapter()
  });
  assert.equal(result.entry_caller.role, 'unverified');
  assert.equal(result.direct_entry.status, 'unverified');
  assert.equal(result.direct_entry.model_evidence, 'unverified');
});
