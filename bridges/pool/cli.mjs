#!/usr/bin/env node
// Trusted local host helper. It issues a short-lived opaque context AFTER an
// exact Codex parent-chain lookup. It never prints a lease and has no
// --root/--child production override.
import path from 'node:path';
import { loadPoolConfig } from './service.mjs';
import { issueContext, resolveContext } from './context.mjs';
import { resolveRootChain } from './host.mjs';
import { redact } from '../dsh/core.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
function option(name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw Error(`Missing value for ${name}`);
  return argv[i + 1];
}
try {
  const configPath = option('--config');
  if (!configPath || !path.isAbsolute(configPath)) throw Error('--config ABS is required');
  const config = loadPoolConfig(configPath);
  if (cmd === 'context') {
    const issued = issueContext({ config });
    process.stdout.write(JSON.stringify(issued) + '\n');
  } else if (cmd === 'resolve') {
    const childId = process.env.CODEX_THREAD_ID;
    if (!childId) throw Error('CODEX_THREAD_ID is unavailable; refusing to guess a root');
    const resolved = resolveRootChain({ childId });
    const out = {
      child_id: resolved.childId, root_chat_id: resolved.rootChatId,
      chain_length: resolved.chain.length, read_only: true
    };
    process.stdout.write(JSON.stringify(out) + '\n');
  } else if (cmd === 'verify-context') {
    const reference = option('--context');
    const resolved = resolveContext({ config, reference });
    process.stdout.write(JSON.stringify({ valid: true, root_chat_id: resolved.rootId, expires_at: resolved.expiresAt, read_only: true }) + '\n');
  } else {
    throw Error('usage: context --config ABS | resolve --config ABS | verify-context --config ABS --context REF');
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ error: redact(error.message) }) + '\n');
  process.exit(1);
}
