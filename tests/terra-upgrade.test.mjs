import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { prepareElevation } from '../scripts/sol-setup.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brokerDirectory = 'bridges/sol/broker/windows';
const brokerFiles = ['install.ps1', 'build.ps1', 'Protocol.cs', 'WindowsPipe.cs', 'BrokerState.cs', 'Upstream.cs', 'Program.cs'];
const bootstrapPath = 'scripts/sol-broker-elevated.ps1';
const read = relative => fs.readFileSync(path.join(repo, relative), 'utf8');
const install = read(`${brokerDirectory}/install.ps1`);
const setup = read('scripts/setup-sol.ps1');
const elevated = read(bootstrapPath);
const helper = read('scripts/sol-setup.mjs');

function sources() {
  const map = new Map();
  for (const name of brokerFiles) map.set(`${brokerDirectory}/${name}`, fs.readFileSync(path.join(repo, brokerDirectory, name)));
  map.set(bootstrapPath, fs.readFileSync(path.join(repo, bootstrapPath)));
  return map;
}

test('typed-null is used for all three File.Replace backup parameters', () => {
  const calls = [...install.matchAll(/\[IO\.File\]::Replace\([^\r\n]*\)/g)].map(match => match[0]);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call, /\[System\.Management\.Automation\.Language\.NullString\]::Value/);
  }
  assert.doesNotMatch(install, /\[IO\.File\]::Replace\([^\r\n]*,\s*\$null\s*\)/);
});

test('Terra elevation carries explicit consent through the fixed bootstrap only', () => {
  const normal = prepareElevation(sources(), { bundlePath: 'C:\\Temp\\broker-source.json', enableTerraApi: true });
  assert.match(normal.invocation, /-EnableTerraApi/);
  assert.doesNotMatch(normal.invocation, /AllowBriefRestart/);

  const consented = prepareElevation(sources(), {
    bundlePath: 'C:\\Temp\\broker-source.json', enableTerraApi: true, allowBriefRestart: true
  });
  assert.match(consented.invocation, /-EnableTerraApi -AllowBriefRestart/);
  assert.ok(Buffer.from(consented.encodedCommand, 'base64').toString('utf16le').includes(consented.invocation));

  assert.throws(() => prepareElevation(sources(), {
    bundlePath: 'C:\\Temp\\broker-source.json', clientSid: 'S-1-5-21-1-2-3-4', model: 'gpt-6.2-sol', effort: 'max',
    action: 'Install', allowBriefRestart: true
  }), /only for the reviewed API role elevation/);
});

test('Luna elevation selects one protected role and preserves operator choices', () => {
  const bundlePath = "C:\\Temp\\owner's broker-source.json";
  const normal = prepareElevation(sources(), { bundlePath, enableLunaApi: true });
  assert.match(normal.invocation, /-EnableLunaApi$/);
  assert.match(normal.invocation, /owner''s broker-source/);
  assert.doesNotMatch(normal.invocation, /EnableTerraApi|SetKey|ClientSid|ProjectId|RequestsPerHour|AllowBriefRestart/);
  assert.ok(Buffer.from(normal.encodedCommand, 'base64').toString('utf16le').includes(normal.invocation));

  const maintenance = prepareElevation(sources(), {
    bundlePath, enableLunaApi: true, requestsPerHour: 100, allowBriefRestart: true
  });
  assert.match(maintenance.invocation, /-EnableLunaApi -RequestsPerHour 100 -AllowBriefRestart$/);
  assert.throws(() => prepareElevation(sources(), { bundlePath, enableLunaApi: true, enableTerraApi: true }),
    /Enable one broker role/);
  assert.throws(() => prepareElevation(sources(), { bundlePath, enableLunaApi: true, action: 'Enroll' }),
    /separate elevation action/);
});

test('reviewed elevation fits Windows command limits with CRLF and long paths', () => {
  const reviewed = sources();
  const lf = reviewed.get(bootstrapPath).toString('utf8').replace(/\r\n/g, '\n');
  const bundlePath = "C:\\Users\\operator's profile\\AppData\\Local\\Temp\\" +
    'approved-'.repeat(19) + '项目\\broker-source.json';
  const route = { clientSid: 'S-1-5-21-1200-1300-1400-1500', model: 'gpt-6.2-sol', effort: 'max',
    project: 'proj_' + 'p'.repeat(140), organization: 'org-' + 'o'.repeat(140) };
  const modes = [
    [{ ...route, action: 'Install', setKey: true }, /-Install -SetKey$/],
    [{ ...route, action: 'Enroll' }, /-SetKey -ValidateExisting$/],
    [{ enableTerraApi: true, requestsPerHour: 100, allowBriefRestart: true }, /-EnableTerraApi -RequestsPerHour 100 -AllowBriefRestart$/],
    [{ enableLunaApi: true, requestsPerHour: 96, allowBriefRestart: true }, /-EnableLunaApi -RequestsPerHour 96 -AllowBriefRestart$/]
  ];
  for (const script of [lf, lf.replace(/\n/g, '\r\n')]) {
    const bytes = Buffer.from(script, 'utf8');
    reviewed.set(bootstrapPath, bytes);
    for (const [options, expected] of modes) {
      const result = prepareElevation(reviewed, { bundlePath, ...options });
      assert.ok(result.encodedCommand.length <= 30000);
      const command = Buffer.from(result.encodedCommand, 'base64').toString('utf16le');
      const payload = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(command);
      assert.ok(payload, 'Reviewed bootstrap must be present in the encoded command.');
      assert.deepEqual(gunzipSync(Buffer.from(payload[1], 'base64')), bytes);
      assert.ok(command.includes(result.invocation));
      assert.match(result.invocation, expected);
    }
  }
  assert.throws(() => prepareElevation(reviewed, { bundlePath: 'x'.repeat(12000), enableLunaApi: true }), /exceeds its size limit/);
});

test('explicit 100/hour opt-in is bounded and carried through the fixed elevation', () => {
  const quota = prepareElevation(sources(), {
    bundlePath: 'C:\\Temp\\broker-source.json', enableTerraApi: true, requestsPerHour: 100, allowBriefRestart: true
  });
  assert.match(quota.invocation, /-EnableTerraApi -RequestsPerHour 100 -AllowBriefRestart$/);
  assert.ok(Buffer.from(quota.encodedCommand, 'base64').toString('utf16le').includes(quota.invocation));

  const quiet = prepareElevation(sources(), {
    bundlePath: 'C:\\Temp\\broker-source.json', enableTerraApi: true, requestsPerHour: 100
  });
  assert.match(quiet.invocation, /-EnableTerraApi -RequestsPerHour 100$/);
  assert.doesNotMatch(quiet.invocation, /AllowBriefRestart/);

  // 96 remains a valid previous explicit value and is carried verbatim when an
  // operator deliberately requests it; it is not an implicit upgrade target.
  const previous = prepareElevation(sources(), {
    bundlePath: 'C:\\Temp\\broker-source.json', enableTerraApi: true, requestsPerHour: 96
  });
  assert.match(previous.invocation, /-EnableTerraApi -RequestsPerHour 96$/);

  for (const invalid of [0, -1, 1001, 100.5, '100']) {
    assert.throws(() => prepareElevation(sources(), {
      bundlePath: 'C:\\Temp\\broker-source.json', enableTerraApi: true, requestsPerHour: invalid
    }), /hourly quota/);
  }
  assert.throws(() => prepareElevation(sources(), {
    bundlePath: 'C:\\Temp\\broker-source.json', clientSid: 'S-1-5-21-1-2-3-4', model: 'gpt-6.2-sol', effort: 'max',
    action: 'Install', requestsPerHour: 100
  }), /only for the reviewed installed-broker quota elevation/);

  assert.match(install, /\[Parameter\(ParameterSetName = 'EnableTerraApi'\)\]\[ValidateRange\(1, 1000\)\]\[int\]\$RequestsPerHour/);
  assert.match(install, /requests_per_hour = 100/);
  assert.match(install, /This operation only raises the bound/);
  assert.match(setup, /\[ValidateRange\(1, 1000\)\]\[int\]\$RequestsPerHour/);
  assert.match(setup, /--requests-per-hour/);
  assert.match(setup, /-RequestsPerHour \{0\}/);
  assert.match(setup, /new_protected_install = 100/);
  assert.match(helper, /maxRequestsPerHour = 1000/);
  assert.match(helper, /NEW_INSTALL_REQUESTS_PER_HOUR = 100/);
  assert.match(helper, /LEGACY_REQUESTS_PER_HOUR = 24/);
  assert.match(helper, /'requests-per-hour'/);
  assert.match(elevated, /\[ValidateRange\(1, 1000\)\]\[int\]\$RequestsPerHour/);
  assert.match(elevated, /\$parameters\.RequestsPerHour = \$RequestsPerHour/);
});

test('ordinary entry accepts -AllowBriefRestart only for an applied API role upgrade', () => {
  assert.match(setup, /\[switch\]\$AllowBriefRestart/);
  assert.match(setup, /if \(\$AllowBriefRestart -and \(-not \$upgradeRequested -or -not \$Apply\)\)/);
  assert.match(setup, /--allow-brief-restart/);
  assert.match(setup, /\{2\}\{3\} -AllowBriefRestart -Apply/);
  assert.match(setup, /apply_command_with_brief_restart/);
  assert.match(setup, /no_atomic_drain = \$true/);
  assert.match(setup, /residual_race = 'The old service has no atomic drain/);
  assert.match(setup, /client_sampling = 'Five short-interval read-only samples/);
  assert.match(helper, /'allow-brief-restart': \{ type: 'boolean' \}/);
  assert.match(helper, /upgrade\?\.\[2\] !== 'elevation'/);
  assert.match(helper, /allowBriefRestart: opts\['allow-brief-restart'\] === true/);
  assert.match(elevated, /\[switch\]\$AllowBriefRestart/);
  assert.match(elevated, /\$parameters\.AllowBriefRestart = \$true/);
  assert.match(install, /\[Parameter\(ParameterSetName = 'EnableTerraApi'\)\]\[switch\]\$AllowBriefRestart/);
});

test('the protected gate follows compile, exact backup and policy preparation', () => {
  const build = install.indexOf("& (Join-Path $PSScriptRoot 'build.ps1') -OutputPath $candidateExe");
  const policy = install.indexOf('$newPolicy = New-BrokerUpgradePolicy $currentPolicy $enableField $changeQuota $RequestsPerHour');
  const backup = install.indexOf('Copy-ExactBrokerFile $exe $backupExe');
  const transaction = install.indexOf('[IO.File]::WriteAllText($transactionFile');
  const gate = install.indexOf('# Phase 2: authoritative local gate');
  const idle = install.indexOf('Wait-ForIdleBrokerClients $gate');
  const stop = install.search(/^[ \t]*Stop-BrokerServiceOnce[ \t]*\r?$/m);
  const replace = install.indexOf('[IO.File]::Replace($candidateExe');
  for (const [name, index] of Object.entries({ build, policy, backup, transaction, gate, idle, stop, replace })) {
    assert.ok(index >= 0, `${name} marker is missing`);
  }
  assert.ok(build < policy && policy < backup && backup < transaction && transaction < gate);
  assert.ok(gate < idle && idle < stop && stop < replace);
});

test('the gate verifies fixed registration, account, stable state and PID', () => {
  assert.match(install, /Get-CimInstance -ClassName Win32_Service/);
  assert.match(install, /\$registered\.PathName -cne \$image/);
  assert.match(install, /\$registered\.StartName -cne \$account/);
  assert.match(install, /\$registered\.State -cne \$state/);
  assert.match(install, /did not report a stable process ID/);
  assert.match(install, /changed from \{0\} \(PID \{1\}\) to \{2\} \(PID \{3\}\)/);
});

test('client sampling is read-only, repeated and fail-closed without killing callers', () => {
  assert.match(install, /\$samples = 5/);
  assert.match(install, /\$intervalMilliseconds = 600/);
  assert.match(install, /Start-Sleep -Milliseconds \$intervalMilliseconds/);
  assert.match(install, /Get-CimInstance -ClassName Win32_Process/);
  assert.match(install, /ExecutablePath/);
  assert.match(install, /could not be read; the upgrade is refused/);
  assert.match(install, /different image path is verified unrelated/);
  assert.match(install, /Assert-BrokerCanStop/);
  assert.match(install, /They were not stopped or forced/);
  assert.doesNotMatch(install, /\.Kill\(|taskkill|Stop-Process/);
  assert.doesNotMatch(install, /Invoke-ServiceTool @\('stop'/);
});

test('exactly one stop/start is used and stop recovery is armed before the call', () => {
  const armed = install.indexOf('$stopRequested = $true');
  const stop = install.indexOf('Stop-BrokerServiceOnce', armed);
  assert.ok(armed >= 0 && stop > armed && stop - armed < 200);
  const running = install.indexOf("if ($originalState -eq 'Running')");
  assert.ok(running > stop);
  assert.match(install, /Start-Service -Name \$name/);
  assert.match(install, /state Running after exactly one explicit-consent stop and restart/);
  assert.match(install, /Stopped \(unchanged; it was not started\)/);
  assert.match(install, /The runtime service identity\/DPAPI check was not run because the service remained stopped/);
});

test('rollback restores files before state and preserves evidence when incomplete', () => {
  assert.match(install, /Restore-ExactBrokerFile \$backupPolicy/);
  assert.match(install, /Restore-ExactBrokerFile \$backupExe/);
  assert.match(install, /\$filesRestored = -not \(\$exeReplaced -or \$policyReplaced\)/);
  assert.match(install, /Only restore the original running state after both original files are back and verified/);
  assert.match(install, /if \(\$filesRestored\) \{/);
  assert.match(install, /\$preserveForRecovery = \$true/);
  assert.match(install, /ROLLBACK-FAILED\.txt/);
  assert.match(install, /Actual service state: \{2\}/);
  assert.match(install, /Recovery material is preserved at \{4\}/);
});
