import fs from 'node:fs';
import path from 'node:path';
import { discoverDsh, pathKey, runtimeForInstance } from '../bridges/dsh/core.mjs';
import { loadSchedule } from '../bridges/dsh/schedule.mjs';
import { loadPoolConfig, validatePoolConfig } from '../bridges/pool/service.mjs';
import { contains, loadSolConfig, SERVICE as SOL_SERVER, validateSolConfig } from '../bridges/sol/config.mjs';

export { SOL_SERVER };

function tableKey(name) {
  return `(?:${name}|"${name}"|'${name}')`;
}

function serverKey(name) {
  return tableKey('mcp_servers') + '[\\t ]*\\.[\\t ]*' + tableKey(name);
}

export function findMcpRegistration(toml, name) {
  const header = new RegExp('^[\\t ]*\\[[\\t ]*' + serverKey(name) + '[\\t ]*\\][\\t ]*(?:#.*)?$', 'gm');
  const matches = [...toml.matchAll(header)];
  if (matches.length > 1) throw Error('Duplicate MCP registration for ' + name + '.');
  if (!matches.length) return null;
  return toml.slice(matches[0].index + matches[0][0].length).split(/^[\t ]*\[/m, 1)[0];
}

export function tomlStringArray(section, key) {
  const field = new RegExp('^\\s*' + key + '\\s*=\\s*(\\[.*)$');
  const lines = section.split(/\r?\n/);
  const start = lines.findIndex(line => field.test(line));
  if (start < 0) return null;
  let literal = lines[start].match(field)[1];
  for (let i = start + 1; i < lines.length && !literal.trimEnd().endsWith(']'); i++) literal += lines[i];
  try {
    const value = JSON.parse(literal.replace(/,\s*\]$/, ']'));
    return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : null;
  } catch {
    return null;
  }
}

export function tomlString(section, key) {
  const value = section.match(new RegExp('^[\\t ]*' + key + '\\s*=\\s*(.+)$', 'm'))?.[1];
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return value?.match(/^'([^']+)'$/)?.[1] ?? null;
  }
}

export function isNodeCommand(executable) {
  return typeof executable === 'string' && /^node(?:\.exe)?$/i.test(path.basename(executable));
}

export function hasInlineEnv(toml, section, name) {
  const table = new RegExp('^[\\t ]*\\[[\\t ]*' + serverKey(name) + '[\\t ]*\\.[\\t ]*' + tableKey('env') + '[\\t ]*\\]', 'm');
  return /^[\t ]*env\s*=/m.test(section) || table.test(toml);
}

function standardRegistrationArgs(toml, name, directory, valueFlags) {
  const section = findMcpRegistration(toml, name);
  if (section === null) return null;
  const args = tomlStringArray(section, 'args');
  const supported = args && path.isAbsolute(args[0] || '')
    && path.basename(args[0]) === 'server.mjs' && path.basename(path.dirname(args[0])) === directory
    && isNodeCommand(tomlString(section, 'command')) && !hasInlineEnv(toml, section, name)
    && !/^[\t ]*(?:enabled\s*=\s*false\b|env_vars\s*=)/m.test(section);
  const refuse = () => Error('Cannot safely inherit ' + name + '. Supply --sol-coordinator-config.');
  if (!supported) throw refuse();
  const flags = new Map();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flags.has(flag)) throw refuse();
    if (flag === '--read-only' || flag === '--allow-write') flags.set(flag, true);
    else if (valueFlags.includes(flag) && path.isAbsolute(args[i + 1] || '')) flags.set(flag, args[++i]);
    else if (flag === '--instance' && directory === 'dsh' && args[i + 1] === 'default') flags.set(flag, args[++i]);
    else throw refuse();
  }
  if (flags.has('--read-only') && flags.has('--allow-write')) throw refuse();
  return flags;
}

function existingAbsolute(value, label) {
  if (!path.isAbsolute(value || '') || !fs.existsSync(value)) throw Error(label + ' must be an existing absolute path.');
  return fs.realpathSync(value);
}

function validateCalendar(config) {
  const schedule = loadSchedule(config.pool.schedule_config);
  if (!schedule.enabled || !schedule.hardStopAtPeak || schedule.resumeAutomatically) {
    throw Error('The Sol DSH calendar must be enabled, with peak hard stop and no automatic resume.');
  }
  return config;
}

export function solEnvironmentNames(config) {
  return [...new Set(['CODEX_HOME', ...(config.workbuddy?.envVars ?? [])])];
}

function existingRegistration(filename) {
  const current = validateCalendar(loadSolConfig(filename));
  if (current.openai.credential_source === 'windows-broker') return { files: [], filename, config: current };
  if (current.openai.project_env || current.openai.organization_env) {
    throw Error('Preserve the existing project/organization in broker installation policy, then replace the legacy openai environment references with credential_source="windows-broker" in the local JSON.');
  }
  const value = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  delete value.openai.api_key_env;
  value.openai.credential_source = 'windows-broker';
  return { filename, config: validateCalendar(validateSolConfig(value)), files: [{ file: filename, data: JSON.stringify(value, null, 2) + '\n' }] };
}

export function buildSolRegistration({ toml, plannedDsh, codexHome, repo, explicit, workspace, model, effort, dshEntry }) {
  if (explicit) {
    if (workspace || model || effort) throw Error('Choose either --sol-coordinator-config or the three generation options.');
    const filename = existingAbsolute(explicit, '--sol-coordinator-config');
    return existingRegistration(filename);
  }
  if (!workspace || !model || !effort) throw Error('Generating a Sol config requires --sol-workspace-root, --sol-model and --sol-reasoning-effort.');
  const workspaceRoot = existingAbsolute(workspace, '--sol-workspace-root');
  if (!fs.statSync(workspaceRoot).isDirectory()) throw Error('--sol-workspace-root must be a directory.');
  const solDir = path.join(codexHome, 'ai-rule-sol');
  const filename = path.join(solDir, 'coordinator.local.json');
  if (fs.existsSync(filename)) {
    const current = validateCalendar(loadSolConfig(filename));
    if (current.openai.model !== model || current.openai.reasoning_effort !== effort || pathKey(current.workspaceRoot) !== pathKey(workspaceRoot)) {
      throw Error('The existing Sol config has different choices. Review it locally and use --sol-coordinator-config.');
    }
    return existingRegistration(filename);
  }
  const files = [];
  let poolFile, pool;
  const poolFlags = standardRegistrationArgs(toml, 'dsh-root-pool', 'pool', ['--config']);
  if (poolFlags) {
    poolFile = existingAbsolute(poolFlags.get('--config'), 'Registered pool config');
    pool = loadPoolConfig(poolFile);
    if (pathKey(pool.workspace_root) !== pathKey(workspaceRoot) || (poolFlags.has('--read-only') && pool.allow_write)) {
      throw Error('The existing root-pool workspace or write cap differs from the requested scope. Supply --sol-coordinator-config.');
    }
  } else {
    const legacy = standardRegistrationArgs(plannedDsh ?? toml, 'dsh-opencode-go', 'dsh', ['--dsh-entry', '--schedule-config', '--runtime']);
    const cli = discoverDsh(dshEntry || legacy?.get('--dsh-entry'));
    if (!cli.prefix[0]) throw Error('The Sol DSH pool requires the installed JavaScript CLI. Pass --dsh-entry.');
    poolFile = path.join(solDir, 'pool.local.json');
    if (fs.existsSync(poolFile)) throw Error('A local Sol DSH pool config already exists. Review it and reference it in --sol-coordinator-config.');
    const legacyRuntime = pathKey(legacy?.get('--runtime') || runtimeForInstance());
    const target = pathKey(solDir);
    if (contains(legacyRuntime, target) || contains(target, legacyRuntime)) {
      throw Error('Generated Sol state overlaps the original DSH runtime. Supply --sol-coordinator-config.');
    }
    pool = validatePoolConfig({
      pool_root: path.join(solDir, 'pool'), workspace_root: workspaceRoot, dsh_entry: cli.prefix[0],
      schedule_config: legacy?.get('--schedule-config') || path.join(repo, 'config', 'offpeak.schedule.json'),
      allow_write: !legacy?.has('--read-only')
    });
    files.push({ file: poolFile, data: JSON.stringify(pool, null, 2) + '\n' });
  }
  const value = {
    state_dir: path.join(solDir, 'state'), pool_config: poolFile,
    openai: { model, reasoning_effort: effort, credential_source: 'windows-broker' }
  };
  const config = validateCalendar(validateSolConfig(value, { poolConfig: pool }));
  files.push({ file: filename, data: JSON.stringify(value, null, 2) + '\n' });
  return { files, filename, config };
}

export function solRegistrationStatus({ managedSection, outside, bridgeEntry }) {
  if (!managedSection) {
    return { registered: findMcpRegistration(outside, SOL_SERVER) !== null, managed: false, structure_valid: null };
  }
  try {
    const section = findMcpRegistration(managedSection, SOL_SERVER);
    const args = tomlStringArray(section, 'args');
    const env = tomlStringArray(section, 'env_vars');
    const command = tomlString(section, 'command');
    const cwd = tomlString(section, 'cwd');
    if (findMcpRegistration(outside, SOL_SERVER) !== null || !isNodeCommand(command) || !path.isAbsolute(command)
      || !fs.statSync(command).isFile() || !cwd || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()
      || args?.length !== 3 || !path.isAbsolute(args[0]) || args[1] !== '--config'
      || pathKey(args[0]) !== pathKey(bridgeEntry) || !fs.existsSync(bridgeEntry)) throw Error('registration');
    const config = validateCalendar(loadSolConfig(args[2]));
    const expectedEnv = solEnvironmentNames(config).sort();
    const valid = config.openai.credential_source === 'windows-broker' && JSON.stringify(env?.sort()) === JSON.stringify(expectedEnv)
      && !hasInlineEnv(managedSection, section, SOL_SERVER) && !/^[\t ]*enabled\s*=\s*false\b/m.test(section);
    return { registered: true, managed: true, structure_valid: valid };
  } catch {
    return { registered: true, managed: true, structure_valid: false };
  }
}
