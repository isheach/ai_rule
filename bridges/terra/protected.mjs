// Protected Terra entry for trusted local adapters.
//
// Production callers get a real TerraClient whose only transport is the local
// Windows credential broker. There is no URL, credential source, API key,
// model, effort, transport or broker override in the public factory. Before
// every Responses request the broker status must prove, in one reply, that the
// broker is ready and that Terra is enabled with the fixed model and effort.
// A missing field, an error reply, an unknown reply or an unsupported tool list
// is never treated as ready.
//
// The broker is the only place a credential may live. This module never reads
// an API key from the environment, never falls back to a subscription, never
// starts a service, never retries and never executes model-supplied data.
// `createTerraTestHarness` is an offline test seam only, not an adapter API.

import { brokerCall } from '../sol/broker.mjs';
import {
  ACTION_TOOL,
  CONFIRM_TOOL,
  FINISH_TOOL,
  TERRA_MODEL,
  TERRA_REASONING_EFFORT,
  TerraClient,
  TerraError
} from './client.mjs';

export const TERRA_BROKER_STATUS_TIMEOUT_MS = 5000;
export const TERRA_BROKER_RESPONSE_TIMEOUT_MS = 200000;

export const TERRA_ACCEPTANCE_LIMITS = Object.freeze({
  max_rounds: 4,
  max_actions: 1,
  max_output_tokens: 512,
  max_total_tokens: 6000,
  max_input_bytes: 16000,
  max_report_bytes: 1200
});

export const TERRA_ACCEPTANCE_INPUT = [
  'Call terra_action exactly once with action inspect_contract.',
  'Then call finish_terra with a short report of the local result.',
  'Do not request files, commands, logs, credentials, URLs, or any other action.'
].join(' ');

export const TERRA_ACCEPTANCE_ACTION = Object.freeze({
  name: 'inspect_contract',
  effect: 'read',
  description: 'Read the fixed local Terra contract. No file, network, command, or model data.',
  callback() {
    return {
      ok: true,
      source: 'fixed-local-contract',
      model: TERRA_MODEL,
      reasoning_effort: TERRA_REASONING_EFFORT,
      confirm_tool: CONFIRM_TOOL,
      action_tool: ACTION_TOOL,
      finish_tool: FINISH_TOOL,
      read_only: true
    };
  }
});

// These broker replies prove that no upstream request was admitted. This is
// the same conservative set used by the Sol Responses client. Every other
// failure, including an interrupted helper or an unrecognized code, leaves the
// request and usage outcome unknown.
const BROKER_UNSENT = new Set([
  'BROKER_FORBIDDEN',
  'BROKER_PROTOCOL',
  'BROKER_POLICY_DENIED',
  'BROKER_INPUT_LIMIT',
  'BROKER_CREDENTIAL_MISSING',
  'BROKER_RATE_LIMITED',
  'BROKER_BUSY',
  'BROKER_STORAGE_UNAVAILABLE',
  'UPSTREAM_UNSENT'
]);

const ALLOWED_OPTIONS = new Set(['actions', 'allowWrite', 'limits']);
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const RESPONSE_ID = /^resp_[A-Za-z0-9_-]{1,190}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeCode(value) {
  return typeof value === 'string' && CODE.test(value) ? value : null;
}

function safeStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function safeResponseId(value) {
  return typeof value === 'string' && RESPONSE_ID.test(value) ? value : null;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function pickUsage(value) {
  if (!isObject(value)) return null;
  const input = count(value.input_tokens);
  const output = count(value.output_tokens);
  const total = count(value.total_tokens);
  if (input === null || output === null || total === null) return null;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Math.max(total, input + output),
    cached_input_tokens: count(value.input_tokens_details?.cached_tokens)
      ?? count(value.cached_input_tokens) ?? 0,
    reasoning_tokens: count(value.output_tokens_details?.reasoning_tokens)
      ?? count(value.reasoning_tokens) ?? 0
  };
}

function failureRecord(code, { status = null, known, usageUnknown, requestSent }) {
  return Object.freeze({
    code,
    status: safeStatus(status),
    known: known === true,
    usageUnknown: usageUnknown === true,
    requestSent: requestSent === true ? true : requestSent === false ? false : null
  });
}

export class TerraProviderError extends Error {
  constructor(code, message, {
    status = null,
    known = false,
    usageUnknown = true,
    requestSent = null,
    usage = null,
    responseIds = []
  } = {}) {
    super(message);
    this.name = 'TerraProviderError';
    this.code = safeCode(code) ?? 'TERRA_BROKER_UNKNOWN';
    this.status = safeStatus(status);
    this.known = known === true;
    this.usageUnknown = usageUnknown === true;
    this.requestSent = requestSent === true ? true : requestSent === false ? false : null;
    this.usage = this.known ? pickUsage(usage) : null;
    this.responseIds = Object.freeze(responseIds.map(safeResponseId).filter(Boolean));
  }
}

function optionSet(options, allowBroker) {
  if (options === undefined) return {};
  if (!isObject(options)) {
    throw new TerraError('TERRA_OPTIONS_FORBIDDEN',
      'Terra protected client options must be an object with actions, allowWrite, or limits.');
  }
  for (const key of Object.keys(options)) {
    if (allowBroker && key === 'callBroker') continue;
    if (!ALLOWED_OPTIONS.has(key)) {
      throw new TerraError('TERRA_OPTIONS_FORBIDDEN',
        'Terra protected client does not accept URL, credential, model, effort, transport, or broker overrides.');
    }
  }
  return options;
}

function statusSnapshot(callBroker) {
  const unavailable = { ready: false, code: 'TERRA_BROKER_UNAVAILABLE', broker_read: false };
  const protocol = { ready: false, code: 'TERRA_BROKER_PROTOCOL', broker_read: true };
  return (async () => {
    let reply;
    try {
      reply = await callBroker({ op: 'status' }, AbortSignal.timeout(TERRA_BROKER_STATUS_TIMEOUT_MS));
    } catch {
      return unavailable;
    }
    if (!isObject(reply) || typeof reply.ok !== 'boolean' || !Number.isInteger(reply.status)) {
      return protocol;
    }
    if (reply.ok !== true) {
      return {
        ready: false,
        code: safeCode(reply.code) ?? 'TERRA_BROKER_UNKNOWN',
        status: safeStatus(reply.status),
        broker_read: true
      };
    }
    if (reply.status !== 200 || !isObject(reply.body)) return protocol;

    const body = reply.body;
    const hasTools = Object.hasOwn(body, 'terra_tools');
    const tools = hasTools && Array.isArray(body.terra_tools)
      && body.terra_tools.every(tool => typeof tool === 'string')
      ? [...body.terra_tools]
      : null;
    const snapshot = {
      ready: false,
      code: null,
      broker_read: true,
      terra_enabled: body.terra_enabled === true,
      terra_model: typeof body.terra_model === 'string' ? body.terra_model : null,
      terra_reasoning_effort: typeof body.terra_reasoning_effort === 'string'
        ? body.terra_reasoning_effort : null,
      terra_tools: tools,
      model: typeof body.model === 'string' ? body.model : null,
      reasoning_effort: typeof body.reasoning_effort === 'string' ? body.reasoning_effort : null,
      max_input_bytes: count(body.max_input_bytes),
      max_output_tokens: count(body.max_output_tokens),
      api_timeout_ms: count(body.api_timeout_ms)
    };
    if (body.ready !== true) return { ...snapshot, code: 'TERRA_BROKER_NOT_READY' };
    if (body.terra_enabled !== true) return { ...snapshot, code: 'TERRA_BROKER_TERRA_DISABLED' };
    if (body.terra_model !== TERRA_MODEL || body.terra_reasoning_effort !== TERRA_REASONING_EFFORT) {
      return { ...snapshot, code: 'TERRA_BROKER_ROUTE_MISMATCH' };
    }
    // An enabled Terra role must prove the complete tool capability. A missing,
    // partial or malformed terra_tools is not ready. A status body without
    // terra_enabled (including the legacy service) was already rejected above,
    // so it is never assumed capable of the new role. This is capability
    // gating, not a request grant.
    if (!hasTools || tools === null
      || ![CONFIRM_TOOL, ACTION_TOOL, FINISH_TOOL].every(name => tools.includes(name))) {
      return { ...snapshot, code: 'TERRA_BROKER_UNSUPPORTED' };
    }
    return { ...snapshot, ready: true };
  })();
}

function createTransport(callBroker) {
  let failure = null;

  async function request(body) {
    failure = null;
    if (!isObject(body)
      || body.model !== TERRA_MODEL
      || body.reasoning?.effort !== TERRA_REASONING_EFFORT) {
      failure = failureRecord('TERRA_ROUTE_MISMATCH', {
        known: true, usageUnknown: false, requestSent: false
      });
      throw new Error('The Terra request did not use the fixed model and effort.');
    }

    // Fail closed immediately before every response. A status reply is read
    // only, never billable, and must satisfy all capability fields at once.
    const readiness = await statusSnapshot(callBroker);
    if (readiness.ready !== true) {
      failure = failureRecord(readiness.code ?? 'TERRA_BROKER_NOT_READY', {
        status: readiness.status,
        known: true,
        usageUnknown: false,
        requestSent: false
      });
      throw new Error('The local Terra broker did not prove readiness.');
    }

    let reply;
    try {
      reply = await callBroker({ op: 'response', body },
        AbortSignal.timeout(TERRA_BROKER_RESPONSE_TIMEOUT_MS));
    } catch {
      failure = failureRecord('TERRA_BROKER_UNAVAILABLE', {
        known: false, usageUnknown: true, requestSent: null
      });
      throw new Error('The local Terra broker did not return a complete reply.');
    }

    if (!isObject(reply) || typeof reply.ok !== 'boolean' || !Number.isInteger(reply.status)) {
      failure = failureRecord('TERRA_BROKER_PROTOCOL', {
        known: false, usageUnknown: true, requestSent: null
      });
      throw new Error('The local Terra broker returned an invalid reply.');
    }

    if (reply.ok !== true) {
      const code = safeCode(reply.code);
      const status = safeStatus(reply.status);
      if (code === null || status === null) {
        failure = failureRecord('TERRA_BROKER_UNKNOWN', {
          status,
          known: false,
          usageUnknown: true,
          requestSent: null
        });
        throw new Error('The local Terra broker returned an unrecognized failure.');
      }
      const refused = BROKER_UNSENT.has(code);
      failure = failureRecord(code, {
        status,
        known: refused,
        usageUnknown: !refused,
        requestSent: refused ? false : code === 'UPSTREAM_HTTP' ? true : null
      });
      throw new Error('The local Terra broker declined or failed the response.');
    }

    if (reply.status !== 200 || !isObject(reply.body)) {
      failure = failureRecord('TERRA_BROKER_PROTOCOL', {
        status: reply.status,
        known: false,
        usageUnknown: true,
        requestSent: null
      });
      throw new Error('The local Terra broker returned an invalid success envelope.');
    }
    return reply.body;
  }

  return {
    request,
    status: () => statusSnapshot(callBroker),
    takeFailure() {
      const value = failure;
      failure = null;
      return value;
    }
  };
}

class ProtectedTerraClient extends TerraClient {
  #transport;

  constructor({ actions, allowWrite, limits, callBroker }) {
    const transport = createTransport(callBroker);
    super({ request: transport.request, actions, allowWrite, limits });
    this.#transport = transport;
  }

  // Read-only broker status. No response operation is sent and nothing is
  // billed; the result is a whitelisted snapshot, never the raw reply.
  async status() {
    return this.#transport.status();
  }

  async confirm(options) {
    return this.#guard(() => super.confirm(options));
  }

  async run(options) {
    return this.#guard(() => super.run(options));
  }

  async #guard(operation) {
    try {
      return await operation();
    } catch (error) {
      const failure = this.#transport.takeFailure();
      if (failure && error?.code === 'TERRA_RESPONSE_UNKNOWN') {
        const state = error.state ?? {};
        const responseIds = (Array.isArray(state.evidence) ? state.evidence : [])
          .map(entry => safeResponseId(entry?.response_id))
          .filter(Boolean);
        throw new TerraProviderError(failure.code,
          'The Terra response did not complete; inspect code, status, and known/unknown.',
          {
            status: failure.status,
            known: failure.known,
            usageUnknown: failure.usageUnknown,
            requestSent: failure.requestSent,
            usage: failure.known ? state.usage : null,
            responseIds
          });
      }
      throw error;
    }
  }
}

// Public production entry. Only local action registration and the client's
// bounded limits may be supplied; routing and credentials are fixed.
export function createProtectedTerraClient(options = {}) {
  const normalized = optionSet(options, false);
  return new ProtectedTerraClient({
    actions: normalized.actions,
    allowWrite: normalized.allowWrite,
    limits: normalized.limits,
    callBroker: brokerCall
  });
}

// Offline test seam. It is deliberately separate from the production entry,
// which rejects a broker/transport override. Do not use this to dispatch work.
export function createTerraTestHarness(options = {}) {
  const normalized = optionSet(options, true);
  if (typeof normalized.callBroker !== 'function') {
    throw new TerraError('TERRA_OPTIONS_FORBIDDEN',
      'The Terra offline harness requires an injected callBroker function.');
  }
  return new ProtectedTerraClient({
    actions: normalized.actions,
    allowWrite: normalized.allowWrite,
    limits: normalized.limits,
    callBroker: normalized.callBroker
  });
}

// Read-only status for the CLI. No response operation, credential, or key read.
export async function readTerraStatus() {
  return statusSnapshot(brokerCall);
}

function boundedReport(value, maxBytes) {
  if (typeof value !== 'string') return '';
  let text = value;
  while (Buffer.byteLength(text, 'utf8') > maxBytes) text = text.slice(0, -1);
  return text;
}

// Turn a real TerraClient.run() result into bounded acceptance evidence. The
// model's report is retained only as clearly labelled model text; success
// requires the local read-only action receipt and the confirmation round.
export function summarizeTerraAcceptance(result) {
  const state = {
    evidence: result?.rounds ?? [],
    actions: result?.actions ?? [],
    usage: result?.usage ?? null
  };
  const incomplete = message => {
    throw new TerraError('TERRA_ACCEPTANCE_INCOMPLETE', message, state);
  };
  if (!isObject(result) || result.status !== 'finished' || result.confirmed !== true) {
    incomplete('The bounded acceptance run did not finish with a confirmation.');
  }
  if (result.model !== TERRA_MODEL) incomplete('The acceptance result did not use the fixed Terra model.');
  const rounds = Array.isArray(result.rounds) ? result.rounds : [];
  if (rounds.length < 2 || rounds[0]?.tool !== CONFIRM_TOOL) {
    incomplete('The acceptance result has no confirm_terra_api round.');
  }
  const receipts = Array.isArray(result.actions) ? result.actions : [];
  const receipt = receipts.find(entry => entry?.action === TERRA_ACCEPTANCE_ACTION.name
    && entry?.effect === 'read' && entry?.ok === true);
  if (!receipt || receipts.length !== 1) {
    incomplete('The bounded acceptance run has no single successful read-only action receipt.');
  }
  const responseIds = rounds.map(round => safeResponseId(round?.response_id));
  if (responseIds.some(id => id === null)) {
    incomplete('The acceptance evidence contains an invalid response ID.');
  }
  const usage = pickUsage(result.usage);
  if (usage === null) incomplete('The acceptance result has no valid usage evidence.');
  const local = isObject(receipt.result) ? receipt.result : {};
  return {
    ok: true,
    status: 'verified',
    response_ids: responseIds,
    rounds: rounds.length,
    model: TERRA_MODEL,
    reasoning_effort: TERRA_REASONING_EFFORT,
    usage,
    action: {
      name: TERRA_ACCEPTANCE_ACTION.name,
      effect: 'read',
      ok: true,
      checks: {
        source: local.source === 'fixed-local-contract' ? 'fixed-local-contract' : null,
        model: local.model === TERRA_MODEL ? TERRA_MODEL : null,
        reasoning_effort: local.reasoning_effort === TERRA_REASONING_EFFORT
          ? TERRA_REASONING_EFFORT : null,
        read_only: local.read_only === true
      }
    },
    model_report: boundedReport(result.report, TERRA_ACCEPTANCE_LIMITS.max_report_bytes),
    evidence: 'local read-only action receipt; the model report is not evidence'
  };
}
