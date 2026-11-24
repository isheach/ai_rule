#!/usr/bin/env node
// Read-only layered dispatch resolver for the installed Skill and normal hosts.
// This command performs no model call and needs no credential or machine path.
import { pathToFileURL } from 'node:url';
import { resolveDispatch } from '../dispatch.mjs';

const USAGE = 'Usage: node bridges/dispatch/cli.mjs resolve [--source subscription|api] [--purpose <purpose>] [--backend <backend>] [--entry-structure astra|sol]';

function parse(argv) {
  if (!Array.isArray(argv) || argv[0] !== 'resolve') throw Error(USAGE);
  const options = {};
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (!['--source', '--purpose', '--backend', '--entry-structure'].includes(flag)) throw Error(USAGE);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw Error(USAGE);
    const key = flag === '--entry-structure' ? 'entryStructure' : flag.slice(2);
    if (options[key] !== undefined) throw Error(USAGE);
    options[key] = value;
  }
  return options;
}

export function runDispatchCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    const input = parse(argv);
    const plan = resolveDispatch(input);
    stdout.write(JSON.stringify(plan) + '\n');
    return 0;
  } catch (error) {
    const code = error?.code && /^DISPATCH_/.test(error.code) ? error.code : 'DISPATCH_CLI_USAGE';
    stderr.write(JSON.stringify({ ok: false, code, message: error?.message ?? USAGE }) + '\n');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runDispatchCli(process.argv.slice(2));
}
