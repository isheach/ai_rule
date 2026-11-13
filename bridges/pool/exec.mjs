#!/usr/bin/env node
// Compatibility/diagnostic one-shot runner. The production path is the pooled
// stdio MCP server; this wrapper uses the SAME service, strict pool handles and
// routing coordinator so no second routing stack exists.
import fs from 'node:fs';
import path from 'node:path';
import { loadPoolConfig, PoolService } from './service.mjs';
import { loadSchedule } from '../dsh/schedule.mjs';
import { resolveRootChain } from './host.mjs';
import { discoverDsh, redact } from '../dsh/core.mjs';

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const fail = (message, code = 1) => { console.error(JSON.stringify({ error: redact(message) })); process.exit(code); };
const configPath = opt('config');
if (!configPath || !path.isAbsolute(configPath)) fail('--config must be an absolute path');
let config, service;
try {
  config = loadPoolConfig(configPath);
  const childId = process.env.CODEX_THREAD_ID;
  if (!childId) fail('CODEX_THREAD_ID is unavailable; refusing to guess a root');
  const resolved = resolveRootChain({ childId });
  const inputFile = opt('input');
  let raw;
  try { raw = inputFile ? fs.readFileSync(inputFile, 'utf8') : fs.readFileSync(0, 'utf8'); } catch { fail('request input unreadable'); }
  let input;
  try { input = JSON.parse(raw); } catch { fail('request JSON invalid'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('request must be an object');
  if (!['run', 'get', 'wait', 'cancel'].includes(input.action)) fail('action must be run/get/wait/cancel');
  service = new PoolService({
    config, schedule: loadSchedule(config.schedule_config),
    allowWriteCli: argv.includes('--allow-write'), clock: () => new Date()
  });
  const locator = input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : { taskId: input.taskId };
  if (!locator.idempotencyKey && !locator.taskId) fail('idempotencyKey or taskId required');
  let result;
  if (input.action === 'run') {
    const task = {
      prompt: input.prompt, cwd: input.cwd, idempotencyKey: input.idempotencyKey,
      timeoutMs: input.timeoutMs ?? 900000, permissionMode: input.permissionMode ?? 'read-only',
      ...(input.capability ? { capability: input.capability } : {}),
      ...(input.authorizationNote ? { authorizationNote: input.authorizationNote } : {}),
      ...(input.writes ? { writes: input.writes } : {}),
      ...(input.writeScopes ? { writeScopes: input.writeScopes } : {}),
      ...(input.commands ? { commands: input.commands } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {})
    };
    result = await service.run(resolved.rootChatId, task);
  } else if (input.action === 'get') {
    result = service.get(resolved.rootChatId, locator);
  } else if (input.action === 'wait') {
    result = await service.wait(resolved.rootChatId, locator, input.waitMs ?? 25000);
  } else {
    result = await service.cancel(resolved.rootChatId, locator);
  }
  const receipt = result.receipt ?? null;
  process.stdout.write(JSON.stringify({
    task_id: result.task_id, status: result.status, backend: result.backend,
    receipt_path: receipt?.receipt_path ?? null, answer: receipt?.answer ?? null
  }) + '\n');
  await service.close();
  process.exit(input.action === 'run' && result.status !== 'completed' ? 2 : 0);
} catch (error) {
  try { await service?.close(); } catch {}
  fail(error.message);
}
