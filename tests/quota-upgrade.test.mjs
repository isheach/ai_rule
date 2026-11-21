import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installQuotaPreview, LEGACY_REQUESTS_PER_HOUR, NEW_INSTALL_REQUESTS_PER_HOUR
} from '../scripts/sol-setup.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(repo, relative), 'utf8');
const protocol = read('bridges/sol/broker/windows/Protocol.cs');
const state = read('bridges/sol/broker/windows/BrokerState.cs');
const program = read('bridges/sol/broker/windows/Program.cs');
const install = read('bridges/sol/broker/windows/install.ps1');
const setup = read('scripts/setup-sol.ps1');
const helper = read('scripts/sol-setup.mjs');
const elevated = read('scripts/sol-broker-elevated.ps1');
const native = read('tests/sol-broker-windows.cs');
const docs = read('docs/terra-api.md');

test('the legacy fallback and finite upper bound are shared by policy, status and admission', () => {
  assert.match(protocol, /internal const int CallsPerHour = 24;/);
  assert.match(protocol, /internal const int MaxCallsPerHour = 1000;/);
  assert.match(protocol, /\{ "requests_per_hour", RequestsPerHour \}/);
  assert.match(protocol, /requests_per_hour = RequestsPerHour/);
  assert.match(protocol, /quota is int/);
  assert.match(protocol, /\(int\)quota > Protocol\.MaxCallsPerHour/);
  assert.match(state, /internal bool Reserve\(DateTime utc, int requestsPerHour\)/);
  assert.match(state, /requestsPerHour < 1 \|\| requestsPerHour > Protocol\.MaxCallsPerHour/);
  assert.match(state, /Protocol\.MaxCallsPerHour \* sizeof\(long\)/);
  assert.match(state, /times\.Count >= requestsPerHour/);
  assert.match(program, /state\.Reserve\(DateTime\.UtcNow, policy\.RequestsPerHour\)/);
});

test('the production fresh-install writer emits an explicit 100/hour policy and preview reports it', () => {
  const freshWriter = install.slice(install.indexOf('function New-InstallBrokerPolicy'), install.indexOf('function New-BrokerUpgradePolicy'));
  assert.match(freshWriter, /requests_per_hour = 100/);
  assert.match(freshWriter, /Effort\.ToLowerInvariant\(\)/);
  assert.match(freshWriter, /if \(\$Project\) \{ \$policy\.project = \$Project \}/);
  assert.match(install, /\$policy = New-InstallBrokerPolicy \$caller\.Value \$Model \$ReasoningEffort \$ProjectId \$OrganizationId/);
  const buildExe = install.indexOf("& (Join-Path $PSScriptRoot 'build.ps1') -OutputPath $exe");
  const createPolicy = install.indexOf('$policy = New-InstallBrokerPolicy $caller.Value');
  const writePolicy = install.indexOf('[IO.File]::WriteAllText($policyFile, $json');
  const createService = install.indexOf('[AiRuleSolBrokerInstaller]::Create');
  assert.ok(buildExe >= 0 && createPolicy > buildExe && writePolicy > createPolicy && createService > writePolicy,
    'the fresh path must build the exe, write the 100/hour policy, then create the service');
  assert.match(setup, /\$plan\.status \| ConvertTo-Json -Depth 6/);

  assert.equal(NEW_INSTALL_REQUESTS_PER_HOUR, 100);
  assert.equal(LEGACY_REQUESTS_PER_HOUR, 24);
  assert.deepEqual(installQuotaPreview(), {
    field: 'requests_per_hour',
    new_protected_install: 100,
    legacy_missing_field: 24,
    existing_explicit: 'preserved unless an explicitly requested installed-broker quota upgrade succeeds',
    explicit_upgrade: '-EnableTerraApi -RequestsPerHour <1..1000> -Apply'
  });
  assert.match(helper, /broker_quota: installQuotaPreview\(\)/);
});

test('existing-machine preview reports the real policy value and never treats missing as fresh 100', () => {
  assert.match(setup, /\$installedRequestsPerHour = \$null/);
  assert.match(setup, /\$installedRequestsPerHour = 24\s*\r?\n\s*\$installedQuotaSource = 'legacy-missing-field'/);
  assert.match(setup, /\$installedRequestsPerHour = \[int\]\$quotaField\.Value/);
  assert.match(setup, /\$installedPolicy -isnot \[pscustomobject\]/);
  assert.match(setup, /The installed broker policy is missing the required field \{0\}/);
  assert.match(setup, /current = \$installedRequestsPerHour/);
  assert.match(setup, /current_source = \$installedQuotaSource/);
  assert.match(setup, /new_protected_install = 100/);
  assert.match(setup, /legacy_fallback = 24/);
  assert.doesNotMatch(setup, /catch \{ \$terraAlreadyEnabled = \$false; \$installedRequestsPerHour = 24 \}/);
  assert.doesNotMatch(setup, /\$installedRequestsPerHour = 100/);
});

test('ordinary rerun and no-quota Terra upgrade preserve explicit limits instead of applying 100', () => {
  assert.match(install, /\$changeQuota = \$SetQuota -and \(\$RequestsPerHour -ne \$currentPolicy\.RequestsPerHour\)/);
  assert.match(install, /if \(-not \$enableTerra -and -not \$changeQuota\) \{/);
  assert.match(install, /No production file was written and the service was not stopped or started/);
  assert.match(install, /if \(\$SetQuota -and \$RequestsPerHour -lt \$currentPolicy\.RequestsPerHour\)/);
  assert.match(install, /This operation only raises the bound/);
  assert.match(setup, /\$quotaChange = \$installed -and \$quotaRequested -and \(\$RequestsPerHour -ne \$installedRequestsPerHour\)/);
  assert.match(setup, /if \(\$quotaRequested\) \{ \$previewArguments \+= @\('--requests-per-hour'/);
  assert.doesNotMatch(setup, /\$RequestsPerHour = 100/);
  const upgradeWriter = install.slice(install.indexOf('function New-BrokerUpgradePolicy'), install.indexOf('function Get-BrokerServiceSnapshot'));
  assert.doesNotMatch(upgradeWriter, /100/);
  assert.match(upgradeWriter, /if \(\$SetQuota\) \{ \$ordered\['requests_per_hour'\] = \$RequestsPerHour \}/);
});

test('96 or legacy 24 to 100 is carried through the reviewed elevation into guarded replacement', () => {
  assert.match(setup, /--requests-per-hour/);
  assert.match(setup, /-RequestsPerHour \{0\}/);
  assert.match(setup, /-EnableTerraApi\{2\} -Apply/);
  assert.match(helper, /-RequestsPerHour \$\{options\.requestsPerHour\}/);
  assert.match(elevated, /\$parameters\.RequestsPerHour = \$RequestsPerHour/);
  assert.match(install, /Invoke-BrokerUpgrade -SetQuota:\$quotaRequested -RequestsPerHour \$RequestsPerHour/);
  assert.match(install, /New-BrokerUpgradePolicy \$currentPolicy \$enableTerra \$changeQuota \$RequestsPerHour/);
  const upgrade = install.indexOf('Invoke-BrokerUpgrade -SetQuota:$quotaRequested -RequestsPerHour $RequestsPerHour');
  const policy = install.indexOf('New-BrokerUpgradePolicy $currentPolicy $enableTerra $changeQuota $RequestsPerHour');
  const replace = install.indexOf('[IO.File]::Replace($candidatePolicy, $policyFile');
  assert.ok(upgrade >= 0 && policy >= 0 && replace > policy,
    'the explicit value must reach the guarded policy candidate replacement');
});

test('quota upgrade reuses the guarded executable and policy replacement transaction', () => {
  assert.match(install, /New-BrokerUpgradePolicy \$currentPolicy \$enableTerra \$changeQuota \$RequestsPerHour/);
  assert.match(install, /requests_per_hour_before = \$currentPolicy\.RequestsPerHour/);
  assert.match(install, /requests_per_hour_after =/);
  assert.match(install, /\[IO\.File\]::Replace\(\$candidateExe, \$exe/);
  assert.match(install, /\[IO\.File\]::Replace\(\$candidatePolicy, \$policyFile/);
  assert.match(install, /\$candidateExeHash/);
  assert.match(install, /Copy-ExactBrokerFile \$exe \$backupExe/);
  assert.match(install, /Copy-ExactBrokerFile \$policyFile \$backupPolicy/);
  assert.match(install, /Restore-ExactBrokerFile \$backupPolicy \$policyFile/);
  assert.match(install, /Wait-ForIdleBrokerClients \$gate/);
  assert.match(install, /Assert-BrokerCanStop \$gate/);
  assert.match(install, /rolling rate records and audit files were not reset or edited/);
  assert.doesNotMatch(install, /\[IO\.File\]::(?:WriteAllBytes|WriteAllText|Delete)\([^\r\n]*rate\.bin/);
});

test('the native fixture checks legacy 24/25, explicit 96->100, and 99th/100th/101st boundaries', () => {
  assert.match(native, /A policy without requests_per_hour must retain the historical finite 24\/hour fallback/);
  assert.match(native, /The 25th synthetic call must be rejected under the historical 24\/hour fallback/);
  assert.match(native, /An explicit 96\/hour policy must retain that machine limit/);
  assert.match(native, /An explicit higher machine limit must be preserved rather than clamped to 100/);
  assert.match(native, /The 97th synthetic call must be denied before the explicit 96->100 upgrade/);
  assert.match(native, /The 99th synthetic call must be accepted at the new 100\/hour limit/);
  assert.match(native, /The 100th synthetic call must be accepted at the new 100\/hour limit/);
  assert.match(native, /The 101st synthetic call must be denied at the new 100\/hour limit/);
  assert.match(native, /All 96 previous and 4 post-upgrade admissions must remain in the rolling record/);
  assert.match(native, /A restart must retain all 100 persisted rolling admissions/);
  assert.match(native, /A full rolling hour must release the earlier admissions/);
});

test('the portable quota docs state fresh 100, legacy 24, and explicit persistence', () => {
  assert.match(docs, /100/);
  assert.match(docs, /24/);
  assert.match(docs, /96/);
  assert.match(docs, /缺失/);
  assert.match(docs, /保留/);
  assert.doesNotMatch(
    docs,
    /(?:^|[^A-Za-z0-9_])(?:[A-Za-z]:[\\/]|(?:(?:tmp|temp)[-_]checkout(?:[-_.][^\\/\s]+)?|(?:tmp|temp)[\\/]checkout)[\\/])/im,
    'the public quota docs must not contain drive-qualified Windows paths or explicit temporary checkout paths'
  );
});
