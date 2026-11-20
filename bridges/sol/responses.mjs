import { redact } from '../dsh/core.mjs';
import { SAFE_ID } from './config.mjs';

const ENDPOINT = 'https://api.openai.com/v1/responses';
const ID = value => typeof value === 'string' && SAFE_ID.test(value) && redact(value) === value ? value : null;
const PROBE = {
  type: 'function', name: 'confirm_sol_api', description: 'Confirm the configured model can call a strict function.', strict: true,
  parameters: { type: 'object', properties: { result: { type: 'string', enum: ['ready'] } }, required: ['result'], additionalProperties: false }
};

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

async function readJson(response, maxBytes = 1_200_000) {
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty Responses API body.');
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw Error('Responses API body exceeds the local limit.');
      parts.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(parts, size).toString('utf8'));
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }
}

export class ResponsesClient {
  constructor({ config, credential, fetchImpl = globalThis.fetch }) {
    this.config = config.openai;
    this.limits = config.limits;
    this.credential = credential;
    this.fetch = fetchImpl;
  }

  get configured() {
    const { key, project, organization } = this.credential;
    return typeof key === 'string' && /^[\x21-\x7e]{8,500}$/.test(key)
      && (!this.config.project_env || Boolean(ID(project))) && (!this.config.organization_env || Boolean(ID(organization)));
  }

  sanitize(value) {
    const key = this.credential.key;
    const text = String(value);
    return redact(key && key.length >= 8 ? text.split(key).join('[REDACTED]') : text);
  }

  async request({ input, tools, signal, outputTokens = this.limits.max_output_tokens }) {
    if (!this.configured) throw new ResponsesError('OPENAI_CREDENTIALS_MISSING', 'The configured OpenAI credential or project/organization environment reference is unavailable.');
    if (signal?.aborted) throw new ResponsesError('COORDINATION_STOPPED', 'Coordination stopped before the next API call.');
    const { key, project, organization } = this.credential;
    const { model, reasoning_effort: effort, response_model: responseModel = model } = this.config;
    const body = JSON.stringify({
      model, store: false, reasoning: { effort }, include: ['reasoning.encrypted_content'],
      input, tools, tool_choice: 'required', parallel_tool_calls: false, max_output_tokens: outputTokens
    });
    if (Buffer.byteLength(body) > this.limits.max_input_bytes) {
      throw new ResponsesError('OPENAI_INPUT_LIMIT', 'The next Responses request exceeds the configured input byte limit.');
    }
    const timeout = AbortSignal.timeout(this.limits.api_timeout_ms);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    let result;
    try {
      response = await this.fetch(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: requestSignal,
        headers: {
          Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
          ...(project ? { 'OpenAI-Project': project } : {}), ...(organization ? { 'OpenAI-Organization': organization } : {})
        },
        body
      });
      if (response.ok) result = await readJson(response);
      else {
        try { result = await readJson(response, 8192); } catch { /* the HTTP status remains authoritative */ }
      }
    } catch {
      throw new ResponsesError(requestSignal.aborted ? 'OPENAI_REQUEST_INTERRUPTED' : 'OPENAI_RESPONSE_UNKNOWN',
        'The OpenAI request did not return a complete response. Usage and the outcome of this API request are unknown.', { usageUnknown: true });
    }
    const safeId = value => this.sanitize(value) === value ? ID(value) : null;
    const requestId = safeId(response.headers.get('x-request-id'));
    if (!response.ok) {
      const status = response.status;
      const code = safeId(result?.error?.code);
      const type = safeId(result?.error?.type);
      throw new ResponsesError(`OPENAI_HTTP_${status}`, `OpenAI returned HTTP ${status}${code ? ` (${code})` : ''}.`, {
        evidence: { request_id: requestId, http_status: status, error_code: code, error_type: type, usage: null }, usageUnknown: status >= 500 || status === 408
      });
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
    const { output, evidence } = await this.request({
      input: [{ role: 'developer', content: 'Call confirm_sol_api with result ready.' }], tools: [PROBE]
    });
    let call;
    try { call = singleCall(output); }
    catch (error) { throw new ResponsesError(error.code, error.message, { evidence }); }
    if (call.name !== PROBE.name || Object.keys(call.args).length !== 1 || call.args.result !== 'ready') {
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
