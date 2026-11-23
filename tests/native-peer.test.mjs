import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { dispatchLayeredTask, LUNA_MODEL, LUNA_REASONING_EFFORT, TERRA_MODEL } from '../bridges/dispatch.mjs';

const cwd = path.resolve('approved-project');
const request = (peer, idempotencyKey = peer) => ({
  peer, idempotencyKey, goal: 'Check the part assigned by Sol.',
  acceptance: 'Return the actual checks performed.', contextSummary: 'Share this task context.'
});
const owner = (coordinate, options = {}) => ({
  coordinator: { coordinate },
  dsh: { submit() { assert.fail('A peer request must be initiated by Sol and use its native adapter.'); } },
  ...options
});
const task = overrides => ({
  cwd, idempotencyKey: 'approved-parent', permissionMode: 'read-only', capability: 'workspace-read',
  timeoutMs: 8000, ...overrides
});
const run = (approvedTask, options, source = 'subscription') => dispatchLayeredTask({
  source, prompt: 'Coordinate the authorized task.', task: approvedTask
}, options);

test('subscription Sol can dispatch both peers with the same frozen permissions and real receipts', async () => {
  const calls = [];
  const deadline = Date.now() + 6000;
  const allowed = task({
    permissionMode: 'workspace-write', capability: 'workspace-write', deadline,
    authorizationNote: 'User approved the project writes and this command.',
    writeScopes: [{ path: cwd, operations: ['edit'] }],
    writes: [{ path: path.join(cwd, 'approved.txt'), mode: 'edit' }],
    commands: ['node check.mjs'], limits: { max_responses: 4 }
  });
  const approved = structuredClone(allowed);
  function adapter(peer, expectedModel) {
    return {
      async dispatch(args) {
        calls.push(args);
        assert.equal(args.peer, peer);
        assert.equal(args.model, expectedModel);
        assert.equal(args.reasoning_effort, 'max');
        assert.equal(args.source, 'subscription');
        assert.equal(args.acceptance, request(peer).acceptance);
        assert.equal(args.contextSummary, request(peer).contextSummary);
        for (const field of ['cwd', 'permissionMode', 'capability', 'writeScopes', 'writes', 'commands', 'authorizationNote', 'deadline', 'limits']) {
          assert.deepEqual(args.task[field], approved[field]);
        }
        assert.equal(args.task.parentIdempotencyKey, approved.idempotencyKey);
        assert.ok(args.task.timeoutMs > 0 && args.task.timeoutMs <= approved.timeoutMs);
        assert.ok(Object.isFrozen(args.task.writeScopes[0].operations));
        return {
          status: 'completed', agent_id: `${peer}-agent`, model: expectedModel,
          reasoning_effort: 'max', report: `${peer} checked the approved project`, usage: { total_tokens: 7 }
        };
      }
    };
  }
  const result = await run(allowed, owner(async ({ task: coordinatorTask, delegatePeer }) => {
    assert.equal(calls.length, 0);
    // The coordinator's task object is not the authority captured for its peers.
    coordinatorTask.cwd = path.dirname(cwd);
    coordinatorTask.commands.push('node other.mjs');
    coordinatorTask.writeScopes[0].operations.push('replace');
    const terra = delegatePeer(request('terra'));
    const luna = delegatePeer(request('luna'));
    assert.equal(delegatePeer(request('luna')), luna);
    assert.throws(() => delegatePeer({ ...request('terra'), goal: 'Different work.' }), { code: 'DISPATCH_NATIVE_PEER_KEY_REUSED' });
    const outcomes = await Promise.all([terra, luna]);
    assert.ok(Object.isFrozen(outcomes[0].usage));
    return { status: 'completed', report: 'Sol accepted the full task.' };
  }, { nativeTerra: adapter('terra', TERRA_MODEL), nativeLuna: adapter('luna', LUNA_MODEL) }));
  assert.equal(LUNA_MODEL, 'gpt-6-luna');
  assert.equal(LUNA_REASONING_EFFORT, 'max');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].task.idempotencyKey, calls[1].task.idempotencyKey);
  assert.deepEqual(result.peer_results.map(item => [item.peer, item.agent_id, item.usage.total_tokens]), [
    ['terra', 'terra-agent', 7], ['luna', 'luna-agent', 7]
  ]);
});

test('native peers reject scope changes, stay on the selected source, and surface missing adapters', async () => {
  let calls = 0;
  const nativeTerra = { dispatch() { calls++; assert.fail('A missing Luna must never be substituted.'); } };
  const missing = await run(task(), owner(async ({ delegatePeer }) => {
    for (const override of [{ cwd: path.dirname(cwd) }, { commands: [] }, { permissionMode: 'workspace-write' },
      { source: 'api' }, { limits: {} }, { timeoutMs: 4000 }, { peer: 'sol' }]) {
      assert.throws(() => delegatePeer({ ...request('luna'), ...override }), { code: 'DISPATCH_NATIVE_PEER_REQUEST' });
    }
    return delegatePeer(request('luna'));
  }, { nativeTerra }));
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.error_code, 'DISPATCH_NATIVE_PEER_MISSING');
  assert.equal(calls, 0);

  await run(task({ commands: ['node check.mjs'] }), owner(({ delegatePeer }) => {
    assert.throws(() => delegatePeer(request('terra')), { code: 'DISPATCH_NATIVE_PEER_SCOPE' });
    return { status: 'blocked' };
  }, { nativeTerra }));

  await run(task(), owner(({ delegatePeer }) => {
    assert.equal(delegatePeer, undefined);
    return { status: 'completed' };
  }, { nativeTerra }), 'api');
});

test('read-only peers can overlap and shared-write peers wait for the original evidence', async t => {
  for (const { permissionMode, firstStatus } of [
    { permissionMode: 'read-only', firstStatus: 'completed' },
    { permissionMode: 'workspace-write', firstStatus: 'completed' },
    { permissionMode: 'workspace-write', firstStatus: 'unknown_after_disconnect' }
  ]) {
    await t.test(`${permissionMode} / ${firstStatus}`, async () => {
      const calls = [];
      const started = Promise.withResolvers();
      const release = Promise.withResolvers();
      const winner = (peer, model, status) => ({ status, agent_id: peer, model, reasoning_effort: 'max' });
      const options = owner(async ({ delegatePeer }) => {
        await Promise.all([delegatePeer(request('terra')), delegatePeer(request('luna'))]);
        return { status: 'completed' };
      }, {
        nativeTerra: { async dispatch() {
          calls.push('terra');
          started.resolve();
          await release.promise;
          return winner('terra', TERRA_MODEL, firstStatus);
        } },
        nativeLuna: { dispatch() {
          calls.push('luna');
          return winner('luna', LUNA_MODEL, 'completed');
        } }
      });
      const result = run(task({ permissionMode, capability: permissionMode === 'read-only' ? 'workspace-read' : 'workspace-write' }), options);
      await started.promise;
      await new Promise(resolve => setImmediate(resolve));
      const before = [...calls];
      release.resolve();
      const receipt = await result;
      assert.deepEqual(before, permissionMode === 'read-only' ? ['terra', 'luna'] : ['terra']);
      assert.deepEqual(calls, firstStatus === 'completed' ? ['terra', 'luna'] : ['terra']);
      if (firstStatus !== 'completed') assert.equal(receipt.peer_results[1].error_code, 'DISPATCH_NATIVE_PEER_PREDECESSOR_UNCONFIRMED');
    });
  }
});

test('peer evidence and coordination deadline govern completion without retrying on unknown outcomes', async () => {
  const evidence = await run(task(), owner(async ({ delegatePeer }) => {
    const wrongRoute = await delegatePeer(request('luna'));
    assert.equal(wrongRoute.status, 'blocked');
    assert.equal(wrongRoute.error_code, 'DISPATCH_NATIVE_PEER_EVIDENCE');
    const nativeFailure = await delegatePeer(request('terra'));
    assert.equal(nativeFailure.status, 'failed');
    assert.equal(nativeFailure.task_id, 'terra-task');
    return { status: 'blocked' };
  }, {
    nativeLuna: { dispatch: () => ({ status: 'completed', task_id: 'wrong-route', model: TERRA_MODEL, reasoning_effort: 'max' }) },
    nativeTerra: { dispatch: () => ({ status: 'failed', task_id: 'terra-task', model: TERRA_MODEL, reasoning_effort: 'max' }) }
  }));
  assert.equal(evidence.peer_results.length, 2);

  const expired = await run(task({ deadline: Date.now() - 1 }), owner(({ delegatePeer }) => delegatePeer(request('luna')), {
    nativeLuna: { dispatch() { assert.fail('Expired ownership cannot authorize an invocation.'); } }
  }));
  assert.equal(expired.error_code, 'DISPATCH_NATIVE_PEER_DEADLINE');

  const controller = new AbortController();
  let delegate;
  let admissions = 0;
  const interrupted = await run(task(), owner(async ({ delegatePeer }) => {
    delegate = delegatePeer;
    const receipt = await delegatePeer(request('luna'));
    assert.equal(receipt.status, 'unknown');
    assert.equal(receipt.error_code, 'DISPATCH_NATIVE_PEER_OUTCOME_UNKNOWN');
    assert.equal(await delegatePeer(request('luna')), receipt);
    return { status: 'blocked' };
  }, {
    signal: controller.signal,
    nativeLuna: {
      dispatch({ signal }) {
        admissions++;
        controller.abort();
        assert.equal(signal.aborted, true);
        return new Promise(() => {});
      }
    }
  }));
  assert.equal(admissions, 1);
  assert.equal(interrupted.peer_results[0].status, 'unknown');
  assert.throws(() => delegate(request('luna', 'another')), { code: 'DISPATCH_NATIVE_PEER_CLOSED' });
});
