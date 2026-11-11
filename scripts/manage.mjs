#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { discoverDsh, preflight, VERSION } from '../bridges/dsh/core.mjs';

export function mergeBlock(original, content, kind) {
  const start = kind === 'toml' ? '# BEGIN isheach/ai_rule managed' : '<!-- BEGIN isheach/ai_rule managed -->';
  const end = kind === 'toml' ? '# END isheach/ai_rule managed' : '<!-- END isheach/ai_rule managed -->';
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
export function buildPlan({ home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex'), enableDsh = false, dshEntry, allowWrite = false, workbuddyBridge, offpeakSchedule = false, disableOffpeakSchedule = false } = {}) {
  codexHome = path.resolve(codexHome);
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
  const parts = [];
  if (offpeakSchedule && disableOffpeakSchedule) throw Error('Cannot enable and disable offpeak simultaneously.');
  if ((offpeakSchedule || disableOffpeakSchedule) && !enableDsh) throw Error('Schedule options require --enable-dsh.');
  const previousManaged = original.match(/# BEGIN isheach\/ai_rule managed[\s\S]*?# END isheach\/ai_rule managed/)?.[0] || '';
  const useSchedule = !disableOffpeakSchedule && (offpeakSchedule || previousManaged.includes('--schedule-config'));
  if (enableDsh) {
    const cli = discoverDsh(dshEntry);
    modelCheck = preflight(cli);
    const args = [path.join(repo, 'bridges', 'dsh', 'server.mjs'), ...(cli.prefix.length ? ['--dsh-entry', cli.prefix[0]] : []), ...(allowWrite ? ['--allow-write'] : []), ...(useSchedule ? ['--schedule-config', path.join(repo, 'config', 'offpeak.schedule.json')] : [])];
    parts.push('[mcp_servers.dsh-opencode-go]', `command = ${JSON.stringify(process.execPath)}`, `args = ${JSON.stringify(args)}`, `cwd = ${JSON.stringify(repo)}`, 'startup_timeout_sec = 30', 'tool_timeout_sec = 3700', 'enabled = true', '');
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
  if (parts.length) {
    const oldBlock = original.match(/# BEGIN isheach\/ai_rule managed[\s\S]*?# END isheach\/ai_rule managed/)?.[0] || '';
    const outside = original.replace(oldBlock, '');
    for (const match of parts.join('\n').matchAll(/^\[mcp_servers\.([^\].]+)\]$/gm)) {
      if (new RegExp(`^\\s*\\[mcp_servers\\.(?:"${match[1]}"|${match[1]})\\]`, 'm').test(outside)) throw Error(`Unmanaged MCP ${match[1]} already exists. Resolve manually; not overwritten.`);
    }
    // When adding one managed service, retain other entries in the old managed block.
    let block = parts.join('\n');
    if (oldBlock) {
      const body = oldBlock.split('\n').slice(1, -1).join('\n');
      const sections = body.split(/(?=^\[mcp_servers\.[^\].]+\]\s*$)/m).filter(x => x.trim());
      for (const section of sections) {
        const name = section.match(/^\[mcp_servers\.([^\].]+)\]/m)?.[1];
        if (!name) throw Error('Unknown content in managed TOML block.');
        if (!block.includes(`[mcp_servers.${name}]`)) block += '\n' + section;
      }
    }
    plan.push({ file: configFile, data: mergeBlock(original, block, 'toml') });
  }
  return { plan, codexHome, modelCheck, usesOverride: agentsPath === override };
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
export function main(args) {
  const home = option(args, '--home') || os.homedir();
  const codexHome = option(args, '--codex-home') || process.env.CODEX_HOME || path.join(home, '.codex');
  if (args.includes('--rollback')) return rollback(option(args, '--rollback'));
  if (args.includes('--verify')) {
    const override = path.join(codexHome, 'AGENTS.override.md');
    const agents = read(override).trim() ? override : path.join(codexHome, 'AGENTS.md');
    const skill = path.join(home, '.agents', 'skills', 'multi-agent-dispatch', 'SKILL.md');
    const config = read(path.join(codexHome, 'config.toml'));
    const checks = { effective_agents_has_rules: read(agents).includes('BEGIN isheach/ai_rule managed'), skill_installed: read(skill).includes('ai-rule-managed'),
      dsh_mcp_registered: /\[mcp_servers\.dsh-opencode-go\]/.test(config),
      dsh_offpeak_schedule_registered: /--schedule-config/.test(config),
      workbuddy_hy4_registered: /\[mcp_servers\.hy4-workbuddy\]/.test(config),
      workbuddy_deepseek_registered: /\[mcp_servers\.deepseek-v4-flash-workbuddy\]/.test(config),
      live_model_call_performed: false };
    console.log(JSON.stringify(checks, null, 2));
    if (!checks.effective_agents_has_rules || !checks.skill_installed) process.exitCode = 1;
    return;
  }
  const result = buildPlan({ home, codexHome, enableDsh: args.includes('--enable-dsh'), dshEntry: option(args, '--dsh-entry'), allowWrite: args.includes('--allow-write'), workbuddyBridge: option(args, '--workbuddy-bridge'), offpeakSchedule: args.includes('--offpeak-schedule'), disableOffpeakSchedule: args.includes('--disable-offpeak-schedule') });
  console.log(`ai_rule ${VERSION}: ${args.includes('--apply') ? 'APPLY' : 'PLAN ONLY'}`);
  for (const change of result.plan) console.log(`${read(change.file) === change.data ? 'UNCHANGED' : 'MERGE/INSTALL'} ${change.file}`);
  if (result.usesOverride) console.log('Existing nonempty AGENTS.override.md is the effective global file; it will receive the managed block.');
  if (result.modelCheck) console.log(`DSH ${result.modelCheck.version}: configured route verified; no paid API call performed.`);
  if (args.includes('--apply')) apply(result.plan, result.codexHome);
  else console.log('No files changed. Re-run with --apply after reviewing the plan.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
