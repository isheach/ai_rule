import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../dsh/core.mjs';

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const GOOGLE_KEY = /AIza[0-9A-Za-z_-]{25,}/;
const CONVERSATION = /^[a-z0-9-]{36}$/i;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const PROVIDERS = ['gemini-api-key', 'enterprise-adc'];
const HOST_ENV = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'LANG', 'LC_ALL', 'TZ']);
const AGENT = 'ai-rule-text';
const MAX_STDOUT = 512_000;

export class AntigravityError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function object(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key))) throw Error(`Invalid ${label}.`);
  return value;
}

function existing(value, isDirectory, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error(`${label} must be an absolute path.`);
  const canonical = fs.realpathSync(value);
  const stat = fs.statSync(canonical);
  if (isDirectory ? !stat.isDirectory() : !stat.isFile()) throw Error(`${label} has an unexpected type.`);
  return canonical;
}

function overlaps(a, b) {
  const contains = (from, to) => {
    const relative = path.relative(from, to);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return contains(a, b) || contains(b, a);
}

export function loadAntigravityConfig(input, protectedPaths) {
  if (input === undefined) return null;
  object(input, ['binary', 'runtime_dir', 'models_file', 'credential_source', 'adc_credentials_file'], 'antigravity configuration');
  const binary = existing(input.binary, false, 'antigravity.binary');
  if (process.platform === 'win32' && !/\.exe$/i.test(binary)) throw Error('antigravity.binary must be a Windows executable.');
  const runtimeDir = existing(input.runtime_dir, true, 'antigravity.runtime_dir');
  if (typeof input.models_file !== 'string' || !path.isAbsolute(input.models_file)) throw Error('antigravity.models_file must be absolute.');
  const modelsFile = path.join(existing(path.dirname(input.models_file), true, 'antigravity.models_file parent'), path.basename(input.models_file));
  if (!PROVIDERS.includes(input.credential_source)) throw Error('An explicitly configured Gemini API key or enterprise ADC route is required.');
  const adcFile = input.credential_source === 'enterprise-adc'
    ? existing(input.adc_credentials_file, false, 'antigravity.adc_credentials_file') : null;
  if (!adcFile && input.adc_credentials_file !== undefined) throw Error('adc_credentials_file requires enterprise-adc.');
  if (protectedPaths.some(dir => [runtimeDir, modelsFile, binary, adcFile].filter(Boolean).some(target => overlaps(dir, target)))
    || [modelsFile, binary, adcFile].filter(Boolean).some(target => overlaps(runtimeDir, target))) {
    throw Error('Antigravity runtime, executable, model settings and credentials must be outside the workspace and other service state.');
  }
  return Object.freeze({ binary, runtimeDir, modelsFile, credentialSource: input.credential_source, adcFile });
}

function readModels(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.size > 32_000 || fs.realpathSync(filename) !== filename) throw Error('Model settings must be a bounded regular file.');
  const doc = object(JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')), ['default_model', 'models'], 'Antigravity model settings');
  if (!doc.models || typeof doc.models !== 'object' || Array.isArray(doc.models)) throw Error('Antigravity models must be an object.');
  const entries = Object.entries(doc.models);
  if (!entries.length || entries.length > 100 || typeof doc.default_model !== 'string'
    || !Object.hasOwn(doc.models, doc.default_model)) throw Error('Set a default_model matching an approved model alias.');
  const models = new Map();
  for (const [alias, item] of entries) {
    object(item, ['id', 'effort'], 'Antigravity model option');
    if (!ALIAS.test(alias) || GOOGLE_KEY.test(alias) || typeof item.id !== 'string' || !MODEL.test(item.id) || GOOGLE_KEY.test(item.id)
      || (item.effort !== undefined && !EFFORTS.includes(item.effort))) throw Error('Invalid Antigravity alias, model slug, or effort.');
    models.set(alias, Object.freeze({ alias, id: item.id, effort: item.effort ?? null }));
  }
  return { models, defaultAlias: doc.default_model };
}

export function antigravityModels(config) {
  if (!config) throw new AntigravityError('ANTIGRAVITY_NOT_CONFIGURED', 'The host has no configured Antigravity text entry.');
  try { return readModels(config.modelsFile); }
  catch { throw new AntigravityError('ANTIGRAVITY_MODEL_CONFIG_INVALID', 'Inspect the host model settings file and its default alias.'); }
}

function authEnvironment(config, env) {
  if (config.credentialSource === 'gemini-api-key') {
    if (!env.GEMINI_API_KEY?.trim()) throw new AntigravityError('ANTIGRAVITY_AUTH_MISSING', 'The selected host Gemini API key route is not configured.');
    return { GEMINI_API_KEY: env.GEMINI_API_KEY };
  }
  if (fs.realpathSync(config.adcFile) !== config.adcFile) throw Error('The approved ADC credential file changed location.');
  return { AGY_ADC_AUTH: 'true', GOOGLE_APPLICATION_CREDENTIALS: config.adcFile };
}

export function antigravityStatus(config, env = process.env) {
  if (!config) return { configured: false, ready: null, code: 'ANTIGRAVITY_NOT_CONFIGURED' };
  try {
    const { models, defaultAlias } = antigravityModels(config);
    authEnvironment(config, env);
    return { configured: true, ready: null, credential_source: config.credentialSource,
      default_model: defaultAlias, configured_models: [...models.values()], live_model_access: 'unverified' };
  } catch (error) {
    return { configured: true, ready: false, credential_source: config.credentialSource,
      code: error instanceof AntigravityError ? error.code : 'ANTIGRAVITY_AUTH_UNVERIFIED' };
  }
}

function prepare(config, env) {
  if (fs.realpathSync(config.runtimeDir) !== config.runtimeDir || fs.realpathSync(config.binary) !== config.binary) {
    throw new AntigravityError('ANTIGRAVITY_HOST_PATH_CHANGED', 'Inspect the Antigravity binary or runtime path on its host.');
  }
  for (let directory = config.runtimeDir;; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, '.git'))) {
      throw new AntigravityError('ANTIGRAVITY_RUNTIME_IN_GIT', 'Use a dedicated Antigravity runtime outside Git worktrees.');
    }
    if (path.dirname(directory) === directory) break;
  }
  const auth = authEnvironment(config, env);
  const directory = fs.mkdtempSync(path.join(config.runtimeDir, 'text-'));
  try {
    const cwd = path.join(directory, 'workspace');
    const home = path.join(directory, 'profile');
    const agents = path.join(cwd, '.agents', 'agents', AGENT);
    const settings = path.join(home, '.gemini', 'antigravity-cli');
    fs.mkdirSync(agents, { recursive: true, mode: 0o700 });
    fs.mkdirSync(settings, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(agents, 'agent.md'), [
      '---', `name: ${AGENT}`, 'description: Return text from the supplied input.',
      'mainAgent: true', 'subagent: false', 'tools: []', 'skills: []', 'plugins: []', 'mcpServers: []',
      'commandExecutionPolicy: off', '---', 'Answer in text using only the supplied material.'
    ].join('\n') + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(settings, 'settings.json'), JSON.stringify({
      toolPermission: 'strict', allowNonWorkspaceAccess: false, useG1Credits: false,
      ...(config.credentialSource === 'gemini-api-key' ? { modelProvider: 'gemini' } : {}),
      permissions: { deny: ['read_file(*)', 'write_file(*)', 'command(*)', 'mcp(*)', 'read_url(*)', 'execute_url(*)'] }
    }), { mode: 0o600 });
    const explicitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => HOST_ENV.has(key.toUpperCase())));
    return { directory, cwd, env: { ...explicitEnv, ...auth, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home, TMP: directory, TEMP: directory, TMPDIR: directory, NO_COLOR: '1' } };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function runProcess(binary, args, workspace, { signal, timeoutMs, spawnProcess, onLine }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AntigravityError('ANTIGRAVITY_STOPPED', 'Antigravity was stopped before invocation.'));
    const child = spawnProcess(binary, args, {
      cwd: workspace.cwd, env: workspace.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
    });
    let failure, output = '', total = 0;
    const stop = cause => {
      if (failure) return;
      failure = cause;
      child.kill('SIGKILL');
    };
    const aborted = () => stop(new AntigravityError('ANTIGRAVITY_STOPPED', 'The original Antigravity process was stopped.'));
    const timer = setTimeout(() => stop(new AntigravityError('ANTIGRAVITY_TIMEOUT', 'The original Antigravity call exceeded its time budget.')), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    const consume = line => {
      if (!failure && onLine && line.trim()) {
        try { onLine(JSON.parse(line), child.stdin); }
        catch (error) { stop(error instanceof AntigravityError ? error
          : new AntigravityError('ANTIGRAVITY_PROTOCOL_ERROR', 'The CLI returned an invalid stream event.')); }
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      total += Buffer.byteLength(chunk);
      if (total > MAX_STDOUT) return stop(new AntigravityError('ANTIGRAVITY_OUTPUT_LIMIT', 'The CLI exceeded its output limit.'));
      output += chunk;
      if (onLine) {
        for (let end; (end = output.indexOf('\n')) >= 0;) {
          consume(output.slice(0, end));
          output = output.slice(end + 1);
        }
      }
    });
    child.stdin.on('error', () => stop(new AntigravityError('ANTIGRAVITY_INPUT_CLOSED', 'The CLI input closed before its response was confirmed.')));
    child.once('error', () => stop(new AntigravityError('ANTIGRAVITY_PROCESS_ERROR', 'The host failed to start Antigravity.')));
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (onLine) consume(output);
      if (failure) reject(failure);
      else resolve({ code, output });
    });
    if (!onLine) child.stdin.end();
  });
}

function safeVendorText(value, key) {
  const sanitized = redact(value).replace(/AIza[0-9A-Za-z_-]{25,}/g, '<redacted>');
  return key ? sanitized.replaceAll(key, '<redacted>') : sanitized;
}

function catalogOf(text, key) {
  const result = new Map();
  for (const line of text.trim().split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = line.trim().match(/^(\S+)(?: {2,}|\t+)(\S.*)$/);
    if (!row || !MODEL.test(row[1]) || GOOGLE_KEY.test(row[1]) || (key && row[1].includes(key)) || result.has(row[1])) {
      throw new AntigravityError('ANTIGRAVITY_CATALOG_UNVERIFIED', 'The CLI did not return the documented model-slug list format.');
    }
    result.set(row[1], safeVendorText(row[2], key).slice(0, 200));
  }
  if (!result.size) throw new AntigravityError('ANTIGRAVITY_CATALOG_UNVERIFIED', 'The CLI model directory is empty.');
  return result;
}

async function probe(config, workspace, options) {
  const versionResult = await runProcess(config.binary, ['--version'], workspace, options);
  const version = versionResult.output.trim().match(/^(?:(?:agy|Antigravity(?: CLI)?)(?: version)?[ \t]+)?v?(\d+)\.(\d+)\.(\d+)(?:[ \t]+[^\r\n]+)?$/i);
  if (versionResult.code !== 0 || !version || Number(version[1]) !== 1 || Number(version[2]) < 5) {
    throw new AntigravityError('ANTIGRAVITY_VERSION_UNVERIFIED', 'A compatible Antigravity 1.5 or later 1.x CLI is required.');
  }
  const catalog = await runProcess(config.binary, ['models'], workspace, options);
  if (catalog.code !== 0) throw new AntigravityError('ANTIGRAVITY_CATALOG_UNAVAILABLE', 'The selected Antigravity host could not list models.');
  return { version: version.slice(1).join('.'), catalog: catalogOf(catalog.output, workspace.env.GEMINI_API_KEY) };
}

function cleanup(directory) {
  try { fs.rmSync(directory, { recursive: true, force: true }); }
  catch { /* Keep the isolated data directory for local inspection. */ }
}

export async function listAntigravityModels(config, { env = process.env, spawnProcess = spawn } = {}) {
  if (!config) throw new AntigravityError('ANTIGRAVITY_NOT_CONFIGURED', 'The host has no configured Antigravity text entry.');
  let models = new Map(), defaultAlias = null, modelConfigIssue = null;
  try { ({ models, defaultAlias } = antigravityModels(config)); }
  catch (error) { modelConfigIssue = error.code; }
  const workspace = prepare(config, env);
  try {
    const { version, catalog } = await probe(config, workspace, { timeoutMs: 15000, spawnProcess });
    return { configured: true, ready: null, credential_source: config.credentialSource, version, default_model: defaultAlias,
      available_models: Array.from(catalog, ([id, name]) => ({ id, name })),
      configured_models: [...models.values()].map(model => ({ ...model, available: catalog.has(model.id) })),
      model_config_issue: modelConfigIssue,
      evidence_source: 'agy models', live_model_access: 'unverified' };
  } finally { cleanup(workspace.directory); }
}

export async function runAntigravityText(config, { model, prompt, signal, timeoutMs, onSubmitted, env = process.env, spawnProcess = spawn }) {
  const workspace = prepare(config, env);
  try {
    const deadline = Date.now() + timeoutMs;
    const { version, catalog } = await probe(config, workspace, { signal, timeoutMs: Math.min(timeoutMs, 15000), spawnProcess });
    if (!catalog.has(model.id)) throw new AntigravityError('ANTIGRAVITY_MODEL_UNAVAILABLE', 'The selected slug is absent from this host account’s model listing.');
    let init, result;
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'default',
      '--disable-slash-commands', '--agent', AGENT, '--model', model.id];
    if (model.effort) args.push('--effort', model.effort);
    const exit = await runProcess(config.binary, args, workspace, {
      signal, timeoutMs: Math.max(1, deadline - Date.now()), spawnProcess,
      onLine(event, stdin) {
        if (!init) {
          const startup = event?.init;
          if (event?.event !== 'init' || !CONVERSATION.test(event.conversation_id ?? '') || startup?.agent !== AGENT
            || startup.permission_mode !== 'strict' || !Array.isArray(startup.tools) || startup.tools.length !== 0
            || ![model.id, catalog.get(model.id)].includes(startup.model) || typeof startup.cwd !== 'string'
            || path.relative(workspace.cwd, startup.cwd) !== '') {
            throw new AntigravityError('ANTIGRAVITY_TEXT_BOUNDARY_UNVERIFIED', 'The CLI did not confirm the text-only agent, strict permissions, selected model and isolated directory. No task text was sent.');
          }
          init = { conversation_id: event.conversation_id, cli_selected_model: startup.model, version };
          onSubmitted(init);
          stdin.end(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
          return;
        }
        if (!result && event?.event === 'result') {
          result = event.result;
          return;
        }
        if (result || event?.event !== 'step_update'
          || !['user_input', 'agent_response', 'checkpoint'].includes(event.step_update?.step_type)
          || event.step_update.tool_info || event.step_update.subagent_info) {
          throw new AntigravityError('ANTIGRAVITY_NON_TEXT_EVENT', 'The CLI emitted an action or unexpected event; inspect the original receipt.');
        }
      }
    });
    if (exit.code !== 0 || !init || result?.conversation_id !== init.conversation_id || result.status !== 'SUCCESS'
      || result.finished_reason || (result.denied_actions && (!Array.isArray(result.denied_actions) || result.denied_actions.length))
      || typeof result.response !== 'string' || !result.response.trim()) {
      throw new AntigravityError('ANTIGRAVITY_RESULT_UNVERIFIED', 'The original Antigravity CLI run did not return a complete text result.');
    }
    const response = safeVendorText(result.response, workspace.env.GEMINI_API_KEY);
    const usage = result.usage && Object.fromEntries(['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens']
      .filter(key => Number.isSafeInteger(result.usage[key]) && result.usage[key] >= 0).map(key => [key, result.usage[key]]));
    return { ...init, response, usage: usage && Object.keys(usage).length ? usage : null };
  } finally { cleanup(workspace.directory); }
}
