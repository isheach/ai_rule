import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { WORKBUDDY_DSF } from './dispatch.mjs';
import { PROJECT_SESSION_ID, projectError } from './project-config.mjs';

const SDK_PACKAGE = '@tencent-ai/agent-sdk';
const SDK_VERSION = '0.3.305';
const require = createRequire(import.meta.url);
const MODEL = WORKBUDDY_DSF.model;
const CLI_BUNDLES = new Set(['codebuddy-lite-wb.mjs', 'codebuddy-headless.js']);
const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const WRITE_TOOLS = ['Write', 'Edit'];
const COMMAND_TOOLS = ['Bash', 'PowerShell'];
const DENIAL = 'This WorkBuddy task does not authorize the requested tool call.';
const ERROR_RESULTS = new Set(['error_during_execution', 'error_max_turns', 'error_max_budget_usd']);
const ENV_PASSTHROUGH = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE'
]);

export async function loadProjectSdk() {
  let entry;
  let pkg;
  try {
    entry = require.resolve(SDK_PACKAGE);
    // The pinned package exposes lib/index.js and does not export package.json.
    pkg = JSON.parse(await readFile(path.resolve(path.dirname(entry), '..', 'package.json'), 'utf8'));
  } catch {
    throw projectError('WORKBUDDY_SDK_UNAVAILABLE', 'The optional WorkBuddy project SDK is unavailable.');
  }
  if (pkg?.name !== SDK_PACKAGE || pkg.version !== SDK_VERSION) {
    throw projectError('WORKBUDDY_SDK_VERSION_MISMATCH', `The WorkBuddy project SDK must be ${SDK_PACKAGE}@${SDK_VERSION}.`);
  }
  let sdk;
  try { sdk = require(entry); }
  catch { throw projectError('WORKBUDDY_SDK_UNAVAILABLE', 'The optional WorkBuddy project SDK could not load.'); }
  const { unstable_v2_createSession: createSession, unstable_v2_resumeSession: resumeSession } = sdk;
  if (typeof createSession !== 'function' || typeof resumeSession !== 'function') {
    throw projectError('WORKBUDDY_SDK_INTERFACE_UNAVAILABLE', 'The WorkBuddy project SDK session interface is unavailable.');
  }
  return { createSession, resumeSession };
}

function childEnvironment(config) {
  // The SDK overlays options.env on process.env. Undefined entries remove inherited
  // variables when Node spawns the child, including provider keys and Node overrides.
  const cleared = Object.fromEntries(Object.keys(process.env)
    .filter(key => !ENV_PASSTHROUGH.has(key.toUpperCase()))
    .map(key => [key, undefined]));
  return {
    ...cleared,
    CODEBUDDY_CONFIG_DIR: config.configDir,
    CODEBUDDY_DISABLE_AUTO_MEMORY: '1',
    CODEBUDDY_DISABLE_PARENT_MEMORY: '1',
    CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1',
    DISABLE_AUTOUPDATER: '1'
  };
}

function baseOptions(config, cwd) {
  const paths = [config?.cliEntry, config?.configDir, cwd];
  if (!paths.every(value => typeof value === 'string' && path.isAbsolute(value)) ||
      !CLI_BUNDLES.has(path.basename(config.cliEntry).toLowerCase())) {
    throw projectError('WORKBUDDY_SDK_CONFIG', 'The WorkBuddy session requires the pinned CLI, existing account directory and approved task directory.');
  }
  return {
    cwd,
    pathToCodebuddyCode: config.cliEntry,
    executable: process.execPath,
    env: childEnvironment(config),
    model: MODEL,
    permissionMode: 'default',
    settingSources: [],
    // The pinned SDK omits an empty object. Passing the CLI's inline JSON form
    // makes the empty server set explicit alongside strict mode.
    mcpServers: '{"mcpServers":{}}',
    strictMcpConfig: true,
    tools: []
  };
}

function newSession(factory, options, previousId) {
  try { return previousId === undefined ? factory(options) : factory(previousId, options); }
  catch { throw projectError('WORKBUDDY_SDK_START_FAILED', 'The pinned WorkBuddy SDK could not create a session.'); }
}

function bounded(signal, action) {
  if (!signal) return action();
  signal.throwIfAborted();
  let stop;
  const cancelled = new Promise((_, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
  });
  const request = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return action();
  });
  return Promise.race([request, cancelled]).finally(() => signal.removeEventListener('abort', stop));
}

async function selectModel(session, signal) {
  // connect() only starts the local child. Wait for that step before racing
  // cancellation against control requests so close() cannot precede the spawn.
  signal?.throwIfAborted();
  try { await session.connect(); }
  catch { throw projectError('WORKBUDDY_SDK_START_FAILED', 'The pinned WorkBuddy SDK could not start the CLI.'); }

  let catalog;
  try { catalog = await bounded(signal, () => session.getAvailableModels()); }
  catch { throw projectError('WORKBUDDY_SDK_CATALOG_UNAVAILABLE', 'The WorkBuddy CLI did not return a model catalog.'); }
  if (!Array.isArray(catalog) || !catalog.some(item => item?.modelId === MODEL)) {
    throw projectError('WORKBUDDY_SDK_MODEL_UNAVAILABLE', 'The WorkBuddy model catalog does not contain deepseek-v4-flash.');
  }
  try { await bounded(signal, () => session.setModel(MODEL)); }
  catch { throw projectError('WORKBUDDY_SDK_MODEL_SELECTION_FAILED', 'The WorkBuddy CLI did not acknowledge selection of deepseek-v4-flash.'); }
  signal?.throwIfAborted();
}

function closeSession(session) {
  try { session?.close(); } catch { /* SDK diagnostics may contain private data. */ }
}

function stopCode(signal) {
  return signal.reason?.name === 'TimeoutError' ? 'WORKBUDDY_SDK_TIMED_OUT' : 'WORKBUDDY_SDK_CANCELLED';
}

export async function probeProjectSdk({ config, cwd, signal, createSession }) {
  let session;
  try {
    signal?.throwIfAborted();
    session = newSession(createSession, { ...baseOptions(config, cwd), persistSession: false });
    await selectModel(session, signal);
    return { model: MODEL };
  } catch (error) {
    if (signal?.aborted) throw projectError(stopCode(signal), 'The WorkBuddy readiness check was interrupted.');
    throw error;
  } finally { closeSession(session); }
}

function toolList(task) {
  if (task.capability === 'text-only') return [];
  if (task.permissionMode !== 'workspace-write' || task.capability === 'workspace-read') return [...READ_TOOLS];
  return [...READ_TOOLS, ...WRITE_TOOLS, ...(task.allowCommands === true ? COMMAND_TOOLS : [])];
}

function sameDirectory(directory, cwd) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return false;
  const resolved = path.resolve(directory);
  return process.platform === 'win32' ? resolved.toLowerCase() === cwd.toLowerCase() : resolved === cwd;
}

function validToolId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 160;
}

function toolGate({ task, tools, signal, allowTool, state }) {
  function permits(name, input, id, validContext, toolSignal) {
    if (!state.sent || signal?.aborted || toolSignal?.aborted) return false;
    if (validToolId(id) && typeof name === 'string' && !state.checkedTools.has(id)) {
      state.checkedTools.set(id, name);
    }
    try {
      if (validContext && state.checkedTools.get(id) === name && tools.includes(name) &&
          input && typeof input === 'object' && !Array.isArray(input) &&
          !(COMMAND_TOOLS.includes(name) && (input.run_in_background || input.dangerouslyDisableSandbox)) &&
          allowTool(name, input, task.cwd) === true) return true;
    } catch { /* Policy failures deny the call without exposing its input. */ }
    state.denied = true;
    return false;
  }

  return {
    hooks: { PreToolUse: [{ matcher: '*', hooks: [async (input, id, options) => {
      const validContext = input?.hook_event_name === 'PreToolUse' && input.session_id === state.sessionId &&
        (id === undefined || id === input.tool_use_id) && sameDirectory(input.cwd, task.cwd);
      if (permits(input?.tool_name, input?.tool_input, input?.tool_use_id, validContext, options?.signal)) {
        // Let the CLI apply its own rules and request host permission when needed.
        return { continue: true };
      }
      return { decision: 'block', reason: DENIAL };
    }] }] },
    canUseTool: async (name, input, options) => permits(name, input, options?.toolUseID, true, options?.signal)
      ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: DENIAL }
  };
}

function outcome(status, sessionId, reason, answer = '') {
  return { status, session_id: sessionId, answer, ...(reason ? { reason_code: reason } : {}) };
}

async function readTurn(session, state) {
  const { sessionId } = state;
  let modelSeen = false;
  const reportedTools = new Map();
  for await (const message of session.stream()) {
    const init = message?.type === 'system' && message.subtype === 'init';
    const assistant = message?.type === 'assistant';
    if (!init && !assistant && message?.type !== 'result') continue;
    if (message.session_id !== sessionId) {
      return outcome('unknown_after_disconnect', sessionId, 'WORKBUDDY_SDK_SESSION_MISMATCH');
    }
    if ((init && message.model !== MODEL) || (assistant && message.message?.model !== MODEL) ||
        (message.type === 'result' && message.model !== undefined && message.model !== MODEL)) {
      return outcome('unknown_after_disconnect', sessionId, 'WORKBUDDY_SDK_MODEL_MISMATCH');
    }
    if (init && message.permissionMode !== 'default') {
      return outcome('unknown_after_disconnect', sessionId, 'WORKBUDDY_SDK_PERMISSION_MODE_MISMATCH');
    }
    if (init && ((message.cwd !== undefined && !sameDirectory(message.cwd, state.cwd)) || message.mcp_servers?.length)) {
      return outcome('unknown_after_disconnect', sessionId, 'WORKBUDDY_SDK_CONTEXT_MISMATCH');
    }
    if (assistant) {
      modelSeen = true;
      for (const item of message.message.content ?? []) {
        if (item?.type !== 'tool_use') continue;
        if (!validToolId(item.id) || typeof item.name !== 'string' ||
            (reportedTools.has(item.id) && reportedTools.get(item.id) !== item.name)) {
          return outcome('unknown_after_disconnect', sessionId, 'WORKBUDDY_SDK_TOOL_TRACE_INVALID');
        }
        reportedTools.set(item.id, item.name);
      }
    }
    if (message.type !== 'result') continue;
    if ([...reportedTools].some(([id, name]) => state.checkedTools.get(id) !== name)) {
      return outcome('unknown_after_disconnect', sessionId, 'WORKBUDDY_SDK_TOOL_TRACE_MISSING');
    }
    if (state.denied || (Array.isArray(message.permission_denials) && message.permission_denials.length > 0)) {
      return outcome('refused', sessionId, 'WORKBUDDY_SDK_PERMISSION_DENIED');
    }
    if (ERROR_RESULTS.has(message.subtype) || (message.subtype === 'success' && message.is_error === true)) {
      return outcome('failed', sessionId, 'WORKBUDDY_SDK_RESULT_ERROR');
    }
    if (!modelSeen || message.subtype !== 'success' || message.is_error !== false ||
        typeof message.result !== 'string' || !message.result.trim()) {
      return outcome('unknown_after_disconnect', sessionId, 'WORKBUDDY_SDK_RESULT_INVALID');
    }
    return outcome('completed', sessionId, undefined, message.result);
  }
  return outcome('unknown_after_disconnect', sessionId, 'WORKBUDDY_SDK_NO_RESULT');
}

export async function executeProjectSdk({ config, task, signal, createSession, resumeSession, allowTool, onSend }) {
  let session;
  const state = { sent: false, denied: false, sessionId: null, cwd: task.cwd, checkedTools: new Map() };
  try {
    signal?.throwIfAborted();
    const tools = toolList(task);
    const options = {
      ...baseOptions(config, task.cwd),
      tools,
      ...toolGate({ task, tools, signal, allowTool, state }),
      requestTimeoutMs: task.timeoutMs
    };
    session = newSession(task.sessionId === undefined ? createSession : resumeSession, options, task.sessionId);
    if (typeof session?.sessionId !== 'string' || !PROJECT_SESSION_ID.test(session.sessionId) ||
        (task.sessionId !== undefined && session.sessionId !== task.sessionId)) {
      return outcome('refused', null, 'WORKBUDDY_SDK_SESSION_MISMATCH');
    }
    state.sessionId = session.sessionId;
    await selectModel(session, signal);
    await bounded(signal, () => {
      onSend?.(state.sessionId);
      signal?.throwIfAborted();
      state.sent = true;
      return session.send(task.prompt);
    });
    return await bounded(signal, () => readTurn(session, state));
  } catch (error) {
    if (signal?.aborted) {
      const code = stopCode(signal);
      const status = state.sent ? 'unknown_after_disconnect' : code === 'WORKBUDDY_SDK_TIMED_OUT' ? 'timed_out' : 'cancelled';
      return outcome(status, state.sent ? state.sessionId : null, code);
    }
    if (!state.sent) {
      const code = /^WORKBUDDY_[A-Z0-9_]+$/.test(error?.code) ? error.code : 'WORKBUDDY_SDK_START_FAILED';
      return outcome('refused', null, code);
    }
    // The pinned SDK throws ExecutionError instead of yielding some error results.
    // It drops the result's session ID in that case, so the outcome is unverified.
    return outcome('unknown_after_disconnect', state.sessionId, 'WORKBUDDY_SDK_STREAM_FAILED');
  } finally { closeSession(session); }
}
