#!/usr/bin/env node
// Line-JSON ACP fixture. It never contacts a provider; used only by mock tests.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.argv.includes('--version')) {
  process.stdout.write('2.184.0\n');
  process.exit(0);
}
const modeFile = process.env.CODEBUDDY_CONFIG_DIR ? path.join(process.env.CODEBUDDY_CONFIG_DIR, 'mode.txt') : null;
const mode = modeFile && fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : 'normal';
const permissionIndex = process.argv.indexOf('--permission-mode');
const cliPermissionMode = permissionIndex >= 0 ? process.argv[permissionIndex + 1] : 'dontAsk';
let sessionId = null;
let sessionCwd = null;
let promptId = null;
let permissionId = 900;
let legacyPermissionId = null;
const pendingPermissions = new Map();
const models = () => [
  { value: 'hy4free', name: 'Hy4', description: 'x0.00 credits' },
  { value: 'hy4std', name: 'Hy4', description: 'x0.29 credits' }
];
const catalogModels = () => models().map(model => ({ modelId: model.value, name: model.name, description: model.description }));
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const result = (id, value) => write({ jsonrpc: '2.0', id, result: value });
const failure = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
const update = value => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function permission(toolCallId, kind, target, rawInput) {
  const id = permissionId++;
  return new Promise(resolve => {
    pendingPermissions.set(id, resolve);
    write({
      jsonrpc: '2.0', id, method: 'session/request_permission',
      params: {
        sessionId, toolCallId,
        toolCall: { toolCallId, rawInput, ...(target ? { locations: [{ path: target }] } : {}) },
        options: [
          { optionId: 'allow-once', kind: 'allow_once' },
          { optionId: 'reject-once', kind: 'reject_once' },
          { optionId: 'allow-always', kind: 'allow_always' }
        ]
      }
    });
  });
}
function outcome(message) {
  return message?.result?.outcome?.outcome === 'selected' ? message.result.outcome.optionId : null;
}
async function writeTool(toolCallId, kind, target, rawInput) {
  update({ sessionUpdate: 'tool_call', toolCallId, kind, locations: [{ path: target }], status: 'pending' });
  const selected = await permission(toolCallId, kind, target, rawInput);
  if (selected !== 'allow-once') {
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
    return false;
  }
  if (kind === 'edit') {
    if (typeof rawInput.content === 'string') fs.writeFileSync(target, rawInput.content);
    else {
      const current = fs.readFileSync(target, 'utf8');
      fs.writeFileSync(target, current.replace(rawInput.old_string, rawInput.new_string));
    }
  }
  update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
  return true;
}
async function commandTool(toolCallId, command, auto = false) {
  update({ sessionUpdate: 'tool_call', toolCallId, kind: 'execute', locations: [{ path: sessionCwd }], rawInput: { command, cwd: sessionCwd }, status: 'pending' });
  if (auto) {
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
    return true;
  }
  const selected = await permission(toolCallId, 'execute', sessionCwd, { command, cwd: sessionCwd });
  if (selected !== 'allow-once') {
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
    return false;
  }
  update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
  return true;
}

async function scenario(id) {
  if (mode === 'write-create') {
    const okay = await writeTool('tc-create', 'edit', path.join(sessionCwd, 'created.txt'), { file_path: path.join(sessionCwd, 'created.txt'), content: 'CREATED\n' });
    return result(id, { stopReason: okay ? 'end_turn' : 'refusal' });
  }
  if (mode === 'write-edit') {
    const okay = await writeTool('tc-edit', 'edit', path.join(sessionCwd, 'existing.txt'), {
      file_path: path.join(sessionCwd, 'existing.txt'), old_string: 'OLD', new_string: 'NEW', replace_all: false
    });
    return result(id, { stopReason: okay ? 'end_turn' : 'refusal' });
  }
  if (mode === 'write-repeat') {
    const target = path.join(sessionCwd, 'repeat.txt');
    const one = await writeTool('tc-repeat-1', 'edit', target, { file_path: target, content: 'ONE\n' });
    if (!one) return result(id, { stopReason: 'refusal' });
    const two = await writeTool('tc-repeat-2', 'edit', target, { file_path: target, content: 'TWO\n' });
    return result(id, { stopReason: two ? 'end_turn' : 'refusal' });
  }
  if (mode === 'write-hash-ok' || mode === 'write-hash-bad') {
    const target = path.join(sessionCwd, 'hashed.txt');
    const okay = await writeTool('tc-hash', 'edit', target, { file_path: target, content: mode === 'write-hash-ok' ? 'HASHED\n' : 'DIFFERENT\n' });
    return result(id, { stopReason: okay ? 'end_turn' : 'refusal' });
  }
  if (mode === 'write-edit-absent') {
    const target = path.join(sessionCwd, 'absent-edit.txt');
    const okay = await writeTool('tc-edit-absent', 'edit', target, { file_path: target, old_string: 'OLD', new_string: 'NEW' });
    return result(id, { stopReason: okay ? 'end_turn' : 'refusal' });
  }
  if (mode === 'write-file-uri') {
    const target = path.join(sessionCwd, 'uri.txt');
    update({ sessionUpdate: 'tool_call', toolCallId: 'tc-uri', kind: 'edit', locations: [{ uri: pathToFileURL(target).href }], status: 'pending' });
    const selected = await permission('tc-uri', 'edit', target, { file_path: target, content: 'URI\n' });
    if (selected !== 'allow-once') {
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-uri', status: 'failed' });
      return result(id, { stopReason: 'refusal' });
    }
    fs.writeFileSync(target, 'URI\n');
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-uri', status: 'completed' });
    return result(id, { stopReason: 'end_turn' });
  }
  if (mode === 'write-nested') {
    const target = path.join(sessionCwd, 'nested', 'deep', 'file.txt');
    const okay = await writeTool('tc-nested', 'edit', target, { file_path: target, content: 'NESTED\n' });
    return result(id, { stopReason: okay ? 'end_turn' : 'refusal' });
  }
  if (mode === 'write-outside-scope') {
    const target = path.join(sessionCwd, 'other.txt');
    const okay = await writeTool('tc-outside-scope', 'edit', target, { file_path: target, content: 'NO\n' });
    return result(id, { stopReason: okay ? 'end_turn' : 'refusal' });
  }
  if (mode === 'write-mixed') {
    const one = await writeTool('tc-mixed-1', 'edit', path.join(sessionCwd, 'ok.txt'), { file_path: path.join(sessionCwd, 'ok.txt'), content: 'OK\n' });
    const two = await writeTool('tc-mixed-2', 'edit', path.join(sessionCwd, 'denied.txt'), { file_path: path.join(sessionCwd, 'denied.txt'), content: 'NO\n' });
    return result(id, { stopReason: one && two ? 'end_turn' : 'refusal' });
  }
  if (mode === 'write-no-complete') {
    const target = path.join(sessionCwd, 'unconfirmed.txt');
    update({ sessionUpdate: 'tool_call', toolCallId: 'tc-unconfirmed', kind: 'edit', locations: [{ path: target }], status: 'pending' });
    const selected = await permission('tc-unconfirmed', 'edit', target, { file_path: target, content: 'UNCONFIRMED\n' });
    if (selected === 'allow-once') fs.writeFileSync(target, 'UNCONFIRMED\n');
    return result(id, { stopReason: 'end_turn' });
  }
  if (mode === 'write-outside') {
    const target = process.env.HY4_TEST_OUTSIDE || path.join(process.cwd(), '..', 'outside.txt');
    const okay = await writeTool('tc-outside', 'edit', target, { file_path: target, content: 'NO\n' });
    return result(id, { stopReason: okay ? 'end_turn' : 'refusal' });
  }
  if (mode === 'write-sensitive') {
    const target = path.join(sessionCwd, '.env.fixture');
    const okay = await writeTool('tc-sensitive', 'edit', target, { file_path: target, content: 'SECRET\n' });
    return result(id, { stopReason: okay ? 'end_turn' : 'refusal' });
  }
  if (mode === 'write-symlink') {
    const target = path.join(sessionCwd, 'link', 'escaped.txt');
    const okay = await writeTool('tc-symlink', 'edit', target, { file_path: target, content: 'NO\n' });
    return result(id, { stopReason: okay ? 'end_turn' : 'refusal' });
  }
  if (mode === 'read-repeat') {
    const target = path.join(sessionCwd, 'readme.txt');
    // Provisional metadata arrives first; the same operation is re-announced
    // with the concrete kind/locations/input. None of these create a new op.
    update({ sessionUpdate: 'tool_call', toolCallId: 'tc-read-repeat', kind: 'other', status: 'in_progress', rawInput: {} });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-read-repeat', rawInput: { file_path: target } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'tc-read-repeat', kind: 'read', status: 'pending', locations: [{ path: target }], rawInput: { file_path: target } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-read-repeat', status: 'completed' });
    return result(id, { stopReason: 'end_turn' });
  }
  if (mode === 'read-outside' || mode === 'read-sensitive') {
    const target = mode === 'read-sensitive'
      ? path.join(sessionCwd, '.env.fixture')
      : (process.env.HY4_TEST_OUTSIDE || path.join(process.cwd(), '..', 'outside.txt'));
    update({ sessionUpdate: 'tool_call', toolCallId: 'tc-read-outside', kind: 'read', locations: [{ path: target }], rawInput: { file_path: target }, status: 'pending' });
    await sleep(20);
    return result(id, { stopReason: 'end_turn' });
  }
  if (mode === 'command-allow') {
    const okay = await commandTool('tc-command', 'Write-Output HY4_OK');
    return result(id, { stopReason: okay ? 'end_turn' : 'refusal' });
  }
  if (mode === 'command-auto') {
    await commandTool('tc-command-auto', 'Write-Output HY4_OK', true);
    return result(id, { stopReason: 'end_turn' });
  }
  if (mode === 'command-unrelated') {
    update({ sessionUpdate: 'tool_call', toolCallId: 'tc-command-bad', kind: 'execute', locations: [{ path: sessionCwd }], rawInput: { command: 'Write-Output UNRELATED', cwd: sessionCwd }, status: 'pending' });
    await sleep(20);
    return result(id, { stopReason: 'end_turn' });
  }
  if (mode === 'command-mixed') {
    const one = await commandTool('tc-command-mixed-1', 'Write-Output HY4_OK');
    update({ sessionUpdate: 'tool_call', toolCallId: 'tc-command-mixed-2', kind: 'execute', locations: [{ path: sessionCwd }], rawInput: { command: 'Write-Output UNRELATED', cwd: sessionCwd }, status: 'pending' });
    await sleep(20);
    return result(id, { stopReason: one ? 'end_turn' : 'refusal' });
  }
  if (mode === 'deny') {
    legacyPermissionId = permissionId++;
    write({ jsonrpc: '2.0', id: legacyPermissionId, method: 'session/request_permission', params: { sessionId, toolCall: { title: 'fixture' } } });
    return;
  }
  if (mode === 'tool-event') {
    update({ sessionUpdate: 'tool_call', title: 'fixture-tool' });
    return result(id, { stopReason: 'end_turn' });
  }
  if (mode === 'model-change') {
    update({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: 'hy4std' }] });
    return result(id, { stopReason: 'end_turn' });
  }
  if (mode === 'slow') {
    setTimeout(() => result(id, { stopReason: 'end_turn' }), 5000);
    return;
  }
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HY4_' } });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } });
  return result(id, { stopReason: 'end_turn' });
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && msg.method === 'initialize') {
    return result(msg.id, { protocolVersion: 1, agentCapabilities: {} });
  }
  if (msg.id !== undefined && msg.method === 'session/new') {
    if (mode === 'auth-gate') return failure(msg.id, -32000, 'authentication required');
    sessionId = 'sess-fixture';
    sessionCwd = msg.params?.cwd || process.cwd();
    const onlyStd = mode === 'pin-mismatch' || mode === 'free-missing';
    const priced = mode === 'free-price';
    const configModels = (onlyStd ? [models()[1]] : models()).map(model =>
      priced && model.value === 'hy4free' ? { ...model, description: 'x0.29 credits' } : model);
    const available = onlyStd ? [catalogModels()[1]] : catalogModels().map(model =>
      priced && model.modelId === 'hy4free' ? { ...model, description: 'x0.29 credits' } : model);
    return result(msg.id, {
      sessionId,
      modes: { currentModeId: mode === 'permission-mismatch' ? 'ask' : (cliPermissionMode || 'dontAsk') },
      models: { availableModels: available },
      configOptions: mode === 'free-models-only' ? [] : [{ id: 'model', name: 'Model', currentValue: 'hy4std', options: configModels }]
    });
  }
  if (msg.id !== undefined && msg.method === 'session/set_config_option') {
    if (msg.params?.configId !== 'model' || msg.params?.value !== 'hy4free') return failure(msg.id, -32602, 'unexpected model');
    return result(msg.id, { configOptions: [{ id: 'model', name: 'Model', currentValue: 'hy4free', options: models() }] });
  }
  if (msg.id !== undefined && msg.method === 'session/prompt') {
    promptId = msg.id;
    write({ jsonrpc: '2.0', method: 'session/metadata_notification', params: { sessionId, metadata: { ui: 'ignored' } } });
    // Official ACP may emit this before tool use. It is optional UI metadata,
    // not a permission/tool request and must not abort the turn.
    update({
      sessionUpdate: 'session_info_update', title: 'fixture session',
      _meta: { timestamp: new Date().toISOString(), baggage: 'fixture-baggage', traceparent: 'fixture-traceparent' }
    });
    if (mode === 'partial') {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PARTIAL' } });
      setTimeout(() => process.exit(0), 20);
      return;
    }
    void scenario(msg.id).catch(() => { try { result(msg.id, { stopReason: 'refusal' }); } catch {} });
    return;
  }
  if (msg.id !== undefined && pendingPermissions.has(msg.id)) {
    const resolve = pendingPermissions.get(msg.id);
    pendingPermissions.delete(msg.id);
    return resolve(outcome(msg));
  }
  if (msg.id !== undefined && msg.id === legacyPermissionId && promptId !== null) {
    const id = promptId; promptId = null; legacyPermissionId = null;
    return result(id, { stopReason: 'refusal' });
  }
});
