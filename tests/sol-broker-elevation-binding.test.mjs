import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareElevation } from '../scripts/sol-setup.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bootstrapPath = 'scripts/sol-broker-elevated.ps1';
const brokerDirectory = 'bridges/sol/broker/windows';
const brokerFiles = ['install.ps1', 'build.ps1', 'Protocol.cs', 'WindowsPipe.cs', 'BrokerState.cs', 'Upstream.cs', 'Program.cs'];
const read = relative => fs.readFileSync(path.join(repo, relative), 'utf8');
const elevated = read(bootstrapPath);
const powershell = process.platform === 'win32'
  ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : null;
const hasWindowsPowerShell = Boolean(powershell && fs.existsSync(powershell));

function sources() {
  const map = new Map();
  for (const name of brokerFiles) map.set(`${brokerDirectory}/${name}`, fs.readFileSync(path.join(repo, brokerDirectory, name)));
  map.set(bootstrapPath, fs.readFileSync(path.join(repo, bootstrapPath)));
  return map;
}

function elevation(action, setKey = true) {
  return prepareElevation(sources(), {
    bundlePath: 'C:\\Temp\\broker-source.json',
    clientSid: 'S-1-5-21-1-2-3-4',
    model: 'gpt-6.2-sol',
    effort: 'max',
    project: 'proj_ci_example',
    organization: 'org-ci-example',
    action,
    setKey
  });
}

function switchParameters(name) {
  const pattern = new RegExp(`((?:\\s*\\[Parameter\\([^\\]]+\\)\\])+)\\s*\\[switch\\]\\$${name}\\b`);
  return pattern.exec(elevated)?.[1] ?? '';
}

function parameterBlock() {
  const start = elevated.indexOf('[CmdletBinding(');
  const paramStart = elevated.indexOf('param(', start);
  const end = elevated.indexOf('\n)', paramStart);
  if (start < 0 || paramStart < 0 || end < 0) throw Error('The bootstrap parameter block could not be extracted.');
  return elevated.slice(start, end + 2);
}

function bind(invocation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sol-broker-binding-'));
  const probe = path.join(directory, 'probe.ps1');
  const runner = path.join(directory, 'runner.ps1');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  fs.writeFileSync(probe, [
    parameterBlock(),
    '$result = [pscustomobject]@{',
    '    ParameterSetName = $PSCmdlet.ParameterSetName',
    '    Install = [bool]$Install',
    '    SetKey = [bool]$SetKey',
    '    ValidateExisting = [bool]$ValidateExisting',
    '    EnableTerraApi = [bool]$EnableTerraApi',
    '    EnableLunaApi = [bool]$EnableLunaApi',
    '    RequestsPerHour = $RequestsPerHour',
    '    AllowBriefRestart = [bool]$AllowBriefRestart',
    '}',
    '$result | ConvertTo-Json -Compress',
    ''
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(runner, `& ${quote(probe)} ${invocation}\r\n`, 'utf8');
  try {
    return spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner], {
      encoding: 'utf8', windowsHide: true, timeout: 30000
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('existing-broker elevation omits -Install and selects its set explicitly', () => {
  const enroll = elevation('Enroll');
  assert.match(enroll.invocation, /-SetKey -ValidateExisting$/);
  assert.doesNotMatch(enroll.invocation, /(?:^|\s)-Install(?:\s|$)/);
  assert.match(elevation('Install').invocation, /-Install -SetKey$/);
  assert.match(elevation('Install', false).invocation, /-Install$/);

  const validate = switchParameters('ValidateExisting');
  assert.match(validate, /ParameterSetName = 'SetKey'/);
  assert.match(validate, /Mandatory/);
  assert.doesNotMatch(validate, /ParameterSetName = 'Install'\)/);

  // -SetKey remains valid for the install-then-enroll path. -ValidateExisting
  // is the selector that keeps the existing-broker call out of Install.
  const setKey = switchParameters('SetKey');
  assert.match(setKey, /ParameterSetName = 'Install'\)/);
  assert.match(setKey, /ParameterSetName = 'SetKey'/);

  const install = switchParameters('Install');
  assert.match(install, /ParameterSetName = 'Install'\)/);
});

test('Windows PowerShell binds existing, fresh and Luna upgrade elevation call shapes', (t) => {
  if (!hasWindowsPowerShell) {
    t.skip('Windows PowerShell 5.1 is not available on this host.');
    return;
  }
  const empty = { Install: false, SetKey: false, ValidateExisting: false, EnableTerraApi: false,
    EnableLunaApi: false, RequestsPerHour: 0, AllowBriefRestart: false };
  const luna = prepareElevation(sources(), {
    bundlePath: 'C:\\Temp\\broker-source.json', enableLunaApi: true, requestsPerHour: 96, allowBriefRestart: true
  });
  for (const [name, request, expected] of [
    ['existing', elevation('Enroll'), { ParameterSetName: 'SetKey', SetKey: true, ValidateExisting: true }],
    ['fresh with enrollment', elevation('Install'), { ParameterSetName: 'Install', Install: true, SetKey: true }],
    ['fresh install only', elevation('Install', false), { ParameterSetName: 'Install', Install: true }],
    ['Luna upgrade', luna, { ParameterSetName: 'EnableLunaApi', EnableLunaApi: true,
      RequestsPerHour: 96, AllowBriefRestart: true }]
  ]) {
    const result = bind(request.invocation);
    assert.equal(result.error, undefined, `${name}: ${result.error?.message ?? ''}`);
    assert.equal(result.status, 0, `${name}: ${result.stderr || result.stdout}`);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { ...empty, ...expected }, name);
  }
});
