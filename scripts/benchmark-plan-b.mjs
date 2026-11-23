#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = 1;
const SCENARIOS = [
  {
    id: 'simple-routing-input',
    label: 'Simple route parsing',
    file: 'tests/framework.test.mjs',
    test: 'route parser ignores unrelated web search route',
    fixture: 'Pure input parsing and route validation.',
  },
  {
    id: 'multi-file-project',
    label: 'Two-file project workflow',
    file: 'tests/workbuddy-project.test.mjs',
    test: 'one stdio project entry accepts two different papers and a subdirectory created after startup',
    fixture: 'Offline fake SDK reads two input files, writes one report, and replays each request.',
  },
  {
    id: 'independent-parallel',
    label: 'Independent parallel tasks',
    file: 'tests/multisession.test.mjs',
    test: 'independent instances run mock DSH children with overlapping lifetimes',
    fixture: 'Two mock DSH children run concurrently in separate instances and workspaces.',
  },
  {
    id: 'recovery-replay',
    label: 'Recovery and same-key replay',
    file: 'tests/workbuddy-project.test.mjs',
    test: 'same-key replay and original session scope survive a second process; an unknown submission retains its lock',
    fixture: 'Offline project SDK exercises replay, continuation, and an unknown disconnect receipt.',
    asserts: { sameSessionRevisions: 1, sdkPrompts: 3, duplicateExecutions: 0, replayOwner: false },
  },
  {
    id: 'same-session-revision',
    label: 'Original Sol executor session revision',
    file: 'tests/sol.test.mjs',
    test: 'API Sol calls real pooled DSH, inspects and revises the original session with complete usage and lineage',
    fixture: 'The protected loop uses an injected broker and mock DSH; the two revisions carry the same executor session.',
    asserts: { sameSessionRevisions: 1, executorReceipts: 2, responseReceipts: 3 },
  },
  {
    id: 'controlled-failure',
    label: 'Failure and partial write handling',
    file: 'tests/hy4-native.test.mjs',
    test: 'scope outside the target, edit-created files and mixed terminal states fail safely',
    fixture: 'Fake ACP presents denied and mixed write outcomes; no external ACP is started.',
  },
  {
    id: 'disconnect-ownership',
    label: 'Disconnected owner handling',
    file: 'tests/multisession.test.mjs',
    test: 'a non-owning bridge can read a disconnected receipt but cannot cancel or duplicate it',
    fixture: 'Mock child and second local bridge exercise unknown state and owner-only cancellation.',
    asserts: { observerCanCancel: false, duplicateExecutions: 0, originalOwnerCanCancel: true },
  },
  {
    id: 'path-boundary',
    label: 'Workspace path boundary',
    file: 'tests/hy4-native.test.mjs',
    test: 'outside exact paths and sensitive lexical paths are rejected before spawn',
    fixture: 'Synthetic workspace and fake ACP; validates outside and sensitive path refusal.',
  },
  {
    id: 'public-routing',
    label: 'Public coordinator routing',
    file: 'tests/layered-dispatch.test.mjs',
    test: 'public dispatch routes general work through the Sol coordinator before the selected DSF backend',
    fixture: 'Injected coordinator and DSF adapters record the selected path; no model request occurs.',
  },
  {
    id: 'broker-usage-unknown',
    label: 'Broker disconnect and unknown usage',
    file: 'tests/terra-protected.test.mjs',
    test: 'an interrupted broker call is unknown and never retried',
    fixture: 'Injected in-memory broker transport asserts unknown usage and exactly one response attempt.',
    asserts: { simulatedResponseAttempts: 1, duplicateExecutions: 0 },
    usageAssertion: 'The selected fixture asserts usageUnknown=true; this is protocol behavior, not measured API usage.',
  },
  {
    id: 'broker-provider-failure',
    label: 'Broker provider failure and usage evidence',
    file: 'tests/terra-protected.test.mjs',
    test: 'a provider HTTP failure preserves code/status and does not claim known usage',
    fixture: 'Injected in-memory provider failure; test asserts usageUnknown=true and usage=null.',
    usageAssertion: 'The selected fixture asserts unknown usage; this is protocol behavior, not measured API usage.',
  },
];

function usage() {
  return [
    'Usage: node scripts/benchmark-plan-b.mjs <baseline-dir> <candidate-dir> [--repeat=N] [--timeout-ms=N] [--out=FILE]',
    'Runs paired, offline node:test scenarios with isolated temporary directories.',
  ].join('\n');
}

function parseArgs(args) {
  const positionals = [];
  const options = { repeat: 1, timeoutMs: 60_000, output: null };
  for (const arg of args) {
    if (arg.startsWith('--repeat=')) options.repeat = Number(arg.slice('--repeat='.length));
    else if (arg.startsWith('--timeout-ms=')) options.timeoutMs = Number(arg.slice('--timeout-ms='.length));
    else if (arg.startsWith('--out=')) options.output = arg.slice('--out='.length);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positionals.push(arg);
  }
  if (options.help) return options;
  if (positionals.length !== 2) throw new Error(usage());
  if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 20) {
    throw new Error('--repeat must be an integer from 1 to 20');
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 600_000) {
    throw new Error('--timeout-ms must be an integer from 1000 to 600000');
  }
  options.baseline = path.resolve(positionals[0]);
  options.candidate = path.resolve(positionals[1]);
  if (options.output) options.output = path.resolve(options.output);
  return options;
}

function repoInfo(root) {
  const packageFile = path.join(root, 'package.json');
  if (!fs.statSync(root).isDirectory() || !fs.statSync(packageFile).isFile()) {
    throw new Error(`Not a repository root with package.json: ${root}`);
  }
  for (const scenario of SCENARIOS) {
    if (!fs.statSync(path.join(root, scenario.file), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Missing benchmark test ${scenario.file} in ${root}`);
    }
  }
  const revision = git(root, ['rev-parse', '--verify', 'HEAD']) || null;
  const dirty = git(root, ['status', '--porcelain']);
  return {
    path: root,
    revision,
    dirtyFileCount: dirty ? dirty.split('\n').filter(Boolean).length : 0,
  };
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

function quoteRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeEnv(caseRoot) {
  const keep = new Set([
    'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT',
    'LANG', 'LC_ALL', 'TZ',
  ]);
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (keep.has(key)) env[key] = value;
  }
  env.HOME = caseRoot;
  env.USERPROFILE = caseRoot;
  env.TMPDIR = caseRoot;
  env.TMP = caseRoot;
  env.TEMP = caseRoot;
  env.CI = '1';
  return env;
}

function parseTap(output, expectedName) {
  const counts = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const found = output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
    counts[name] = found ? Number(found[1]) : null;
  }
  const expectedLine = new RegExp(`^ok \\d+ - ${quoteRegex(expectedName)}$`, 'm');
  const failedExpectedLine = new RegExp(`^not ok \\d+ - ${quoteRegex(expectedName)}(?: \\(.+\\))?$`, 'm');
  return {
    counts,
    expectedTestPassed: expectedLine.test(output),
    expectedTestFailed: failedExpectedLine.test(output),
  };
}

async function runTest(root, scenario, side, repetition, timeoutMs) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const caseRoot = fs.mkdtempSync(path.join(tempRoot, `plan-b-${side}-${scenario.id}-`));
  const testPath = path.join(root, scenario.file);
  const pattern = `^${quoteRegex(scenario.test)}$`;
  const args = [
    '--test', '--test-concurrency=1', '--test-reporter=tap',
    '--test-name-pattern', pattern,
    testPath,
  ];
  const started = process.hrtime.bigint();
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let exitCode = null;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: root,
        env: safeEnv(caseRoot),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = [];
      const err = [];
      child.stdout.on('data', chunk => out.push(chunk));
      child.stderr.on('data', chunk => err.push(chunk));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
        killTimer.unref();
      }, timeoutMs);
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') });
      });
    });
    stdout = result.out;
    stderr = result.err;
    exitCode = result.code;
  } catch (error) {
    stderr = String(error?.stack ?? error);
  } finally {
    fs.rmSync(caseRoot, { recursive: true, force: true });
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const tap = parseTap(stdout, scenario.test);
  const passed = !timedOut && exitCode === 0 && tap.expectedTestPassed
    && !tap.expectedTestFailed && tap.counts.tests === 1 && tap.counts.pass === 1
    && tap.counts.fail === 0 && tap.counts.skipped === 0;
  const footerDuration = stdout.match(/^# duration_ms ([\d.]+)$/m);
  return {
    side,
    repetition,
    passed,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    testDurationMs: footerDuration ? Number(footerDuration[1]) : null,
    exitCode,
    timedOut,
    counts: tap.counts,
    selectedTestPassed: tap.expectedTestPassed,
    errorTail: passed ? null : `${stderr}\n${stdout}`.trim().slice(-6000),
  };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(runs) {
  const durations = runs.map(run => run.elapsedMs);
  return {
    passed: runs.every(run => run.passed),
    runs,
    passCount: runs.filter(run => run.passed).length,
    medianElapsedMs: median(durations),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const baselineInfo = repoInfo(options.baseline);
  const candidateInfo = repoInfo(options.candidate);
  const results = [];
  for (const [scenarioIndex, scenario] of SCENARIOS.entries()) {
    const baselineRuns = [];
    const candidateRuns = [];
    for (let repetition = 1; repetition <= options.repeat; repetition++) {
      const order = (scenarioIndex + repetition) % 2 === 0
        ? [['baseline', options.baseline, baselineRuns], ['candidate', options.candidate, candidateRuns]]
        : [['candidate', options.candidate, candidateRuns], ['baseline', options.baseline, baselineRuns]];
      for (const [side, root, target] of order) {
        target.push(await runTest(root, scenario, side, repetition, options.timeoutMs));
      }
    }
    const baseline = summarize(baselineRuns);
    const candidate = summarize(candidateRuns);
    results.push({
      id: scenario.id,
      label: scenario.label,
      testFile: scenario.file,
      testName: scenario.test,
      fixture: scenario.fixture,
      usageAssertion: scenario.usageAssertion ?? null,
      baseline,
      candidate,
      elapsedDeltaMs: baseline.medianElapsedMs === null || candidate.medianElapsedMs === null
        ? null : Math.round((candidate.medianElapsedMs - baseline.medianElapsedMs) * 100) / 100,
      observability: {
        repairAttempts: null,
        independentReviewCount: 0,
        executionRepetitions: options.repeat,
        taskOwner: null,
        actualUsage: null,
        usageUnknown: null,
        fixtureAssertedUnknownUsage: scenario.usageAssertion ? true : null,
        fixtureAssertions: scenario.asserts ?? null,
        note: 'node:test fixtures expose no task-owner, repair/review history, or real provider usage. Broker usageUnknown assertions are described separately and do not imply an API call.',
      },
    });
  }
  const report = {
    schemaVersion: VERSION,
    benchmark: 'Plan B offline repository test comparison',
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    repeat: options.repeat,
    timeoutMs: options.timeoutMs,
    inputs: { baseline: baselineInfo, candidate: candidateInfo },
    interpretation: {
      purpose: 'Compare deterministic existing repository test scenarios on two source trees using fresh temporary directories for every run.',
      limit: 'Elapsed time measures local test execution only. It is not production model cost, token use, repair speed, or independent review effort.',
      externalServices: 'The selected tests use local mock CLIs, fake SDK/ACP adapters, or injected broker transports. This runner passes a minimal environment and does not invoke a live model API or broker service.',
    },
    results,
    passed: results.every(item => item.baseline.passed && item.candidate.passed),
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) fs.writeFileSync(options.output, json, 'utf8');
  process.stdout.write(json);
  return report.passed ? 0 : 1;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 2;
});
