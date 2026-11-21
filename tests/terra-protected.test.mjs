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
import {
  createProtectedTerraClient,
  createTerraTestHarness,
  summarizeTerraAcceptance,
  TERRA_ACCEPTANCE_ACTION,
  TERRA_ACCEPTANCE_INPUT,
  TERRA_ACCEPTANCE_LIMITS,
  TerraProviderError
} from '../bridges/terra/protected.mjs';
import {
  parseTerraCliArgs,
  runTerraCli,
  TerraCliError
} from '../bridges/terra/cli.mjs';

const USAGE = Object.freeze({
  input_tokens: 10,
  output_tokens: 5,
  total_tokens: 15,
  input_tokens_details: { cached_tokens: 1 },
  output_tokens_details: { reasoning_tokens: 2 }
});

const READY_BODY = Object.freeze({
  ready: true,
  terra_enabled: true,
  terra_model: TERRA_MODEL,
  terra_reasoning_effort: TERRA_REASONING_EFFORT,
  terra_tools: [CONFIRM_TOOL, ACTION_TOOL, FINISH_TOOL],
  model: 'gpt-6.2-sol',
  reasoning_effort: 'max',
  max_input_bytes: 768000,
  max_output_tokens: 64000,
  api_timeout_ms: 180000
});

function readyStatus() {
  return {
    ok: true,
    status: 200,
    body: { ...READY_BODY, terra_tools: [...READY_BODY.terra_tools] }
  };
}

function notReadyStatus(body = { ...READY_BODY, ready: false }) {
  return { ok: true, status: 200, body };
}

function envelope(id, call, {
  model = TERRA_MODEL,
  effort = TERRA_REASONING_EFFORT,
  status = 'completed',
  usage = USAGE,
  output
} = {}) {
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

// A successful response from the Windows broker is never a bare Responses
// body: it is always the {ok:true,status:200,body:<Responses object>} envelope.
// Recognize only well-formed Responses fixtures so deliberate failure,
// malformed and refusal replies are returned to the client unchanged.
function isSimulatedResponses(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.object === 'response'
    && typeof value.id === 'string'
    && value.id.startsWith('resp_')
    && typeof value.model === 'string'
    && typeof value.status === 'string'
    && value.reasoning !== null
    && typeof value.reasoning === 'object'
    && Array.isArray(value.output)
    && value.usage !== null
    && typeof value.usage === 'object';
}

function makeBroker({ status = () => readyStatus(), responses = [] } = {}) {
  const calls = [];
  let statusIndex = 0;
  let responseIndex = 0;
  async function callBroker(request) {
    calls.push(request);
    if (request.op === 'status') {
      return typeof status === 'function' ? status(statusIndex++) : status;
    }
    if (request.op === 'response') {
      if (responseIndex >= responses.length) throw new Error('unexpected Terra response');
      const next = responses[responseIndex++];
      const value = typeof next === 'function' ? await next(request) : next;
      return isSimulatedResponses(value)
        ? { ok: true, status: 200, body: value }
        : value;
    }
    throw new Error('unexpected Terra broker operation');
  }
  return {
    callBroker,
    calls,
    get statusCount() { return calls.filter(call => call.op === 'status').length; },
    get responseCount() { return calls.filter(call => call.op === 'response').length; }
  };
}

function missing(body, key) {
  const copy = { ...body };
  delete copy[key];
  return copy;
}

test('status is read-only and a fully ready broker status exposes only safe fields', async () => {
  const mock = makeBroker();
  const client = createTerraTestHarness({ callBroker: mock.callBroker });
  assert.ok(client instanceof TerraClient);

  const status = await client.status();

  assert.equal(status.ready, true);
  assert.equal(status.terra_enabled, true);
  assert.equal(status.terra_model, TERRA_MODEL);
  assert.equal(status.terra_reasoning_effort, TERRA_REASONING_EFFORT);
  assert.equal(status.code, null);
  assert.equal(status.broker_read, true);
  assert.deepEqual(mock.calls, [{ op: 'status' }]);
  assert.equal(mock.responseCount, 0);
});

const gateCases = [
  ['ready is false', { ...READY_BODY, ready: false }, 'TERRA_BROKER_NOT_READY'],
  ['ready is missing', missing(READY_BODY, 'ready'), 'TERRA_BROKER_NOT_READY'],
  ['ready is not a boolean', { ...READY_BODY, ready: 'true' }, 'TERRA_BROKER_NOT_READY'],
  ['terra_enabled is false', { ...READY_BODY, terra_enabled: false }, 'TERRA_BROKER_TERRA_DISABLED'],
  ['terra_enabled is missing', missing(READY_BODY, 'terra_enabled'), 'TERRA_BROKER_TERRA_DISABLED'],
  ['terra_model is wrong', { ...READY_BODY, terra_model: 'gpt-6.2-sol' }, 'TERRA_BROKER_ROUTE_MISMATCH'],
  ['terra_model is missing', missing(READY_BODY, 'terra_model'), 'TERRA_BROKER_ROUTE_MISMATCH'],
  ['terra effort is wrong', { ...READY_BODY, terra_reasoning_effort: 'high' }, 'TERRA_BROKER_ROUTE_MISMATCH'],
  ['terra effort is missing', missing(READY_BODY, 'terra_reasoning_effort'), 'TERRA_BROKER_ROUTE_MISMATCH'],
  ['terra_tools is partial', { ...READY_BODY, terra_tools: [CONFIRM_TOOL] }, 'TERRA_BROKER_UNSUPPORTED'],
  ['terra_tools is empty', { ...READY_BODY, terra_tools: [] }, 'TERRA_BROKER_UNSUPPORTED'],
  ['terra_tools is missing', missing(READY_BODY, 'terra_tools'), 'TERRA_BROKER_UNSUPPORTED'],
  ['terra_tools is missing confirm_terra_api', { ...READY_BODY, terra_tools: [ACTION_TOOL, FINISH_TOOL] }, 'TERRA_BROKER_UNSUPPORTED'],
  ['terra_tools is missing terra_action', { ...READY_BODY, terra_tools: [CONFIRM_TOOL, FINISH_TOOL] }, 'TERRA_BROKER_UNSUPPORTED'],
  ['terra_tools is missing finish_terra', { ...READY_BODY, terra_tools: [CONFIRM_TOOL, ACTION_TOOL] }, 'TERRA_BROKER_UNSUPPORTED'],
  ['terra_tools is malformed', { ...READY_BODY, terra_tools: CONFIRM_TOOL }, 'TERRA_BROKER_UNSUPPORTED'],
  ['terra_tools has a non-string', { ...READY_BODY, terra_tools: [CONFIRM_TOOL, 3, ACTION_TOOL] }, 'TERRA_BROKER_UNSUPPORTED']
];

for (const [label, body, code] of gateCases) {
  test(`a status where ${label} is never treated as ready and sends zero responses`, async () => {
    const mock = makeBroker({ status: { ok: true, status: 200, body } });
    const client = createTerraTestHarness({ callBroker: mock.callBroker });

    await assert.rejects(client.confirm(), error => {
      assert.ok(error instanceof TerraProviderError);
      assert.equal(error.code, code);
      assert.equal(error.known, true);
      assert.equal(error.usageUnknown, false);
      assert.equal(error.requestSent, false);
      return true;
    });
    assert.equal(mock.responseCount, 0);
  });
}

test('a broker status error keeps its sanitized code and status and sends zero responses', async () => {
  const mock = makeBroker({
    status: { ok: false, status: 503, code: 'BROKER_CREDENTIAL_MISSING' }
  });
  const client = createTerraTestHarness({ callBroker: mock.callBroker });

  await assert.rejects(client.confirm(), error => {
    assert.ok(error instanceof TerraProviderError);
    assert.equal(error.code, 'BROKER_CREDENTIAL_MISSING');
    assert.equal(error.status, 503);
    assert.equal(error.known, true);
    assert.equal(error.usageUnknown, false);
    assert.equal(error.requestSent, false);
    return true;
  });
  assert.equal(mock.responseCount, 0);
});

test('a malformed status reply fails closed without sending a billable request', async () => {
  const mock = makeBroker({ status: { ok: 'yes', status: 200 } });
  const client = createTerraTestHarness({ callBroker: mock.callBroker });

  await assert.rejects(client.confirm(), error => {
    assert.ok(error instanceof TerraProviderError);
    assert.equal(error.code, 'TERRA_BROKER_PROTOCOL');
    // The status reply cannot be trusted, so its HTTP 200 is not retained,
    // but the response operation stops before a billable request: the local
    // outcome is still known and unsent.
    assert.equal(error.status, null);
    assert.equal(error.known, true);
    assert.equal(error.usageUnknown, false);
    assert.equal(error.requestSent, false);
    return true;
  });
  assert.equal(mock.responseCount, 0);
});

test('the production factory rejects every routing and transport override before any call', () => {
  const overrides = [
    { url: 'https://api.openai.com/v1/responses' },
    { base_url: 'https://api.openai.com/v1' },
    { apiKey: 'sk-test-placeholder' },
    { api_key: 'sk-test-placeholder' },
    { credential_source: 'environment' },
    { model: 'gpt-6.2-sol' },
    { reasoning_effort: 'high' },
    { transport: {} },
    { broker: {} },
    { callBroker: async () => ({ ok: true, status: 200, body: {} }) },
    { request: async () => ({}) }
  ];
  for (const options of overrides) {
    assert.throws(() => createProtectedTerraClient(options), error => {
      assert.ok(error instanceof TerraError);
      assert.equal(error.code, 'TERRA_OPTIONS_FORBIDDEN');
      return true;
    });
  }
  const client = createProtectedTerraClient({
    actions: [{ name: 'inspect_contract', effect: 'read', callback() { return { ok: true }; } }],
    limits: { max_rounds: 2 }
  });
  assert.ok(client instanceof TerraClient);
});

test('confirm uses the real TerraClient confirm_terra_api contract through the broker', async () => {
  const mock = makeBroker({
    responses: [envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } })]
  });
  const client = createTerraTestHarness({ callBroker: mock.callBroker });

  const result = await client.confirm();

  assert.equal(result.confirmed, true);
  assert.equal(result.model, TERRA_MODEL);
  assert.equal(result.response_id, 'resp_1');
  assert.equal(result.evidence.tool, CONFIRM_TOOL);
  assert.equal(result.usage.total_tokens, 15);
  assert.deepEqual(mock.calls.map(call => call.op), ['status', 'response']);
  const body = mock.calls[1].body;
  assert.equal(body.model, TERRA_MODEL);
  assert.equal(body.reasoning.effort, TERRA_REASONING_EFFORT);
  assert.equal(body.store, false);
  assert.deepEqual(body.tools.map(tool => tool.name), [CONFIRM_TOOL]);
  assert.equal(body.tools[0].strict, true);
  assert.equal(body.tools[0].parameters.properties.result.enum[0], 'ready');
  assert.equal(mock.responseCount, 1);
});

test('every response is gated by fresh status; a later not-ready stops before the next response', async () => {
  const mock = makeBroker({
    status: index => index === 0 ? readyStatus() : notReadyStatus(),
    responses: [envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } })]
  });
  const client = createTerraTestHarness({
    callBroker: mock.callBroker,
    actions: [TERRA_ACCEPTANCE_ACTION]
  });

  await assert.rejects(client.run({ input: 'run one fixed action' }), error => {
    assert.ok(error instanceof TerraProviderError);
    assert.equal(error.code, 'TERRA_BROKER_NOT_READY');
    assert.equal(error.known, true);
    assert.equal(error.requestSent, false);
    assert.equal(error.usage.total_tokens, 15);
    return true;
  });
  assert.equal(mock.statusCount, 2);
  assert.equal(mock.responseCount, 1);
});

test('a provider HTTP failure preserves code/status and does not claim known usage', async () => {
  const secret = 'sk-test-provider-secret';
  const mock = makeBroker({
    responses: [{
      ok: false,
      status: 500,
      code: 'UPSTREAM_HTTP',
      body: { error: secret },
      message: secret
    }]
  });
  const client = createTerraTestHarness({ callBroker: mock.callBroker });

  await assert.rejects(client.confirm(), error => {
    assert.ok(error instanceof TerraProviderError);
    assert.equal(error.code, 'UPSTREAM_HTTP');
    assert.equal(error.status, 500);
    assert.equal(error.known, false);
    assert.equal(error.usageUnknown, true);
    assert.equal(error.requestSent, true);
    assert.equal(error.usage, null);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
  assert.equal(mock.responseCount, 1);
});

test('a broker refusal is known unsent and an unrecognized code stays unknown', async () => {
  const refused = makeBroker({
    responses: [{ ok: false, status: 429, code: 'BROKER_RATE_LIMITED' }]
  });
  await assert.rejects(createTerraTestHarness({ callBroker: refused.callBroker }).confirm(), error => {
    assert.equal(error.code, 'BROKER_RATE_LIMITED');
    assert.equal(error.status, 429);
    assert.equal(error.known, true);
    assert.equal(error.usageUnknown, false);
    assert.equal(error.requestSent, false);
    return true;
  });

  const unknown = makeBroker({
    responses: [{ ok: false, status: 502, code: 'BROKER_OUTCOME_UNKNOWN' }]
  });
  await assert.rejects(createTerraTestHarness({ callBroker: unknown.callBroker }).confirm(), error => {
    assert.equal(error.code, 'BROKER_OUTCOME_UNKNOWN');
    assert.equal(error.known, false);
    assert.equal(error.usageUnknown, true);
    assert.equal(error.requestSent, null);
    return true;
  });

  const unsafe = makeBroker({
    responses: [{ ok: false, status: 502, code: 'not a broker code' }]
  });
  await assert.rejects(createTerraTestHarness({ callBroker: unsafe.callBroker }).confirm(), error => {
    assert.equal(error.code, 'TERRA_BROKER_UNKNOWN');
    assert.equal(error.known, false);
    assert.equal(error.requestSent, null);
    return true;
  });
});

test('an interrupted broker call is unknown and never retried', async () => {
  const mock = makeBroker({
    responses: [() => { throw new Error('pipe closed'); }]
  });
  const client = createTerraTestHarness({ callBroker: mock.callBroker });

  await assert.rejects(client.confirm(), error => {
    assert.ok(error instanceof TerraProviderError);
    assert.equal(error.code, 'TERRA_BROKER_UNAVAILABLE');
    assert.equal(error.known, false);
    assert.equal(error.usageUnknown, true);
    assert.equal(error.requestSent, null);
    return true;
  });
  assert.equal(mock.responseCount, 1);
});

test('a returned route mismatch is a TerraError and never reported as verified', async () => {
  const mock = makeBroker({
    responses: [envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } },
      { model: 'gpt-6.2-sol' })]
  });
  const client = createTerraTestHarness({ callBroker: mock.callBroker });

  await assert.rejects(client.confirm(), error => {
    assert.ok(error instanceof TerraError);
    assert.equal(error instanceof TerraProviderError, false);
    assert.equal(error.code, 'TERRA_ROUTE_MISMATCH');
    return true;
  });
});

test('the bounded acceptance run is read-only and requires a local receipt', async () => {
  const mock = makeBroker({
    responses: [
      envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } }),
      envelope('2', { name: ACTION_TOOL, args: { action: 'inspect_contract' } }),
      envelope('3', { name: FINISH_TOOL, args: { report: 'The local contract was inspected.' } })
    ]
  });
  let callbacks = 0;
  const client = createTerraTestHarness({
    callBroker: mock.callBroker,
    actions: [{
      ...TERRA_ACCEPTANCE_ACTION,
      callback() {
        callbacks++;
        return TERRA_ACCEPTANCE_ACTION.callback();
      }
    }],
    limits: TERRA_ACCEPTANCE_LIMITS
  });

  const result = await client.run({ input: TERRA_ACCEPTANCE_INPUT });
  const summary = summarizeTerraAcceptance(result);

  assert.equal(callbacks, 1);
  assert.equal(summary.ok, true);
  assert.equal(summary.status, 'verified');
  assert.deepEqual(summary.response_ids, ['resp_1', 'resp_2', 'resp_3']);
  assert.equal(summary.rounds, 3);
  assert.equal(summary.usage.total_tokens, 45);
  assert.equal(summary.action.name, 'inspect_contract');
  assert.equal(summary.action.effect, 'read');
  assert.equal(summary.action.checks.read_only, true);
  assert.equal(summary.model_report, 'The local contract was inspected.');
  assert.equal(summary.evidence, 'local read-only action receipt; the model report is not evidence');

  const actionBody = mock.calls.filter(call => call.op === 'response')[1].body;
  assert.deepEqual(actionBody.tools.map(tool => tool.name), [ACTION_TOOL, FINISH_TOOL]);
  assert.deepEqual(
    actionBody.tools.find(tool => tool.name === ACTION_TOOL).parameters.properties.action.enum,
    ['inspect_contract']
  );
  assert.equal(actionBody.max_output_tokens, TERRA_ACCEPTANCE_LIMITS.max_output_tokens);
  assert.ok(Buffer.byteLength(JSON.stringify(actionBody)) <= TERRA_ACCEPTANCE_LIMITS.max_input_bytes);
});

test('acceptance summary refuses a finished run with no successful read-only receipt', () => {
  const result = {
    status: 'finished',
    confirmed: true,
    model: TERRA_MODEL,
    rounds: [
      { tool: CONFIRM_TOOL, response_id: 'resp_1' },
      { tool: FINISH_TOOL, response_id: 'resp_2' }
    ],
    actions: [],
    usage: USAGE,
    report: 'done'
  };
  assert.throws(() => summarizeTerraAcceptance(result), error => {
    assert.ok(error instanceof TerraError);
    assert.equal(error.code, 'TERRA_ACCEPTANCE_INCOMPLETE');
    return true;
  });
});

test('a model-supplied path or command is rejected before the read-only callback runs', async () => {
  const mock = makeBroker({
    responses: [
      envelope('1', { name: CONFIRM_TOOL, args: { result: 'ready' } }),
      envelope('2', {
        name: ACTION_TOOL,
        args: { action: 'inspect_contract', path: 'C:\\Windows\\System32\\cmd.exe' }
      })
    ]
  });
  let callbacks = 0;
  const client = createTerraTestHarness({
    callBroker: mock.callBroker,
    actions: [{
      ...TERRA_ACCEPTANCE_ACTION,
      callback() {
        callbacks++;
        return { ok: true };
      }
    }],
    limits: TERRA_ACCEPTANCE_LIMITS
  });

  await assert.rejects(client.run({ input: TERRA_ACCEPTANCE_INPUT }), error => {
    assert.ok(error instanceof TerraError);
    assert.equal(error.code, 'TERRA_TOOL_ARGUMENTS');
    return true;
  });
  assert.equal(callbacks, 0);
  assert.equal(mock.responseCount, 2);
});

test('the CLI keeps status separate from explicitly consented billable commands', () => {
  assert.deepEqual(parseTerraCliArgs(['status']), { command: 'status' });
  assert.deepEqual(parseTerraCliArgs(['verify-api', '--accept-terra-charges']),
    { command: 'verify-api', acceptCharges: true });
  assert.deepEqual(parseTerraCliArgs(['acceptance', '--accept-terra-charges']),
    { command: 'acceptance', acceptCharges: true });

  for (const argv of [['verify-api'], ['acceptance']]) {
    assert.throws(() => parseTerraCliArgs(argv), error => {
      assert.ok(error instanceof TerraCliError);
      assert.equal(error.code, 'TERRA_CLI_CONSENT_REQUIRED');
      assert.equal(error.exitCode, 2);
      return true;
    });
  }

  const invalid = [
    [],
    ['run'],
    ['status', '--accept-terra-charges'],
    ['status', '--model', 'gpt-6.2-sol'],
    ['verify-api', '--accept-terra-charges', '--url', 'https://example.invalid'],
    ['verify-api', '--accept-terra-charges', '--api-key', 'sk-test-placeholder'],
    ['acceptance', '--script', 'C:\\Windows\\System32\\cmd.exe']
  ];
  for (const argv of invalid) {
    assert.throws(() => parseTerraCliArgs(argv), error => {
      assert.ok(error instanceof TerraCliError);
      assert.equal(error.code, 'TERRA_CLI_USAGE');
      assert.equal(error.message.includes('sk-test'), false);
      return true;
    });
  }
});

test('the CLI refuses missing consent before any broker operation', async () => {
  const stdout = [];
  const stderr = [];
  const code = await runTerraCli(['verify-api'], {
    stdout: { write: value => stdout.push(value) },
    stderr: { write: value => stderr.push(value) }
  });

  assert.equal(code, 2);
  assert.equal(stdout.length, 0);
  const report = JSON.parse(stderr.join(''));
  assert.equal(report.ok, false);
  assert.equal(report.code, 'TERRA_CLI_CONSENT_REQUIRED');
});

test('the CLI does not echo a rejected secret argument', async () => {
  const stdout = [];
  const stderr = [];
  const code = await runTerraCli(['verify-api', '--api-key', 'sk-test-placeholder'], {
    stdout: { write: value => stdout.push(value) },
    stderr: { write: value => stderr.push(value) }
  });

  assert.equal(code, 2);
  assert.equal(stdout.length, 0);
  assert.equal(stderr.join('').includes('sk-test-placeholder'), false);
  assert.equal(JSON.parse(stderr.join('')).code, 'TERRA_CLI_USAGE');
});
