#!/usr/bin/env node
// Test-only wrapper that injects a deterministic clock into the SAME stdio MCP
// implementation. It never overrides the production server's real clock.
import { startPoolServer } from '../bridges/pool/server.mjs';

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const iso = opt('clock');
const clock = iso ? () => new Date(iso) : undefined;
startPoolServer({
  configPath: opt('config'),
  allowWrite: argv.includes('--allow-write'),
  clock,
  sessionsRoot: opt('sessions-root')
}).catch(error => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
