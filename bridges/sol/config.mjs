import fs from 'node:fs';
import { openAIEnvName } from '../executor-environment.mjs';
import path from 'node:path';
import { runtimeBase } from '../dsh/core.mjs';
import { contextDirFor } from '../pool/context.mjs';
import { loadPoolConfig, validatePoolConfig } from '../pool/service.mjs';
import { WORKBUDDY_DSF } from '../workbuddy/dispatch.mjs';
import { loadProjectConfig, PROJECT_CONTRACT, PROJECT_SERVER_ENTRY } from '../workbuddy/project-config.mjs';
import { DSH_TIMEOUT_MS } from '../task-lifecycle.mjs';

export const SERVICE = 'sol-coordinator';
export const CoordinatorMode = Object.freeze({ SUBSCRIPTION: 'subscription', API: 'api' });
export const COORDINATOR_MODES = Object.freeze(Object.values(CoordinatorMode));
export const EXECUTION_BACKENDS = Object.freeze(['DSH', 'WorkBuddy DSF', 'Terra', 'HY4', 'A']);
export const EXECUTION_PERMISSIONS = Object.freeze(['read-only', 'workspace-write']);
export const SAFE_KEY = /^[A-Za-z0-9_.:-]{1,100}$/;
export const SAFE_ID = /^[A-Za-z0-9_.:@/-]{1,160}$/;
const ENV = /^[A-Z][A-Z0-9_]{1,99}$/;
const MODEL = /^[a-z0-9][a-z0-9_.:-]{0,99}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;
const LIMITS = {
  max_responses: [8, 2, 20], max_delegations: [3, 1, 8], max_output_tokens: [16000, 256, 64000],
  max_total_tokens: [60000, 1000, 500000], max_input_bytes: [192000, 16000, 768000],
  api_timeout_ms: [180000, 1000, 900000],
  task_timeout_ms: [DSH_TIMEOUT_MS.default, DSH_TIMEOUT_MS.minimum, DSH_TIMEOUT_MS.maximum]
};

export function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw Error(`${label} contains an unsupported field.`);
  return value;
}

export function boundedText(value, min, max, label) {
  if (typeof value !== 'string' || (min && !value.trim()) || Buffer.byteLength(value) > max) {
    throw Error(`${label} must be ${min ? 'nonempty ' : ''}text of at most ${max} UTF-8 bytes.`);
  }
  return value;
}

export function limitText(value, bytes) {
  const buffer = Buffer.from(String(value));
  return buffer.length <= bytes ? buffer.toString() : buffer.subarray(0, bytes - 3).toString().replace(/\ufffd$/, '') + '...';
}

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error(`${label} must be an absolute local path.`);
  return path.resolve(value);
}

function existing(value, label, kind) {
  const filename = fs.realpathSync(absolute(value, label));
  const stat = fs.statSync(filename);
  if (!(kind === 'directory' ? stat.isDirectory() : stat.isFile())) throw Error(`${label} must be an existing ${kind}.`);
  return filename;
}

function futurePath(value) {
  try { return fs.realpathSync(value); }
  catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(value) === value) throw error;
    return path.join(futurePath(path.dirname(value)), path.basename(value));
  }
}

export function contains(base, filename) {
  const rel = path.relative(base, filename);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export function approvedCwd(config, cwd) {
  const result = existing(cwd, 'cwd', 'directory');
  if (!contains(config.workspaceRoot, result)) throw Error('cwd is outside the approved workspace root.');
  return result;
}

function envName(value, suffix, label) {
  if (typeof value !== 'string' || !ENV.test(value) || !suffix.test(value)) throw Error(`${label} must be an environment variable name.`);
  return value;
}

function fields(value, names, required, label) {
  const result = object(value, names, label);
  if (required.some(key => !Object.hasOwn(result, key)) || Object.values(result).some(value => !FIELD.test(value) || typeof value !== 'string'
    || ['__proto__', 'prototype', 'constructor'].includes(value)) || new Set(Object.values(result)).size !== Object.keys(result).length) {
    throw Error(`${label} must explicitly map each required field to a distinct safe property name.`);
  }
  return result;
}

function loadWorkBuddy(value, reservedEnv) {
  if (value === undefined) return null;
  const resultDefaults = { status: 'status', model: 'model', taskId: 'task_id', sessionId: 'session_id', answer: 'answer' };
  if (value && Object.hasOwn(value, 'project_config')) {
    object(value, ['project_config'], 'workbuddy');
    const project = loadProjectConfig(value.project_config);
    return { command: process.execPath, args: [PROJECT_SERVER_ENTRY, '--config', project.configPath],
      cwd: path.dirname(PROJECT_SERVER_ENTRY), envVars: [], projectContract: PROJECT_CONTRACT, resultFields: resultDefaults };
  }
  const wb = object(value, ['command', 'args', 'cwd', 'env', 'env_vars', 'arguments', 'profiles', 'status_fields', 'result_fields'], 'workbuddy');
  const command = existing(wb.command, 'workbuddy.command', 'file');
  if (process.platform === 'win32' && !/\.exe$/i.test(command)) throw Error('workbuddy.command must be a Windows executable, with no shell wrapper.');
  const cwd = existing(wb.cwd, 'workbuddy.cwd', 'directory');
  if (!Array.isArray(wb.args) || wb.args.length > 32 || wb.args.some(arg => typeof arg !== 'string' || arg.length > 4096
    || /(?:sk-|ghp_|github_pat_)[\w-]{12,}|(?:api[-_]?key|password|token|secret)(?:=|$)/i.test(arg))) {
    throw Error('workbuddy.args must contain bounded local stdio arguments without credentials.');
  }
  const env = object(wb.env ?? {}, ['WB_MODEL', 'WB_SKIP_PERMISSIONS'], 'workbuddy.env');
  if ((env.WB_MODEL !== undefined && env.WB_MODEL !== WORKBUDDY_DSF.model)
    || (env.WB_SKIP_PERMISSIONS !== undefined && env.WB_SKIP_PERMISSIONS !== 'false')) {
    throw Error('WorkBuddy requires its fixed DSF model and ordinary permission checks.');
  }
  const envVars = wb.env_vars ?? [];
  if (!Array.isArray(envVars) || envVars.length > 24 || new Set(envVars).size !== envVars.length
    || envVars.some(name => typeof name !== 'string' || !ENV.test(name) || reservedEnv.includes(name) || openAIEnvName(name)
      || /^(?:NODE_OPTIONS|ELECTRON_RUN_AS_NODE|WB_MODEL)$|(?:SKIP|BYPASS|ALLOW_ALL|UNSAFE|PERMISSION)/i.test(name))) {
    throw Error('workbuddy.env_vars contains an unsupported reference.');
  }
  const profiles = object(wb.profiles, ['read-only', 'workspace-write'], 'workbuddy.profiles');
  if (Object.keys(profiles).length === 0 || Object.values(profiles).some(value => typeof value !== 'string' || !SAFE_KEY.test(value))) {
    throw Error('workbuddy.profiles requires at least one explicitly authorized existing permission profile.');
  }
  return {
    command, cwd, args: wb.args, envVars, profiles,
    arguments: fields(wb.arguments, ['task', 'cwd', 'profile', 'session', 'timeoutMs'], ['task', 'cwd', 'profile'], 'workbuddy.arguments'),
    statusFields: fields(wb.status_fields ?? { ready: 'ready', model: 'model' }, ['ready', 'model'], ['ready', 'model'], 'workbuddy.status_fields'),
    resultFields: fields(wb.result_fields ?? resultDefaults,
      ['status', 'model', 'taskId', 'sessionId', 'answer'], ['status', 'taskId', 'sessionId', 'answer'], 'workbuddy.result_fields')
  };
}

export function validateSolConfig(value, { poolConfig } = {}) {
  object(value, ['state_dir', 'pool_config', 'openai', 'limits', 'workbuddy'], 'coordinator configuration');
  const poolFilename = absolute(value.pool_config, 'pool_config');
  const pool = poolConfig ? validatePoolConfig(poolConfig) : loadPoolConfig(poolFilename);
  const workspaceRoot = existing(pool.workspace_root, 'workspace_root', 'directory');
  const stateDir = futurePath(absolute(value.state_dir, 'state_dir'));
  const protectedPaths = [workspaceRoot, pool.pool_root, contextDirFor(pool), runtimeBase()].map(futurePath);
  if (protectedPaths.some(dir => contains(dir, stateDir) || contains(stateDir, dir))) {
    throw Error('state_dir must be physically disjoint from the workspace, pool, pool contexts and legacy DSH runtimes.');
  }
  const openai = object(value.openai, ['model', 'reasoning_effort', 'credential_source', 'api_key_env', 'project_env', 'organization_env', 'response_model'], 'openai');
  if (typeof openai.model !== 'string' || !MODEL.test(openai.model) || (openai.response_model !== undefined
    && (typeof openai.response_model !== 'string' || !MODEL.test(openai.response_model)))) throw Error('An explicit OpenAI API model ID is required.');
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(openai.reasoning_effort)) throw Error('An explicit OpenAI reasoning_effort is required.');
  // Legacy files remain readable for subscription and existing task receipts.
  // Never resolve their environment references, even if those variables exist.
  const reservedEnv = [];
  if (openai.api_key_env !== undefined) reservedEnv.push(envName(openai.api_key_env, /API_KEY$/, 'openai.api_key_env'));
  if (openai.project_env !== undefined) reservedEnv.push(envName(openai.project_env, /PROJECT(?:_ID)?$/, 'openai.project_env'));
  if (openai.organization_env !== undefined) reservedEnv.push(envName(openai.organization_env, /(?:ORG|ORGANIZATION)(?:_ID)?$/, 'openai.organization_env'));
  if (openai.credential_source !== 'windows-broker' && !(reservedEnv.length && openai.credential_source === undefined)) {
    throw Error('openai.credential_source must be windows-broker.');
  }
  if (openai.credential_source && reservedEnv.length) throw Error('Remove legacy OpenAI environment references from the broker configuration.');
  const supplied = object(value.limits ?? {}, Object.keys(LIMITS), 'limits');
  const limits = Object.fromEntries(Object.entries(LIMITS).map(([key, [fallback, min, max]]) => {
    const number = supplied[key] ?? fallback;
    if (!Number.isSafeInteger(number) || number < min || number > max) throw Error(`limits.${key} must be ${min}..${max}.`);
    return [key, number];
  }));
  if (limits.max_delegations >= limits.max_responses) throw Error('limits.max_responses must leave room for acceptance after delegation.');
  const contextConfig = { ...pool, context_dir: path.join(stateDir, 'contexts') };
  return { stateDir, workspaceRoot, contextConfig, pool, openai, limits, reservedEnv, workbuddy: loadWorkBuddy(value.workbuddy, reservedEnv) };
}

export function loadSolConfig(filename) {
  const file = absolute(filename, '--config');
  if (fs.statSync(file).size > 128000) throw Error('Coordinator config is too large.');
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw Error('Coordinator config is unreadable or invalid JSON.'); }
  return validateSolConfig(config);
}

// Drop obsolete references at the process boundary without reading their values.
export function discardLegacyEnvironment(config, env = process.env) {
  for (const name of Object.keys(env)) {
    if (config.reservedEnv.includes(name.toUpperCase()) || openAIEnvName(name)) delete env[name];
  }
}
