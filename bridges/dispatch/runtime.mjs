// Executable side of the layered policy.
//
// The dispatcher only calls adapters that the host/API process explicitly
// provides. It never discovers a desktop, reads image data, guesses a host
// path, scans a prompt for keywords, or falls back to a billable model.
//
// API Terra uses the existing protected Terra client. Each host capability is
// exposed to Terra as one bounded action with no model-supplied arguments; the
// callback closes over the already-authorized task. Subscription Terra is a
// real host adapter invocation, never a local imitation of Terra.

import {
  Backend,
  DispatchSource,
  DispatchPolicyError,
  TERRA_MODEL,
  TERRA_REASONING_EFFORT,
  hostHandoff,
  resolveDispatch
} from './policy.mjs';
import { createProtectedTerraClient } from '../terra/protected.mjs';
import { ACTION_TOOL, CONFIRM_TOOL, FINISH_TOOL } from '../terra/client.mjs';
import { nativePeerCoordinator } from './native-peer.mjs';

const MAX_PROMPT_BYTES = 60000;
const ACTION_NAMES = Object.freeze({
  computer_operation: 'computer_operation',
  acceptance: 'inspect_acceptance',
  image_generation: 'generate_image',
  image_recognition: 'recognize_image'
});
const DEFAULT_EFFECTS = Object.freeze({
  computer_operation: 'write',
  acceptance: 'read',
  image_generation: 'write',
  image_recognition: 'read'
});
const MEDIA_FIELDS = new Set(['imageData', 'image_data', 'screenshot', 'screenCapture', 'screen_capture', 'desktop']);
const TERRA_RESPONSE_ID = /^resp_[A-Za-z0-9_-]{1,190}$/;

export class DispatchBlockedError extends Error {
  constructor(code, message, { plan = null, missingCapabilities = [], missingAdapters = [], missingActions = [] } = {}) {
    super(message);
    this.name = 'DispatchBlockedError';
    this.code = code;
    this.plan = plan;
    this.missing_capabilities = [...missingCapabilities];
    this.missing_adapters = [...missingAdapters];
    this.missing_actions = [...missingActions];
  }
}

function validatePrompt(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > MAX_PROMPT_BYTES) {
    throw new DispatchPolicyError('DISPATCH_PROMPT_INVALID', `prompt must contain 1..${MAX_PROMPT_BYTES} UTF-8 bytes.`);
  }
  return value;
}

function assertNoRawMedia(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (MEDIA_FIELDS.has(key)) {
      throw new DispatchPolicyError('DISPATCH_MEDIA_FORBIDDEN',
        `Raw ${key} is not passed through dispatch. Use an opaque host capability reference instead.`);
    }
  }
}

function adapterFor(capabilities, name) {
  const adapter = capabilities?.[name];
  if (adapter === undefined || adapter === null) return null;
  if (typeof adapter === 'function') return { run: adapter, effect: DEFAULT_EFFECTS[name] ?? 'read' };
  if (typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw new DispatchPolicyError('DISPATCH_CAPABILITY_INVALID', `Capability ${name} must be a function or an object with run().`);
  }
  if (typeof adapter.run !== 'function') {
    throw new DispatchPolicyError('DISPATCH_CAPABILITY_INVALID', `Capability ${name} must provide run().`);
  }
  if (adapter.effect !== undefined && adapter.effect !== 'read' && adapter.effect !== 'write') {
    throw new DispatchPolicyError('DISPATCH_CAPABILITY_INVALID', `Capability ${name} effect must be read or write.`);
  }
  return { run: adapter.run.bind(adapter), effect: adapter.effect ?? DEFAULT_EFFECTS[name] ?? 'read' };
}

export function missingCapabilities(plan, capabilities = {}) {
  if (!plan || plan.schema !== 1) throw new DispatchPolicyError('DISPATCH_PLAN_INVALID', 'A resolved dispatch plan is required.');
  return plan.capabilities.required.filter(name => !adapterFor(capabilities, name));
}

function assertCapabilities(plan, capabilities) {
  const missing = missingCapabilities(plan, capabilities);
  if (missing.length) {
    throw new DispatchBlockedError('DISPATCH_CAPABILITY_MISSING',
      `The selected purpose requires missing host capabilities: ${missing.join(', ')}.`,
      { plan, missingCapabilities: missing });
  }
}

export function createTerraCapabilityActions({ plan, prompt, capabilities = {}, task = null }) {
  if (!plan || plan.schema !== 1) throw new DispatchPolicyError('DISPATCH_PLAN_INVALID', 'A resolved dispatch plan is required.');
  const actions = [];
  for (const name of plan.capabilities.required) {
    const adapter = adapterFor(capabilities, name);
    if (!adapter) continue;
    const actionName = ACTION_NAMES[name];
    if (!actionName) throw new DispatchPolicyError('DISPATCH_CAPABILITY_INVALID', `No bounded Terra action exists for ${name}.`);
    actions.push({
      name: actionName,
      effect: adapter.effect,
      description: `Run the host-authorized ${name} capability once. No model-supplied arguments.`,
      callback: async () => adapter.run({ purpose: plan.purpose, prompt, source: DispatchSource.API, task })
    });
  }
  return actions;
}

function terraInput(plan, prompt) {
  return [
    `Selected purpose: ${plan.purpose}.`,
    `Use the fixed Terra route (${TERRA_MODEL}, reasoning effort ${TERRA_REASONING_EFFORT}).`,
    'Only local action receipts are evidence for host actions; finish_terra.report is model text.',
    plan.purpose === 'writing'
      ? 'Return the complete requested writing in finish_terra.report; it is the usable text output.'
      : 'Perform only the task below and the explicitly authorized local actions.',
    '',
    prompt
  ].join('\n');
}

function textOf(result) {
  for (const value of [result?.text, result?.report, result?.answer, result?.output?.text, result?.output?.report]) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function blocked(plan, code, message, extra = {}) {
  return new DispatchBlockedError(code, message, { plan, ...extra });
}

// TerraClient.run() reports the evidence it actually recorded for every
// Responses round. The finished envelope has no top-level reasoning_effort, so
// the round evidence, not the requested plan labels, is the route proof:
// confirmation first, zero or more action rounds, finish_terra last.
function assertTerraRounds(plan, rounds) {
  if (!Array.isArray(rounds) || rounds.length < 2) {
    throw blocked(plan, 'DISPATCH_TERRA_INCOMPLETE',
      'Terra returned no complete confirm_terra_api/finish_terra round sequence.');
  }
  const ids = new Set();
  rounds.forEach((round, index) => {
    if (!isObject(round)) {
      throw blocked(plan, 'DISPATCH_TERRA_EVIDENCE_INVALID',
        `Terra round ${index + 1} is not an object.`);
    }
    if (typeof round.response_id !== 'string' || !TERRA_RESPONSE_ID.test(round.response_id)) {
      throw blocked(plan, 'DISPATCH_TERRA_EVIDENCE_INVALID',
        `Terra round ${index + 1} has no valid response_id.`);
    }
    if (ids.has(round.response_id)) {
      throw blocked(plan, 'DISPATCH_TERRA_EVIDENCE_INVALID',
        `Terra round ${index + 1} reused response_id ${round.response_id}.`);
    }
    ids.add(round.response_id);
    if (round.model !== TERRA_MODEL) {
      throw blocked(plan, 'DISPATCH_TERRA_ROUTE_MISMATCH',
        `Terra round ${index + 1} reported model ${String(round.model).slice(0, 80)}, not ${TERRA_MODEL}.`);
    }
    if (round.reasoning_effort !== TERRA_REASONING_EFFORT) {
      throw blocked(plan, 'DISPATCH_TERRA_ROUTE_MISMATCH',
        `Terra round ${index + 1} reported effort ${String(round.reasoning_effort).slice(0, 40)}, not ${TERRA_REASONING_EFFORT}.`);
    }
    if (round.status !== 'completed') {
      throw blocked(plan, 'DISPATCH_TERRA_INCOMPLETE',
        `Terra round ${index + 1} did not complete.`);
    }
    if (typeof round.tool !== 'string' || !round.tool) {
      throw blocked(plan, 'DISPATCH_TERRA_EVIDENCE_INVALID',
        `Terra round ${index + 1} has no tool evidence.`);
    }
  });
  if (rounds[0].tool !== CONFIRM_TOOL) {
    throw blocked(plan, 'DISPATCH_TERRA_EVIDENCE_INVALID',
      `Terra's first round was ${rounds[0].tool.slice(0, 80)}, not ${CONFIRM_TOOL}.`);
  }
  if (rounds.at(-1).tool !== FINISH_TOOL) {
    throw blocked(plan, 'DISPATCH_TERRA_INCOMPLETE',
      `Terra's last round was ${rounds.at(-1).tool.slice(0, 80)}, not ${FINISH_TOOL}.`);
  }
  for (const round of rounds.slice(1, -1)) {
    if (round.tool !== ACTION_TOOL) {
      throw blocked(plan, 'DISPATCH_TERRA_EVIDENCE_INVALID',
        `Terra round ${round.response_id} used ${round.tool.slice(0, 80)} between confirmation and finish.`);
    }
  }
  return rounds;
}

// A model-only finish is not acceptance evidence for a host capability. Every
// required non-writing purpose needs a successful local receipt for the exact
// bounded action name, with the effect and local callback result preserved.
// authorizedActions is the name/effect snapshot actually handed to the API
// factory. When provided it is authoritative, including for explicit host
// effects that differ from DEFAULT_EFFECTS; a missing entry is an error, not a
// fallback. The native path passes no snapshot and keeps the defaults.
// For the API client the successful receipt count must also match the actual
// terra_action rounds.
function assertTerraActions(plan, result, rounds = null, authorizedActions = null) {
  if (!Array.isArray(result.actions)) {
    throw blocked(plan, 'DISPATCH_TERRA_EVIDENCE_INVALID',
      'Terra did not return an actions evidence array.');
  }
  if (Array.isArray(rounds)) {
    const actionRounds = rounds.slice(1, -1).length;
    if (result.actions.length !== actionRounds) {
      throw blocked(plan, 'DISPATCH_TERRA_EVIDENCE_INVALID',
        `Terra returned ${result.actions.length} local action receipt(s) for ${actionRounds} action round(s).`);
    }
  }
  if (plan.purpose === 'writing') {
    if (result.actions.length) {
      throw blocked(plan, 'DISPATCH_TERRA_ACTION_INVALID',
        'A writing task returned host action receipts even though no host capability was authorized.',
        {});
    }
    return [];
  }
  const allowed = new Map();
  for (const capability of plan.capabilities.required) {
    const actionName = ACTION_NAMES[capability];
    if (!actionName) {
      throw blocked(plan, 'DISPATCH_TERRA_ACTION_INVALID',
        `No bounded Terra action exists for required capability ${capability}.`);
    }
    const effect = authorizedActions
      ? authorizedActions.get(actionName)
      : DEFAULT_EFFECTS[capability];
    if (effect === undefined) {
      throw blocked(plan, 'DISPATCH_TERRA_ACTION_INVALID',
        `No authorized effect was recorded for Terra action ${actionName}.`);
    }
    allowed.set(actionName, { capability, effect });
  }
  const seen = new Set();
  for (const receipt of result.actions) {
    if (!isObject(receipt) || typeof receipt.action !== 'string' || !receipt.action) {
      throw blocked(plan, 'DISPATCH_TERRA_ACTION_INVALID',
        'Terra returned a local action receipt without an action name.');
    }
    if (seen.has(receipt.action)) {
      throw blocked(plan, 'DISPATCH_TERRA_ACTION_INVALID',
        `Terra returned more than one local receipt for ${receipt.action}.`);
    }
    seen.add(receipt.action);
    const expected = allowed.get(receipt.action);
    if (!expected) {
      throw blocked(plan, 'DISPATCH_TERRA_ACTION_INVALID',
        `Terra returned an unexpected local action ${receipt.action}.`);
    }
    if (receipt.effect !== expected.effect) {
      throw blocked(plan, 'DISPATCH_TERRA_ACTION_INVALID',
        `Terra action ${receipt.action} reported effect ${String(receipt.effect).slice(0, 20)}, not ${expected.effect}.`);
    }
    if (receipt.ok !== true) {
      throw blocked(plan, 'DISPATCH_TERRA_ACTION_INVALID',
        `Terra action ${receipt.action} did not report ok:true.`);
    }
    if (!isObject(receipt.result) || receipt.result.ok !== true) {
      throw blocked(plan, 'DISPATCH_TERRA_ACTION_INVALID',
        `Terra action ${receipt.action} has no successful local result evidence.`);
    }
  }
  const missing = [...allowed.keys()].filter(name => !seen.has(name));
  if (missing.length) {
    throw blocked(plan, 'DISPATCH_TERRA_ACTION_MISSING',
      `Terra finished without the required local action receipt(s): ${missing.join(', ')}. Model text is not evidence.`,
      { missingActions: missing });
  }
  return result.actions;
}

function validateTerraResult(plan, result, authorizedActions = null) {
  if (!isObject(result) || result.status !== 'finished' || result.confirmed !== true) {
    throw blocked(plan, 'DISPATCH_TERRA_INCOMPLETE',
      `Terra did not return a finished, confirmed ${TERRA_MODEL} receipt.`);
  }
  if (result.model !== TERRA_MODEL) {
    throw blocked(plan, 'DISPATCH_TERRA_ROUTE_MISMATCH',
      `Terra returned model ${String(result.model).slice(0, 80)}, not ${TERRA_MODEL}.`);
  }
  if (result.reasoning_effort !== undefined && result.reasoning_effort !== TERRA_REASONING_EFFORT) {
    throw blocked(plan, 'DISPATCH_TERRA_ROUTE_MISMATCH',
      `Terra returned top-level effort ${String(result.reasoning_effort).slice(0, 40)}, not ${TERRA_REASONING_EFFORT}.`);
  }
  const rounds = assertTerraRounds(plan, result.rounds);
  const actions = assertTerraActions(plan, result, rounds, authorizedActions);
  const text = textOf(result);
  if (!text) {
    throw blocked(plan, 'DISPATCH_TERRA_NO_OUTPUT', 'Terra returned no usable text output.');
  }
  return { rounds, actions, text, model: result.model, reasoning_effort: TERRA_REASONING_EFFORT };
}

function terraReceipt(plan, result, source, { rounds, actions, text, reasoningEffort }) {
  return {
    status: 'completed',
    backend: Backend.TERRA,
    source,
    purpose: plan.purpose,
    requested_model: TERRA_MODEL,
    requested_reasoning_effort: TERRA_REASONING_EFFORT,
    model: result.model,
    returned_model: typeof result.model === 'string' ? result.model : null,
    returned_backend: typeof result.backend === 'string' ? result.backend : null,
    reasoning_effort: reasoningEffort,
    returned_reasoning_effort: reasoningEffort,
    transport: typeof result.transport === 'string' ? result.transport : plan.executor.transport,
    returned_transport: typeof result.transport === 'string' ? result.transport : null,
    text,
    report: text,
    actions,
    rounds,
    response_ids: rounds.map(round => round.response_id),
    usage: result.usage ?? null,
    confirmed: result.confirmed === true,
    plan
  };
}

export async function runApiTerraTask({ plan, prompt, capabilities = {}, terraClient = null, terraFactory = null, signal, task = null, allowWrite = false }) {
  if (!plan || plan.schema !== 1) throw new DispatchPolicyError('DISPATCH_PLAN_INVALID', 'A resolved dispatch plan is required.');
  if (plan.source !== DispatchSource.API) throw new DispatchPolicyError('DISPATCH_SOURCE_CONFLICT', 'API Terra execution requires source api.');
  validatePrompt(prompt);
  assertCapabilities(plan, capabilities);
  const actions = createTerraCapabilityActions({ plan, prompt, capabilities, task });
  const blockedWrites = actions.filter(action => action.effect === 'write' && allowWrite !== true);
  if (blockedWrites.length) {
    throw new DispatchBlockedError('DISPATCH_PERMISSION_REQUIRED',
      `The selected capability requires workspace-write authorization: ${blockedWrites.map(action => action.name).join(', ')}.`,
      { plan });
  }
  const factory = typeof terraFactory === 'function' ? terraFactory : createProtectedTerraClient;
  // Independent snapshot of the approved name/effect pairs, taken before the
  // factory sees the live action objects. Receipts are checked against this,
  // never against a later mutation or an effect inferred from the receipt.
  const authorizedActions = new Map(actions.map(action => [action.name, action.effect]));
  const client = terraClient ?? factory({ actions, allowWrite: allowWrite === true });
  if (!client || typeof client.run !== 'function') {
    throw new DispatchBlockedError('DISPATCH_TERRA_CLIENT_MISSING',
      'The existing protected Terra client is unavailable; no substitute model was called.',
      { plan, missingAdapters: ['protected_terra_client'] });
  }
  // Read-only readiness first. No response is sent when the fixed Terra route
  // or any required tool capability is not proved.
  if (typeof client.status === 'function') {
    const status = await client.status();
    if (status?.ready !== true) {
      throw new DispatchBlockedError('DISPATCH_TERRA_NOT_READY',
        `The protected Terra broker is not ready (${String(status?.code ?? 'TERRA_BROKER_NOT_READY').slice(0, 80)}); no response was sent.`,
        { plan });
    }
  }
  let result;
  try { result = await client.run({ input: terraInput(plan, prompt), ...(signal ? { signal } : {}) }); }
  catch (error) {
    if (error?.code && (String(error.code).startsWith('TERRA_')
      || error.usageUnknown !== undefined || error.requestSent !== undefined)) throw error;
    throw new DispatchBlockedError('DISPATCH_TERRA_FAILED', 'The protected Terra client failed; no fallback model was called.',
      { plan, missingAdapters: [] });
  }
  const evidence = validateTerraResult(plan, result, authorizedActions);
  return terraReceipt(plan, result, DispatchSource.API, {
    rounds: evidence.rounds,
    actions: evidence.actions,
    text: evidence.text,
    reasoningEffort: evidence.reasoning_effort
  });
}

export async function runNativeTerraTask({ plan, prompt, nativeTerra = null, task = null }) {
  if (!plan || plan.schema !== 1) throw new DispatchPolicyError('DISPATCH_PLAN_INVALID', 'A resolved dispatch plan is required.');
  if (plan.source !== DispatchSource.SUBSCRIPTION) throw new DispatchPolicyError('DISPATCH_SOURCE_CONFLICT', 'Native Terra execution requires source subscription.');
  validatePrompt(prompt);
  if (!nativeTerra || typeof nativeTerra.dispatch !== 'function') {
    throw new DispatchBlockedError('DISPATCH_NATIVE_TERRA_MISSING',
      'The subscription source requires a real host-native Terra adapter; no API model or substitute was called.',
      { plan, missingAdapters: ['native_terra_host_adapter'] });
  }
  // A native host must prove the capability set it claims. For a non-writing
  // purpose, an undeclared capability set is not a pass: it is missing proof.
  const declared = Array.isArray(nativeTerra.capabilities) ? nativeTerra.capabilities : [];
  const missing = plan.capabilities.required.filter(name => !declared.includes(name));
  if (missing.length) {
    throw new DispatchBlockedError('DISPATCH_CAPABILITY_MISSING',
      `The native Terra host does not provide: ${missing.join(', ')}.`, { plan, missingCapabilities: missing });
  }
  const result = await nativeTerra.dispatch({
    model: TERRA_MODEL,
    reasoning_effort: TERRA_REASONING_EFFORT,
    purpose: plan.purpose,
    source: DispatchSource.SUBSCRIPTION,
    prompt,
    required_capabilities: plan.capabilities.required,
    task
  });
  if (!isObject(result) || !['completed', 'finished'].includes(result.status)) {
    throw new DispatchBlockedError('DISPATCH_NATIVE_TERRA_INCOMPLETE',
      'The native Terra host did not return a completed receipt.', { plan });
  }
  // Native provenance is actual host evidence, not the requested Terra label.
  // A host that omits the returned model or effort has not proved the route.
  if (result.model !== TERRA_MODEL) {
    throw blocked(plan, 'DISPATCH_TERRA_ROUTE_MISMATCH',
      `The native host returned ${String(result.model).slice(0, 80)}, not ${TERRA_MODEL}.`);
  }
  if (result.reasoning_effort !== TERRA_REASONING_EFFORT) {
    throw blocked(plan, 'DISPATCH_TERRA_ROUTE_MISMATCH',
      `The native host returned effort ${String(result.reasoning_effort).slice(0, 40)}, not ${TERRA_REASONING_EFFORT}.`);
  }
  const actionSource = plan.purpose === 'writing' && result.actions === undefined
    ? { ...result, actions: [] }
    : result;
  const actions = assertTerraActions(plan, actionSource, null);
  const text = textOf(result);
  if (!text) {
    throw new DispatchBlockedError('DISPATCH_TERRA_NO_OUTPUT', 'The native Terra host returned no usable text output.', { plan });
  }
  const rounds = Array.isArray(result.rounds) ? result.rounds : [];
  return terraReceipt(plan, result, DispatchSource.SUBSCRIPTION, {
    rounds,
    actions,
    text,
    reasoningEffort: result.reasoning_effort
  });
}

function solCoordinatorFor(options) {
  const candidate = options.coordinator ?? options.solCoordinator ?? options.nativeSol ?? options.sol ?? null;
  if (candidate === null || candidate === undefined) return null;
  if (!isObject(candidate) || typeof candidate.coordinate !== 'function') {
    throw new DispatchBlockedError('DISPATCH_COORDINATOR_INVALID',
      'The Sol coordinator adapter must be an object that implements coordinate(); a raw DSF adapter is not a Sol owner entry.',
      { missingAdapters: ['sol_coordinator'] });
  }
  return candidate;
}

function executorFor(plan, options) {
  const name = plan.executor.backend === Backend.WORKBUDDY_DSF ? 'workbuddy' : 'dsh';
  const adapter = options[name] ?? options[plan.executor.backend];
  if (!adapter) {
    throw new DispatchBlockedError('DISPATCH_EXECUTOR_UNAVAILABLE',
      `No ${plan.executor.label} adapter was supplied to the Sol coordinator; no backend was substituted.`,
      { plan, missingAdapters: [name] });
  }
  const call = typeof adapter === 'function' ? adapter : adapter.dispatch ?? adapter.submit;
  if (typeof call !== 'function') {
    throw new DispatchPolicyError('DISPATCH_EXECUTOR_INVALID', `The ${name} adapter must be a function or provide dispatch()/submit().`);
  }
  return Object.freeze({
    backend: plan.executor.backend,
    label: plan.executor.label,
    model: plan.executor.model,
    reasoning_effort: plan.executor.reasoning_effort,
    adapter,
    submit(request) { return call.call(adapter, request); }
  });
}

async function runGeneralCoordinator(plan, input, options) {
  // The generic public route must invoke a real Sol coordinator adapter before
  // any DSF adapter. The coordinator receives the selected backend handle and
  // alone decides when to call it; this runtime never calls DSF directly here.
  const coordinator = solCoordinatorFor(options);
  if (!coordinator) {
    throw new DispatchBlockedError('DISPATCH_COORDINATOR_MISSING',
      `The ${plan.source} general route requires a real Sol coordinator adapter; no ${plan.executor.label} execution was invoked directly.`,
      { plan, missingAdapters: ['sol_coordinator'] });
  }
  const backend = executorFor(plan, options);
  const peers = plan.source === DispatchSource.SUBSCRIPTION ? nativePeerCoordinator(input, options) : null;
  let result;
  let peerResults;
  try {
    result = await coordinator.coordinate({
      plan,
      prompt: input.prompt,
      task: input.task ?? null,
      purpose: plan.purpose,
      source: plan.source,
      model: plan.coordinator.model,
      reasoning_effort: plan.coordinator.reasoning_effort,
      coordinator: plan.coordinator,
      backend,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(peers ? { delegatePeer: peers.delegate } : {})
    });
    if (!isObject(result)) {
      throw new DispatchBlockedError('DISPATCH_COORDINATOR_INVALID_RESULT',
        'The Sol coordinator adapter returned no receipt; no backend result was substituted.',
        { plan });
    }
    peerResults = await peers?.collect();
  } finally {
    peers?.close();
  }
  // Preserve actual producer fields. Only the requested labels are added, and
  // selected_backend is not allowed to overwrite a coordinator's actual value.
  return {
    ...result,
    ...(peerResults?.length ? { peer_results: peerResults } : {}),
    dispatch: plan,
    ...(Object.hasOwn(result, 'selected_backend') ? {} : { selected_backend: plan.executor.backend }),
    requested_backend: plan.executor.backend,
    requested_model: plan.executor.model,
    requested_reasoning_effort: plan.executor.reasoning_effort,
    requested_coordinator: plan.coordinator
  };
}

export async function dispatchLayeredTask(input, options = {}) {
  const plan = resolveDispatch(input);
  validatePrompt(input.prompt);
  assertNoRawMedia(input);
  assertNoRawMedia(input.task);
  if (plan.layer === 'coordinator') return runGeneralCoordinator(plan, input, options);
  if (plan.source === DispatchSource.API) {
    return runApiTerraTask({
      plan,
      prompt: input.prompt,
      capabilities: options.capabilities ?? {},
      terraClient: options.terraClient ?? null,
      terraFactory: options.terraFactory ?? null,
      signal: options.signal,
      task: input.task ?? null,
      allowWrite: options.allowWrite === true || input.permissionMode === 'workspace-write'
    });
  }
  return runNativeTerraTask({ plan, prompt: input.prompt, nativeTerra: options.nativeTerra ?? null, task: input.task ?? null });
}

export { hostHandoff };
