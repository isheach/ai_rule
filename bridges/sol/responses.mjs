import { redact } from '../dsh/core.mjs';
import { LUNA_MODEL, LUNA_REASONING_EFFORT, TERRA_MODEL, TERRA_REASONING_EFFORT } from '../dispatch/policy.mjs';
import { SAFE_ID } from './config.mjs';
import { brokerCall } from './broker.mjs';

// Only these replies prove no upstream request was admitted. An interrupted
// client or an unrecognized reply always leaves the usage outcome unknown.
const UNSENT = new Set(['BROKER_FORBIDDEN', 'BROKER_PROTOCOL', 'BROKER_POLICY_DENIED', 'BROKER_INPUT_LIMIT',
  'BROKER_CREDENTIAL_MISSING', 'BROKER_RATE_LIMITED', 'BROKER_BUSY', 'BROKER_STORAGE_UNAVAILABLE', 'UPSTREAM_UNSENT']);
const ID = value => typeof value === 'string' && SAFE_ID.test(value) && redact(value) === value ? value : null;
const PROBE = {
  type: 'function', name: 'confirm_sol_api', description: 'Confirm the configured model can call a strict function.', strict: true,
  parameters: { type: 'object', properties: { result: { type: 'string', enum: ['ready'] } }, required: ['result'], additionalProperties: false }
};
const PEERS = Object.freeze({
  terra: Object.freeze({ model: TERRA_MODEL, effort: TERRA_REASONING_EFFORT, confirm: 'confirm_terra_api' }),
  luna: Object.freeze({ model: LUNA_MODEL, effort: LUNA_REASONING_EFFORT, confirm: 'confirm_luna_api' })
});
export const PEER_NAMES = Object.freeze(Object.keys(PEERS));

function peerReadiness(body, peer) {
  const { model, effort, confirm } = PEERS[peer];
  const tools = [confirm, 'delegate_work', 'finish_coordination'];
  const route = { model, reasoning_effort: effort,
    ...(Number.isSafeInteger(body.requests_per_hour) && body.requests_per_hour > 0
      ? { requests_per_hour: body.requests_per_hour } : {}) };
  const prefix = peer.toUpperCase();
  if (body[`${peer}_enabled`] !== true) return { ...route, ready: false, code: `${prefix}_BROKER_DISABLED` };
  if (body[`${peer}_model`] !== model || body[`${peer}_reasoning_effort`] !== effort) {
    return { ...route, ready: false, code: `${prefix}_BROKER_ROUTE_MISMATCH` };
  }
  const advertised = body[`${peer}_tools`];
  if (!Array.isArray(advertised) || tools.some(tool => !advertised.includes(tool))) {
    return { ...route, ready: false, code: `${prefix}_BROKER_UNSUPPORTED` };
  }
  return { ...route, ready: body.ready === true, tools,
    ...(body.ready === true ? {} : { code: `${prefix}_BROKER_NOT_READY` }) };
}

export class ResponsesError extends Error {
  constructor(code, message, { evidence = null, usageUnknown = false } = {}) {
    super(message);
    this.code = code;
    this.evidence = evidence;
    this.usageUnknown = usageUnknown;
  }
}

function usageOf(value) {
  const count = number => Number.isSafeInteger(number) && number >= 0 ? number : null;
  const input = count(value?.input_tokens);
  const output = count(value?.output_tokens);
  if (input === null || output === null) return null;
  return {
    input_tokens: input, output_tokens: output,
    total_tokens: Math.max(count(value.total_tokens) ?? 0, input + output),
    cached_input_tokens: count(value.input_tokens_details?.cached_tokens),
    cache_write_tokens: count(value.input_tokens_details?.cache_write_tokens),
    reasoning_tokens: count(value.output_tokens_details?.reasoning_tokens)
  };
}

export class ResponsesClient {
  constructor({ config, callBroker = brokerCall, peer = null }) {
    if (peer !== null && !PEER_NAMES.includes(peer)) throw Error('Unknown protected API collaborator.');
    this.peer = peer;
    const route = peer ? PEERS[peer] : null;
    this.config = route
      ? { model: route.model, reasoning_effort: route.effort, credential_source: config.openai.credential_source }
      : config.openai;
    this.limits = config.limits;
    this.callBroker = callBroker;
  }

  forPeer(peer) {
    if (!PEER_NAMES.includes(peer)) throw Error('Unknown protected API collaborator.');
    return new ResponsesClient({
      config: { openai: this.config, limits: this.limits },
      callBroker: this.callBroker, peer
    });
  }

  async readiness() {
    if (this.config.credential_source !== 'windows-broker') return { ready: false, code: 'SOL_BROKER_MIGRATION_REQUIRED' };
    try {
      const reply = await this.callBroker({ op: 'status' }, AbortSignal.timeout(5000));
      if (reply?.ok === false && UNSENT.has(reply.code)) return { ready: false, code: reply.code };
      if (reply?.ok === true && reply.status === 200 && reply.body && typeof reply.body === 'object') {
        if (this.peer) return peerReadiness(reply.body, this.peer);
        if (reply.body?.model !== this.config.model || reply.body?.reasoning_effort !== this.config.reasoning_effort) {
          return { ready: false, code: 'SOL_BROKER_ROUTE_MISMATCH' };
        }
        const peer_api = Object.fromEntries(PEER_NAMES.map(peer => [peer, peerReadiness(reply.body, peer)]));
        const delegate_peer = Array.isArray(reply.body.sol_tools) && reply.body.sol_tools.includes('delegate_peer');
        return { ready: reply.body.ready === true, peer_api, delegate_peer,
          ...(reply.body.ready === true ? {} : { code: 'SOL_BROKER_NOT_READY' }) };
      }
    } catch { /* unavailable or unauthenticated helper */ }
    return { ready: false, code: 'SOL_BROKER_UNAVAILABLE' };
  }

  sanitize(value) { return redact(String(value)); }

  async request({ input, tools, signal, outputTokens = this.limits.max_output_tokens }) {
    if (this.config.credential_source !== 'windows-broker') throw new ResponsesError('SOL_BROKER_MIGRATION_REQUIRED', 'Migrate the local Sol configuration before using API Sol.');
    if (signal?.aborted) throw new ResponsesError('COORDINATION_STOPPED', 'Coordination stopped before the next API call.');
    const { model, reasoning_effort: effort, response_model: responseModel = model } = this.config;
    const body = {
      model, store: false, reasoning: { effort }, include: ['reasoning.encrypted_content'],
      input, tools, tool_choice: 'required', parallel_tool_calls: false, max_output_tokens: outputTokens
    };
    if (Buffer.byteLength(JSON.stringify(body)) > this.limits.max_input_bytes) {
      throw new ResponsesError('OPENAI_INPUT_LIMIT', 'The next Responses request exceeds the configured input byte limit.');
    }
    const timeout = AbortSignal.timeout(this.limits.api_timeout_ms);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let reply;
    try {
      reply = await this.callBroker({ op: 'response', body }, requestSignal);
      if (typeof reply?.ok !== 'boolean' || !Number.isInteger(reply.status)) throw Error();
    } catch {
      throw new ResponsesError(requestSignal.aborted ? 'OPENAI_REQUEST_INTERRUPTED' : 'OPENAI_RESPONSE_UNKNOWN',
        'The broker did not return a complete response. API usage and outcome are unknown.', { usageUnknown: true });
    }
    const safeId = value => this.sanitize(value) === value ? ID(value) : null;
    const requestId = /^req_[a-zA-Z0-9_-]{1,100}$/.test(reply.request_id ?? '') ? safeId(reply.request_id) : null;
    if (!reply.ok) {
      if (reply.code === 'UPSTREAM_HTTP' && reply.status >= 300 && reply.status <= 599) {
        throw new ResponsesError(`OPENAI_HTTP_${reply.status}`, `OpenAI returned HTTP ${reply.status}.`, {
          evidence: { request_id: requestId, http_status: reply.status, usage: null }, usageUnknown: reply.status >= 500 || reply.status === 408
        });
      }
      const refused = UNSENT.has(reply.code);
      throw new ResponsesError(refused ? reply.code : 'OPENAI_RESPONSE_UNKNOWN',
        refused ? 'Credential broker declined the request.' : 'The broker could not confirm the API outcome.', { usageUnknown: !refused });
    }
    const result = reply.body;
    if (reply.status !== 200 || !result || typeof result !== 'object') {
      throw new ResponsesError('OPENAI_RESPONSE_UNKNOWN', 'Invalid broker response.', { usageUnknown: true });
    }
    const usage = usageOf(result?.usage);
    const evidence = {
      request_id: requestId, response_id: safeId(result?.id), requested_model: model, returned_model: safeId(result?.model),
      reasoning_effort: result?.reasoning?.effort === effort ? effort : null,
      response_status: safeId(result?.status), incomplete_reason: safeId(result?.incomplete_details?.reason), usage
    };
    const errorDetails = { evidence, usageUnknown: !usage };
    if (result?.model !== responseModel || result?.reasoning?.effort !== effort) {
      throw new ResponsesError('OPENAI_ROUTE_MISMATCH', 'The response did not confirm the configured OpenAI model and reasoning effort.', errorDetails);
    }
    if (result.status !== 'completed' || !Array.isArray(result.output) || !evidence.response_id || !usage) {
      throw new ResponsesError('OPENAI_INCOMPLETE', 'The OpenAI response did not complete with valid output and usage metadata.', errorDetails);
    }
    return { output: result.output, evidence };
  }

  async verify() {
    const probe = this.peer ? { ...PROBE, name: PEERS[this.peer].confirm } : PROBE;
    const { output, evidence } = await this.request({
      input: [{ role: 'developer', content: `Call ${probe.name} with result ready.` }], tools: [probe]
    });
    let call;
    try { call = singleCall(output); }
    catch (error) { throw new ResponsesError(error.code, error.message, { evidence }); }
    if (call.name !== probe.name || Object.keys(call.args).length !== 1 || call.args.result !== 'ready') {
      throw new ResponsesError('OPENAI_TOOL_UNVERIFIED', 'The verification request did not return the expected strict tool call.', { evidence });
    }
    return { verified: true, model: this.config.model, requested_reasoning_effort: this.config.reasoning_effort, ...evidence };
  }
}

export function singleCall(output) {
  const calls = output.filter(item => item?.type === 'function_call');
  if (calls.length !== 1 || !ID(calls[0].call_id) || typeof calls[0].name !== 'string'
    || (calls[0].status !== undefined && calls[0].status !== 'completed') || typeof calls[0].arguments !== 'string'
    || Buffer.byteLength(calls[0].arguments) > 32000) {
    throw new ResponsesError('OPENAI_INVALID_TOOL_CALL', 'The response must contain exactly one complete supported function call.');
  }
  let args;
  try { args = JSON.parse(calls[0].arguments); } catch { /* handled by the schema check below */ }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ResponsesError('OPENAI_INVALID_TOOL_ARGUMENTS', 'The function call did not supply a JSON object.');
  }
  return { id: calls[0].call_id, name: calls[0].name, args };
}
