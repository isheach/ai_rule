#!/usr/bin/env node
// Terra CLI. Three deliberately separate reports:
//   status       read-only broker status, no response operation, no billing
//   verify-api   one real confirm_terra_api request, explicit billing consent
//   acceptance   one bounded read-only action run, explicit billing consent
//
// There is no argument for a URL, API key, credential source, model, effort,
// script, path, log, or broker. Unknown arguments are refused before any broker
// call. The broker status is checked again inside the protected client before
// every response.

import { pathToFileURL } from 'node:url';
import { CONFIRM_TOOL, TERRA_MODEL, TERRA_REASONING_EFFORT, TerraError } from './client.mjs';
import {
  createProtectedTerraClient,
  readTerraStatus,
  summarizeTerraAcceptance,
  TERRA_ACCEPTANCE_ACTION,
  TERRA_ACCEPTANCE_INPUT,
  TERRA_ACCEPTANCE_LIMITS,
  TerraProviderError
} from './protected.mjs';

const USAGE = 'Usage: node bridges/terra/cli.mjs status | verify-api --accept-terra-charges | acceptance --accept-terra-charges';
const RESPONSE_ID = /^resp_[A-Za-z0-9_-]{1,190}$/;
const PRE_SEND = new Set([
  'TERRA_CONTRACT',
  'TERRA_OPTIONS_FORBIDDEN',
  'TERRA_INPUT_LIMIT'
]);

export class TerraCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TerraCliError';
    this.code = code;
    this.exitCode = 2;
  }
}

function usageError() {
  return new TerraCliError('TERRA_CLI_USAGE', USAGE);
}

export function parseTerraCliArgs(argv) {
  if (!Array.isArray(argv)) throw usageError();
  const [command, ...rest] = argv;
  if (command === 'status') {
    if (rest.length !== 0) throw usageError();
    return { command };
  }
  if (command === 'verify-api' || command === 'acceptance') {
    if (rest.length === 0) {
      throw new TerraCliError('TERRA_CLI_CONSENT_REQUIRED',
        'This command can submit a billable Terra request and requires explicit --accept-terra-charges consent.');
    }
    if (rest.length !== 1 || rest[0] !== '--accept-terra-charges') throw usageError();
    return { command, acceptCharges: true };
  }
  throw usageError();
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function pickUsage(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = count(value.input_tokens);
  const output = count(value.output_tokens);
  const total = count(value.total_tokens);
  if (input === null || output === null || total === null) return null;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Math.max(total, input + output),
    cached_input_tokens: count(value.input_tokens_details?.cached_tokens)
      ?? count(value.cached_input_tokens) ?? 0,
    reasoning_tokens: count(value.output_tokens_details?.reasoning_tokens)
      ?? count(value.reasoning_tokens) ?? 0
  };
}

function pickResponseIds(state) {
  if (!Array.isArray(state?.evidence)) return [];
  return state.evidence
    .map(entry => typeof entry?.response_id === 'string' && RESPONSE_ID.test(entry.response_id)
      ? entry.response_id : null)
    .filter(Boolean);
}

function safeCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value)
    ? value : 'TERRA_CLI_FAILURE';
}

function failureReport(command, error) {
  if (error instanceof TerraProviderError) {
    return {
      command,
      ok: false,
      status: 'failed',
      phase: 'response',
      error: {
        code: error.code,
        status: error.status,
        known: error.known,
        usage_unknown: error.usageUnknown,
        request_sent: error.requestSent,
        usage: error.usage,
        response_ids: [...error.responseIds]
      },
      billing: error.usage ? 'incurred' : error.known ? 'none' : 'unknown'
    };
  }
  if (error instanceof TerraError) {
    const state = error.state ?? {};
    const responseIds = pickResponseIds(state);
    const usage = pickUsage(state.usage);
    const preSend = PRE_SEND.has(error.code) && responseIds.length === 0 && usage === null;
    const known = preSend || usage !== null;
    return {
      command,
      ok: false,
      status: 'failed',
      phase: 'response',
      error: {
        code: safeCode(error.code),
        status: null,
        known,
        usage_unknown: !known,
        request_sent: preSend ? false : responseIds.length || usage ? true : null,
        usage,
        response_ids: responseIds
      },
      billing: usage ? 'incurred' : preSend ? 'none' : 'unknown'
    };
  }
  return {
    command,
    ok: false,
    status: 'failed',
    phase: 'response',
    error: {
      code: 'TERRA_CLI_FAILURE',
      status: null,
      known: false,
      usage_unknown: true,
      request_sent: null,
      usage: null,
      response_ids: []
    },
    billing: 'unknown'
  };
}

async function execute(options) {
  if (options.command === 'status') {
    const status = await readTerraStatus();
    return {
      command: 'status',
      ...status,
      billing: 'none',
      note: 'Read-only broker status. No response operation was sent.'
    };
  }

  const preflight = await readTerraStatus();
  if (preflight.ready !== true) {
    return {
      command: options.command,
      ok: false,
      status: 'not_ready',
      phase: 'status',
      error: {
        code: preflight.code ?? 'TERRA_BROKER_NOT_READY',
        status: preflight.status ?? null,
        known: true,
        usage_unknown: false,
        request_sent: false
      },
      readiness: preflight,
      billing: 'none'
    };
  }

  if (options.command === 'verify-api') {
    const client = createProtectedTerraClient();
    const result = await client.confirm();
    const usage = pickUsage(result.usage);
    const responseId = typeof result.response_id === 'string' && RESPONSE_ID.test(result.response_id)
      ? result.response_id : null;
    if (result.confirmed !== true || result.model !== TERRA_MODEL || !responseId || usage === null) {
      throw new TerraError('TERRA_VERIFY_INCOMPLETE',
        'confirm_terra_api did not return complete confirmation evidence.',
        {
          evidence: result.evidence ? [result.evidence] : [],
          usage: result.usage
        });
    }
    return {
      command: 'verify-api',
      ok: true,
      status: 'verified',
      confirmed: true,
      response_id: responseId,
      model: TERRA_MODEL,
      reasoning_effort: TERRA_REASONING_EFFORT,
      usage,
      confirm_tool: result.evidence?.tool === CONFIRM_TOOL ? CONFIRM_TOOL : null,
      billing: 'incurred',
      note: 'confirm_terra_api returned this response. Usage is returned metadata, not a billing statement.'
    };
  }

  const client = createProtectedTerraClient({
    actions: [TERRA_ACCEPTANCE_ACTION],
    limits: TERRA_ACCEPTANCE_LIMITS
  });
  const result = await client.run({ input: TERRA_ACCEPTANCE_INPUT });
  return {
    command: 'acceptance',
    ...summarizeTerraAcceptance(result),
    billing: 'incurred'
  };
}

export async function runTerraCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let options;
  try {
    options = parseTerraCliArgs(argv);
  } catch (error) {
    const code = error?.code === 'TERRA_CLI_CONSENT_REQUIRED'
      ? 'TERRA_CLI_CONSENT_REQUIRED' : 'TERRA_CLI_USAGE';
    stderr.write(JSON.stringify({ ok: false, code, message: error?.message ?? USAGE }) + '\n');
    return 2;
  }
  try {
    const report = await execute(options);
    stdout.write(JSON.stringify(report) + '\n');
    return report.ok === false || report.ready === false ? 1 : 0;
  } catch (error) {
    const report = failureReport(options.command, error);
    stdout.write(JSON.stringify(report) + '\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runTerraCli(process.argv.slice(2));
  process.exitCode = code;
}
