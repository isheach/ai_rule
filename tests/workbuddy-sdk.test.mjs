import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { executeProjectSdk, loadProjectSdk, probeProjectSdk } from '../bridges/workbuddy/project-sdk.mjs';

const MODEL = 'deepseek-v4-flash';
const SESSION = 'fake-session-123';
const CWD = path.resolve('.');
const CONFIG = { cliEntry: path.join(CWD, 'codebuddy-headless.js'), configDir: path.join(CWD, 'account') };
const TASK = { cwd: CWD, prompt: 'Read paper.md', permissionMode: 'read-only', capability: 'default', timeoutMs: 1000 };
const success = { type: 'result', session_id: SESSION, subtype: 'success', is_error: false, result: 'Reviewed the paper.' };
const assistant = (...content) => ({ type: 'assistant', session_id: SESSION, message: { model: MODEL, content } });
const readInput = { file_path: 'paper.md' };
const readToolUse = { type: 'tool_use', id: 'use-read-1', name: 'Read', input: readInput };

function fixture({ catalog = [{ modelId: MODEL }], messages = [assistant(), success], beforeMessages } = {}) {
  const events = [];
  const value = {
    events,
    session: {
      sessionId: SESSION,
      async connect() { events.push('connect'); },
      async getAvailableModels() { events.push('catalog'); return catalog; },
      async setModel(model) { events.push(['model', model]); },
      async send(prompt) { events.push(['send', prompt]); },
      async *stream() {
        events.push('stream');
        await beforeMessages?.(value.options);
        yield* messages;
      },
      close() { events.push('close'); }
    },
    createSession(options) {
      events.push('create');
      value.options = options;
      return value.session;
    },
    resumeSession(sessionId, options) {
      events.push(['resume', sessionId]);
      value.options = options;
      return value.session;
    }
  };
  return value;
}

function run(fake, task = TASK, extra = {}) {
  return executeProjectSdk({
    config: CONFIG, task, createSession: fake.createSession, resumeSession: fake.resumeSession,
    allowTool: () => false, onSend: id => fake.events.push(['onSend', id]), ...extra
  });
}

function hook(options, { name = 'Read', input = readInput, id = readToolUse.id, cwd = CWD, session = SESSION } = {}) {
  const [preToolUse] = options.hooks.PreToolUse[0].hooks;
  return preToolUse({ hook_event_name: 'PreToolUse', session_id: session, cwd, tool_name: name, tool_input: input, tool_use_id: id }, id);
}

test('readiness uses the pinned entry, the existing account directory and no prompt', async () => {
  const fake = fixture();
  const result = await probeProjectSdk({ config: CONFIG, cwd: CWD, createSession: fake.createSession });
  assert.deepEqual(result, { model: MODEL });
  assert.deepEqual(fake.events, ['create', 'connect', 'catalog', ['model', MODEL], 'close']);
  assert.equal(fake.options.pathToCodebuddyCode, CONFIG.cliEntry);
  assert.equal(fake.options.executable, process.execPath);
  assert.equal(fake.options.env.CODEBUDDY_CONFIG_DIR, CONFIG.configDir);
  assert.equal(fake.options.env.CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS, '1');
  assert.equal(fake.options.permissionMode, 'default');
  assert.equal(fake.options.strictMcpConfig, true);
  assert.deepEqual(JSON.parse(fake.options.mcpServers), { mcpServers: {} });
  assert.deepEqual(fake.options.settingSources, []);
  assert.deepEqual(fake.options.tools, []);
  assert.equal(fake.options.persistSession, false);
  assert.equal(fake.options.allowedTools, undefined);

  const lite = { ...CONFIG, cliEntry: path.join(CWD, 'codebuddy-lite-wb.mjs') };
  assert.deepEqual(await probeProjectSdk({ config: lite, cwd: CWD, createSession: fake.createSession }), { model: MODEL });
  assert.equal(fake.options.pathToCodebuddyCode, lite.cliEntry);
});

test('exact catalog and model-control failures close the session before dispatch', async () => {
  const alias = fixture({ catalog: [{ modelId: 'deepseek-v4.1-flash', name: MODEL }] });
  await assert.rejects(probeProjectSdk({ config: CONFIG, cwd: CWD, createSession: alias.createSession }), {
    code: 'WORKBUDDY_SDK_MODEL_UNAVAILABLE'
  });
  assert.deepEqual(alias.events, ['create', 'connect', 'catalog', 'close']);

  const rejected = fixture();
  rejected.session.setModel = async () => { throw Error('private stderr'); };
  assert.deepEqual(await run(rejected), {
    status: 'refused', session_id: null, answer: '', reason_code: 'WORKBUDDY_SDK_MODEL_SELECTION_FAILED'
  });
  assert.deepEqual(rejected.events, ['create', 'connect', 'catalog', 'close']);

  const launcher = { ...CONFIG, cliEntry: path.join(CWD, 'bin', 'codebuddy') };
  await assert.rejects(probeProjectSdk({ config: launcher, cwd: CWD, createSession: fixture().createSession }), {
    code: 'WORKBUDDY_SDK_CONFIG'
  });
});

test('both callbacks apply the same project policy and safe read evidence completes', async () => {
  const seen = [];
  const fake = fixture({
    messages: [assistant(readToolUse), success],
    async beforeMessages(options) {
      assert.deepEqual(await hook(options), { continue: true });
      assert.deepEqual(await options.canUseTool('Read', readInput, { toolUseID: readToolUse.id }), {
        behavior: 'allow', updatedInput: readInput
      });
    }
  });
  const result = await run(fake, TASK, { allowTool: (name, input, cwd) => {
    seen.push([name, input, cwd]);
    return true;
  } });
  assert.deepEqual(result, { status: 'completed', session_id: SESSION, answer: success.result });
  assert.deepEqual(fake.options.tools, ['Read', 'Glob', 'Grep']);
  assert.deepEqual(seen, [['Read', readInput, CWD], ['Read', readInput, CWD]]);
  assert.deepEqual(fake.events, ['create', 'connect', 'catalog', ['model', MODEL], ['onSend', SESSION], ['send', TASK.prompt], 'stream', 'close']);
});

test('live tasks expose only tools selected by their project mode', async () => {
  const writable = ['Read', 'Glob', 'Grep', 'Write', 'Edit'];
  for (const [options, tools] of [
    [{ capability: 'text-only' }, []],
    [{ allowCommands: true }, ['Read', 'Glob', 'Grep']],
    [{ permissionMode: 'workspace-write' }, writable],
    [{ permissionMode: 'workspace-write', allowCommands: true }, [...writable, 'Bash', 'PowerShell']]
  ]) {
    const fake = fixture();
    assert.equal((await run(fake, { ...TASK, ...options })).status, 'completed');
    assert.deepEqual(fake.options.tools, tools);
    assert.equal(fake.options.allowedTools, undefined);
  }
});

test('unauthorized calls, foreign hook contexts and background commands are blocked', async () => {
  for (const request of [
    { name: 'Read', input: { file_path: '../outside.txt' } },
    { name: 'Read', cwd: path.join(CWD, 'other') },
    { name: 'Read', session: 'other-session' },
    { name: 'Bash', input: { command: 'echo example', run_in_background: true } },
    { name: 'PowerShell', input: { command: 'Write-Host example', dangerouslyDisableSandbox: true } },
    { name: 'Agent', input: { prompt: 'test' } }
  ]) {
    const fake = fixture({ async beforeMessages(options) {
      assert.equal((await hook(options, request)).decision, 'block');
      if (!request.cwd && !request.session) {
        const decision = await options.canUseTool(request.name, request.input, { toolUseID: 'other-tool-id' });
        assert.equal(decision.behavior, 'deny');
      }
    } });
    const result = await run(fake, { ...TASK, permissionMode: 'workspace-write', allowCommands: true }, {
      allowTool: (_name, input) => input.file_path !== '../outside.txt'
    });
    assert.deepEqual(result, { status: 'refused', session_id: SESSION, answer: '', reason_code: 'WORKBUDDY_SDK_PERMISSION_DENIED' });
  }
});

test('post-dispatch receipts require a matching session, fixed model, tool trace and final answer', async () => {
  for (const [messages, reason] of [
    [[assistant(readToolUse), success], 'WORKBUDDY_SDK_TOOL_TRACE_MISSING'],
    [[{ ...assistant(), session_id: 'other-session' }, success], 'WORKBUDDY_SDK_SESSION_MISMATCH'],
    [[{ ...assistant(), message: { model: 'wrong-model', content: [] } }, success], 'WORKBUDDY_SDK_MODEL_MISMATCH'],
    [[{ type: 'system', subtype: 'init', model: 'wrong-model', session_id: SESSION }, assistant(), success], 'WORKBUDDY_SDK_MODEL_MISMATCH'],
    [[{ type: 'system', subtype: 'init', model: MODEL, session_id: SESSION, permissionMode: 'bypassPermissions' }, assistant(), success],
      'WORKBUDDY_SDK_PERMISSION_MODE_MISMATCH'],
    [[{ type: 'system', subtype: 'init', model: MODEL, session_id: SESSION, permissionMode: 'default', mcp_servers: [{ name: 'unexpected' }] },
      assistant(), success], 'WORKBUDDY_SDK_CONTEXT_MISMATCH'],
    [[assistant(), { ...success, model: 'wrong-model' }], 'WORKBUDDY_SDK_MODEL_MISMATCH'],
    [[success], 'WORKBUDDY_SDK_RESULT_INVALID'],
    [[assistant(), { ...success, result: '   ' }], 'WORKBUDDY_SDK_RESULT_INVALID'],
    [[assistant()], 'WORKBUDDY_SDK_NO_RESULT']
  ]) {
    const fake = fixture({ messages });
    assert.deepEqual(await run(fake), { status: 'unknown_after_disconnect', session_id: SESSION, answer: '', reason_code: reason });
    assert.equal(fake.events.at(-1), 'close');
  }
});

test('actual resume uses its API and expected session while unknown sends are never retried', async () => {
  const resumed = fixture();
  assert.equal((await run(resumed, { ...TASK, sessionId: SESSION })).status, 'completed');
  assert.deepEqual(resumed.events[0], ['resume', SESSION]);

  const foreign = fixture();
  assert.equal((await run(foreign, { ...TASK, sessionId: 'foreign-session' })).reason_code, 'WORKBUDDY_SDK_SESSION_MISMATCH');
  assert.deepEqual(foreign.events, [['resume', 'foreign-session'], 'close']);

  const errored = fixture();
  errored.session.send = async () => { throw Error('private side-effect diagnostic'); };
  const result = await run(errored);
  assert.deepEqual(result, { status: 'unknown_after_disconnect', session_id: SESSION, answer: '', reason_code: 'WORKBUDDY_SDK_STREAM_FAILED' });
  assert.deepEqual(errored.events, ['create', 'connect', 'catalog', ['model', MODEL], ['onSend', SESSION], 'close']);
});

test('a stop before submission prevents the prompt and a stop after submission remains uncertain', async () => {
  const notStarted = fixture();
  const cancelled = await run(notStarted, TASK, { signal: AbortSignal.abort() });
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(notStarted.events, []);

  const controller = new AbortController();
  const pending = fixture({ beforeMessages: async () => {
    controller.abort(new DOMException('private timeout detail', 'TimeoutError'));
    await new Promise(() => {});
  } });
  const result = await run(pending, TASK, { signal: controller.signal });
  assert.deepEqual(result, { status: 'unknown_after_disconnect', session_id: SESSION, answer: '', reason_code: 'WORKBUDDY_SDK_TIMED_OUT' });
  assert.deepEqual(pending.events.slice(-3), [['send', TASK.prompt], 'stream', 'close']);
});

const fakeCli = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const args = process.argv.slice(2);
const option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const model = 'deepseek-v4-flash';
const sessionId = option('--session-id');
const probe = args.includes('--no-session-persistence');
const trace = event => fs.appendFileSync('trace.ndjson', JSON.stringify({ event, sessionId, probe }) + '\n');
assert.equal(option('--permissions-mode'), undefined);
assert.equal(option('--permission-mode'), 'default');
assert.equal(option('--setting-sources'), 'none');
assert.equal(option('--tools'), probe ? '' : 'Read,Glob,Grep');
assert.equal(option('--model'), model);
assert.ok(args.includes('--strict-mcp-config'));
assert.deepEqual(JSON.parse(option('--mcp-config')), { mcpServers: {} });
assert.ok(!args.includes('--allowedTools'));
assert.equal(process.env.CODEBUDDY_CONFIG_DIR, path.join(process.cwd(), 'account'));
assert.equal(process.env.WORKBUDDY_TEST_SECRET, undefined);
assert.equal(process.env.CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS, '1');
if (args.includes('--resume')) assert.equal(option('--resume'), sessionId);
const emit = message => process.stdout.write(JSON.stringify(message) + '\n');
const acknowledge = (id, response = {}) => emit({ type: 'control_response', response: { request_id: id, subtype: 'success', response } });
const request = (id, request) => emit({ type: 'control_request', request_id: id, request });
const emitTurn = (type, fields) => emit({ type, session_id: sessionId, ...fields });
const input = { file_path: 'paper.md' };
const toolId = 'fake-read-1';
let hookId;
let initialized = false;
let catalog = false;
let selected = false;
const stream = readline.createInterface({ input: process.stdin });
stream.on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    const { request_id, request } = message;
    trace(request.subtype);
    if (request.subtype === 'initialize') {
      assert.equal(request.hasPrompt, true);
      if (!probe) {
        assert.equal(request.hooks.PreToolUse[0].matcher, '*');
        [hookId] = request.hooks.PreToolUse[0].hookCallbackIds;
        assert.ok(hookId);
      }
      initialized = true;
      acknowledge(request_id, { currentModelId: model });
    } else if (request.subtype === 'get_available_models') {
      assert.ok(initialized);
      catalog = true;
      acknowledge(request_id, { availableModels: [{ modelId: model, name: 'DeepSeek V4 Flash' }] });
    } else if (request.subtype === 'set_model') {
      assert.ok(catalog);
      assert.equal(request.model, model);
      assert.equal(request.session_id, sessionId);
      emitTurn('system', { subtype: 'init', model: 'stale-pre-prompt-model', permissionMode: 'default' });
      selected = true;
      acknowledge(request_id);
    } else assert.fail('Unexpected control request');
  } else if (message.type === 'user') {
    assert.ok(selected && !probe);
    trace('prompt');
    if (message.message.content === 'simulate timeout') return;
    emitTurn('system', { subtype: 'init', model, permissionMode: 'default', cwd: process.cwd(), mcp_servers: [] });
    emitTurn('assistant', { message: { model, content: [{ type: 'tool_use', id: toolId, name: 'Read', input }] } });
    request('fake-pretool', { subtype: 'hook_callback', callback_id: hookId, tool_use_id: toolId, input: {
      hook_event_name: 'PreToolUse', session_id: sessionId, cwd: process.cwd(), tool_name: 'Read', tool_input: input, tool_use_id: toolId
    } });
  } else if (message.type === 'control_response' && message.response.request_id === 'fake-pretool') {
    assert.deepEqual(message.response.response, { continue: true });
    trace('pretool_allowed');
    request('fake-permission', { subtype: 'can_use_tool', tool_name: 'Read', tool_use_id: toolId, input });
  } else if (message.type === 'control_response' && message.response.request_id === 'fake-permission') {
    assert.deepEqual(message.response.response, { allowed: true, updatedInput: input, tool_use_id: toolId });
    trace('permission_allowed');
    emitTurn('result', { subtype: 'success', is_error: false, result: 'Verified offline fixture.', permission_denials: [] });
  } else assert.fail('Unexpected input message');
});
const close = () => { trace('closed'); process.exit(0); };
stream.on('close', close);
process.once('SIGTERM', close);
`;

async function traceAfter(root, matches) {
  const file = path.join(root, 'trace.ndjson');
  for (let remaining = 100; remaining > 0; remaining--) {
    const trace = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    if (matches(trace)) return trace;
    await delay(20);
  }
  assert.fail('The offline SDK child did not close.');
}

test('released pinned SDK handles readiness, tools, resume and close over offline CLI stdio', {
  skip: process.env.AI_RULE_TEST_WORKBUDDY_SDK !== '1', timeout: 12_000
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workbuddy-sdk-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { cliEntry: path.join(root, 'codebuddy-lite-wb.mjs'), configDir: path.join(root, 'account') };
  await mkdir(config.configDir);
  await writeFile(config.cliEntry, `import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\n${fakeCli}`);
  const sdk = await loadProjectSdk();
  process.env.WORKBUDDY_TEST_SECRET = 'fixture-only-value';
  t.after(() => { delete process.env.WORKBUDDY_TEST_SECRET; });

  assert.deepEqual(await probeProjectSdk({ config, cwd: root, signal: AbortSignal.timeout(2500), ...sdk }), { model: MODEL });
  const full = await executeProjectSdk({ config, task: { ...TASK, cwd: root, timeoutMs: 2500 },
    signal: AbortSignal.timeout(2500), ...sdk, allowTool: (name, input, cwd) => name === 'Read' && input.file_path === 'paper.md' && cwd === root });
  assert.equal(full.status, 'completed');
  assert.equal(full.answer, 'Verified offline fixture.');
  const resumed = await executeProjectSdk({ config, task: { ...TASK, cwd: root, timeoutMs: 2500, sessionId: full.session_id },
    signal: AbortSignal.timeout(2500), ...sdk, allowTool: () => true });
  assert.deepEqual(resumed, full);

  const controller = new AbortController();
  const pending = executeProjectSdk({ config, task: { ...TASK, cwd: root, timeoutMs: 2500, prompt: 'simulate timeout' },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2500)]), ...sdk });
  const trace = await traceAfter(root, events => events.filter(row => row.event === 'prompt').length === 3);
  controller.abort(new DOMException('fixture deadline', 'TimeoutError'));
  const expired = await pending;
  assert.equal(expired.status, 'unknown_after_disconnect');
  assert.equal(expired.reason_code, 'WORKBUDDY_SDK_TIMED_OUT');
  await traceAfter(root, rows => rows.filter(row => row.event === 'closed').length === 4);
  assert.deepEqual(trace.filter(row => row.probe).map(row => row.event), ['initialize', 'get_available_models', 'set_model', 'closed']);
  assert.equal(trace.filter(row => row.event === 'permission_allowed').length, 2);
});
