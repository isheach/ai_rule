import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { dispatchLayeredTask, LUNA_MODEL } from '../bridges/dispatch.mjs';

const cwd = path.resolve('approved-project');
const child = (overrides = {}) => ({
  peer: 'antigravity', idempotencyKey: 'agy-write-1', goal: 'Draft the requested paragraph.',
  acceptance: 'Return one standalone text paragraph.', contextSummary: 'Use only the supplied notes.', ...overrides
});
const task = overrides => ({
  cwd, idempotencyKey: 'approved-parent', permissionMode: 'read-only', capability: 'workspace-read',
  timeoutMs: 5000, constraints: 'Keep it concise.', acceptAntigravityUsage: true, antigravityModel: 'draft', ...overrides
});
const run = (approvedTask, nativeAntigravity, coordinate) => dispatchLayeredTask({
  source: 'subscription', prompt: 'Coordinate the approved work.', task: approvedTask
}, {
  coordinator: { coordinate },
  dsh: { submit() { assert.fail('The coordinator owns the call; the native peer must not invoke DSH.'); } },
  ...(nativeAntigravity ? { nativeAntigravity } : {})
});

test('subscription Antigravity receives only frozen text and narrow host authorization', async () => {
  let payload;
  const result = await run(task({
    permissionMode: 'workspace-write', capability: 'workspace-write',
    authorizationNote: 'The parent may edit the project.',
    writeScopes: [{ path: cwd, operations: ['edit'] }],
    writes: [{ path: path.join(cwd, 'approved.txt'), mode: 'edit' }],
    commands: ['node check.mjs']
  }), {
    async dispatch(args) {
      payload = args;
      return {
        status: 'completed', task_id: 'agy-local-1', peer: 'antigravity',
        report: 'A standalone paragraph.', usage: { total_tokens: 48 },
        antigravity: {
          model_alias: 'draft', requested_model: 'models/gemini-2.5-pro',
          cli_selected_model: 'gemini-2.5-pro', provider_model: 'claimed-model'
        }
      };
    }
  }, async ({ delegatePeer }) => {
    await delegatePeer(child());
    return { status: 'completed', report: 'Sol accepted the paragraph.' };
  });

  assert.deepEqual(Object.keys(payload).sort(), ['authorization', 'request', 'signal']);
  assert.equal(Object.isFrozen(payload.request), true);
  assert.equal(Object.isFrozen(payload.authorization), true);
  assert.deepEqual(Object.keys(payload.request).sort(), [
    'acceptAntigravityUsage', 'acceptance', 'constraints', 'contextSummary', 'coordinatorMode', 'goal',
    'idempotencyKey', 'modelAlias', 'peer', 'prompt', 'purpose', 'source'
  ]);
  assert.equal(payload.request.modelAlias, 'draft');
  assert.equal(payload.request.acceptAntigravityUsage, true);
  assert.equal(payload.request.source, 'subscription');
  assert.equal(payload.request.coordinatorMode, 'subscription');
  assert.equal(payload.request.constraints, 'Keep it concise.');
  assert.equal(payload.request.prompt,
    'Draft the requested paragraph.\n\nConstraints:\nKeep it concise.\n\nSupplied material:\nUse only the supplied notes.\n\nAcceptance criteria:\nReturn one standalone text paragraph.');
  assert.ok(!payload.request.prompt.includes(cwd));
  for (const field of ['cwd', 'permissionMode', 'capability', 'writeScopes', 'writes', 'commands', 'authorizationNote', 'deadline']) {
    assert.equal(Object.hasOwn(payload.request, field), false, `request exposed ${field}`);
  }
  assert.deepEqual(Object.keys(payload.authorization).sort(), [
    'cwd', 'deadline', 'idempotencyKey', 'parentIdempotencyKey', 'timeoutMs'
  ]);
  assert.equal(payload.authorization.cwd, cwd);
  assert.ok(payload.authorization.timeoutMs > 0 && payload.authorization.timeoutMs <= 5000);

  const receipt = result.peer_results[0];
  assert.equal(receipt.coordinator_mode, 'subscription');
  assert.equal(receipt.source, 'subscription');
  assert.equal(receipt.antigravity.model_alias, 'draft');
  assert.equal(receipt.antigravity.requested_model, 'models/gemini-2.5-pro');
  assert.equal(receipt.antigravity.cli_selected_model, 'gemini-2.5-pro');
  assert.equal(receipt.antigravity.provider_model, 'unverified');
});

test('Antigravity requires explicit usage, an approved alias and a configured adapter', async () => {
  let calls = 0;
  const adapter = { dispatch() { calls++; assert.fail('A refused subtask must not be dispatched.'); } };
  const denied = await run(task({ acceptAntigravityUsage: false }), adapter,
    async ({ delegatePeer }) => ({ status: 'blocked', peer_receipt: await delegatePeer(child()) }));
  assert.equal(denied.peer_receipt.error_code, 'DISPATCH_NATIVE_PEER_ANTIGRAVITY_CONSENT_REQUIRED');

  const missingAlias = await run(task({ antigravityModel: '../unapproved' }), adapter,
    async ({ delegatePeer }) => ({ status: 'blocked', peer_receipt: await delegatePeer(child()) }));
  assert.equal(missingAlias.peer_receipt.error_code, 'DISPATCH_NATIVE_PEER_ANTIGRAVITY_MODEL_UNAPPROVED');

  const missingAdapter = await run(task(), null,
    async ({ delegatePeer }) => ({ status: 'blocked', peer_receipt: await delegatePeer(child()) }));
  assert.equal(missingAdapter.peer_receipt.error_code, 'DISPATCH_NATIVE_PEER_MISSING');
  assert.equal(calls, 0);
});

test('Antigravity text limits and action permissions are enforced before adapter dispatch', async () => {
  let calls = 0;
  const result = await run(task({
    permissionMode: 'workspace-write', capability: 'workspace-write',
    writeScopes: [{ path: cwd, operations: ['edit'] }], writes: [{ path: path.join(cwd, 'x'), mode: 'edit' }],
    commands: ['node check.mjs']
  }), { dispatch() { calls++; assert.fail('Only a valid text-only request can reach the adapter.'); } }, ({ delegatePeer }) => {
    assert.throws(() => delegatePeer(child({ goal: 'g'.repeat(12001) })), { code: 'DISPATCH_NATIVE_PEER_REQUEST' });
    assert.throws(() => delegatePeer(child({ acceptance: 'a'.repeat(8001) })), { code: 'DISPATCH_NATIVE_PEER_REQUEST' });
    assert.throws(() => delegatePeer(child({ contextSummary: 'c'.repeat(16001) })), { code: 'DISPATCH_NATIVE_PEER_REQUEST' });
    for (const scope of [
      { cwd: path.dirname(cwd) }, { permissionMode: 'workspace-write' }, { writeScopes: [] },
      { commands: ['node arbitrary.mjs'] }, { action: 'computer_operation' }
    ]) {
      assert.throws(() => delegatePeer(child(scope)), { code: 'DISPATCH_NATIVE_PEER_REQUEST' });
    }
    return { status: 'completed' };
  });
  assert.equal(result.status, 'completed');
  assert.equal(calls, 0);

  const oversizedConstraints = await run(task({ constraints: 'x'.repeat(12001) }), {
    dispatch() { calls++; assert.fail('Oversized parent constraints must not be sent.'); }
  }, async ({ delegatePeer }) => ({ status: 'blocked', peer_receipt: await delegatePeer(child()) }));
  assert.equal(oversizedConstraints.peer_receipt.error_code, 'DISPATCH_NATIVE_PEER_ANTIGRAVITY_LIMIT');
  assert.equal(calls, 0);
});

test('Antigravity honors the parent deadline and never retries an unknown outcome', async () => {
  let calls = 0;
  const expired = await run(task({ deadline: Date.now() - 1 }), { dispatch() {
    calls++;
    assert.fail('Expired parent budget cannot authorize a new adapter invocation.');
  } }, async ({ delegatePeer }) => ({ status: 'blocked', peer_receipt: await delegatePeer(child()) }));
  assert.equal(expired.peer_receipt.error_code, 'DISPATCH_NATIVE_PEER_DEADLINE');

  const interrupted = await run(task(), { dispatch() {
    calls++;
    throw new Error('Lost the local CLI receipt.');
  } }, async ({ delegatePeer }) => {
    const first = delegatePeer(child());
    assert.equal(delegatePeer(child()), first);
    const receipt = await first;
    assert.equal(receipt.status, 'unknown');
    assert.equal(receipt.error_code, 'DISPATCH_NATIVE_PEER_OUTCOME_UNKNOWN');
    return { status: 'blocked' };
  });
  assert.equal(interrupted.peer_results[0].status, 'unknown');
  assert.equal(calls, 1);
});

test('Antigravity completion binds the approved alias to actual model evidence', async () => {
  const result = await run(task(), { dispatch: () => ({
    status: 'completed', task_id: 'agy-local-2',
    antigravity: { model_alias: 'research', requested_model: 'models/gemini-2.5-pro' }
  }) }, async ({ delegatePeer }) => {
    const receipt = await delegatePeer(child());
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.error_code, 'DISPATCH_NATIVE_PEER_EVIDENCE');
    return { status: 'blocked' };
  });
  assert.equal(result.peer_results[0].error_code, 'DISPATCH_NATIVE_PEER_EVIDENCE');
});

test('Antigravity consent and alias metadata do not leak into Luna child task scope', async () => {
  const result = await dispatchLayeredTask({ source: 'subscription', prompt: 'Coordinate the approved work.', task: task() }, {
    coordinator: { async coordinate({ delegatePeer }) {
      await delegatePeer({
        peer: 'luna', idempotencyKey: 'luna-check-1', goal: 'Check the approved details.',
        acceptance: 'Return the actual checks performed.'
      });
      return { status: 'completed' };
    } },
    dsh: { submit() { assert.fail('The coordinator owns the call.'); } },
    nativeLuna: { dispatch(args) {
      assert.equal(Object.hasOwn(args.task, 'acceptAntigravityUsage'), false);
      assert.equal(Object.hasOwn(args.task, 'antigravityModel'), false);
      return { status: 'completed', agent_id: 'luna-agent', model: LUNA_MODEL, reasoning_effort: 'max' };
    } }
  });
  assert.equal(result.peer_results[0].peer, 'luna');
  assert.equal(result.peer_results[0].status, 'completed');
});
