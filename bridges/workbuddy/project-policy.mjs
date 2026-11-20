import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../dsh/core.mjs';
import {
  canonicalDirectoryWithin, canonicalFileWithin, commandAllowed, exactWriteFor, isInside, isProtectedName,
  normalizeTaskAuthorization, samePath, scopeAllows, sha256, writeOperation
} from '../hy4/policy.mjs';
import { matchProject, PROJECT_ID, PROJECT_SESSION_ID, PROJECT_TASK_KEY, projectError } from './project-config.mjs';

const MODES = ['read-only', 'workspace-write'];
const CAPABILITIES = ['default', 'text-only', 'workspace-read', 'workspace-write'];
const text = { type: 'string' };
const narrowScope = {
  authorizationNote: { ...text, maxLength: 2000 },
  writes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'mode'], properties: {
    path: text, mode: { ...text, enum: ['create', 'edit', 'write'] }, content_sha256: { type: ['string', 'null'] }
  } } },
  writeScopes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'operations'], properties: {
    path: text, operations: { type: 'array', items: { ...text, enum: ['create', 'replace', 'edit'] } }
  } } },
  commands: { type: 'array', items: text }
};
const scope = {
  projectId: { ...text, pattern: PROJECT_ID.source, description: 'The stable ID returned by project readiness for this cwd.' },
  cwd: { ...text, description: 'An existing absolute directory within the already approved project.' },
  permissionMode: { ...text, enum: MODES },
  capability: { ...text, enum: CAPABILITIES },
  ...narrowScope
};
const key = { ...text, pattern: PROJECT_TASK_KEY.source };
const schema = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });

export const projectStatusSchema = schema(scope);
export const projectRunSchema = schema({
  ...scope, idempotencyKey: key, prompt: { ...text, minLength: 1, maxLength: 60000 },
  timeoutMs: { type: 'integer', minimum: 1000, maximum: 3600000 },
  sessionId: { ...text, pattern: PROJECT_SESSION_ID.source }
}, ['projectId', 'cwd', 'permissionMode', 'idempotencyKey', 'prompt']);
export const projectLookupSchema = schema({ idempotencyKey: key }, ['idempotencyKey']);

export function checkProjectArguments(args, spec) {
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
    Object.keys(args).some(field => !Object.hasOwn(spec.properties, field)) ||
    spec.required.some(field => !Object.hasOwn(args, field))) {
    throw projectError('WORKBUDDY_INVALID_TASK', 'WorkBuddy arguments do not match the project entry schema.');
  }
  for (const [key, value] of Object.entries(args)) {
    const rule = spec.properties[key];
    const hasType = rule.type === 'array' ? Array.isArray(value)
      : rule.type === 'integer' ? Number.isSafeInteger(value) : typeof value === rule.type;
    if (!hasType || (rule.enum && !rule.enum.includes(value)) || (rule.pattern && !new RegExp(rule.pattern).test(value)) ||
      (rule.maxLength && Buffer.byteLength(value) > rule.maxLength) || (rule.minLength && value.trim().length < rule.minLength) ||
      (rule.minimum !== undefined && (value < rule.minimum || value > rule.maximum))) {
      throw projectError('WORKBUDDY_INVALID_TASK', `Invalid WorkBuddy project argument ${key}.`);
    }
  }
}

export function prepareProjectTask(config, args, probe = false) {
  checkProjectArguments(args, probe ? projectStatusSchema : projectRunSchema);
  const permissionMode = args.permissionMode ?? 'read-only';
  const capability = args.capability ?? 'default';
  if ((permissionMode === 'workspace-write' && !['default', 'workspace-write'].includes(capability)) ||
    (capability === 'workspace-write' && permissionMode !== 'workspace-write')) {
    throw projectError('WORKBUDDY_PROJECT_PERMISSION', 'The task permission mode and capability do not match.');
  }
  const { project, cwd } = matchProject(config, {
    cwd: args.cwd ?? config.projects.find(project => project.id === args.projectId)?.root ?? config.projects[0].root,
    projectId: args.projectId, permissionMode
  });
  let narrow;
  try { narrow = normalizeTaskAuthorization({ ...args, cwd, permissionMode, capability }); }
  catch (error) { throw projectError('WORKBUDDY_PROJECT_PERMISSION', error.message); }
  const hasFileScope = Boolean(narrow.writes.length || narrow.writeScopes.length);
  const allowCommands = permissionMode === 'workspace-write' && project.allowCommands &&
    (!hasFileScope || narrow.commands.length > 0);
  if (narrow.commands.length && !allowCommands) {
    throw projectError('WORKBUDDY_PROJECT_PERMISSION', 'This WorkBuddy project grant does not allow the requested commands.');
  }
  if (redact(args.idempotencyKey ?? '') !== (args.idempotencyKey ?? '') ||
    redact(args.sessionId ?? '') !== (args.sessionId ?? '')) {
    throw projectError('WORKBUDDY_INVALID_TASK', 'Use non-secret task keys and session identifiers.');
  }
  return { ...args, ...narrow, cwd, permissionMode, capability, projectId: project.id, allowCommands, hasFileScope,
    timeoutMs: args.timeoutMs ?? 900000 };
}

function taskPath(cwd, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath || rawPath !== rawPath.trim() ||
    rawPath.split(/[\\/]/).some(part => part === '..')) throw Error('Invalid project-relative path.');
  const target = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
  if (!isInside(cwd, target)) throw Error('Project tool path is outside the task directory.');
  return target;
}

function fileStat(target) {
  try { return fs.statSync(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function hasSafeSearchPattern(pattern) {
  return pattern === undefined || (typeof pattern === 'string' && !path.isAbsolute(pattern) &&
    !pattern.split(/[\\/]/).some(part => part === '..' || isProtectedName(part)));
}

function permitsWrittenFile(task, tool, target, stat, input) {
  if (task.permissionMode !== 'workspace-write') return false;
  const operation = writeOperation({
    exists: Boolean(stat), ...(tool === 'Write' ? { content: input.content } : {
      oldString: input.old_string, newString: input.new_string
    })
  });
  if (!operation) return false;
  if (!task.hasFileScope) return true;
  const exact = exactWriteFor(task.writes, target);
  if (exact) {
    const modeMatches = exact.mode === 'write' ? operation === 'create' || operation === 'replace' : exact.mode === operation;
    return modeMatches && (tool === 'Write' || operation === 'edit') &&
      (!exact.content_sha256 || sha256(input.content) === exact.content_sha256);
  }
  return scopeAllows(task.writeScopes, target, operation);
}

function commandArguments(command, tool) {
  if (typeof command !== 'string' || !command || Buffer.byteLength(command) > 2048 || command !== command.trim() ||
    /[\u0000-\u001f\u007f\x60$%~^]|--(?:dangerously-)?(?:skip-permissions|bypass-permissions|no-sandbox|disable-sandbox|allow-all|auto-approve)/i.test(command)) {
    return [];
  }
  const line = tool === 'PowerShell' ? command.replace(/^& +/, '') : command;
  const tokens = /("[^"]*"|'[^']*'|[^ "'<>;&|]+)(?: +|$)/gy;
  const result = [];
  let cursor = 0;
  for (let match; (match = tokens.exec(line));) {
    cursor = tokens.lastIndex;
    result.push(match[1].replace(/^["']|["']$/g, ''));
  }
  return cursor === line.length ? result : [];
}

function checkCommandPath(cwd, value) {
  if (isProtectedName(value) || value === '..' || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) throw Error('Unsafe command path.');
  if (!/[\\/]/.test(value)) return;
  const candidate = taskPath(cwd, value);
  if (fileStat(candidate)?.isDirectory()) canonicalDirectoryWithin(cwd, candidate, 'project command directory');
  else canonicalFileWithin(cwd, candidate, 'project command path');
}

function permitsCommand(task, tool, input) {
  if (!task.allowCommands || input.run_in_background === true || input.dangerouslyDisableSandbox === true ||
    input.cwd !== undefined || input.workdir !== undefined) return false;
  const command = input.command;
  if (task.commands.length && !commandAllowed(task.commands, command)) return false;
  const args = commandArguments(command, tool);
  const [launcher, ...operands] = args;
  if (!launcher) return false;
  // The launcher can be a normal installed program such as MATLAB. Direct
  // project paths are still checked before the vendor sees a command.
  if (path.isAbsolute(launcher)) {
    if (!fileStat(launcher)?.isFile() || isProtectedName(path.basename(launcher))) return false;
  } else {
    if (/^[-.]$|[\s=]/.test(launcher)) return false;
    checkCommandPath(task.cwd, launcher);
  }
  // Catch common shell escapes at the callback. An admitted native program
  // still has the host's ordinary process permissions.
  for (const operand of operands) {
    const value = operand.replace(/^--?[\w-]+=/, '');
    const literals = [...value.matchAll(/(['"])(.*?)\1/g)];
    if (literals.length) for (const literal of literals) checkCommandPath(task.cwd, literal[2]);
    else checkCommandPath(task.cwd, value);
  }
  return true;
}

export function allowProjectTool(task, tool, input, cwd) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || task.capability === 'text-only') return false;
  try {
    if (!samePath(task.cwd, canonicalDirectoryWithin(task.cwd, cwd, 'tool cwd'))) return false;
    if (tool === 'Bash' || tool === 'PowerShell') return permitsCommand(task, tool, input);
    if (tool === 'Glob' || tool === 'Grep') {
      const target = taskPath(task.cwd, input.path ?? task.cwd);
      if (!hasSafeSearchPattern(tool === 'Glob' ? input.pattern : input.glob)) return false;
      if (tool === 'Glob' || fileStat(target)?.isDirectory()) canonicalDirectoryWithin(task.cwd, target, 'search directory');
      else if (!fileStat(canonicalFileWithin(task.cwd, target, 'search file'))?.isFile()) return false;
      return true;
    }
    if (!['Read', 'Write', 'Edit'].includes(tool)) return false;
    const target = canonicalFileWithin(task.cwd, taskPath(task.cwd, input.file_path), 'project file');
    const stat = fileStat(target);
    if (stat && stat.nlink !== 1) return false;
    if (tool === 'Read') return Boolean(stat?.isFile());
    return permitsWrittenFile(task, tool, target, stat, input);
  } catch { return false; }
}
