#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { discoverDsh, preflight, VERSION, INSTANCE_DEFAULT, validateInstanceName, runtimeForInstance, serverNameForInstance, instanceFromServerName, pathKey } from '../bridges/dsh/core.mjs';

const MANAGED_START = '# BEGIN isheach/ai_rule managed';
const MANAGED_END = '# END isheach/ai_rule managed';
const DSH_SERVER = 'dsh-opencode-go';
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
function mcpSection(name, args) {
  return `[mcp_servers.${name}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(args)}\ncwd = ${JSON.stringify(repo)}\nstartup_timeout_sec = 30\ntool_timeout_sec = 3700\nenabled = true\n`;
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


export function buildPlan({ home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex'), enableDsh = false, dshEntry, allowWrite = false, workbuddyBridge, offpeakSchedule = false, disableOffpeakSchedule = false, dshInstances = [], removeDshInstances = [] } = {}) {
  codexHome = path.resolve(codexHome);
  if (!Array.isArray(dshInstances) || !Array.isArray(removeDshInstances)) throw Error('DSH instance options must be lists.');
  const addNames = dshInstances.map(validateInstanceName);
  const removeNames = removeDshInstances.map(validateInstanceName);
  if (new Set(addNames).size !== addNames.length) throw Error('Duplicate --dsh-instance value; each named instance may be registered once.');
  if (new Set(removeNames).size !== removeNames.length) throw Error('Duplicate --remove-dsh-instance value.');
  for (const name of addNames) if (removeNames.includes(name)) throw Error(`DSH instance "${name}" cannot be added and removed in the same operation.`);
  if (addNames.length && !enableDsh) throw Error('--dsh-instance requires --enable-dsh so the default service and CLI preflight are handled together.');
  const override = path.join(codexHome, 'AGENTS.override.md');
  const agentsPath = read(override).trim() ? override : path.join(codexHome, 'AGENTS.md');
  const skill = path.join(home, '.agents', 'skills', 'multi-agent-dispatch', 'SKILL.md');
  if (read(skill).trim() && !read(skill).includes('ai-rule-managed')) throw Error(`Existing unrelated Skill would be overwritten: ${skill}`);
  const plan = [
    { file: agentsPath, data: mergeBlock(read(agentsPath), read(path.join(repo, 'AGENTS.md')), 'markdown') },
    { file: skill, data: read(path.join(repo, 'skills', 'multi-agent-dispatch', 'SKILL.md')) }
  ];
  let modelCheck = null;
  const configFile = path.join(codexHome, 'config.toml');
  const original = read(configFile);
  const existing = managedParts(original);
  const oldDefaultSection = existing.sections.find(section => sectionName(section) === DSH_SERVER);
  const oldDefaultArgs = oldDefaultSection ? tomlArray(oldDefaultSection) : null;
  const unmanagedDefault = new RegExp(`^\\s*\\[mcp_servers\\.(?:"${DSH_SERVER}"|${DSH_SERVER})\\]`, 'm').test(existing.outside);
  const preserveDefault = enableDsh && addNames.length > 0 && Boolean(oldDefaultSection || unmanagedDefault);
  const parts = [];
  const dshPlan = [];
  const preservedServices = [];
  if (offpeakSchedule && disableOffpeakSchedule) throw Error('Cannot enable and disable offpeak simultaneously.');
  if ((offpeakSchedule || disableOffpeakSchedule) && !enableDsh) throw Error('Schedule options require --enable-dsh.');
  if (preserveDefault && (offpeakSchedule || disableOffpeakSchedule)) throw Error('Adding named instances must not silently rewrite the existing default service schedule. Change the global schedule with a separate --enable-dsh command (without --dsh-instance) first, then add instances; named instances inherit the resulting policy.');
  const previousManaged = original.match(/# BEGIN isheach\/ai_rule managed[\s\S]*?# END isheach\/ai_rule managed/)?.[0] || '';
  const useSchedule = !disableOffpeakSchedule && (offpeakSchedule || previousManaged.includes('--schedule-config'));
  if (enableDsh) {
    const cli = discoverDsh(dshEntry);
    modelCheck = preflight(cli);
    const bridge = path.join(repo, 'bridges', 'dsh', 'server.mjs');
    const inheritedEntry = oldDefaultArgs ? argValue(oldDefaultArgs, '--dsh-entry') : undefined;
    const cliEntry = dshEntry ? cli.prefix[0] : (inheritedEntry || cli.prefix[0]);
    const inheritedSchedule = oldDefaultArgs ? argValue(oldDefaultArgs, '--schedule-config') : undefined;
    const schedulePath = useSchedule ? (preserveDefault && inheritedSchedule ? inheritedSchedule : path.join(repo, 'config', 'offpeak.schedule.json')) : null;
    if (!preserveDefault) {
      const common = [...(cli.prefix.length ? ['--dsh-entry', cli.prefix[0]] : []), ...(allowWrite ? ['--allow-write'] : []), ...(schedulePath ? ['--schedule-config', schedulePath] : [])];
      parts.push(mcpSection(DSH_SERVER, [bridge, ...common]));
      dshPlan.push({ instance: INSTANCE_DEFAULT, server: DSH_SERVER, runtime: runtimeForInstance(INSTANCE_DEFAULT) });
    } else if (oldDefaultSection) {
      dshPlan.push({ instance: INSTANCE_DEFAULT, server: DSH_SERVER, preserved: true,
        runtime: (oldDefaultArgs && argValue(oldDefaultArgs, '--runtime')) || runtimeForInstance(INSTANCE_DEFAULT) });
    } else {
      preservedServices.push({ name: DSH_SERVER, reason: 'unmanaged default service preserved' });
    }
    for (const name of addNames) {
      const server = serverNameForInstance(name);
      const args = [bridge, '--instance', name, ...(cliEntry ? ['--dsh-entry', cliEntry] : []), ...(allowWrite ? ['--allow-write'] : []), ...(schedulePath ? ['--schedule-config', schedulePath] : [])];
      parts.push(mcpSection(server, args));
      dshPlan.push({ instance: name, server, runtime: runtimeForInstance(name) });
    }
  } else if (allowWrite) throw Error('--allow-write requires --enable-dsh.');
  if (workbuddyBridge) {
    const entry = fs.realpathSync(workbuddyBridge);
    if (!fs.statSync(entry).isFile() || !/\.mjs$/i.test(entry)) throw Error('WorkBuddy bridge must be an existing server.mjs; this repository does not recreate unseen custom authorization code.');
    for (const [name, model] of [['hy4-workbuddy', 'hy4-preview'], ['deepseek-v4-flash-workbuddy', 'deepseek-v4-flash']]) {
      // Preserve any existing service instead of replacing it.
      if (new RegExp(`^\\s*\\[mcp_servers\\.(?:"${name}"|${name})\\]`, 'm').test(original)) continue;
      parts.push(`[mcp_servers.${name}]`, `command = ${JSON.stringify(process.execPath)}`, `args = ${JSON.stringify([entry])}`, `cwd = ${JSON.stringify(path.dirname(entry))}`, 'tool_timeout_sec = 3700', `[mcp_servers.${name}.env]`, `WB_MODEL = ${JSON.stringify(model)}`, 'WB_SKIP_PERMISSIONS = "false"', '');
    }
  }
  const configTouched = enableDsh || Boolean(workbuddyBridge) || removeNames.length > 0;
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
    let block = parts.join('\n');
    for (const section of oldSections) {
      const name = sectionName(section);
      if (!name) throw Error('Unknown content in managed TOML block.');
      if (removeServers.has(name)) continue;
      if (!block.includes(`[mcp_servers.${name}]`)) block += '\n' + section;
    }
    if (block.trim()) plan.push({ file: configFile, data: mergeBlock(original, block, 'toml') });
    else if (old.block) {
      let data = original.replace(old.block, '');
      data = data.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
      plan.push({ file: configFile, data });
    } else plan.push({ file: configFile, data: original });
  }
  return { plan, codexHome, modelCheck, usesOverride: agentsPath === override, dshInstances: dshPlan, preservedServices, useSchedule };
}
function apply(plan, codexHome) {
  const changed = plan.filter(x => read(x.file) !== x.data);
  if (!changed.length) return console.log('No changes; installation is already up to date.');
  const backup = path.join(codexHome, 'ai-rule-backups', `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const manifest = { version: VERSION, repo, files: [] };
  for (const [i, change] of changed.entries()) {
    if (fs.existsSync(change.file) && fs.lstatSync(change.file).isSymbolicLink()) throw Error(`Refusing to replace symlink: ${change.file}`);
    const existed = fs.existsSync(change.file);
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
  for (const item of manifest.files) if (!fs.existsSync(item.file) || hash(read(item.file)) !== item.installed_hash) throw Error(`Changed since installation; refusing to overwrite: ${item.file}`);
  for (const item of manifest.files) {
    if (item.existed) fs.copyFileSync(item.saved, item.file); else fs.rmSync(item.file);
  }
  console.log('Rollback completed; no CLI packages or credentials were removed.');
}
export function verifyInstallation({ home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex') } = {}) {
  codexHome = path.resolve(codexHome);
  const override = path.join(codexHome, 'AGENTS.override.md');
  const agents = read(override).trim() ? override : path.join(codexHome, 'AGENTS.md');
  const skill = path.join(home, '.agents', 'skills', 'multi-agent-dispatch', 'SKILL.md');
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
      schedule_config: scheduleConfig, schedule_config_exists: scheduleConfigExists, allow_write: Boolean(args?.includes('--allow-write')),
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
    effective_agents_has_rules: read(agents).includes('BEGIN isheach/ai_rule managed'),
    skill_installed: read(skill).includes('ai-rule-managed'),
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
    workbuddy_deepseek_registered: /\[mcp_servers\.deepseek-v4-flash-workbuddy\]/.test(config),
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
    if (!checks.effective_agents_has_rules || !checks.skill_installed || !checks.dsh_structure_valid) process.exitCode = 1;
    return;
  }
  const result = buildPlan({ home, codexHome, enableDsh: args.includes('--enable-dsh'), dshEntry: option(args, '--dsh-entry'), allowWrite: args.includes('--allow-write'),
    workbuddyBridge: option(args, '--workbuddy-bridge'), offpeakSchedule: args.includes('--offpeak-schedule'), disableOffpeakSchedule: args.includes('--disable-offpeak-schedule'),
    dshInstances: optionValues(args, '--dsh-instance'), removeDshInstances: optionValues(args, '--remove-dsh-instance') });
  console.log(`ai_rule ${VERSION}: ${args.includes('--apply') ? 'APPLY' : 'PLAN ONLY'}`);
  for (const item of result.dshInstances) console.log(`DSH instance ${item.server} (${item.instance})${item.preserved ? ' [preserved]' : ''}: ${item.runtime}`);
  for (const item of result.preservedServices) console.log(`Preserved ${item.name}: ${item.reason}; not rewritten or validated as an ai_rule managed service.`);
  for (const change of result.plan) console.log(`${read(change.file) === change.data ? 'UNCHANGED' : 'MERGE/INSTALL'} ${change.file}`);
  if (result.usesOverride) console.log('Existing nonempty AGENTS.override.md is the effective global file; it will receive the managed block.');
  if (result.modelCheck) console.log(`DSH ${result.modelCheck.version}: configured route verified; no paid API call performed.`);
  if (args.includes('--apply')) apply(result.plan, result.codexHome);
  else console.log('No files changed. Re-run with --apply after reviewing the plan.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
