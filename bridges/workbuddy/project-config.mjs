import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalDirectoryWithin, isInside, samePath } from '../hy4/policy.mjs';

export const PROJECT_CONTRACT = 'project-v1';
export const PROJECT_SERVER_ENTRY = fileURLToPath(new URL('./project-server.mjs', import.meta.url));
export const PROJECT_ID = /^[A-Za-z0-9_.-]{1,64}$/;
export const PROJECT_TASK_KEY = /^[A-Za-z0-9_.:-]{1,100}$/;
export const PROJECT_SESSION_ID = /^[A-Za-z0-9_.:@/-]{1,160}$/;
export const WORKBUDDY_BUNDLE_FILES = ['codebuddy-lite-wb.mjs', 'codebuddy-headless.js'];

export function projectError(code, message) {
  return Object.assign(Error(message), { code });
}

function configError(message) {
  return projectError('WORKBUDDY_PROJECT_CONFIG', message);
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) {
    throw configError(`${label} has an unsupported format or field.`);
  }
}

function localPath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /^[\\/]{2}/.test(value) || /[\u0000-\u001f]/.test(value)) {
    throw configError(`${label} must be an absolute local path.`);
  }
  return path.resolve(value);
}

function physicalPath(value, label, kind, future = false) {
  const target = localPath(value, label);
  let stat;
  try { stat = fs.lstatSync(target); }
  catch (error) {
    if (future && error.code === 'ENOENT' && path.dirname(target) !== target) {
      return path.join(physicalPath(path.dirname(target), label, 'directory', true), path.basename(target));
    }
    throw configError(`${label} must be an existing ${kind}.`);
  }
  const isExpectedKind = kind === 'file' ? stat.isFile() : stat.isDirectory();
  if (!isExpectedKind || !samePath(target, fs.realpathSync.native(target))) {
    throw configError(`${label} must be a physical ${kind} without a symlink or junction.`);
  }
  return fs.realpathSync.native(target);
}

function overlaps(a, b) { return isInside(a, b) || isInside(b, a); }

export function loadProjectConfig(filename) {
  const configPath = physicalPath(filename, 'WorkBuddy project config', 'file');
  let value;
  try {
    if (fs.statSync(configPath).size > 128000) throw Error('Config is too large.');
    value = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch { throw configError('The WorkBuddy project config must be bounded, valid JSON.'); }
  exactObject(value, ['schema', 'workbuddy_cli', 'cli_sha256', 'workbuddy_config_dir', 'runtime_dir', 'projects'], 'WorkBuddy project config');
  if (value.schema !== 1) throw configError('The WorkBuddy project config schema must be 1.');
  const cliEntry = physicalPath(value.workbuddy_cli, 'workbuddy_cli', 'file');
  // Pin the effective script. The SDK rewrites its supported launcher path
  // bin/codebuddy, which would otherwise leave the actual bundle unpinned.
  const entryName = path.basename(cliEntry).toLowerCase();
  const relativeEntry = path.join('resources', 'app.asar.unpacked', 'cli', 'dist', entryName);
  if (!WORKBUDDY_BUNDLE_FILES.includes(entryName) || !cliEntry.toLowerCase().endsWith(`${path.sep}${relativeEntry}`)) {
    throw configError('workbuddy_cli must name the effective codebuddy-lite-wb.mjs or codebuddy-headless.js in the existing WorkBuddy app bundle.');
  }
  if (typeof value.cli_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.cli_sha256)) {
    throw configError('cli_sha256 must be the SHA-256 of the effective WorkBuddy CLI script.');
  }
  const configDir = physicalPath(value.workbuddy_config_dir, 'workbuddy_config_dir', 'directory');
  const runtimeDir = physicalPath(value.runtime_dir, 'runtime_dir', 'directory', true);
  const installDir = cliEntry.slice(0, -(relativeEntry.length + 1));
  if ([configPath, installDir, configDir].some(reserved => overlaps(reserved, runtimeDir))) {
    throw configError('runtime_dir must be separate from the config file, WorkBuddy installation and existing account configuration.');
  }
  if (!Array.isArray(value.projects) || value.projects.length < 1 || value.projects.length > 64) {
    throw configError('Configure 1..64 already approved project directories.');
  }
  const projects = value.projects.map(item => {
    exactObject(item, ['id', 'root', 'allow_write', 'allow_commands'], 'WorkBuddy project grant');
    if (typeof item.id !== 'string' || !PROJECT_ID.test(item.id) ||
      ['allow_write', 'allow_commands'].some(field => item[field] !== undefined && typeof item[field] !== 'boolean') ||
      (item.allow_commands === true && item.allow_write !== true)) {
      throw configError('Each project needs a safe ID and explicit boolean grants. Commands require a write grant.');
    }
    const root = physicalPath(item.root, 'project root', 'directory');
    canonicalDirectoryWithin(path.parse(root).root, root, 'project root');
    if ([configPath, installDir, configDir, runtimeDir].some(reserved => overlaps(reserved, root))) {
      throw configError('Project roots must be separate from bridge config, WorkBuddy installation, account configuration and runtime.');
    }
    return { id: item.id, root, allowWrite: item.allow_write === true, allowCommands: item.allow_commands === true };
  });
  if (projects.some((project, index) => projects.slice(0, index).some(other =>
    other.id === project.id || overlaps(other.root, project.root)))) {
    throw configError('Project IDs and physical roots must be distinct and project roots cannot overlap.');
  }
  return { configPath, runtimeDir, configDir, cliEntry, cliSha256: value.cli_sha256.toLowerCase(), projects };
}

export function ensureProjectRuntime(config) {
  fs.mkdirSync(config.runtimeDir, { mode: 0o700, recursive: true });
  if (!samePath(physicalPath(config.runtimeDir, 'runtime_dir', 'directory'), config.runtimeDir)) {
    throw configError('The project runtime changed location.');
  }
}

export async function verifyProjectCli(config) {
  const filename = physicalPath(config.cliEntry, 'workbuddy_cli', 'file');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  if (hash.digest('hex') !== config.cliSha256) {
    throw projectError('WORKBUDDY_CLI_PIN_MISMATCH', 'The local WorkBuddy CLI does not match the pinned SHA-256.');
  }
}

export function matchProject(config, { cwd, projectId, permissionMode }) {
  const lexical = localPath(cwd, 'cwd');
  const project = config.projects.find(item => isInside(item.root, lexical));
  if (!project || (projectId !== undefined && project.id !== projectId)) {
    throw projectError('WORKBUDDY_PROJECT_OUTSIDE_GRANT', 'The task cwd is outside the selected approved WorkBuddy project.');
  }
  let canonical;
  try { canonical = canonicalDirectoryWithin(project.root, cwd, 'task cwd'); }
  catch { throw projectError('WORKBUDDY_PROJECT_OUTSIDE_GRANT', 'Task cwd must be an existing physical directory within its approved project.'); }
  if (permissionMode === 'workspace-write' && !project.allowWrite) {
    throw projectError('WORKBUDDY_PROJECT_READ_ONLY', 'This WorkBuddy project grant is read-only.');
  }
  return { project, cwd: canonical };
}
