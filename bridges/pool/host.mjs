import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UUID = /^[a-f0-9-]{36}$/i;
const MAX_META = 256 * 1024;
const MAX_DEPTH = 16;

export function defaultSessionsRoot() {
  return process.env.CODEX_HOME
    ? path.join(process.env.CODEX_HOME, 'sessions')
    : path.join(os.homedir(), '.codex', 'sessions');
}

function walk(dir, depth, out) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1, out);
    else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) out.push(full);
  }
}

// Read ONLY the first line, in bounded chunks. No prompt/body line is loaded
// into a large buffer, and no later JSON line is interpreted.
function readFirstLine(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunks = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buffer, 0, buffer.length, total);
      if (n <= 0) break;
      const chunk = buffer.subarray(0, n);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        if (total + newline > MAX_META) throw Error('rollout metadata line exceeds the local limit');
        chunks.push(chunk.subarray(0, newline));
        total += newline;
        break;
      }
      chunks.push(chunk); total += n;
      if (total > MAX_META) throw Error('rollout metadata line exceeds the local limit');
    }
    if (!total) throw Error('empty rollout metadata');
    return Buffer.concat(chunks, total).toString('utf8').replace(/\r$/, '');
  } finally { fs.closeSync(fd); }
}

function readMeta(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('rollout metadata is not a regular local file');
  const line = readFirstLine(file);
  try { return JSON.parse(line); } catch { throw Error('invalid rollout metadata'); }
}

// A root rollout must prove a known host origin. A missing or arbitrary source
// at the end of the chain is not treated as a root.
function knownRootSource(payload) {
  if (payload?.originator === 'codex_work_desktop') return true;
  const source = payload?.source;
  if (source === 'vscode' || source === 'codex_work_desktop') return true;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    return source.type === 'vscode' || source.kind === 'vscode'
      || source.originator === 'codex_work_desktop' || source.source === 'vscode';
  }
  return false;
}

export function resolveRootChain({ sessionsRoot = defaultSessionsRoot(), childId, maxDepth = MAX_DEPTH } = {}) {
  if (!UUID.test(childId || '')) throw Error('child thread ID must be a UUID');
  let root;
  try { root = (fs.realpathSync.native || fs.realpathSync)(sessionsRoot); } catch { throw Error('Codex sessions root is missing or unreadable'); }
  if (!fs.statSync(root).isDirectory()) throw Error('Codex sessions root is not a directory');
  const files = [];
  walk(root, 0, files);
  const seen = new Set();
  const chain = [];
  let current = childId;
  for (let depth = 0; depth < maxDepth; depth++) {
    if (seen.has(current)) throw Error('cyclic rollout parent chain');
    seen.add(current);
    const matches = files.filter(file => path.basename(file).toLowerCase().endsWith(`-${current.toLowerCase()}.jsonl`));
    if (matches.length === 0) throw Error(`exact rollout metadata not found for ${current}`);
    if (matches.length > 1) throw Error(`exact rollout metadata is ambiguous for ${current}`);
    const file = matches[0];
    const meta = readMeta(file);
    if (meta?.type !== 'session_meta' || !meta.payload || typeof meta.payload !== 'object') {
      throw Error('first rollout line is not session_meta');
    }
    const payload = meta.payload;
    if (payload.id !== current) throw Error('rollout child ID does not match chain');
    const source = payload.source;
    const spawn = source && typeof source === 'object' ? source.subagent?.thread_spawn : null;
    const hasSubagent = source && typeof source === 'object' && source.subagent !== undefined;
    const parent = spawn?.parent_thread_id;
    if (hasSubagent && (!spawn || typeof spawn !== 'object' || Array.isArray(spawn)
      || parent === undefined || parent === null || parent === '')) {
      throw Error('malformed subagent parent metadata in rollout chain');
    }
    chain.push({ id: current, file, has_parent: parent !== undefined && parent !== null && parent !== '' });
    if (parent === undefined || parent === null || parent === '') {
      if (chain.length < 2) throw Error('child has no known subagent source/parent metadata');
      if (!knownRootSource(payload)) throw Error('root session source is missing or not recognized');
      return { childId, rootChatId: current, chain };
    }
    if (!spawn || typeof spawn !== 'object' || Array.isArray(spawn) || !UUID.test(parent) || parent === current) {
      throw Error('malformed subagent parent metadata in rollout chain');
    }
    current = parent;
  }
  throw Error('rollout parent chain exceeded bound');
}

export function resolveRootFromRollout(options = {}) {
  const result = resolveRootChain(options);
  if (result.chain.length < 2) throw Error('child has no subagent parent metadata');
  return result;
}
