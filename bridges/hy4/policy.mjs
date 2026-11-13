// Shared, local-only task authorization policy for the opt-in CodeBuddy ACP
// adapter. Nothing here calls a model, vendor API, package manager or shell.
//
// This module is deliberately conservative about filesystem names. It is a
// task-permission contract, not an OS sandbox: another process running as the
// same account can still race or edit these paths.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const WRITE_MODES = Object.freeze(['create', 'edit', 'write']);
export const SCOPE_OPERATIONS = Object.freeze(['create', 'replace', 'edit']);
export const MAX_WRITES = 32;
export const MAX_WRITE_SCOPES = 32;
export const MAX_COMMANDS = 32;
export const MAX_COMMAND_BYTES = 2048;
export const MAX_PATH_BYTES = 4096;

const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)(?:\..*)?$/i;
const WINDOWS_BAD = /[<>"|?*\u0000-\u001f]/;
// Apply to every lexical and canonical component. ".env.fixture" is included
// on purpose so tests can prove that a synthetic fixture is denied too.
const PROTECTED = /^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.gnupg|\.codex|\.config|\.npmrc|\.netrc|auth\.json|models\.json|credentials|secrets?|id_rsa|id_ed25519|\.credentials(?:\..*)?|.*\.(?:pem|key|pfx|p12|kdbx))$/i;
const COMMAND_FORBIDDEN = /[<>&|;\r\n`\u0000]/;
const COMMAND_SUBSTITUTION = /\$\(|\$\{/;
const COMMAND_BYPASS = /(?:--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--bypass-permissions|bypassPermissions|--no-sandbox|--disable-sandbox|--allow-all|--auto-approve)/i;

export const DENY_READ = Object.freeze([
  'Read(.env*)',
  'Read(**/.env*)',
  'Read(.git/**)',
  'Read(**/.git/**)',
  'Read(.ssh/**)',
  'Read(**/.ssh/**)',
  'Read(.aws/**)',
  'Read(**/.aws/**)',
  'Read(.azure/**)',
  'Read(**/.azure/**)',
  'Read(.gnupg/**)',
  'Read(**/.gnupg/**)',
  'Read(.codex/**)',
  'Read(**/.codex/**)',
  'Read(auth.json)',
  'Read(**/auth.json)',
  'Read(models.json)',
  'Read(**/models.json)',
  'Read(credentials*)',
  'Read(**/credentials*)',
  'Read(.credentials*)',
  'Read(**/.credentials*)',
  'Read(.npmrc)',
  'Read(**/.npmrc)',
  'Read(.netrc)',
  'Read(**/.netrc)',
  'Read(id_rsa)',
  'Read(**/id_rsa)',
  'Read(id_ed25519)',
  'Read(**/id_ed25519)',
  'Read(*.pem)',
  'Read(**/*.pem)',
  'Read(*.key)',
  'Read(**/*.key)',
  'Read(*.pfx)',
  'Read(**/*.pfx)',
  'Read(*.p12)',
  'Read(**/*.p12)',
  'Read(*.kdbx)',
  'Read(**/*.kdbx)'
]);

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.replace(/\//g, '\\').toLowerCase() : resolved;
}

export function isInside(base, value) {
  const rel = path.relative(base, value);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function fail(message) {
  throw Error(message);
}

export function isProtectedName(name) {
  return typeof name === 'string' && PROTECTED.test(name);
}

function lexicalParts(value) {
  const parsed = process.platform === 'win32' ? path.win32.parse(value) : path.posix.parse(value);
  const root = parsed.root;
  const tail = value.slice(root.length);
  const parts = tail.split(process.platform === 'win32' ? /[\\/]+/ : /\/+/).filter(Boolean);
  return { root, parts, tail };
}

// Validates the spelling of an absolute path before any filesystem lookup.
// Rejects ADS/device/UNC/8.3/trailing-dot/stream-like forms rather than trying
// to reinterpret them later.
export function validateAbsolutePath(value, label = 'path') {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_PATH_BYTES) fail(`${label} must be a bounded absolute path.`);
  if (value.includes('\u0000') || /[\u0001-\u001f]/.test(value)) fail(`${label} contains control characters.`);
  if (value !== value.trim()) fail(`${label} must not have leading or trailing whitespace.`);
  if (!path.isAbsolute(value)) fail(`${label} must be absolute.`);
  const { root, parts } = lexicalParts(value);
  if (!root) fail(`${label} has an ambiguous root.`);
  if (process.platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]$/.test(root) || /^[\\/]{2}/.test(value)) fail(`${label} must be a local drive path, not a UNC, device or stream path.`);
    for (const part of parts) {
      if (!part || part === '.' || part === '..') fail(`${label} has an ambiguous path segment.`);
      if (part.includes(':') || WINDOWS_BAD.test(part)) fail(`${label} contains an alternate-stream, device or ambiguous component.`);
      if (/[. ]$/.test(part)) fail(`${label} has a trailing dot or space.`);
      if (WINDOWS_RESERVED.test(part)) fail(`${label} contains a reserved Windows device name.`);
      if (/~\d/.test(part)) fail(`${label} contains an ambiguous short-name component.`);
    }
  } else {
    for (const part of parts) {
      if (!part || part === '.' || part === '..') fail(`${label} has an ambiguous path segment.`);
      if (part.includes('\u0000')) fail(`${label} contains an ambiguous component.`);
    }
  }
  for (const part of parts) if (isProtectedName(part)) fail(`${label} contains a protected credential or repository component.`);
  return path.resolve(value);
}

function lstatOrNull(value) {
  try { return fs.lstatSync(value); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    fail('A path component is not accessible.');
  }
}

function assertNoReparsePoints(root, target) {
  if (!isInside(root, target)) fail('A path escapes its approved directory.');
  const rel = path.relative(root, target);
  if (!rel) return;
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) fail('A path contains a symlink or junction; refusing to follow it.');
    if (current !== target && !stat.isDirectory()) fail('A path component is not a directory.');
  }
}

function assertProtectedRelative(base, target, label) {
  if (!isInside(base, target)) fail(`${label} escapes its approved directory.`);
  for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
    if (isProtectedName(part)) fail(`${label} resolves to a protected credential or repository path.`);
  }
}

export function canonicalDirectoryWithin(root, value, label = 'directory') {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('The approved root is invalid.');
  const lexical = validateAbsolutePath(value, label);
  if (!isInside(root, lexical)) fail(`${label} is outside the approved directory.`);
  assertNoReparsePoints(root, lexical);
  let real;
  try { real = (fs.realpathSync.native || fs.realpathSync)(lexical); }
  catch { fail(`${label} must be an existing directory.`); }
  let stat;
  try { stat = fs.statSync(real); } catch { fail(`${label} is not accessible.`); }
  if (!stat.isDirectory()) fail(`${label} is not a directory.`);
  if (!isInside(root, real)) fail(`${label} escapes the approved directory through a link.`);
  assertProtectedRelative(root, real, label);
  return real;
}

export function canonicalFileWithin(root, value, label = 'file') {
  const lexical = validateAbsolutePath(value, label);
  if (value.endsWith(path.sep) || (process.platform === 'win32' && /[\\/]$/.test(value))) fail(`${label} names a directory, not a file.`);
  if (!isInside(root, lexical)) fail(`${label} is outside the approved directory.`);
  const parent = path.dirname(lexical);
  const leaf = path.basename(lexical);
  if (!leaf || leaf === '.' || leaf === '..') fail(`${label} has no valid file name.`);
  if (isProtectedName(leaf)) fail(`${label} is a protected credential or repository path.`);
  let realParent;
  try { realParent = canonicalDirectoryWithin(root, parent, `${label} parent`); }
  catch (error) { throw Error(error.message); }
  const target = path.join(realParent, leaf);
  if (!isInside(root, target)) fail(`${label} escapes the approved directory.`);
  assertProtectedRelative(root, target, label);
  const stat = lstatOrNull(target);
  if (!stat) return target;
  if (stat.isSymbolicLink()) fail(`${label} is a symlink or junction; refusing to follow it.`);
  if (stat.isDirectory()) fail(`${label} is a directory.`);
  if (!stat.isFile()) fail(`${label} is not a regular file.`);
  let real;
  try { real = (fs.realpathSync.native || fs.realpathSync)(target); }
  catch { fail(`${label} is not accessible.`); }
  if (pathKey(real) !== pathKey(target)) fail(`${label} resolves through a link or alias.`);
  if (!isInside(root, real)) fail(`${label} escapes the approved directory.`);
  assertProtectedRelative(root, real, label);
  return real;
}

function normalizeOperations(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > SCOPE_OPERATIONS.length) {
    fail('Each writeScope needs 1..3 explicit operations.');
  }
  const result = [];
  for (const operation of value) {
    if (typeof operation !== 'string' || !SCOPE_OPERATIONS.includes(operation)) {
      fail('writeScope operations must be create, replace or edit.');
    }
    if (!result.includes(operation)) result.push(operation);
  }
  return Object.freeze(result.sort());
}

export function normalizeWriteScopes(cwd, value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_WRITE_SCOPES) fail(`writeScopes must be an array of at most ${MAX_WRITE_SCOPES} directories.`);
  const seen = new Set();
  const scopes = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('Invalid writeScope entry.');
    for (const key of Object.keys(item)) if (!['path', 'operations'].includes(key)) fail('Unknown writeScope field.');
    const scopePath = canonicalDirectoryWithin(cwd, item.path, 'writeScope');
    const key = pathKey(scopePath);
    if (seen.has(key)) fail('Duplicate writeScope path.');
    seen.add(key);
    return Object.freeze({ path: scopePath, operations: normalizeOperations(item.operations) });
  });
  return Object.freeze(scopes.sort((a, b) => pathKey(a.path).localeCompare(pathKey(b.path))));
}

export function normalizeWrites(cwd, value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_WRITES) fail(`writes must be an array of at most ${MAX_WRITES} exact files.`);
  const seen = new Set();
  const writes = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('Invalid authorized write entry.');
    for (const key of Object.keys(item)) if (!['path', 'mode', 'content_sha256'].includes(key)) fail('Unknown authorized write field.');
    if (typeof item.mode !== 'string' || !WRITE_MODES.includes(item.mode)) fail('Authorized write mode must be create, edit or write.');
    const target = canonicalFileWithin(cwd, item.path, 'authorized write');
    const key = pathKey(target);
    if (seen.has(key)) fail('Duplicate authorized write path.');
    seen.add(key);
    const suppliedHash = item.content_sha256 === null ? undefined : item.content_sha256;
    if (suppliedHash !== undefined) {
      if (typeof suppliedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(suppliedHash)) fail('Invalid write content hash.');
      if (item.mode === 'edit') fail('content_sha256 is only valid for full-content create/write entries, not edit.');
    }
    return Object.freeze({
      path: target,
      mode: item.mode,
      content_sha256: suppliedHash === undefined ? null : suppliedHash.toLowerCase()
    });
  });
  return Object.freeze(writes.sort((a, b) => pathKey(a.path).localeCompare(pathKey(b.path))));
}

export function normalizeCommands(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_COMMANDS) fail(`commands must be an array of at most ${MAX_COMMANDS} exact commands.`);
  const seen = new Set();
  const commands = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw) > MAX_COMMAND_BYTES) fail('Each command must be a 1..2048 byte string.');
    if (raw !== raw.trim()) fail('Commands must not have leading or trailing whitespace.');
    if (/[\u0000-\u001f\u007f]/.test(raw)) fail('Commands must not contain control characters or newlines.');
    if (COMMAND_FORBIDDEN.test(raw) || COMMAND_SUBSTITUTION.test(raw)) fail('Commands must be complete literal argv lines without pipes, redirection, backgrounding, separators or substitutions.');
    if (COMMAND_BYPASS.test(raw)) fail('Commands must not request a permission or sandbox bypass.');
    if (seen.has(raw)) fail('Duplicate exact command.');
    seen.add(raw);
    commands.push(raw);
  }
  return Object.freeze(commands.sort());
}

export function normalizeTaskAuthorization({ cwd, permissionMode = 'read-only', capability = 'default', writes, writeScopes, commands } = {}) {
  const writeRequested = permissionMode === 'workspace-write';
  const hasFileAuthorization = (Array.isArray(writes) && writes.length > 0) || (Array.isArray(writeScopes) && writeScopes.length > 0);
  const hasCommandAuthorization = Array.isArray(commands) && commands.length > 0;
  if (!writeRequested && (hasFileAuthorization || hasCommandAuthorization)) {
    fail('writes, writeScopes and commands are only valid with workspace-write permission.');
  }
  if (capability !== 'workspace-write' && (hasFileAuthorization || hasCommandAuthorization)) {
    fail('writes, writeScopes and commands require the workspace-write capability.');
  }
  const normalizedWrites = normalizeWrites(cwd, writes);
  const normalizedScopes = normalizeWriteScopes(cwd, writeScopes);
  const normalizedCommands = normalizeCommands(commands);
  return {
    writes: normalizedWrites,
    writeScopes: normalizedScopes,
    commands: normalizedCommands
  };
}

export function taskFingerprint(task) {
  return sha256(JSON.stringify({
    schema: 2,
    prompt_sha256: sha256(task.prompt ?? ''),
    cwd: task.cwd ?? null,
    idempotency_key: task.idempotencyKey ?? null,
    timeout_ms: task.timeoutMs ?? null,
    permission_mode: task.permissionMode ?? null,
    capability: task.capability ?? null,
    backend: task.backend ?? 'hy4',
    authorization_note: task.authorizationNote ?? null,
    session_id: task.sessionId ?? null,
    continuation_of_task_id: task.continuationOfTaskId ?? null,
    repair_of_task_id: task.repairOfTaskId ?? null,
    write_scopes: (task.writeScopes ?? []).map(scope => ({ path: scope.path, operations: scope.operations })),
    writes: (task.writes ?? []).map(write => ({ path: write.path, mode: write.mode, content_sha256: write.content_sha256 ?? null })),
    commands: task.commands ?? []
  }));
}

export function scopeAllows(scopes, target, operation) {
  return (scopes ?? []).some(scope =>
    isInside(scope.path, target) && Array.isArray(scope.operations) && scope.operations.includes(operation));
}

export function exactWriteFor(writes, target) {
  const key = pathKey(target);
  return (writes ?? []).find(write => pathKey(write.path) === key) ?? null;
}

export function writeOperation({ exists, content, oldString, newString }) {
  const hasContent = typeof content === 'string';
  const hasEdit = typeof oldString === 'string' && typeof newString === 'string';
  if (hasContent === hasEdit) return null;
  if (hasContent) return exists ? 'replace' : 'create';
  return exists ? 'edit' : 'create';
}

export function commandAllowed(commands, value) {
  return typeof value === 'string' && (commands ?? []).includes(value);
}

export function normalizeLocationPath(location) {
  const raw = location?.path ?? location?.uri ?? location;
  if (typeof raw !== 'string' || !raw) return null;
  if (/^file:/i.test(raw)) {
    try { return fileURLToPath(raw); }
    catch { return null; }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) return null;
  return raw;
}

export function samePath(a, b) {
  return pathKey(a) === pathKey(b);
}

export function safeWriteMetadata(task) {
  return {
    write_scope_count: task.writeScopes?.length ?? 0,
    exact_write_count: task.writes?.length ?? 0,
    command_count: task.commands?.length ?? 0,
    write_scope_operations: [...new Set((task.writeScopes ?? []).flatMap(scope => scope.operations))].sort(),
    exact_write_modes: [...new Set((task.writes ?? []).map(write => write.mode))].sort()
  };
}
