// Layered dispatch policy.
//
// This module is pure routing: it reads an explicitly selected purpose, source
// and (optionally) backend, and returns the fixed model layers. It never reads
// the prompt, a log, a filename or a keyword to guess a purpose. A caller that
// does not select a purpose gets `general`, whatever the prompt says.
//
// Layers:
//   general/coordinating -> gpt-6.2-sol (max) -> DSH's configured
//     opencode-go/deepseek-v4.1-flash by default, WorkBuddy DSF selectable.
//   computer_operation, acceptance, image_generation,
//     image_recognition -> gpt-6.1-terra (max), through the real native host
//     on the subscription source or the protected Terra client on the API
//     source.
//   writing -> pinned Antigravity CLI on a configured host, with legacy Terra
//     compatibility for existing or explicitly selected routes.
//
// No backend or model is invented here. Unsupported combinations fail closed
// and name the supported choices.

import { normalizeEntryStructure } from '../entry-structure.mjs';

export const DISPATCH_SCHEMA = 1;
export const DISPATCH_POLICY_VERSION = '2026-11-21.layered-defaults-r1';

export const DispatchSource = Object.freeze({
  SUBSCRIPTION: 'subscription',
  API: 'api'
});
export const SOURCES = Object.freeze(Object.values(DispatchSource));
export const DEFAULT_SOURCE = DispatchSource.SUBSCRIPTION;

export const Purpose = Object.freeze({
  GENERAL: 'general',
  COMPUTER_OPERATION: 'computer_operation',
  ACCEPTANCE: 'acceptance',
  WRITING: 'writing',
  IMAGE_GENERATION: 'image_generation',
  IMAGE_RECOGNITION: 'image_recognition'
});
export const PURPOSES = Object.freeze(Object.values(Purpose));

export const Backend = Object.freeze({
  DSH: 'dsh',
  WORKBUDDY_DSF: 'workbuddy-dsf',
  TERRA: 'terra',
  ANTIGRAVITY: 'antigravity'
});
export const BACKENDS = Object.freeze(Object.values(Backend));

export const SOL_MODEL = 'gpt-6.2-sol';
export const SOL_REASONING_EFFORT = 'max';
export const TERRA_MODEL = 'gpt-6.1-terra';
export const TERRA_REASONING_EFFORT = 'max';
export const LUNA_MODEL = 'gpt-6-luna';
export const LUNA_REASONING_EFFORT = 'max';
export const DSH_MODEL = 'deepseek-v4.1-flash';
export const DSH_REASONING_EFFORT = 'max';
export const WORKBUDDY_MODEL = 'deepseek-v4-flash';
export const WORKBUDDY_REASONING_EFFORT = 'max';

const PURPOSE_ALIASES = Object.freeze({
  general: Purpose.GENERAL,
  coordinating: Purpose.GENERAL,
  coordination: Purpose.GENERAL,
  computer_operation: Purpose.COMPUTER_OPERATION,
  'computer-operation': Purpose.COMPUTER_OPERATION,
  'computer operation': Purpose.COMPUTER_OPERATION,
  acceptance: Purpose.ACCEPTANCE,
  accept: Purpose.ACCEPTANCE,
  writing: Purpose.WRITING,
  write: Purpose.WRITING,
  drawing: Purpose.IMAGE_GENERATION,
  draw: Purpose.IMAGE_GENERATION,
  image_generation: Purpose.IMAGE_GENERATION,
  'image-generation': Purpose.IMAGE_GENERATION,
  'image generation': Purpose.IMAGE_GENERATION,
  image_recognition: Purpose.IMAGE_RECOGNITION,
  'image-recognition': Purpose.IMAGE_RECOGNITION,
  'image recognition': Purpose.IMAGE_RECOGNITION
});

const BACKEND_ALIASES = Object.freeze({
  dsh: Backend.DSH,
  'dsh opencode go deepseek flash': Backend.DSH,
  'opencode-go': Backend.DSH,
  'workbuddy dsf': Backend.WORKBUDDY_DSF,
  workbuddy: Backend.WORKBUDDY_DSF,
  'workbuddy-dsf': Backend.WORKBUDDY_DSF,
  wb: Backend.WORKBUDDY_DSF,
  terra: Backend.TERRA,
  'gpt-6.1-terra': Backend.TERRA,
  antigravity: Backend.ANTIGRAVITY,
  agy: Backend.ANTIGRAVITY
});

const SOURCE_ALIASES = Object.freeze({
  subscription: DispatchSource.SUBSCRIPTION,
  api: DispatchSource.API
});

// Required capabilities are host-bound. They are not inferred from text and
// they are not silently replaced by a different model.
export const CAPABILITY_POLICY = Object.freeze({
  [Purpose.GENERAL]: Object.freeze({ required: Object.freeze([]), output: 'text' }),
  [Purpose.COMPUTER_OPERATION]: Object.freeze({ required: Object.freeze(['computer_operation']), output: 'action+text' }),
  [Purpose.ACCEPTANCE]: Object.freeze({ required: Object.freeze(['acceptance']), output: 'action+text' }),
  [Purpose.WRITING]: Object.freeze({ required: Object.freeze([]), output: 'text' }),
  [Purpose.IMAGE_GENERATION]: Object.freeze({ required: Object.freeze(['image_generation']), output: 'image-handle+text' }),
  [Purpose.IMAGE_RECOGNITION]: Object.freeze({ required: Object.freeze(['image_recognition']), output: 'text' })
});

const SPECIALIST_PURPOSES = new Set(PURPOSES.filter(purpose => purpose !== Purpose.GENERAL));
const WORKBUDDY_SERVER = 'deepseek-v4-flash-workbuddy';

export class DispatchPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DispatchPolicyError';
    this.code = code;
    this.details = { ...details };
  }
}

export function normalizeSource(value, fallback = DispatchSource.SUBSCRIPTION) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') throw new DispatchPolicyError('DISPATCH_SOURCE_INVALID', 'source must be subscription or api.');
  const source = SOURCE_ALIASES[value.trim().toLowerCase()];
  if (!source) throw new DispatchPolicyError('DISPATCH_SOURCE_INVALID', 'source must be subscription or api.', { supported: SOURCES });
  return source;
}

export function normalizePurpose(value, fallback = Purpose.GENERAL) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') throw new DispatchPolicyError('DISPATCH_PURPOSE_INVALID', 'purpose must be one of the supported purposes.', { supported: PURPOSES });
  const purpose = PURPOSE_ALIASES[value.trim().toLowerCase()];
  if (!purpose) throw new DispatchPolicyError('DISPATCH_PURPOSE_INVALID', `Unsupported purpose "${value.trim().slice(0, 80)}".`, { supported: PURPOSES });
  return purpose;
}

export function normalizeBackend(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new DispatchPolicyError('DISPATCH_BACKEND_INVALID', 'backend must be DSH, WorkBuddy DSF, Terra or Antigravity.', { supported: BACKENDS });
  const backend = BACKEND_ALIASES[value.trim().toLowerCase()];
  if (!backend) throw new DispatchPolicyError('DISPATCH_BACKEND_INVALID', `Unsupported backend "${value.trim().slice(0, 80)}".`, { supported: BACKENDS });
  return backend;
}

function coordinator(source) {
  if (source === DispatchSource.SUBSCRIPTION) {
    return {
      layer: 'coordinator',
      provider: 'codex-subscription',
      model: SOL_MODEL,
      reasoning_effort: SOL_REASONING_EFFORT,
      transport: 'native-subscription'
    };
  }
  return {
    layer: 'coordinator',
    provider: 'openai-responses',
    model: SOL_MODEL,
    reasoning_effort: SOL_REASONING_EFFORT,
    transport: 'sol-coordinator',
    server_name: 'sol-coordinator'
  };
}

function dshExecutor() {
  return {
    backend: Backend.DSH,
    backend_name: 'DSH',
    label: 'DSH OpenCode Go DeepSeek Flash',
    provider: 'opencode-go',
    model: DSH_MODEL,
    reasoning_effort: DSH_REASONING_EFFORT,
    transport: 'dsh-headless',
    server_names: ['dsh-root-pool', 'dsh-opencode-go']
  };
}

function workBuddyExecutor() {
  return {
    backend: Backend.WORKBUDDY_DSF,
    backend_name: 'WorkBuddy DSF',
    label: 'WorkBuddy DeepSeek Flash',
    provider: 'workbuddy',
    model: WORKBUDDY_MODEL,
    reasoning_effort: WORKBUDDY_REASONING_EFFORT,
    transport: 'workbuddy-project',
    server_name: WORKBUDDY_SERVER
  };
}

function terraExecutor(source) {
  return {
    backend: Backend.TERRA,
    backend_name: 'Terra',
    label: 'Terra',
    provider: 'openai',
    model: TERRA_MODEL,
    reasoning_effort: TERRA_REASONING_EFFORT,
    transport: source === DispatchSource.API ? 'protected-terra' : 'native-terra'
  };
}

export function resolveDispatch(input = {}, { antigravityConfigured = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DispatchPolicyError('DISPATCH_INPUT_INVALID', 'Dispatch input must be an object.');
  }
  const allowed = new Set(['source', 'coordinatorMode', 'purpose', 'backend', 'prompt', 'task', 'permissionMode', 'entryStructure']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new DispatchPolicyError('DISPATCH_INPUT_INVALID', `Unsupported dispatch field "${key}".`);
  }
  const entryStructure = normalizeEntryStructure(input.entryStructure);
  if (input.source !== undefined && input.coordinatorMode !== undefined) {
    if (normalizeSource(input.source) !== normalizeSource(input.coordinatorMode)) {
      throw new DispatchPolicyError('DISPATCH_SOURCE_CONFLICT', 'source and coordinatorMode select different sources.');
    }
  }
  const sourceExplicit = input.source !== undefined || input.coordinatorMode !== undefined;
  const source = normalizeSource(input.source ?? input.coordinatorMode);
  const purposeExplicit = input.purpose !== undefined && input.purpose !== null && input.purpose !== '';
  const purpose = normalizePurpose(input.purpose);
  const explicitBackend = normalizeBackend(input.backend);
  const specialist = SPECIALIST_PURPOSES.has(purpose);
  const choices = !specialist ? [Backend.DSH, Backend.WORKBUDDY_DSF]
    : purpose === Purpose.WRITING ? [Backend.ANTIGRAVITY, Backend.TERRA] : [Backend.TERRA];

  let backend;
  if (explicitBackend === null) backend = purpose === Purpose.WRITING && antigravityConfigured ? Backend.ANTIGRAVITY
    : (specialist ? Backend.TERRA : Backend.DSH);
  else if (specialist && !choices.includes(explicitBackend)) {
    throw new DispatchPolicyError('DISPATCH_BACKEND_PURPOSE_CONFLICT',
      `${purpose} tasks are routed to ${TERRA_MODEL}; ${explicitBackend} is not a supported backend for that purpose.`,
      { purpose, requested_backend: explicitBackend, supported: choices });
  } else if (!specialist && explicitBackend === Backend.TERRA) {
    throw new DispatchPolicyError('DISPATCH_BACKEND_PURPOSE_CONFLICT',
      `Terra is selected only for explicitly specialized purposes; general/coordinating work uses ${SOL_MODEL}.`,
      { purpose, requested_backend: explicitBackend, supported: [Backend.DSH, Backend.WORKBUDDY_DSF] });
  } else if (!choices.includes(explicitBackend)) {
    throw new DispatchPolicyError('DISPATCH_BACKEND_PURPOSE_CONFLICT', 'Antigravity is restricted to writing.',
      { purpose, requested_backend: explicitBackend, supported: choices });
  } else backend = explicitBackend;

  const executor = backend === Backend.DSH ? dshExecutor()
    : backend === Backend.WORKBUDDY_DSF ? workBuddyExecutor()
      : backend === Backend.ANTIGRAVITY
        ? { backend, backend_name: 'Antigravity', label: 'Google Antigravity CLI', provider: 'google-antigravity-cli',
          model: null, reasoning_effort: null, transport: 'antigravity-cli', server_name: 'sol-coordinator' }
        : terraExecutor(source);
  const required = CAPABILITY_POLICY[purpose].required;

  return Object.freeze({
    schema: DISPATCH_SCHEMA,
    policy_version: DISPATCH_POLICY_VERSION,
    source,
    source_explicit: sourceExplicit,
    entry_structure: entryStructure,
    purpose,
    purpose_explicit: purposeExplicit,
    layer: specialist ? 'specialist' : 'coordinator',
    coordinator: specialist ? null : coordinator(source),
    executor: Object.freeze(executor),
    backend_source: explicitBackend === null ? 'default' : 'explicit',
    output: CAPABILITY_POLICY[purpose].output,
    capabilities: Object.freeze({
      required,
      transport: backend === Backend.ANTIGRAVITY ? 'isolated-host-text' : specialist
        ? (source === DispatchSource.API ? 'protected-terra-actions' : 'native-host')
        : 'executor-native',
      media: 'excluded-by-default',
      keyword_matching: 'disabled'
    }),
    choices: Object.freeze({
      sources: SOURCES,
      purposes: PURPOSES,
      backends: Object.freeze(choices)
    })
  });
}

// A subscription host entry cannot execute native Terra itself and must not
// pretend it can. These handoffs keep the selected route and tell the host what
// to invoke. They never contain a fabricated task ID.
export const resolveLayerDispatch = resolveDispatch;
export const resolveLayeredDispatch = resolveDispatch;

export function hostHandoff(plan, { reason = null } = {}) {  if (!plan || plan.schema !== DISPATCH_SCHEMA) throw new DispatchPolicyError('DISPATCH_PLAN_INVALID', 'A resolved dispatch plan is required.');
  if (plan.executor.backend === Backend.ANTIGRAVITY) return {
    status: 'not_dispatched', handoff: true, reason_code: 'ANTIGRAVITY_HOST_HANDOFF',
    selected_source: plan.source, selected_backend: Backend.ANTIGRAVITY, dispatch: plan,
    next_step: 'Use the configured sol-coordinator Antigravity text entry with explicit authorization.'
  };
  const specialist = plan.layer === 'specialist';
  const nextStep = specialist
    ? `Run the task with the current host's native Terra capability (${TERRA_MODEL}, effort ${TERRA_REASONING_EFFORT}). No billable model was substituted and no native route was invoked by this bridge.`
    : `Submit the task through the already registered WorkBuddy DSF entry (${WORKBUDDY_SERVER}). This bridge did not redirect the explicit backend to DSH.`;
  return {
    status: specialist ? 'native_handoff' : 'not_dispatched',
    reason_code: reason ?? (specialist ? 'NATIVE_TERRA_REQUIRED' : 'WORKBUDDY_DSF_HOST_HANDOFF'),
    handoff: true,
    selected_source: plan.source,
    selected_backend: plan.executor.backend,
    model: plan.executor.model,
    reasoning_effort: plan.executor.reasoning_effort,
    required_capabilities: plan.capabilities.required,
    dispatch: plan,
    next_step: nextStep
  };
}
