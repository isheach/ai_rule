#!/usr/bin/env node
import { redact } from '../dsh/core.mjs';
import { issueContext } from '../pool/context.mjs';
import { discardLegacyEnvironment, loadSolConfig, SERVICE } from './config.mjs';
import { ResponsesClient } from './responses.mjs';

let responses;
try {
  const [command, flag, filename, ...extra] = process.argv.slice(2);
  if (flag !== '--config' || !['context', 'broker-status', 'verify-api'].includes(command)
    || (command === 'verify-api' ? extra.length !== 1 || extra[0] !== '--accept-api-charges' : extra.length !== 0)) {
    throw Error('Use context or broker-status --config ABS for offline checks. verify-api --config ABS --accept-api-charges sends a billable model request.');
  }
  const config = loadSolConfig(filename);
  discardLegacyEnvironment(config);
  let result;
  if (command === 'context') result = issueContext({ config: config.contextConfig, purpose: SERVICE });
  else {
    responses = new ResponsesClient({ config });
    result = await responses.readiness();
    if (!result.ready) process.exitCode = 1;
    else if (command === 'verify-api') result = await responses.verify();
  }
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  const message = responses ? responses.sanitize(error.message) : redact(error.message);
  process.stderr.write(JSON.stringify({ error: message, ...(error.code ? { code: error.code } : {}),
    ...(error.evidence ? { evidence: error.evidence } : {}), ...(error.usageUnknown ? { usage_unknown: true } : {}) }) + '\n');
  process.exitCode = 1;
}
