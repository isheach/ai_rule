#!/usr/bin/env node
import { redact } from '../dsh/core.mjs';
import { issueContext } from '../pool/context.mjs';
import { resolveRootChain } from '../pool/host.mjs';
import { codexEntryCaller } from '../entry-structure.mjs';
import { discardLegacyEnvironment, loadSolConfig, SERVICE } from './config.mjs';
import { SolJournal } from './journal.mjs';
import { PEER_NAMES, peerRouteDiagnostics, ResponsesClient } from './responses.mjs';

let responses;
try {
  const [command, flag, filename, ...extra] = process.argv.slice(2);
  const probe = { 'verify-api': '--accept-api-charges', 'verify-luna-api': '--accept-luna-charges' };
  const consent = Object.hasOwn(probe, command) ? probe[command] : null;
  const setStructure = command === 'set-entry-structure';
  const getStructure = command === 'entry-structure-status';
  const validExtras = setStructure ? extra.length === 1 : consent ? extra.length === 1 && extra[0] === consent : extra.length === 0;
  if (flag !== '--config' || (!setStructure && !getStructure
    && !['context', 'broker-status', 'luna-status', 'peer-status', 'verify-api', 'verify-luna-api'].includes(command)) || !validExtras) {
    throw Error('Use context, broker-status, luna-status, peer-status, or entry-structure-status --config ABS for read-only checks. Use set-entry-structure --config ABS astra|sol to select a root entry. verify-api --config ABS --accept-api-charges and verify-luna-api --config ABS --accept-luna-charges send a billable model request.');
  }
  const config = loadSolConfig(filename);
  discardLegacyEnvironment(config);
  let result;
  if (command === 'context') result = issueContext({ config: config.contextConfig, purpose: SERVICE });
  else if (setStructure || getStructure) {
    const callerId = process.env.CODEX_THREAD_ID;
    if (!callerId) throw Error('CODEX_THREAD_ID is unavailable; refusing to guess a root.');
    const { rootChatId, childId } = resolveRootChain({ childId: callerId, allowRoot: true });
    const journal = new SolJournal(config.stateDir);
    const entry = setStructure ? journal.setEntryStructure(rootChatId, extra[0]) : journal.entryStructure(rootChatId);
    result = { ...entry, entry_caller: codexEntryCaller({ rootId: rootChatId, childId }) };
  }
  else {
    responses = new ResponsesClient({ config });
    if (command === 'luna-status' || command === 'verify-luna-api') responses = responses.forPeer('luna');
    result = await responses.readiness();
    if (command === 'luna-status') {
      const diagnostics = peerRouteDiagnostics({ peer: 'luna', ...result });
      result = { ...result, peer_route_diagnostics: { luna: diagnostics.luna } };
      if (!result.ready) process.exitCode = 1;
    } else if (command === 'peer-status') {
      const diagnostics = peerRouteDiagnostics(result);
      result = { ...result, peer_route_diagnostics: diagnostics };
      if (PEER_NAMES.some(peer => !diagnostics[peer].ready)) process.exitCode = 1;
    } else if (!result.ready) process.exitCode = 1;
    else if (consent) result = await responses.verify();
  }
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  const message = responses ? responses.sanitize(error.message) : redact(error.message);
  process.stderr.write(JSON.stringify({ error: message, ...(error.code ? { code: error.code } : {}),
    ...(error.evidence ? { evidence: error.evidence } : {}), ...(error.usageUnknown ? { usage_unknown: true } : {}) }) + '\n');
  process.exitCode = 1;
}
