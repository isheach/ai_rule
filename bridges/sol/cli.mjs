#!/usr/bin/env node
import { redact } from '../dsh/core.mjs';
import { issueContext } from '../pool/context.mjs';
import { loadSolConfig, openAIEnvironment, SERVICE } from './config.mjs';
import { ResponsesClient } from './responses.mjs';

let responses;
try {
  const [command, flag, filename, ...extra] = process.argv.slice(2);
  if (extra.length || flag !== '--config' || !['context', 'verify-api'].includes(command)) {
    throw Error('Usage: cli.mjs context --config ABS | cli.mjs verify-api --config ABS');
  }
  const config = loadSolConfig(filename);
  let result;
  if (command === 'context') result = issueContext({ config: config.contextConfig, purpose: SERVICE });
  else {
    responses = new ResponsesClient({ config, credential: openAIEnvironment(config) });
    result = await responses.verify();
  }
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  const message = responses ? responses.sanitize(error.message) : redact(error.message);
  process.stderr.write(JSON.stringify({ error: message, ...(error.code ? { code: error.code } : {}),
    ...(error.evidence ? { evidence: error.evidence } : {}), ...(error.usageUnknown ? { usage_unknown: true } : {}) }) + '\n');
  process.exitCode = 1;
}
