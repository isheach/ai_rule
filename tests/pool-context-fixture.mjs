#!/usr/bin/env node
// Test-only synthetic host helper. It uses the real resolveRootChain/issueContext
// with an injected clock and a synthetic CODEX_HOME; no global config is touched.
import { loadPoolConfig } from '../bridges/pool/service.mjs';
import { issueContext } from '../bridges/pool/context.mjs';

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
try {
  const iso = opt('clock');
  const clock = iso ? () => new Date(iso) : () => new Date();
  const issued = issueContext({
    config: loadPoolConfig(opt('config')),
    sessionsRoot: opt('sessions-root'),
    clock
  });
  process.stdout.write(JSON.stringify(issued) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
  process.exit(1);
}
