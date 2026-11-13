import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveRootChain, defaultSessionsRoot } from './host.mjs';
import { runtimeBase } from '../dsh/core.mjs';

// Disjoint from both the pool state and the approved workspace. The helper
// writes one short-lived local reference here; an MCP server reads it, then
// re-resolves the host parent chain itself.
const CONTEXT_ID = /^[A-Za-z0-9_-]{43}$/;
const MAX_CONTEXT_BYTES = 64 * 1024;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;

const real = value => (fs.realpathSync.native || fs.realpathSync)(value);
const isInside = (base, value) => {
  const rel = path.relative(base, value);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

export function contextDirFor(config) {
  if (config?.context_dir !== undefined) {
    if (typeof config.context_dir !== 'string' || !path.isAbsolute(config.context_dir)) throw Error('context_dir must be an absolute path');
    return path.resolve(config.context_dir);
  }
  return path.join(path.dirname(config.pool_root), `${path.basename(config.pool_root)}-contexts`);
}

export function ensureContextDir(config) {
  const dir = contextDirFor(config);
  const lexical = path.resolve(dir);
  let poolReal;
  try { poolReal = real(config.pool_root); } catch { poolReal = path.resolve(config.pool_root); }
  let workspaceReal = null;
  if (config.workspace_root) { try { workspaceReal = real(config.workspace_root); } catch { workspaceReal = path.resolve(config.workspace_root); } }
  const overlap = (a, b) => isInside(a, b) || isInside(b, a);
  // Reject a foreign lexical location BEFORE creating anything.
  if (overlap(poolReal, lexical)) throw Error('context directory must be disjoint from pool state');
  if (workspaceReal && overlap(workspaceReal, lexical)) throw Error('context directory must be disjoint from the approved workspace');
  if (overlap(path.resolve(runtimeBase()), lexical)) throw Error('context directory must be disjoint from legacy/default DSH runtimes');
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw Error('context directory must not be a symlink or junction');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const realDir = real(dir);
  if (fs.lstatSync(dir).isSymbolicLink()) throw Error('context directory must not be a symlink or junction');
  if (overlap(poolReal, realDir)) throw Error('context directory resolves into pool state');
  if (workspaceReal && overlap(workspaceReal, realDir)) throw Error('context directory resolves into the approved workspace');
  if (overlap(path.resolve(runtimeBase()), realDir)) throw Error('context directory resolves into legacy/default DSH runtimes');
  return realDir;
}

function contextFile(config, reference) {
  if (typeof reference !== 'string' || !CONTEXT_ID.test(reference)) throw Error('opaque local context reference required');
  const dir = ensureContextDir(config);
  const file = path.join(dir, `${reference}.json`);
  if (!isInside(dir, file)) throw Error('context reference escapes the local context directory');
  return { dir, file };
}

// Issue only after a trusted host parent-chain lookup. No --root/--child
// override exists on this production path; the child comes from the helper's
// own host environment.
export function issueContext({ config, env = process.env, sessionsRoot = defaultSessionsRoot(), clock = () => new Date(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const childId = env.CODEX_THREAD_ID;
  if (!childId) throw Error('CODEX_THREAD_ID is unavailable; refusing to guess a root');
  if (!Number.isInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 15 * 60 * 1000) throw Error('context ttl is out of bounds');
  const resolved = resolveRootChain({ childId, sessionsRoot });
  if (resolved.chain.length < 2 || !resolved.chain[0].has_parent) {
    throw Error('child has no known subagent parent source; refusing to guess a root');
  }
  const dir = ensureContextDir(config);
  const id = crypto.randomBytes(32).toString('base64url');
  const now = clock();
  const created = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(created.getTime())) throw Error('context clock returned an invalid date');
  const value = {
    schema: 1, context_id: id, root_chat_id: resolved.rootChatId, child_id: childId,
    chain_length: resolved.chain.length, created_at: created.toISOString(), expires_at: new Date(created.getTime() + ttlMs).toISOString()
  };
  const file = path.join(dir, `${id}.json`);
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
  return { context_ref: id, expires_at: value.expires_at };
}

export function resolveContext({ config, reference, sessionsRoot = defaultSessionsRoot(), clock = () => new Date() } = {}) {
  const { dir, file } = contextFile(config, reference);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('context reference is not a regular local file');
  if (stat.size > MAX_CONTEXT_BYTES) throw Error('context reference is too large');
  const realFile = real(file);
  if (!isInside(dir, realFile)) throw Error('context reference resolves outside the local context directory');
  let value;
  try { value = JSON.parse(fs.readFileSync(realFile, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw Error('context reference is unreadable'); }
  if (!value || value.schema !== 1 || value.context_id !== reference || typeof value.root_chat_id !== 'string'
    || typeof value.child_id !== 'string' || typeof value.created_at !== 'string' || typeof value.expires_at !== 'string') {
    throw Error('context reference has an invalid shape');
  }
  const now = clock();
  const current = now instanceof Date ? now : new Date(now);
  const created = Date.parse(value.created_at);
  const expires = Date.parse(value.expires_at);
  if (!Number.isFinite(current.getTime()) || !Number.isFinite(created) || !Number.isFinite(expires)) throw Error('context timestamps are invalid');
  if (created > current.getTime() + MAX_CLOCK_SKEW_MS) throw Error('context reference was created in the future');
  if (expires <= current.getTime()) throw Error('context reference is expired; rerun the local helper');
  if (expires - created > 15 * 60 * 1000) throw Error('context reference lifetime is invalid');
  // Resolve the host parent chain AGAIN from the file's child ID. A stale or
  // edited root_chat_id is not followed, and the UUID alone is not an identity.
  let resolved;
  try { resolved = resolveRootChain({ childId: value.child_id, sessionsRoot }); }
  catch (error) { throw Error(`context host chain cannot be re-resolved: ${error.message}`); }
  if (resolved.chain.length < 2 || !resolved.chain[0].has_parent) throw Error('context child has no known subagent parent source');
  if (resolved.rootChatId !== value.root_chat_id) throw Error('context root does not match the current host parent chain');
  return { rootId: resolved.rootChatId, childId: value.child_id, contextId: reference, expiresAt: value.expires_at, chainLength: resolved.chain.length };
}
