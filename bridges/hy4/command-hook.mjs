#!/usr/bin/env node
// Deterministic CodeBuddy PreToolUse guard for the opt-in native command
// capability. It consumes only a local policy artifact supplied by the HY4
// adapter and a hook JSON object on stdin. It never calls a model, network,
// package manager or the command itself.
//
// Exit 0 lets the normal vendor permission flow continue. Exit 2 blocks. We
// intentionally never emit permissionDecision:"allow", which would bypass the
// vendor's own permission callback.
import fs from 'node:fs';
import path from 'node:path';

const MAX_INPUT = 1024 * 1024;
const MAX_POLICY = 256 * 1024;

function deny(message = 'HY4 command is not authorized by the local task policy.') {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.replace(/\//g, '\\').toLowerCase() : resolved;
}

function canonicalDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  try {
    const real = (fs.realpathSync.native || fs.realpathSync)(value);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch { return null; }
}

function policyPath() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--policy' || !args[1] || !path.isAbsolute(args[1])) return null;
  return args[1];
}

let raw;
try { raw = fs.readFileSync(0, 'utf8'); }
catch { deny('HY4 hook input is unreadable.'); }
if (typeof raw !== 'string' || !raw.trim() || Buffer.byteLength(raw) > MAX_INPUT) deny('HY4 hook input is invalid.');

let input, policy;
try { input = JSON.parse(raw); } catch { deny('HY4 hook input is not JSON.'); }
const file = policyPath();
if (!file) deny('HY4 hook policy argument is invalid.');
try {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) deny('HY4 hook policy is not a regular local file.');
  if (stat.size > MAX_POLICY) deny('HY4 hook policy is too large.');
  policy = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
} catch { deny('HY4 hook policy is unavailable.'); }

if (!policy || typeof policy !== 'object' || Array.isArray(policy) || policy.schema !== 1
  || typeof policy.task_id !== 'string' || !policy.task_id
  || typeof policy.command_tool !== 'string' || !policy.command_tool
  || !Array.isArray(policy.commands) || policy.commands.length < 1
  || !policy.commands.every(value => typeof value === 'string' && value)) {
  deny('HY4 hook policy is malformed.');
}
if (!input || typeof input !== 'object' || Array.isArray(input)) deny('HY4 hook input is malformed.');
const event = input.hook_event_name ?? input.hookEventName;
if (event !== 'PreToolUse') deny('HY4 hook event is not PreToolUse.');
const toolName = input.tool_name ?? input.toolName;
if (toolName !== policy.command_tool) deny('HY4 tool is not the authorized native command tool.');
const toolInput = input.tool_input ?? input.toolInput;
if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) deny('HY4 command input is malformed.');
for (const key of Object.keys(toolInput)) {
  if (!['command', 'cwd', 'description', 'timeout'].includes(key)) deny('HY4 command has unsupported extra arguments.');
}
if (typeof toolInput.command !== 'string' || !policy.commands.includes(toolInput.command)) {
  deny('HY4 command does not exactly match an authorized task command.');
}

const sessionCwd = canonicalDirectory(input.cwd);
const policyCwd = canonicalDirectory(policy.cwd);
if (!sessionCwd || !policyCwd || pathKey(sessionCwd) !== pathKey(policyCwd)) deny('HY4 command cwd does not match the approved task cwd.');
if (toolInput.cwd !== undefined) {
  const toolCwd = canonicalDirectory(toolInput.cwd);
  if (!toolCwd || pathKey(toolCwd) !== pathKey(policyCwd)) deny('HY4 command requested a different cwd.');
}
process.exit(0);
