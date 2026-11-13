import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const HY4_MODEL = 'hy4free';
export const HY4_MODEL_NAME = 'Hy4';
export const HY4_PERMISSION_MODE = 'dontAsk';
export const HY4_TOOLS_MODE = 'disabled';
export const ACP_PROTOCOL_VERSION = 1;

const ALLOWED = new Set([
  'schema', 'node_path', 'cli_entry', 'config_dir', 'workspace_root',
  'expected_version', 'expected_entry_sha256', 'expected_tarball_sha256',
  'internet_environment', 'allow_workspace_read', 'allow_workspace_write',
  'allow_commands', 'hook_shell_path'
]);
const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL|COOKIE)/i;

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function loadManifest(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw Error('HY4 manifest path must be absolute.');
  let value;
  try { value = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { throw Error(`Cannot read HY4 manifest: ${error.code || 'invalid JSON'}.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('HY4 manifest must be an object.');
  for (const key of Object.keys(value)) if (!ALLOWED.has(key)) throw Error(`Unknown HY4 manifest field: ${key}`);
  if (value.schema !== 1) throw Error('HY4 manifest schema must be 1.');
  for (const key of ['node_path', 'cli_entry', 'config_dir', 'workspace_root']) {
    if (typeof value[key] !== 'string' || !path.isAbsolute(value[key])) throw Error(`HY4 manifest ${key} must be an absolute path.`);
  }
  if (!fs.existsSync(value.node_path) || !fs.statSync(value.node_path).isFile()) throw Error('HY4 manifest node_path is not an existing file.');
  if (!fs.existsSync(value.cli_entry) || !fs.statSync(value.cli_entry).isFile()) throw Error('HY4 manifest cli_entry is not an existing file.');
  // Official npm/bundled entries may be extensionless JavaScript. Reject shell
  // shims; Node executes the manifest entry directly.
  if (/\.(?:cmd|bat|ps1|exe)$/i.test(value.cli_entry)) throw Error('HY4 cli_entry must be a Node JavaScript entry, not a shell/executable shim.');
  for (const key of ['config_dir', 'workspace_root']) {
    if (!fs.existsSync(value[key]) || !fs.statSync(value[key]).isDirectory()) throw Error(`HY4 manifest ${key} is not an existing directory.`);
  }
  if (typeof value.expected_version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.expected_version)) {
    throw Error('HY4 manifest expected_version is invalid.');
  }
  for (const key of ['expected_entry_sha256', 'expected_tarball_sha256']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/i.test(value[key]))) {
      throw Error(`HY4 manifest ${key} must be a SHA-256 hex string.`);
    }
  }
  if (typeof value.expected_entry_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.expected_entry_sha256)) {
    throw Error('HY4 manifest expected_entry_sha256 is required.');
  }
  if (value.internet_environment !== 'internal') throw Error('HY4 manifest internet_environment must be "internal".');
  for (const key of ['allow_workspace_read', 'allow_workspace_write', 'allow_commands']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw Error(`HY4 manifest ${key} must be boolean.`);
  }
  if (value.hook_shell_path !== undefined) {
    if (typeof value.hook_shell_path !== 'string' || !path.isAbsolute(value.hook_shell_path)
      || !fs.existsSync(value.hook_shell_path) || !fs.statSync(value.hook_shell_path).isFile()) {
      throw Error('HY4 manifest hook_shell_path must be an existing absolute file when provided.');
    }
  }
  if (value.allow_commands === true && value.hook_shell_path === undefined) {
    throw Error('HY4 manifest allow_commands requires an explicit hook_shell_path; no PATH lookup or implicit Git Bash install.');
  }
  const root = (fs.realpathSync.native || fs.realpathSync)(value.workspace_root);
  return Object.freeze({
    schema: 1,
    node_path: path.resolve(value.node_path),
    cli_entry: path.resolve(value.cli_entry),
    config_dir: path.resolve(value.config_dir),
    workspace_root: root,
    expected_version: value.expected_version,
    expected_entry_sha256: value.expected_entry_sha256.toLowerCase(),
    expected_tarball_sha256: value.expected_tarball_sha256?.toLowerCase() || null,
    internet_environment: value.internet_environment,
    allow_workspace_read: value.allow_workspace_read === true,
    allow_workspace_write: value.allow_workspace_write === true,
    allow_commands: value.allow_commands === true,
    hook_shell_path: value.hook_shell_path === undefined ? null : path.resolve(value.hook_shell_path)
  });
}
