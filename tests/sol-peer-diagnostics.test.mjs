import test from 'node:test';
import assert from 'node:assert/strict';
import { LUNA_MODEL, LUNA_REASONING_EFFORT, TERRA_MODEL, TERRA_REASONING_EFFORT } from '../bridges/dispatch/policy.mjs';
import { peerRouteDiagnostics, ResponsesClient } from '../bridges/sol/responses.mjs';

const config = {
  openai: { model: 'gpt-6.2-sol', reasoning_effort: 'max', credential_source: 'windows-broker' },
  limits: { max_input_bytes: 192000, max_output_tokens: 16000, api_timeout_ms: 5000 }
};

test('peer diagnostics say a ready protected route needs no broker deployment', () => {
  const readiness = {
    ready: true,
    status_observed: true,
    delegate_peer: true,
    peer_api: {
      terra: { ready: true, model: TERRA_MODEL, reasoning_effort: TERRA_REASONING_EFFORT },
      luna: { ready: true, model: LUNA_MODEL, reasoning_effort: LUNA_REASONING_EFFORT }
    }
  };
  const before = JSON.stringify(readiness);
  const diagnostics = peerRouteDiagnostics(readiness);

  assert.deepEqual(Object.keys(diagnostics), ['terra', 'luna']);
  for (const peer of Object.values(diagnostics)) {
    assert.equal(peer.state, 'ready');
    assert.equal(peer.ready, true);
    assert.equal(peer.dispatch_ready, true);
    assert.equal(peer.deployment_required, false);
    assert.equal(peer.action, 'none');
  }
  assert.match(diagnostics.luna.message, /redeployment is not required/i);
  assert.equal(JSON.stringify(readiness), before, 'diagnostics must not mutate the readiness result');
});

test('a confirmed disabled Luna policy recommends the protected enable flow exactly once', async () => {
  const calls = [];
  const client = new ResponsesClient({ config, callBroker: async envelope => {
    calls.push(envelope);
    return {
      ok: true, status: 200,
      body: { ready: true, model: config.openai.model, reasoning_effort: 'max', requests_per_hour: 100 }
    };
  } }).forPeer('luna');

  const readiness = await client.readiness();
  assert.deepEqual(readiness, {
    model: LUNA_MODEL, reasoning_effort: LUNA_REASONING_EFFORT, requests_per_hour: 100,
    ready: false, code: 'LUNA_BROKER_DISABLED'
  }, 'direct readiness fields stay unchanged');
  const { luna } = peerRouteDiagnostics({ peer: 'luna', ...readiness });

  assert.deepEqual(calls, [{ op: 'status' }], 'readiness must not send a Responses request');
  assert.equal(luna.state, 'disabled');
  assert.equal(luna.status_observed, true);
  assert.equal(luna.deployment_required, true);
  assert.equal(luna.action, 'enable_protected_policy');
  assert.match(luna.message, /Enable it once through the existing protected broker policy upgrade/);
});

test('unobserved broker status cannot be mistaken for a disabled peer or a deployment requirement', () => {
  const diagnostics = peerRouteDiagnostics({ ready: false, code: 'SOL_BROKER_UNAVAILABLE' });
  for (const peer of Object.values(diagnostics)) {
    assert.equal(peer.state, 'unknown');
    assert.equal(peer.status_observed, false);
    assert.equal(peer.deployment_required, null);
    assert.equal(peer.action, 'check_status');
    assert.match(peer.message, /do not redeploy based on an unavailable or unobserved status/);
  }
});

test('route mismatch, unsupported tools, and broker refusal never recommend automatic reinstall', () => {
  const mismatch = peerRouteDiagnostics({
    ready: false, status_observed: true, code: 'SOL_BROKER_ROUTE_MISMATCH'
  });
  assert.equal(mismatch.luna.state, 'mismatch');
  assert.equal(mismatch.luna.action, 'inspect_route');
  assert.equal(mismatch.luna.deployment_required, null);
  assert.match(mismatch.luna.message, /Peer readiness cannot be concluded/);

  const unsupported = peerRouteDiagnostics({
    status_observed: true,
    peer_api: {
      terra: { ready: false, code: 'TERRA_BROKER_UNSUPPORTED' },
      luna: { ready: false, code: 'LUNA_BROKER_ROUTE_MISMATCH' }
    }
  });
  assert.equal(unsupported.terra.action, 'inspect_route');
  assert.equal(unsupported.luna.action, 'inspect_route');
  assert.equal(unsupported.terra.deployment_required, null);
  assert.equal(unsupported.luna.deployment_required, null);

  const refused = peerRouteDiagnostics({ ready: false, code: 'BROKER_FORBIDDEN' });
  assert.equal(refused.luna.state, 'refused');
  assert.equal(refused.luna.action, 'review_refusal');
  assert.equal(refused.luna.deployment_required, null);
});

test('a Sol delegation tool mismatch is a route issue, not a peer installation signal', () => {
  const diagnostics = peerRouteDiagnostics({
    ready: true,
    status_observed: true,
    delegate_peer: false,
    peer_api: { luna: { ready: true }, terra: { ready: true } }
  });
  assert.equal(diagnostics.luna.ready, true, 'the individual model role remains ready');
  assert.equal(diagnostics.luna.dispatch_ready, false);
  assert.equal(diagnostics.luna.state, 'mismatch');
  assert.equal(diagnostics.luna.action, 'inspect_route');
  assert.equal(diagnostics.luna.deployment_required, null);
});

test('a protected broker refusal during status never becomes a billable response', async () => {
  const calls = [];
  const client = new ResponsesClient({ config, callBroker: async envelope => {
    calls.push(envelope);
    return { ok: false, status: 403, code: 'BROKER_FORBIDDEN' };
  } }).forPeer('luna');

  const readiness = await client.readiness();
  const { luna } = peerRouteDiagnostics({ peer: 'luna', ...readiness });

  assert.deepEqual(calls, [{ op: 'status' }]);
  assert.equal(luna.state, 'refused');
  assert.equal(luna.deployment_required, null);
  assert.equal(luna.action, 'review_refusal');
});

test('an enabled but unready route directs credential checks without reinstall', () => {
  const diagnostics = peerRouteDiagnostics({
    ready: false,
    status_observed: true,
    peer_api: {
      terra: { ready: false, code: 'TERRA_BROKER_NOT_READY' },
      luna: { ready: false, code: 'LUNA_BROKER_NOT_READY' }
    }
  });
  assert.equal(diagnostics.luna.state, 'not_ready');
  assert.equal(diagnostics.luna.action, 'check_protected_credential');
  assert.equal(diagnostics.luna.deployment_required, false);
});
