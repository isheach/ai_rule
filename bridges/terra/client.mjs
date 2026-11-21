// API Terra call core.
//
// The caller owns the transport and supplies `request(body)`. This module never
// imports an SDK, reads credentials or environment variables, opens a network
// connection, or retries. Each call must return one parsed Responses envelope,
// which is validated before any local callback runs.
//
// Tools: confirm_terra_api (no side effect), terra_action (one pre-authorized
// local action), finish_terra (model report). The model can only choose an
// action name from the caller's finite enum; it cannot supply commands, paths,
// or callback arguments. Local callback results are the evidence, never the
// model's report text.
//
// Actions are supplied as { name, effect: 'read'|'write', requires?, callback }.
// A callback takes no arguments, is attempted at most once, and must return
// {ok:true,...} after re-checking its own local conditions. Any other result is
// a failure or an unknown outcome and stops the run without a retry. The
// transport owns timeouts and in-flight cancellation; `signal` is checked
// between rounds.

export const TERRA_MODEL = 'gpt-6.1-terra';
export const TERRA_REASONING_EFFORT = 'max';
export const CONFIRM_TOOL = 'confirm_terra_api';
export const ACTION_TOOL = 'terra_action';
export const FINISH_TOOL = 'finish_terra';

export const TERRA_DEFAULT_LIMITS = Object.freeze({
  max_rounds: 6,
  max_actions: 4,
  max_output_tokens: 8000,
  max_total_tokens: 60000,
  max_input_bytes: 128000,
  max_report_bytes: 16000
});

const BOUNDS = Object.freeze({
  max_rounds: [2, 12],
  max_actions: [0, 8],
  max_output_tokens: [1, 64000],
  max_total_tokens: [1, 500000],
  max_input_bytes: [1024, 768000],
  max_report_bytes: [64, 64000]
});
const RESPONSE_ID = /^resp_[A-Za-z0-9_-]{1,190}$/;
const CALL_ID = /^call_[A-Za-z0-9_-]{1,190}$/;
const ACTION_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_ARGUMENT_BYTES = 65536;
const MAX_DESCRIPTION_BYTES = 200;
const MAX_INPUT_TEXT_BYTES = 64000;
const MAX_ACTIONS = 12;

const DEVELOPER = [
  'You are the Terra action coordinator. Use only the provided function tools.',
  'Call at most one tool per turn. Use terra_action only with one of the allowed action names; never supply commands, paths, or any other parameter.',
  'A local, pre-authorized callback runs each action. Only its local result is evidence; model text is never proof that an action ran or succeeded.',
  'Call finish_terra only when the task is complete or must be reported as blocked. State what the local action results showed.'
].join(' ');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usageOf(value) {
  if (!isObject(value)) return null;
  const input = count(value.input_tokens);
  const output = count(value.output_tokens);
  const total = count(value.total_tokens);
  if (input === null || output === null || total === null) return null;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Math.max(total, input + output),
    cached_input_tokens: count(value.input_tokens_details?.cached_tokens) ?? 0,
    reasoning_tokens: count(value.output_tokens_details?.reasoning_tokens) ?? 0
  };
}

function addUsage(previous, next) {
  if (!previous) return { ...next };
  return {
    input_tokens: previous.input_tokens + next.input_tokens,
    output_tokens: previous.output_tokens + next.output_tokens,
    total_tokens: previous.total_tokens + next.total_tokens,
    cached_input_tokens: previous.cached_input_tokens + next.cached_input_tokens,
    reasoning_tokens: previous.reasoning_tokens + next.reasoning_tokens
  };
}

function exactArgs(args, keys) {
  const actual = Object.keys(args).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function inputItems(input) {
  if (typeof input === 'string') {
    if (!input.trim() || Buffer.byteLength(input) > MAX_INPUT_TEXT_BYTES) {
      throw new TerraError('TERRA_CONTRACT', `input must be nonempty text of at most ${MAX_INPUT_TEXT_BYTES} UTF-8 bytes.`);
    }
    return [{ role: 'user', content: input }];
  }
  if (Array.isArray(input) && input.length && input.every(isObject)) return input;
  throw new TerraError('TERRA_CONTRACT', 'input must be nonempty text or a nonempty array of Responses input items.');
}

function limitsOf(value) {
  if (value === undefined) value = {};
  if (!isObject(value)) throw new TerraError('TERRA_CONTRACT', 'limits must be an object.');
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(TERRA_DEFAULT_LIMITS, key)) throw new TerraError('TERRA_CONTRACT', `Unsupported limit ${key}.`);
  }
  const limits = { ...TERRA_DEFAULT_LIMITS };
  for (const [key, entry] of Object.entries(value)) {
    const [minimum, maximum] = BOUNDS[key];
    if (!Number.isSafeInteger(entry) || entry < minimum || entry > maximum) {
      throw new TerraError('TERRA_CONTRACT', `limit ${key} must be an integer in [${minimum}, ${maximum}].`);
    }
    limits[key] = entry;
  }
  return Object.freeze(limits);
}

function actionsOf(value) {
  if (!Array.isArray(value)) throw new TerraError('TERRA_CONTRACT', 'actions must be an array.');
  if (value.length > MAX_ACTIONS) throw new TerraError('TERRA_CONTRACT', `At most ${MAX_ACTIONS} actions may be authorized.`);
  const actions = new Map();
  for (const raw of value) {
    if (!isObject(raw)) throw new TerraError('TERRA_CONTRACT', 'Each action must be an object.');
    if (typeof raw.name !== 'string' || !ACTION_NAME.test(raw.name)) {
      throw new TerraError('TERRA_CONTRACT', 'Each action name must be a lowercase identifier.');
    }
    if ([CONFIRM_TOOL, ACTION_TOOL, FINISH_TOOL].includes(raw.name)) {
      throw new TerraError('TERRA_CONTRACT', `Action name ${raw.name} is reserved by the Terra tools.`);
    }
    if (raw.effect !== 'read' && raw.effect !== 'write') {
      throw new TerraError('TERRA_CONTRACT', `Action ${raw.name} must declare effect read or write.`);
    }
    if (typeof raw.callback !== 'function') {
      throw new TerraError('TERRA_CONTRACT', `Action ${raw.name} must carry a local callback.`);
    }
    if (raw.description !== undefined
      && (typeof raw.description !== 'string' || Buffer.byteLength(raw.description) > MAX_DESCRIPTION_BYTES)) {
      throw new TerraError('TERRA_CONTRACT', `Action ${raw.name} description must be bounded text.`);
    }
    if (actions.has(raw.name)) throw new TerraError('TERRA_CONTRACT', `Action ${raw.name} is declared twice.`);
    const requires = raw.requires ?? [];
    if (!Array.isArray(requires) || requires.some(name => typeof name !== 'string')) {
      throw new TerraError('TERRA_CONTRACT', `Action ${raw.name} requires must be an array of action names.`);
    }
    if (new Set(requires).size !== requires.length) {
      throw new TerraError('TERRA_CONTRACT', `Action ${raw.name} repeats a prerequisite.`);
    }
    actions.set(raw.name, {
      name: raw.name,
      effect: raw.effect,
      requires: [...requires],
      callback: raw.callback,
      description: raw.description ?? ''
    });
  }
  for (const action of actions.values()) {
    for (const required of action.requires) {
      if (required === action.name || !actions.has(required)) {
        throw new TerraError('TERRA_CONTRACT', `Action ${action.name} has an invalid prerequisite.`);
      }
    }
  }
  const visiting = new Map();
  const visit = name => {
    if (visiting.get(name) === 2) return;
    if (visiting.get(name) === 1) throw new TerraError('TERRA_CONTRACT', 'Action prerequisites contain a cycle.');
    visiting.set(name, 1);
    for (const required of actions.get(name).requires) visit(required);
    visiting.set(name, 2);
  };
  for (const name of actions.keys()) visit(name);
  return actions;
}

function confirmDefinition() {
  return {
    type: 'function',
    name: CONFIRM_TOOL,
    description: 'Confirm the Terra Responses route with one strict no-side-effect call. Use result ready.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { result: { type: 'string', enum: ['ready'] } },
      required: ['result'],
      additionalProperties: false
    }
  };
}

function actionDefinition(actions) {
  const allowed = actions.map(action => action.description
    ? `${action.name} (${action.effect}): ${action.description}`
    : `${action.name} (${action.effect})`).join('; ');
  return {
    type: 'function',
    name: ACTION_TOOL,
    description: `Run exactly one pre-authorized local action. Allowed actions: ${allowed}. Supply only the action name.`,
    strict: true,
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: actions.map(action => action.name) } },
      required: ['action'],
      additionalProperties: false
    }
  };
}

function finishDefinition() {
  return {
    type: 'function',
    name: FINISH_TOOL,
    description: 'Finish with a report. The report is model text; local action results are the evidence.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        report: { type: 'string', description: 'What the local action results showed. Do not claim unverified success.' }
      },
      required: ['report'],
      additionalProperties: false
    }
  };
}

export class TerraError extends Error {
  constructor(code, message, state = {}) {
    super(message);
    this.name = 'TerraError';
    this.code = code;
    this.state = Object.freeze({
      evidence: Object.freeze([...(state.evidence ?? [])]),
      actions: Object.freeze([...(state.actions ?? [])]),
      usage: state.usage ?? null,
      confirmed: state.confirmed === true,
      usageUnknown: state.usageUnknown === true,
      effectUnknown: state.effectUnknown === true,
      ...(state.missing ? { missing: Object.freeze([...state.missing]) } : {})
    });
  }
}

export class TerraClient {
  #request;
  #actions;
  #allowWrite;
  #limits;
  #history = [];
  #evidence = [];
  #receipts = [];
  #usage = null;
  #confirmed = false;
  #completed = new Set();
  #attempted = new Set();
  #seenIds = new Set();
  #round = 0;
  #signal = null;

  constructor({ request, actions = [], allowWrite = false, limits } = {}) {
    if (typeof request !== 'function') throw new TerraError('TERRA_CONTRACT', 'request(body) must be an injected function.');
    if (typeof allowWrite !== 'boolean') throw new TerraError('TERRA_CONTRACT', 'allowWrite must be a boolean.');
    this.#request = request;
    this.#allowWrite = allowWrite;
    this.#limits = limitsOf(limits);
    this.#actions = actionsOf(actions);
  }

  // One no-side-effect confirmation request. No local callback can run here.
  async confirm({ signal } = {}) {
    this.#begin([], signal);
    await this.#confirmRound();
    return {
      confirmed: true,
      model: TERRA_MODEL,
      response_id: this.#evidence[0].response_id,
      usage: { ...this.#usage },
      evidence: { ...this.#evidence[0] }
    };
  }

  // Confirm the route, then run action rounds until finish_terra. The report is
  // model text; `actions` holds the local callback receipts used for acceptance.
  async run({ input, signal } = {}) {
    this.#begin(inputItems(input), signal);
    await this.#confirmRound();
    const exposed = this.#exposed();
    const tools = exposed.length
      ? [actionDefinition(exposed), finishDefinition()]
      : [finishDefinition()];
    const allowed = tools.map(tool => tool.name);
    for (;;) {
      if (this.#round >= this.#limits.max_rounds) {
        throw new TerraError('TERRA_ROUND_LIMIT',
          `Terra stopped after ${this.#round} API rounds without finish_terra.`, this.#state());
      }
      this.#round++;
      const response = await this.#send(this.#body(this.#history, tools));
      const parsed = this.#read(response, allowed);
      this.#record(parsed);
      this.#history.push(...parsed.items);
      const args = this.#arguments(parsed);
      if (parsed.call.name === FINISH_TOOL) {
        if (!exactArgs(args, ['report']) || typeof args.report !== 'string' || !args.report.trim()) {
          throw new TerraError('TERRA_TOOL_ARGUMENTS', 'finish_terra requires exactly one nonempty report string.', this.#state());
        }
        if (Buffer.byteLength(args.report) > this.#limits.max_report_bytes) {
          throw new TerraError('TERRA_REPORT_LIMIT', 'The finish_terra report exceeds the local byte limit.', this.#state());
        }
        return {
          status: 'finished',
          confirmed: true,
          model: TERRA_MODEL,
          report: args.report,
          actions: this.#receipts.map(receipt => ({ ...receipt })),
          rounds: this.#evidence.map(round => ({ ...round })),
          usage: { ...this.#usage },
          limits: { ...this.#limits }
        };
      }
      if (parsed.call.name !== ACTION_TOOL) {
        throw new TerraError('TERRA_TOOL_UNAUTHORIZED',
          'The response called a tool that is not available in this phase.', this.#state());
      }
      const action = this.#authorizedAction(args);
      await this.#invoke(action);
      this.#history.push({
        type: 'function_call_output',
        call_id: parsed.call.id,
        output: JSON.stringify({ ok: true, action: action.name })
      });
    }
  }

  #begin(input, signal) {
    this.#history = [{ role: 'developer', content: DEVELOPER }, ...input];
    this.#evidence = [];
    this.#receipts = [];
    this.#usage = null;
    this.#confirmed = false;
    this.#completed = new Set();
    this.#attempted = new Set();
    this.#seenIds = new Set();
    this.#round = 0;
    this.#signal = signal;
  }

  #state(extra = {}) {
    return {
      evidence: this.#evidence,
      actions: this.#receipts,
      usage: this.#usage,
      confirmed: this.#confirmed,
      ...extra
    };
  }

  #checkSignal() {
    if (this.#signal?.aborted) throw new TerraError('TERRA_STOPPED', 'The caller aborted the Terra run.', this.#state());
  }

  #exposed() {
    return [...this.#actions.values()].filter(action => this.#allowWrite || action.effect === 'read');
  }

  #body(input, tools) {
    const body = {
      model: TERRA_MODEL,
      store: false,
      reasoning: { effort: TERRA_REASONING_EFFORT },
      include: ['reasoning.encrypted_content'],
      input: [...input],
      tools,
      tool_choice: 'required',
      parallel_tool_calls: false,
      max_output_tokens: this.#limits.max_output_tokens
    };
    if (Buffer.byteLength(JSON.stringify(body)) > this.#limits.max_input_bytes) {
      throw new TerraError('TERRA_INPUT_LIMIT', 'The next Responses request exceeds the local input byte limit.', this.#state());
    }
    return body;
  }

  async #send(body) {
    this.#checkSignal();
    try {
      return await this.#request(body);
    } catch {
      throw new TerraError('TERRA_RESPONSE_UNKNOWN',
        'The Terra transport did not return a complete response; usage and outcome are unknown.',
        this.#state({ usageUnknown: true }));
    }
  }

  #read(response, allowed) {
    const fail = (code, message) => { throw new TerraError(code, message, this.#state()); };
    if (!isObject(response)) fail('TERRA_INVALID_RESPONSE', 'The transport did not return a Responses envelope object.');
    if (typeof response.id !== 'string' || !RESPONSE_ID.test(response.id)) {
      fail('TERRA_INVALID_RESPONSE', 'The Responses envelope has no valid response.id.');
    }
    if (this.#seenIds.has(response.id)) fail('TERRA_INVALID_RESPONSE', 'The Responses envelope reused a response.id.');
    if (response.model !== TERRA_MODEL) fail('TERRA_ROUTE_MISMATCH', `Expected model ${TERRA_MODEL}.`);
    if (response.reasoning?.effort !== TERRA_REASONING_EFFORT) {
      fail('TERRA_ROUTE_MISMATCH', `Expected reasoning effort ${TERRA_REASONING_EFFORT}.`);
    }
    if (response.status !== 'completed') fail('TERRA_INCOMPLETE', 'The Responses envelope did not complete.');
    const usage = usageOf(response.usage);
    if (!usage) fail('TERRA_INCOMPLETE', 'The Responses envelope has invalid usage metadata.');
    if (usage.output_tokens > this.#limits.max_output_tokens) {
      fail('TERRA_USAGE_LIMIT', 'A single response exceeded the requested output token limit.');
    }
    if (!Array.isArray(response.output) || response.output.length === 0) {
      fail('TERRA_OUTPUT_INVALID', 'The Responses envelope has no output items.');
    }
    const calls = [];
    for (const item of response.output) {
      if (!isObject(item)) fail('TERRA_OUTPUT_INVALID', 'The Responses envelope contains a non-object output item.');
      if (item.type === 'function_call') { calls.push(item); continue; }
      if (item.type === 'message') continue;
      if (item.type === 'reasoning') {
        if (typeof item.encrypted_content !== 'string' || item.encrypted_content.length === 0) {
          fail('TERRA_REASONING_UNENCRYPTED', 'A reasoning item has no encrypted_content for stateless replay.');
        }
        continue;
      }
      fail('TERRA_OUTPUT_INVALID', 'The Responses envelope contains an unsupported output item.');
    }
    if (calls.length === 0) fail('TERRA_NO_TOOL_CALL', 'The response contained no function_call.');
    if (calls.length !== 1) fail('TERRA_PARALLEL_TOOLS', 'The response contained more than one function_call.');
    const call = calls[0];
    if (typeof call.call_id !== 'string' || !CALL_ID.test(call.call_id)) {
      fail('TERRA_TOOL_CALL', 'The function_call has no valid call_id.');
    }
    if (this.#seenIds.has(call.call_id)) fail('TERRA_TOOL_CALL', 'The function_call reused a call_id.');
    if (typeof call.name !== 'string' || !allowed.includes(call.name)) {
      fail('TERRA_TOOL_UNAUTHORIZED', 'The response called a tool that is not available in this phase.');
    }
    if (call.status !== undefined && call.status !== 'completed') {
      fail('TERRA_TOOL_CALL', 'The function_call did not complete.');
    }
    if (typeof call.arguments !== 'string' || Buffer.byteLength(call.arguments) > MAX_ARGUMENT_BYTES) {
      fail('TERRA_TOOL_ARGUMENTS', 'The function_call arguments are not a bounded JSON string.');
    }
    return {
      id: response.id,
      usage,
      items: response.output,
      call: { id: call.call_id, name: call.name, arguments: call.arguments }
    };
  }

  #record(parsed) {
    const usage = addUsage(this.#usage, parsed.usage);
    this.#seenIds.add(parsed.id);
    this.#seenIds.add(parsed.call.id);
    this.#evidence.push({
      response_id: parsed.id,
      model: TERRA_MODEL,
      status: 'completed',
      reasoning_effort: TERRA_REASONING_EFFORT,
      tool: parsed.call.name,
      usage: { ...parsed.usage }
    });
    this.#usage = usage;
    if (usage.total_tokens > this.#limits.max_total_tokens) {
      throw new TerraError('TERRA_USAGE_LIMIT', 'The cumulative token usage exceeded the local limit.', this.#state());
    }
  }

  #arguments(parsed) {
    let args;
    try { args = JSON.parse(parsed.call.arguments); }
    catch { throw new TerraError('TERRA_TOOL_ARGUMENTS', 'The function_call arguments are not JSON.', this.#state()); }
    if (!isObject(args)) {
      throw new TerraError('TERRA_TOOL_ARGUMENTS', 'The function_call arguments must be a JSON object.', this.#state());
    }
    return args;
  }

  #authorizedAction(args) {
    if (!exactArgs(args, ['action']) || typeof args.action !== 'string') {
      throw new TerraError('TERRA_TOOL_ARGUMENTS', 'terra_action accepts exactly one action name and no other fields.', this.#state());
    }
    const action = this.#actions.get(args.action);
    if (!action || (!this.#allowWrite && action.effect === 'write')) {
      throw new TerraError('TERRA_ACTION_UNAUTHORIZED', 'The requested action is not authorized for this client.', this.#state());
    }
    return action;
  }

  async #invoke(action) {
    if (this.#attempted.has(action.name)) {
      throw new TerraError('TERRA_ACTION_REPEATED', `Action ${action.name} was already attempted.`, this.#state());
    }
    if (this.#receipts.length >= this.#limits.max_actions) {
      throw new TerraError('TERRA_ACTION_LIMIT', 'The local action limit was reached.', this.#state());
    }
    const missing = action.requires.filter(name => !this.#completed.has(name));
    if (missing.length) {
      throw new TerraError('TERRA_ACTION_OUT_OF_ORDER',
        `Action ${action.name} is missing a successful prerequisite.`, this.#state({ missing }));
    }
    this.#attempted.add(action.name);
    this.#checkSignal();
    let reply;
    try {
      // The declared prerequisite gate is necessary but not sufficient: the
      // callback must re-check local state immediately before acting. No model
      // data is passed to it.
      reply = await action.callback();
    } catch {
      throw new TerraError('TERRA_CALLBACK_UNKNOWN',
        `The local callback for ${action.name} threw; its result and effect are unknown.`,
        this.#state({ effectUnknown: true }));
    }
    if (!isObject(reply) || typeof reply.ok !== 'boolean') {
      throw new TerraError('TERRA_CALLBACK_UNKNOWN',
        `The local callback for ${action.name} did not return an explicit {ok:boolean} result.`,
        this.#state({ effectUnknown: true }));
    }
    if (reply.ok !== true) {
      throw new TerraError('TERRA_CALLBACK_FAILED',
        `The local callback for ${action.name} reported failure.`, this.#state());
    }
    this.#completed.add(action.name);
    this.#receipts.push({ action: action.name, effect: action.effect, ok: true, result: reply });
  }

  async #confirmRound() {
    this.#checkSignal();
    this.#round = 1;
    const tools = [confirmDefinition()];
    const response = await this.#send(this.#body(this.#history, tools));
    const parsed = this.#read(response, [CONFIRM_TOOL]);
    this.#record(parsed);
    this.#history.push(...parsed.items);
    const args = this.#arguments(parsed);
    if (!exactArgs(args, ['result']) || args.result !== 'ready') {
      throw new TerraError('TERRA_CONFIRMATION_INVALID',
        'confirm_terra_api must return exactly {"result":"ready"}.', this.#state());
    }
    this.#confirmed = true;
    this.#history.push({
      type: 'function_call_output',
      call_id: parsed.call.id,
      output: JSON.stringify({ confirmed: true })
    });
  }
}
