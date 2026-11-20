#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { discoverDsh, preflight, VERSION, INSTANCE_DEFAULT, INSTANCE_SERVER_PREFIX, validateInstanceName, runtimeForInstance, serverNameForInstance, instanceFromServerName, pathKey } from '../bridges/dsh/core.mjs';
import { WORKBUDDY_DSF } from '../bridges/workbuddy/dispatch.mjs';
import { loadProjectConfig, PROJECT_SERVER_ENTRY } from '../bridges/workbuddy/project-config.mjs';
import {
  buildSolRegistration, findMcpRegistration, hasInlineEnv, isNodeCommand, solEnvironmentNames, solRegistrationStatus,
  tomlString, tomlStringArray, SOL_SERVER
} from './sol-install.mjs';

const MANAGED_START = '# BEGIN isheach/ai_rule managed';
const MANAGED_END = '# END isheach/ai_rule managed';
const DSH_SERVER = INSTANCE_SERVER_PREFIX;
const DSF_SERVER = WORKBUDDY_DSF.server_name;
const SKILL_NAME = 'multi-agent-dispatch';
const SKILL_MARKER = '<!-- ai-rule-managed:';
const TOOL_TIMEOUT_SECONDS = 3700;
const MCP_TABLE = String.raw`(?:mcp_servers|"mcp_servers"|'mcp_servers')`;
const DSF_KEY = `(?:${DSF_SERVER}|"${DSF_SERVER}"|'${DSF_SERVER}')`;
export function mergeBlock(original, content, kind) {
  const start = kind === 'toml' ? MANAGED_START : '<!-- BEGIN isheach/ai_rule managed -->';
  const end = kind === 'toml' ? MANAGED_END : '<!-- END isheach/ai_rule managed -->';
  const a = original.indexOf(start), b = original.indexOf(end);
  if ((a < 0) !== (b < 0) || (a >= 0 && (b < a || original.indexOf(start, a + start.length) >= 0 || original.indexOf(end, b + end.length) >= 0))) throw Error('Malformed or duplicate managed blocks; refusing automatic edits.');
  const block = `${start}\n${content.trim()}\n${end}`;
  if (a >= 0) return original.slice(0, a) + block + original.slice(b + end.length);
  return original + (original.endsWith('\n') || !original ? '' : '\n') + (original ? '\n' : '') + block + '\n';
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : '';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function assertSkillDirectories(directory) {
  const skills = path.dirname(directory);
  for (const candidate of [path.dirname(skills), skills, directory, path.join(directory, 'references')]) {
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw Error(`Managed Skill path must be a directory without symbolic links: ${candidate}`);
  }
}

function skillFilesFor(home) {
  const source = path.join(repo, 'skills', SKILL_NAME);
  const directory = path.resolve(home, '.agents', 'skills', SKILL_NAME);
  assertSkillDirectories(directory);
  const references = fs.readdirSync(path.join(source, 'references'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => path.join('references', entry.name))
    .sort();
  const files = ['SKILL.md', ...references].map(relative => {
    const file = path.join(directory, relative);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw Error(`Managed Skill path must be a regular file: ${file}`);
    return { file, data: read(path.join(source, relative)) };
  });
  return { directory, files };
}
function option(args, name) { const i = args.indexOf(name); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing value for ${name}`); return args[i + 1]; }
function optionValues(args, name) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing value for ${name}`);
    values.push(args[i + 1]);
  }
  return values;
}
function managedParts(original) {
  const a = original.indexOf(MANAGED_START), b = original.indexOf(MANAGED_END);
  if ((a < 0) !== (b < 0) || (a >= 0 && (b < a || original.indexOf(MANAGED_START, a + MANAGED_START.length) >= 0 || original.indexOf(MANAGED_END, b + MANAGED_END.length) >= 0))) {
    throw Error('Malformed or duplicate managed blocks; refusing automatic edits.');
  }
  const block = a >= 0 ? original.slice(a, b + MANAGED_END.length) : '';
  const body = block ? block.split('\n').slice(1, -1).join('\n') : '';
  const sections = body ? body.split(/(?=^\[mcp_servers\.[^\].]+\]\s*$)/m).filter(x => x.trim()) : [];
  for (const section of sections) {
    if (!/^\[mcp_servers\.[^\].]+\]\s*$/m.test(section)) throw Error('Unknown content in the managed TOML block; refusing automatic edits.');
  }
  return { block, sections, outside: block ? original.replace(block, '') : original };
}
function sectionName(section) { return section.match(/^\[mcp_servers\.([^\].]+)\]/m)?.[1]; }
function mcpSection(name, args, environmentNames = []) {
  const environment = environmentNames.length ? `env_vars = ${JSON.stringify(environmentNames)}\n` : '';
  return `[mcp_servers.${name}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(args)}\n${environment}cwd = ${JSON.stringify(repo)}\nstartup_timeout_sec = 30\ntool_timeout_sec = ${TOOL_TIMEOUT_SECONDS}\nenabled = true\n`;
}
function tomlArray(section) {
  const lines = section.split(/\r?\n/);
  const start = lines.findIndex(line => /^\s*args\s*=\s*\[/.test(line));
  if (start < 0) return null;
  let text = lines[start].replace(/^\s*args\s*=\s*/, '');
  for (let i = start + 1; !text.includes(']') && i < lines.length; i++) text += lines[i];
  try { const value = JSON.parse(text); return Array.isArray(value) ? value : null; } catch { return null; }
}
function argValue(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

function removeLegacyWorkBuddy(toml) {
  // Accept the standard table forms only. A multiline string can contain
  // table-looking text, so leave unusual files for a deliberate local edit.
  if (toml.includes('"""') || toml.includes("'''")) {
    throw Error('The existing config has multiline TOML strings. Back it up and remove the old WorkBuddy DSF entry locally before installing the project entry.');
  }
  const tableName = new RegExp(`^${MCP_TABLE}[\\t ]*\\.[\\t ]*${DSF_KEY}(?:[\\t ]*\\.|[\\t ]*$)`);
  const tables = [...toml.matchAll(/^[\t ]*\[\[?([^\]\r\n]+)\]\]?[\t ]*(?:#[^\r\n]*)?\r?$/gm)];
  let result = toml;
  for (let index = tables.length - 1; index >= 0; index--) {
    const section = tables[index];
    if (!tableName.test(section[1].trim())) continue;
    const next = tables[index + 1]?.index ?? toml.length;
    const body = toml.slice(section.index + section[0].length, next);
    // Keep trailing comments and whitespace associated with the next table,
    // including our managed block marker when it follows this service.
    const tail = body.match(/(?:\r?\n[\t ]*(?:#[^\r\n]*)?)+\s*$/)?.[0] ?? '';
    result = result.slice(0, section.index) + tail.replace(/^\r?\n/, '') + result.slice(next);
  }
  return result;
}

function assertStandardWorkBuddyRegistration(toml) {
  const assignment = new RegExp(`^[\\t ]*(?:${MCP_TABLE}[\\t ]*\\.[\\t ]*)?${DSF_KEY}[\\t ]*[.=]`, 'm');
  const inline = new RegExp(`^[\\t ]*${MCP_TABLE}[\\t ]*=[\\t ]*\\{[^\\r\\n]*${DSF_KEY}[\\t ]*=`, 'm');
  if (assignment.test(toml) || inline.test(toml)) {
    throw Error('The existing WorkBuddy DSF registration uses an unsupported TOML form. Back it up and remove that service locally before installing the project entry.');
  }
}

function projectRegistrationStatus(section) {
  const args = section && tomlStringArray(section, 'args');
  if (!args || !path.isAbsolute(args[0] ?? '') || pathKey(args[0]) !== pathKey(PROJECT_SERVER_ENTRY)) return null;
  try {
    const command = tomlString(section, 'command');
    const cwd = tomlString(section, 'cwd');
    if (!isNodeCommand(command) || !path.isAbsolute(command) || !fs.statSync(command).isFile() ||
      !cwd || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory() || !fs.statSync(PROJECT_SERVER_ENTRY).isFile() ||
      args.length !== 3 || args[1] !== '--config' || hasInlineEnv(section, section, DSF_SERVER) ||
      /^[\t ]*(?:enabled\s*=\s*false\b|env_vars\s*=)/m.test(section)) {
      throw Error('The WorkBuddy project registration has invalid transport settings.');
    }
    loadProjectConfig(args[2]);
    return { structure_valid: true };
  } catch { return { structure_valid: false }; }
}

const solBridge = path.join(repo, 'bridges', 'sol', 'server.mjs');

export function buildPlan({
  home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex'),
  enableDsh = false, dshEntry, allowWrite = false, readOnly = false, workbuddyBridge, workbuddyProjectConfig, replaceWorkBuddyDsf = false,
  offpeakSchedule = false, disableOffpeakSchedule = false, dshInstances = [], removeDshInstances = [],
  solCoordinatorConfig, solWorkspaceRoot, solModel, solReasoningEffort
} = {}) {
  codexHome = path.resolve(codexHome);
  if (allowWrite && readOnly) throw Error('Cannot combine --allow-write and --read-only.');
  if ((allowWrite || readOnly) && !enableDsh) throw Error('DSH permission options require --enable-dsh.');
  if (workbuddyBridge && workbuddyProjectConfig) throw Error('Install the legacy WorkBuddy bridge and the DSF project entry separately.');
  if (replaceWorkBuddyDsf && !workbuddyProjectConfig) throw Error('--replace-workbuddy-dsf requires --workbuddy-project-config.');
  const permissionArgs = previous => {
    if (readOnly || (!allowWrite && previous?.includes('--read-only'))) return ['--read-only'];
    if (allowWrite || previous?.includes('--allow-write')) return ['--allow-write'];
    return [];
  };
  if (!Array.isArray(dshInstances) || !Array.isArray(removeDshInstances)) throw Error('DSH instance options must be lists.');
  const addNames = dshInstances.map(validateInstanceName);
  const removeNames = removeDshInstances.map(validateInstanceName);
  if (new Set(addNames).size !== addNames.length) throw Error('Duplicate --dsh-instance value; each named instance may be registered once.');
  if (new Set(removeNames).size !== removeNames.length) throw Error('Duplicate --remove-dsh-instance value.');
  for (const name of addNames) if (removeNames.includes(name)) throw Error(`DSH instance "${name}" cannot be added and removed in the same operation.`);
  if (addNames.length && !enableDsh) throw Error('--dsh-instance requires --enable-dsh so the default service and CLI preflight are handled together.');
  const override = path.join(codexHome, 'AGENTS.override.md');
  const agentsPath = read(override).trim() ? override : path.join(codexHome, 'AGENTS.md');
  const { directory: skillDirectory, files: skillFiles } = skillFilesFor(home);
  for (const { file, data } of skillFiles) {
    const current = read(file);
    if (current.trim() && current !== data && !current.includes(SKILL_MARKER)) {
      throw Error(`Existing unrelated Skill file would be overwritten: ${file}`);
    }
  }
  const plan = [
    { file: agentsPath, data: mergeBlock(read(agentsPath), read(path.join(repo, 'AGENTS.md')), 'markdown') },
    ...skillFiles
  ];
  let modelCheck = null;
  const configFile = path.join(codexHome, 'config.toml');
  let original = read(configFile);
  const project = workbuddyProjectConfig ? loadProjectConfig(workbuddyProjectConfig) : null;
  if (project) {
    const old = managedParts(original);
    assertStandardWorkBuddyRegistration(original);
    // Call the standard lookup on the whole file too, to detect duplicates.
    findMcpRegistration(original, DSF_SERVER);
    const external = findMcpRegistration(old.outside, DSF_SERVER);
    const managed = old.sections.find(section => sectionName(section) === DSF_SERVER);
    if (external !== null || (managed && !projectRegistrationStatus(managed))) {
      if (!replaceWorkBuddyDsf) throw Error('Existing WorkBuddy DSF service requires explicit --replace-workbuddy-dsf for the one-time project entry migration.');
      if (external !== null) original = removeLegacyWorkBuddy(original);
    }
  }
  const existing = managedParts(original);
  const oldDefaultSection = existing.sections.find(section => sectionName(section) === DSH_SERVER);
  const oldDefaultArgs = oldDefaultSection ? tomlArray(oldDefaultSection) : null;
  const unmanagedDefault = new RegExp(`^\\s*\\[mcp_servers\\.(?:"${DSH_SERVER}"|${DSH_SERVER})\\]`, 'm').test(existing.outside);
  const preserveDefault = enableDsh && addNames.length > 0 && Boolean(oldDefaultSection || unmanagedDefault);
  const parts = [];
  const dshPlan = [];
  const preservedServices = [];
  if (offpeakSchedule && disableOffpeakSchedule) throw Error('Cannot set and clear the schedule calendar simultaneously.');
  if ((offpeakSchedule || disableOffpeakSchedule) && !enableDsh) throw Error('Schedule options require --enable-dsh.');
  if (preserveDefault && (offpeakSchedule || disableOffpeakSchedule)) throw Error('Adding named instances preserves the existing default calendar. Change its registration with a separate --enable-dsh command without --dsh-instance.');
  const previousManaged = original.match(/# BEGIN isheach\/ai_rule managed[\s\S]*?# END isheach\/ai_rule managed/)?.[0] || '';
  const useSchedule = !disableOffpeakSchedule && (offpeakSchedule || previousManaged.includes('--schedule-config'));
  if (enableDsh) {
    const cli = discoverDsh(dshEntry);
    modelCheck = preflight(cli);
    const bridge = path.join(repo, 'bridges', 'dsh', 'server.mjs');
    const inheritedEntry = oldDefaultArgs ? argValue(oldDefaultArgs, '--dsh-entry') : undefined;
    const cliEntry = dshEntry ? cli.prefix[0] : (inheritedEntry || cli.prefix[0]);
    const inheritedSchedule = oldDefaultArgs ? argValue(oldDefaultArgs, '--schedule-config') : undefined;
    const schedulePath = useSchedule ? ((!offpeakSchedule && inheritedSchedule) || path.join(repo, 'config', 'offpeak.schedule.json')) : null;
    if (!preserveDefault) {
      const runtime = oldDefaultArgs ? argValue(oldDefaultArgs, '--runtime') : undefined;
      const common = [
        ...(cliEntry ? ['--dsh-entry', cliEntry] : []), ...(runtime ? ['--runtime', runtime] : []),
        ...permissionArgs(oldDefaultArgs), ...(schedulePath ? ['--schedule-config', schedulePath] : [])
      ];
      parts.push(mcpSection(DSH_SERVER, [bridge, ...common]));
      dshPlan.push({ instance: INSTANCE_DEFAULT, server: DSH_SERVER, runtime: runtime || runtimeForInstance(INSTANCE_DEFAULT) });
    } else if (oldDefaultSection) {
      dshPlan.push({ instance: INSTANCE_DEFAULT, server: DSH_SERVER, preserved: true,
        runtime: (oldDefaultArgs && argValue(oldDefaultArgs, '--runtime')) || runtimeForInstance(INSTANCE_DEFAULT) });
    } else {
      preservedServices.push({ name: DSH_SERVER, reason: 'unmanaged default service preserved' });
    }
    for (const name of addNames) {
      const server = serverNameForInstance(name);
      const previous = existing.sections.find(section => sectionName(section) === server);
      const previousArgs = previous ? tomlArray(previous) : null;
      const runtime = previousArgs ? argValue(previousArgs, '--runtime') : undefined;
      const args = [
        bridge, '--instance', name, ...(cliEntry ? ['--dsh-entry', cliEntry] : []),
        ...(runtime ? ['--runtime', runtime] : []), ...permissionArgs(previousArgs),
        ...(schedulePath ? ['--schedule-config', schedulePath] : [])
      ];
      parts.push(mcpSection(server, args));
      dshPlan.push({ instance: name, server, runtime: runtime || runtimeForInstance(name) });
    }
  }
  if (workbuddyBridge) {
    const entry = fs.realpathSync(workbuddyBridge);
    if (!fs.statSync(entry).isFile() || !/\.mjs$/i.test(entry)) throw Error('WorkBuddy bridge must be an existing server.mjs; this repository does not recreate unseen custom authorization code.');
    for (const [name, model] of [['hy4-workbuddy', 'hy4-preview'], [DSF_SERVER, WORKBUDDY_DSF.model]]) {
      // Preserve any existing service instead of replacing it.
      if (new RegExp(`^\\s*\\[mcp_servers\\.(?:"${name}"|${name})\\]`, 'm').test(original)) continue;
      parts.push(`[mcp_servers.${name}]`, `command = ${JSON.stringify(process.execPath)}`, `args = ${JSON.stringify([entry])}`, `cwd = ${JSON.stringify(path.dirname(entry))}`, `tool_timeout_sec = ${TOOL_TIMEOUT_SECONDS}`, `[mcp_servers.${name}.env]`, `WB_MODEL = ${JSON.stringify(model)}`, 'WB_SKIP_PERMISSIONS = "false"', '');
    }
  }
  if (project) parts.push(mcpSection(DSF_SERVER, [PROJECT_SERVER_ENTRY, '--config', project.configPath]));
  let solRegistration = null;
  if (solCoordinatorConfig || solWorkspaceRoot || solModel || solReasoningEffort) {
    if (findMcpRegistration(existing.outside, SOL_SERVER) !== null) {
      throw Error('Unmanaged MCP sol-coordinator already exists. Review that registration locally.');
    }
    solRegistration = buildSolRegistration({
      toml: original, plannedDsh: parts.find(section => sectionName(section) === DSH_SERVER),
      codexHome, repo, explicit: solCoordinatorConfig, workspace: solWorkspaceRoot,
      model: solModel, effort: solReasoningEffort, dshEntry
    });
    const prior = existing.sections.find(section => sectionName(section) === SOL_SERVER);
    const priorArgs = prior && tomlStringArray(prior, 'args');
    if (prior && (priorArgs?.length !== 3 || priorArgs[1] !== '--config'
      || !path.isAbsolute(priorArgs[2]) || pathKey(priorArgs[2]) !== pathKey(solRegistration.filename))) {
      throw Error('Managed sol-coordinator already uses a different config. Review that registration locally.');
    }
    plan.push(...solRegistration.files);
    parts.push(mcpSection(SOL_SERVER, [solBridge, '--config', solRegistration.filename], solEnvironmentNames(solRegistration.config)));
  }
  const configTouched = enableDsh || Boolean(workbuddyBridge || project) || removeNames.length > 0 || Boolean(solRegistration);
  if (configTouched) {
    const old = existing;
    const oldSections = old.sections;
    const oldNames = new Set(oldSections.map(sectionName).filter(Boolean));
    for (const name of removeNames) {
      const server = serverNameForInstance(name);
      if (!oldNames.has(server)) throw Error(`Managed DSH instance "${name}" (${server}) is not registered in this config; refusing to remove an unmanaged or nonexistent service.`);
    }
    const removeServers = new Set(removeNames.map(serverNameForInstance));
    const outside = old.outside;
    for (const match of parts.join('\n').matchAll(/^\[mcp_servers\.([^\].]+)\]$/gm)) {
      if (new RegExp(`^\\s*\\[mcp_servers\\.(?:"${match[1]}"|${match[1]})\\]`, 'm').test(outside)) throw Error(`Unmanaged MCP ${match[1]} already exists. Resolve manually; not overwritten.`);
    }
    if (enableDsh) {
      // A preserved named service must not silently keep a different schedule
      // policy from the one this install applies to the default service.
      const regenerated = new Set([DSH_SERVER, ...addNames.map(serverNameForInstance)]);
      for (const section of oldSections) {
        const name = sectionName(section);
        if (!name || name === DSH_SERVER || !name.startsWith(`${DSH_SERVER}-`) || removeServers.has(name) || regenerated.has(name)) continue;
        const hasSchedule = section.includes('--schedule-config');
        if (hasSchedule !== useSchedule) throw Error(`Existing DSH service ${name} has a different schedule setting than this install would apply. List its instance name with --dsh-instance to regenerate it, or remove it explicitly; refusing to leave a schedule-policy bypass.`);
      }
    }
    let block = parts.join('\n').trimEnd();
    for (const section of oldSections) {
      const name = sectionName(section);
      if (!name) throw Error('Unknown content in managed TOML block.');
      if (removeServers.has(name)) continue;
      if (!block.includes(`[mcp_servers.${name}]`)) {
        block = [block, section.trimEnd()].filter(Boolean).join('\n\n');
      }
    }
    if (block.trim()) plan.push({ file: configFile, data: mergeBlock(original, block, 'toml') });
    else if (old.block) {
      let data = original.replace(old.block, '');
      data = data.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
      plan.push({ file: configFile, data });
    } else plan.push({ file: configFile, data: original });
  }
  return { plan, codexHome, skillDirectory, modelCheck, usesOverride: agentsPath === override, dshInstances: dshPlan, preservedServices, useSchedule,
    solCoordinatorConfig: solRegistration?.filename ?? null, workbuddyProjectConfig: project?.configPath ?? null };
}
function apply(plan, codexHome, skillDirectory) {
  assertSkillDirectories(skillDirectory);
  const changed = plan.filter(x => read(x.file) !== x.data);
  if (!changed.length) return console.log('No changes; installation is already up to date.');
  const backup = path.join(codexHome, 'ai-rule-backups', `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const manifest = { version: VERSION, repo, skill_directory: skillDirectory, files: [] };
  for (const [i, change] of changed.entries()) {
    const stat = fs.lstatSync(change.file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw Error(`Refusing to replace a non-regular file: ${change.file}`);
    const existed = Boolean(stat);
    const saved = path.join(backup, `${i}.bak`);
    if (existed) { fs.copyFileSync(change.file, saved); if (process.platform !== 'win32') fs.chmodSync(saved, 0o600); }
    manifest.files.push({ file: change.file, existed, saved, installed_hash: hash(change.data) });
  }
  const manifestFile = path.join(backup, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  try {
    for (const change of changed) {
      fs.mkdirSync(path.dirname(change.file), { recursive: true });
      fs.writeFileSync(change.file, change.data, { mode: 0o600 });
    }
  } catch (error) {
    for (const item of manifest.files) {
      if (item.existed) fs.copyFileSync(item.saved, item.file); else fs.rmSync(item.file, { force: true });
    }
    throw error;
  }
  console.log(`Installed ${changed.length} files. Rollback manifest (local, may reference secret-bearing backups): ${manifestFile}`);
}
function rollback(file) {
  const manifest = JSON.parse(read(file));
  if (manifest.skill_directory) assertSkillDirectories(manifest.skill_directory);
  for (const item of manifest.files) {
    if (!fs.lstatSync(item.file, { throwIfNoEntry: false })?.isFile() || hash(read(item.file)) !== item.installed_hash) {
      throw Error(`Changed since installation; refusing to overwrite: ${item.file}`);
    }
  }
  for (const item of manifest.files) {
    if (item.existed) fs.copyFileSync(item.saved, item.file); else fs.rmSync(item.file);
  }
  console.log('Rollback completed; no CLI packages or credentials were removed.');
}
export function verifyInstallation({ home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex') } = {}) {
  codexHome = path.resolve(codexHome);
  const override = path.join(codexHome, 'AGENTS.override.md');
  const agents = read(override).trim() ? override : path.join(codexHome, 'AGENTS.md');
  const agentsText = read(agents);
  const { files: skillFiles } = skillFilesFor(home);
  const config = read(path.join(codexHome, 'config.toml'));
  const managed = managedParts(config);
  const instances = [];
  for (const section of managed.sections) {
    const server = sectionName(section);
    if (!server || (server !== DSH_SERVER && !server.startsWith(`${DSH_SERVER}-`))) continue;
    const args = tomlArray(section);
    let instance = null, nameError = null;
    try { instance = instanceFromServerName(server); } catch (error) { nameError = error.message; }
    const flagInstance = args ? argValue(args, '--instance') : undefined;
    const flagIndex = args ? args.indexOf('--instance') : -1;
    const duplicateFlag = flagIndex >= 0 && args.indexOf('--instance', flagIndex + 1) >= 0;
    const identityValid = Boolean(args && instance && !nameError && !duplicateFlag &&
      (instance === INSTANCE_DEFAULT ? (flagInstance === undefined || flagInstance === INSTANCE_DEFAULT) : flagInstance === instance));
    const runtimeFlag = args ? argValue(args, '--runtime') : undefined;
    let runtime = null;
    try { runtime = runtimeFlag || (instance ? runtimeForInstance(instance) : null); } catch (error) { nameError ||= error.message; }
    const scheduleIndex = args ? args.indexOf('--schedule-config') : -1;
    const scheduleEnabled = scheduleIndex >= 0;
    const scheduleConfig = scheduleEnabled ? args[scheduleIndex + 1] : null;
    const scheduleConfigExists = scheduleEnabled && Boolean(scheduleConfig) && fs.existsSync(scheduleConfig);
    instances.push({ instance, server, identity_valid: identityValid, runtime, schedule_enabled: scheduleEnabled,
      schedule_default_enabled: false, schedule_config: scheduleConfig, schedule_config_exists: scheduleConfigExists,
      allow_write: Boolean(args && !args.includes('--read-only')),
      ...(nameError ? { error: nameError } : {}) });
  }
  const instanceKeys = instances.map(x => x.instance).filter(Boolean);
  const runtimeKeys = instances.map(x => x.runtime).filter(Boolean).map(pathKey);
  const unmanagedDsh = [];
  for (const match of managed.outside.matchAll(/^\s*\[mcp_servers\.([^\].]+)\]\s*$/gm)) {
    const name = match[1].replace(/^"|"$/g, '');
    if (name.includes('.')) continue;
    if (name === DSH_SERVER || name.startsWith(`${DSH_SERVER}-`)) unmanagedDsh.push(name);
  }
  const checks = {
    effective_agents_has_rules: agentsText.includes('BEGIN isheach/ai_rule managed'),
    skill_installed: read(skillFiles[0].file).includes(SKILL_MARKER),
    rules_current: mergeBlock(agentsText, read(path.join(repo, 'AGENTS.md')), 'markdown') === agentsText
      && skillFiles.every(({ file, data }) => read(file) === data),
    dsh_mcp_registered: new RegExp(`\\[mcp_servers\\.${DSH_SERVER}\\]`).test(config),
    dsh_offpeak_schedule_registered: /--schedule-config/.test(config),
    dsh_verification_scope: 'managed ai_rule block only; unmanaged or manually added services are preserved but not validated',
    unmanaged_dsh_services: [...new Set(unmanagedDsh)],
    dsh_instance_count: instances.length,
    dsh_instances: instances,
    dsh_instances_unique: new Set(instanceKeys).size === instanceKeys.length,
    dsh_runtimes_unique: new Set(runtimeKeys).size === runtimeKeys.length,
    dsh_instance_identity_valid: instances.every(x => x.identity_valid),
    dsh_schedule_consistent: new Set(instances.map(x => x.schedule_enabled)).size <= 1,
    dsh_schedule_config_valid: instances.every(x => !x.schedule_enabled || x.schedule_config_exists),
    workbuddy_hy4_registered: /\[mcp_servers\.hy4-workbuddy\]/.test(config),
    workbuddy_deepseek_registered: findMcpRegistration(config, DSF_SERVER) !== null,
    workbuddy_dsf_project: projectRegistrationStatus(managed.sections.find(section => sectionName(section) === DSF_SERVER)),
    sol_coordinator: solRegistrationStatus({
      managedSection: managed.sections.find(section => sectionName(section) === SOL_SERVER), outside: managed.outside, bridgeEntry: solBridge
    }),
    live_model_call_performed: false
  };
  checks.dsh_structure_valid = checks.dsh_instances_unique && checks.dsh_runtimes_unique && checks.dsh_instance_identity_valid && checks.dsh_schedule_consistent && checks.dsh_schedule_config_valid;
  return checks;
}
export function main(args) {
  const home = option(args, '--home') || os.homedir();
  const codexHome = option(args, '--codex-home') || process.env.CODEX_HOME || path.join(home, '.codex');
  if (args.includes('--rollback')) return rollback(option(args, '--rollback'));
  if (args.includes('--verify')) {
    const checks = verifyInstallation({ home, codexHome });
    console.log(JSON.stringify(checks, null, 2));
    if (!checks.effective_agents_has_rules || !checks.skill_installed || !checks.rules_current || !checks.dsh_structure_valid
      || checks.sol_coordinator.structure_valid === false || checks.workbuddy_dsf_project?.structure_valid === false) process.exitCode = 1;
    return;
  }
  const result = buildPlan({ home, codexHome, enableDsh: args.includes('--enable-dsh'), dshEntry: option(args, '--dsh-entry'), allowWrite: args.includes('--allow-write'), readOnly: args.includes('--read-only'),
    workbuddyBridge: option(args, '--workbuddy-bridge'), workbuddyProjectConfig: option(args, '--workbuddy-project-config'),
    replaceWorkBuddyDsf: args.includes('--replace-workbuddy-dsf'), offpeakSchedule: args.includes('--offpeak-schedule'),
    disableOffpeakSchedule: args.includes('--disable-offpeak-schedule'),
    dshInstances: optionValues(args, '--dsh-instance'), removeDshInstances: optionValues(args, '--remove-dsh-instance'),
    solCoordinatorConfig: option(args, '--sol-coordinator-config'), solWorkspaceRoot: option(args, '--sol-workspace-root'),
    solModel: option(args, '--sol-model'), solReasoningEffort: option(args, '--sol-reasoning-effort') });
  console.log(`ai_rule ${VERSION}: ${args.includes('--apply') ? 'APPLY' : 'PLAN ONLY'}`);
  for (const item of result.dshInstances) console.log(`DSH instance ${item.server} (${item.instance})${item.preserved ? ' [preserved]' : ''}: ${item.runtime}`);
  for (const item of result.preservedServices) console.log(`Preserved ${item.name}: ${item.reason}; not rewritten or validated as an ai_rule managed service.`);
  for (const change of result.plan) console.log(`${read(change.file) === change.data ? 'UNCHANGED' : 'MERGE/INSTALL'} ${change.file}`);
  if (result.usesOverride) console.log('Existing nonempty AGENTS.override.md is the effective global file; it will receive the managed block.');
  if (result.solCoordinatorConfig) console.log('Sol coordinator registration uses ' + result.solCoordinatorConfig + '. New chats default to subscription. API verification is separate.');
  if (result.workbuddyProjectConfig) console.log('WorkBuddy DSF project registration uses ' + result.workbuddyProjectConfig + '. Local SDK and model readiness are verified when the service is used.');
  if (result.modelCheck) console.log(`DSH ${result.modelCheck.version}: configured route verified; no paid API call performed.`);
  if (args.includes('--apply')) apply(result.plan, result.codexHome, result.skillDirectory);
  else console.log('No files changed. Re-run with --apply after reviewing the plan.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
