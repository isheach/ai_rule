import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { redact } from '../bridges/dsh/core.mjs';
import { discardLegacyEnvironment } from '../bridges/sol/config.mjs';
import { ResponsesClient } from '../bridges/sol/responses.mjs';
import { apply, buildPlan, verifyInstallation } from './manage.mjs';
import { solSetupInputs } from './sol-install.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bootstrapPath = 'scripts/sol-broker-elevated.ps1';
const brokerDirectory = 'bridges/sol/broker/windows';
const brokerFiles = ['install.ps1', 'build.ps1', 'Protocol.cs', 'WindowsPipe.cs', 'BrokerState.cs', 'Upstream.cs', 'Program.cs'];

function hash(data) { return createHash('sha256').update(data).digest('hex'); }

function printableJson(value, indent) {
  // Windows PowerShell 5.1 may decode native stdout using an OEM code page.
  return JSON.stringify(value, null, indent).replace(/[\u0080-\uffff]/g, letter => `\\u${letter.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function lexicalPath(value) {
  const absolute = path.resolve(value);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function blobId(data) {
  return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
}

export function verifyCheckout(expectedRevision, gitExecutable, repository = repo) {
  if (!/^[a-f\d]{40}$/i.test(expectedRevision ?? '') || !path.isAbsolute(gitExecutable ?? '')) {
    throw Error('Supply the reviewed full Git commit SHA and an absolute Git executable path.');
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  function git(...args) {
    const result = spawnSync(gitExecutable, ['--no-replace-objects', '-C', repository, ...args], {
      env, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024
    });
    if (result.error || result.status !== 0) throw Error('Git could not read the reviewed deployment checkout.');
    return result.stdout;
  }
  const revision = expectedRevision.toLowerCase();
  if (git('rev-parse', '--verify', 'HEAD').toString().trim() !== revision
    || lexicalPath(git('rev-parse', '--show-toplevel').toString().trim()) !== lexicalPath(repository)) {
    throw Error('The local checkout does not match the reviewed deployment commit. Use its verified worktree and try again.');
  }
  const records = git('ls-tree', '-rz', '--full-tree', revision, '--', 'AGENTS.md', 'scripts', 'bridges', 'config', 'skills')
    .toString().split('\0').filter(Boolean);
  const required = new Set([bootstrapPath, ...brokerFiles.map(name => `${brokerDirectory}/${name}`)]);
  const sources = new Map();
  for (const record of records) {
    const entry = /^(?:100644|100755) blob ([a-f\d]{40})\t(.+)$/.exec(record);
    if (!entry) throw Error('The reviewed deployment commit must contain regular source files.');
    const [, id, name] = entry;
    const filename = path.join(repository, name);
    const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (!stat?.isFile() || lexicalPath(fs.realpathSync.native(filename)) !== lexicalPath(filename)) {
      throw Error(`The reviewed source file is missing or redirected: ${name}`);
    }
    const source = fs.readFileSync(filename);
    if (blobId(source) !== id && blobId(Buffer.from(source.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')) !== id) {
      throw Error(`The local source differs from the reviewed commit: ${name}`);
    }
    if (required.has(name)) {
      const pinned = git('cat-file', 'blob', id);
      if (blobId(pinned) !== id) throw Error(`The reviewed Git source could not be verified: ${name}`);
      sources.set(name, pinned);
      required.delete(name);
    }
  }
  if (required.size) throw Error('The reviewed commit does not contain the Windows Sol setup and broker sources.');
  return { revision, sources };
}

function deploymentPlan(opts) {
  const home = os.homedir();
  const codexHome = opts['codex-home'] || process.env.CODEX_HOME || path.join(home, '.codex');
  if (!path.isAbsolute(codexHome)) throw Error('The Codex home must be an absolute path. Set -CodexHome to the local profile in use.');
  const tomlPath = path.join(codexHome, 'config.toml');
  const toml = fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, 'utf8').replace(/^\uFEFF/, '') : '';
  const input = solSetupInputs({ toml, codexHome, explicit: opts.config, workspace: opts.workspace, model: opts.model, effort: opts.effort });
  const plan = buildPlan({ home, codexHome, ...input, dshEntry: opts['dsh-entry'], solReadOnlyByDefault: true });
  const fingerprint = hash(JSON.stringify({
    config: plan.solConfig,
    files: plan.plan.map(({ file, data }) => [file, fs.existsSync(file) ? hash(fs.readFileSync(file)) : null, hash(data)])
  }));
  return { ...plan, fingerprint };
}

export function workbuddySdkStatus(configured, directory = path.join(repo, 'bridges', 'workbuddy')) {
  if (!configured?.projectContract) return null;
  const name = '@tencent-ai/agent-sdk';
  const pinned = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).dependencies[name];
  const manifest = path.join(directory, 'node_modules', name, 'package.json');
  try {
    if (JSON.parse(fs.readFileSync(manifest, 'utf8')).version === pinned) return { installed: true };
  } catch { /* Report the missing or invalid package without loading it. */ }
  return { installed: false, directory };
}

function quotePowerShell(value) { return `'${value.replaceAll("'", "''")}'`; }

export function prepareElevation(sources, options) {
  const bundle = Buffer.from(JSON.stringify(Object.fromEntries(brokerFiles.map(name => [name,
    sources.get(`${brokerDirectory}/${name}`).toString('base64')]))));
  const args = { BundlePath: options.bundlePath, BundleSha256: hash(bundle), ClientSid: options.clientSid,
    Model: options.model, ReasoningEffort: options.effort };
  if (options.project) args.ProjectId = options.project;
  if (options.organization) args.OrganizationId = options.organization;
  const values = Object.entries(args).map(([name, value]) => `-${name} ${quotePowerShell(value)}`).join(' ');
  const script = sources.get(bootstrapPath).toString('utf8').replace(/^\uFEFF/, '');
  const switches = [options.action === 'Install' ? '-Install' : '', options.setKey ? '-SetKey' : ''].filter(Boolean).join(' ');
  const command = `try { & {
${script}
} ${values} ${switches} } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected -and
        [Environment]::GetCommandLineArgs() -notcontains '-NonInteractive') {
        [Console]::WriteLine('Press a key to close this window.')
        try { $null = [Console]::ReadKey($true) } catch {}
    }
    exit 1
}`;
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
  if (encodedCommand.length > 30000) throw Error('The reviewed Windows elevation command exceeds its size limit.');
  return { bundle, encodedCommand };
}

const options = Object.fromEntries(['revision', 'git', 'codex-home', 'config', 'workspace', 'model', 'effort', 'dsh-entry',
  'fingerprint', 'bundle-path', 'client-sid', 'project', 'organization', 'action', 'program-files'].map(name => [name, { type: 'string' }]));

async function main(args) {
  if (process.platform !== 'win32') {
    throw Error(`This command is running on ${process.platform} (${process.arch}). Run the setup in PowerShell on the target Windows computer.`);
  }
  if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Windows Sol setup requires Node.js 22 or later.');
  const { values: opts, positionals: [mode, ...extra] } = parseArgs({ args, options, allowPositionals: true });
  if (extra.length || !['plan', 'elevation', 'apply'].includes(mode)) throw Error('Use the reviewed scripts/setup-sol.ps1 entry point.');
  const { revision, sources } = verifyCheckout(opts.revision, opts.git);
  const plan = deploymentPlan(opts);
  const { openai, workspaceRoot, pool, workbuddy } = plan.solConfig;
  const workbuddySdk = workbuddySdkStatus(workbuddy);
  if (mode !== 'plan' && opts.fingerprint !== plan.fingerprint) {
    throw Error('The local installation plan changed. Run setup again to review the current files and policy.');
  }
  if (mode !== 'plan' && workbuddySdk?.installed === false) throw Error('Install the pinned WorkBuddy SDK in the reviewed worktree and run setup again.');
  if (mode === 'elevation') {
    if (!['Install', 'Enroll'].includes(opts.action) || !path.isAbsolute(opts['bundle-path'] ?? '')) throw Error('Invalid elevation request.');
    const { bundle, encodedCommand } = prepareElevation(sources, {
      bundlePath: opts['bundle-path'], clientSid: opts['client-sid'], model: openai.model, effort: openai.reasoning_effort,
      project: opts.project, organization: opts.organization, action: opts.action, setKey: true
    });
    fs.writeFileSync(opts['bundle-path'], bundle, { flag: 'wx' });
    console.log(encodedCommand);
    return;
  }

  if (!path.isAbsolute(opts['program-files'] ?? '')) throw Error('The target Windows Program Files directory is unavailable.');
  process.env.ProgramFiles = opts['program-files'];
  delete process.env.ProgramW6432;
  discardLegacyEnvironment(plan.solConfig);
  const broker = await new ResponsesClient({ config: plan.solConfig }).readiness();
  const result = {
    revision, node: process.versions.node, codex_home: plan.codexHome, coordinator_config: plan.solCoordinatorConfig,
    workspace_root: workspaceRoot, pool_allow_write: pool.allow_write, model: openai.model, reasoning_effort: openai.reasoning_effort,
    workbuddy_configured: Boolean(workbuddy), workbuddy_sdk: workbuddySdk, broker, live_model_call_performed: false
  };
  if (mode === 'plan') {
    console.log(printableJson({ status: result, fingerprint: plan.fingerprint }));
    return;
  }
  if (!broker.ready) throw Error(`Local Sol broker status is ${broker.code}. Registration was not changed.`);
  apply(plan.plan, plan.codexHome, plan.skillDirectory);
  const checked = verifyInstallation({ codexHome: plan.codexHome });
  if (!checked.rules_current || checked.sol_coordinator.structure_valid !== true) {
    throw Error('The applied rules or Sol MCP registration did not pass structural verification.');
  }
  console.log(printableJson({ ...result, rules_current: checked.rules_current, sol_coordinator: checked.sol_coordinator }, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
}
