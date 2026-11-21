#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param([switch]$DisposableRunner)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $DisposableRunner -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Run this service and temporary-account test only on a disposable GitHub-hosted Windows runner.'
}

$repository = Split-Path -Parent $PSScriptRoot
$native = Join-Path $repository 'bridges\sol\broker\windows'
$install = Join-Path $native 'install.ps1'
$root = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'AiRuleSolBroker'
$credentialFile = Join-Path $root 'state\credential.dpapi'
$exe = Join-Path $root 'SolBroker.exe'
$svc = 'AiRuleSolBroker'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$git = (Get-Command git.exe -ErrorAction Stop).Source
$powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
$scratch = Join-Path ([Environment]::GetFolderPath('CommonDocuments')) ('sol-broker-ci-' + [Guid]::NewGuid().ToString('N'))
$build = Join-Path $native 'build.ps1'
$fixture = Join-Path $scratch 'NativeTests.exe'
$nodeFixture = Join-Path $scratch 'status.mjs'
$cipherFixture = Join-Path $scratch 'encrypted-test-copy.bin'
$accountNames = [Collections.Generic.List[string]]::new()
$installed = $false
$allowed = $null
$safeCodes = @('BROKER_FORBIDDEN', 'BROKER_PROTOCOL', 'BROKER_POLICY_DENIED', 'BROKER_INPUT_LIMIT',
    'BROKER_CREDENTIAL_MISSING', 'BROKER_RATE_LIMITED', 'BROKER_UNAVAILABLE', 'BROKER_BUSY',
    'BROKER_OUTCOME_UNKNOWN', 'BROKER_STORAGE_UNAVAILABLE', 'UPSTREAM_UNSENT', 'UPSTREAM_UNKNOWN', 'UPSTREAM_HTTP')

function New-TestAccount {
    $name = 'SolBrokerCI_' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $password = [Security.SecureString]::new()
    foreach ($character in ('aB1!' + [Guid]::NewGuid().ToString('N')).ToCharArray()) { $password.AppendChar($character) }
    $password.MakeReadOnly()
    $account = New-LocalUser -Name $name -Password $password -PasswordNeverExpires -UserMayNotChangePassword
    $accountNames.Add($name)
    $users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    if (-not (Get-LocalGroupMember -SID $users | Where-Object { $_.SID -eq $account.SID })) {
        Add-LocalGroupMember -SID $users -Member $account
    }
    return [PSCustomObject]@{ Name = $name; Password = $password; Sid = $account.SID.Value }
}

function Invoke-TestUser($Account, [string]$File, [string]$ArgumentLine, [string]$InputText = '',
    [string]$WorkingDirectory = $scratch, [string]$FixtureProfile) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $File
    $info.Arguments = $ArgumentLine
    $info.WorkingDirectory = $WorkingDirectory
    $info.Domain = [Environment]::MachineName
    $info.UserName = $Account.Name
    $info.Password = $Account.Password
    $info.LoadUserProfile = $true
    if ($FixtureProfile) {
        $fixtureLocalData = Join-Path $FixtureProfile 'AppData\Local'
        $fixtureTemp = Join-Path $fixtureLocalData 'Temp'
        $profilePaths = @{
            USERPROFILE = $FixtureProfile
            APPDATA = Join-Path $FixtureProfile 'AppData\Roaming'
            LOCALAPPDATA = $fixtureLocalData
            TEMP = $fixtureTemp
            TMP = $fixtureTemp
        }
        foreach ($entry in $profilePaths.GetEnumerator()) {
            $null = [IO.Directory]::CreateDirectory($entry.Value)
            $info.EnvironmentVariables[$entry.Key] = $entry.Value
        }
    }
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $previousEncoding = [Console]::InputEncoding
    try {
        [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
        $process = [Diagnostics.Process]::Start($info)
    }
    finally { [Console]::InputEncoding = $previousEncoding }
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($InputText)
        if ($bytes.Length) { $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length) }
        $process.StandardInput.Close()
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) {
            $process.Kill()
            throw 'A Sol broker integration process exceeded its deadline.'
        }
        return [PSCustomObject]@{ Status = $process.ExitCode; Output = $output.GetAwaiter().GetResult(); Error = $errors.GetAwaiter().GetResult() }
    }
    finally { $process.Dispose() }
}

function Assert-TestCommand($Result, [string]$Step) {
    if ($Result.Status -ne 0) { throw "$Step failed (exit $($Result.Status)): $($Result.Error) $($Result.Output)" }
}

function New-SetupFixture($Account, [string]$Revision) {
    $fixtureProfileRoot = Join-Path $scratch "ordinary caller's profile"
    $checkout = Join-Path $fixtureProfileRoot ('reviewed checkout ' + [char]0x9879)
    $codexHome = Join-Path $fixtureProfileRoot '.codex'
    $workspace = Join-Path $fixtureProfileRoot 'approved project'
    $configuration = Join-Path $fixtureProfileRoot 'coordinator.local.json'
    $pool = Join-Path $fixtureProfileRoot 'pool.local.json'
    $dsh = Join-Path $fixtureProfileRoot 'never-run.mjs'
    $archive = Join-Path $scratch 'reviewed-checkout.zip'
    $null = New-Item -Path $fixtureProfileRoot -ItemType Directory
    $acl = Get-Acl -LiteralPath $fixtureProfileRoot
    $sid = [Security.Principal.SecurityIdentifier]::new($Account.Sid)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'Modify', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $fixtureProfileRoot -AclObject $acl
    $null = New-Item -Path $codexHome, $workspace -ItemType Directory
    $gitRoot = '-C "{0}"' -f $checkout
    $template = Join-Path $fixtureProfileRoot 'git-template'
    $null = [IO.Directory]::CreateDirectory($template)
    Assert-TestCommand (Invoke-TestUser $Account $git ('init --template="{0}" "{1}"' -f $template, $checkout) -FixtureProfile $fixtureProfileRoot) 'Initialize checkout under ordinary SID'
    & $git -C $repository archive --format=zip "--output=$archive" $Revision
    if ($LASTEXITCODE -ne 0) { throw 'The source checkout fixture could not be archived.' }
    Expand-Archive -LiteralPath $archive -DestinationPath $checkout
    [IO.File]::Delete($archive)
    Assert-TestCommand (Invoke-TestUser $Account $git "$gitRoot -c core.autocrlf=true add --all" -FixtureProfile $fixtureProfileRoot) 'Stage checkout under ordinary SID'
    Assert-TestCommand (Invoke-TestUser $Account $git "$gitRoot -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -m fixture" -FixtureProfile $fixtureProfileRoot) 'Pin fixture revision'
    $head = Invoke-TestUser $Account $git "$gitRoot rev-parse HEAD" -FixtureProfile $fixtureProfileRoot
    Assert-TestCommand $head 'Read the pinned fixture revision'
    $fixedRevision = $head.Output.Trim()
    $toml = Join-Path $codexHome 'config.toml'
    $prior = "# preserve unrelated registrations`n[mcp_servers.unrelated]`ncommand = `"existing-service`"`n"
    Set-Content -LiteralPath $toml -Value $prior -NoNewline -Encoding ASCII
    Set-Content -LiteralPath $dsh -Value "throw Error('The setup must never start DSH.');" -Encoding ASCII
    @{
        pool_root = Join-Path $fixtureProfileRoot 'pool'; workspace_root = $workspace; dsh_entry = $dsh
        schedule_config = Join-Path $checkout 'config\offpeak.schedule.json'; allow_write = $false
    } | ConvertTo-Json | Set-Content -LiteralPath $pool -Encoding UTF8
    @{
        state_dir = Join-Path $fixtureProfileRoot 'sol-state'; pool_config = $pool
        openai = @{ model = 'gpt-6.2-sol'; reasoning_effort = 'max'; api_key_env = 'OPENAI_API_KEY' }
    } | ConvertTo-Json | Set-Content -LiteralPath $configuration -Encoding UTF8
    $entry = Join-Path $checkout 'scripts\setup-sol.ps1'
    $setupArgs = '-NoLogo -NoProfile -NonInteractive -File "{0}" -CodexHome "{1}" -SolCoordinatorConfig "{2}"' -f $entry, $codexHome, $configuration
    return [PSCustomObject]@{ Home = $fixtureProfileRoot; Checkout = $checkout; CodexHome = $codexHome; Configuration = $configuration; Revision = $fixedRevision; Arguments = $setupArgs; OriginalToml = $prior }
}

function Test-SetupPreflight($Account, $Setup) {
    $base = "$($Setup.Arguments) -ExpectedRevision"
    $system = [Environment]::SystemDirectory
    $wrong = Invoke-TestUser $Account $powershell "$base $('0' * 40)" -FixtureProfile $Setup.Home -WorkingDirectory $system
    if ($wrong.Status -eq 0 -or $wrong.Error -notmatch 'does not match the reviewed deployment commit') { throw "Setup did not reject the wrong revision. $($wrong.Error)" }
    $tracked = Join-Path $Setup.Checkout 'scripts\sol-install.mjs'
    $source = [IO.File]::ReadAllBytes($tracked)
    try {
        [IO.File]::AppendAllText($tracked, "`r`n// offline changed source fixture`r`n")
        $dirty = Invoke-TestUser $Account $powershell "$base $($Setup.Revision)" -FixtureProfile $Setup.Home -WorkingDirectory $system
        if ($dirty.Status -eq 0 -or $dirty.Error -notmatch 'local source differs') { throw "Setup did not reject modified source. $($dirty.Error)" }
        $crlf = [Text.Encoding]::UTF8.GetString($source).Replace("`r`n", "`n").Replace("`n", "`r`n")
        [IO.File]::WriteAllText($tracked, $crlf, [Text.UTF8Encoding]::new($false))
        $plan = Invoke-TestUser $Account $powershell "$base $($Setup.Revision)" -FixtureProfile $Setup.Home -WorkingDirectory $system
        Assert-TestCommand $plan 'Preflight from Windows system32 with a CRLF checkout file'
        if ($plan.Output -notmatch 'SOL_BROKER_UNAVAILABLE|SOL_BROKER_NOT_READY' -or $plan.Output -notmatch '"pool_allow_write"\s*:\s*false') {
            throw 'Preflight reported an unexpected readiness or scope.'
        }
    }
    finally { [IO.File]::WriteAllBytes($tracked, $source) }
    Write-Output 'Ordinary-user preflight from System32 passed revision, dirty-source, CRLF, and read-only scope checks.'
}

function Test-SetupApply($Account, $Setup) {
    $command = "$($Setup.Arguments) -ExpectedRevision $($Setup.Revision) -Apply"
    $system = [Environment]::SystemDirectory
    $first = Invoke-TestUser $Account $powershell $command -FixtureProfile $Setup.Home -WorkingDirectory $system
    Assert-TestCommand $first 'Apply setup using the existing ready broker'
    if ($first.Output -notmatch '"rules_current"\s*:\s*true' -or $first.Output -notmatch '"structure_valid"\s*:\s*true') { throw 'Setup did not verify the installed rules and Sol MCP registration.' }
    $coordinator = Get-Content -LiteralPath $Setup.Configuration -Raw | ConvertFrom-Json
    if ($coordinator.openai.credential_source -ne 'windows-broker' -or $coordinator.openai.PSObject.Properties['api_key_env']) {
        throw 'Setup did not migrate the existing credential reference in place.'
    }
    $toml = Get-Content -LiteralPath (Join-Path $Setup.CodexHome 'config.toml') -Raw
    if (-not $toml.StartsWith($Setup.OriginalToml)) { throw 'Setup changed an unrelated MCP registration.' }
    $second = Invoke-TestUser $Account $powershell $command -FixtureProfile $Setup.Home -WorkingDirectory $system
    Assert-TestCommand $second 'Reapply setup with an existing broker and config'
    if ($second.Output -notmatch 'No changes; installation is already up to date\.') { throw 'The second setup was not idempotent.' }
    Write-Output 'Ordinary-user migration, registration verification, and repeat apply passed.'
}

function Invoke-ReviewedElevation([string]$Encoded) {
    # No UAC consent UI is available to the CI runner, which is already elevated.
    # Read the child streams directly so PowerShell does not interpret stderr as CLI XML.
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $powershell
    $info.Arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand ' + $Encoded
    $info.WorkingDirectory = [Environment]::SystemDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    try {
        $process.StandardInput.Close()
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(45000)) {
            $process.Kill()
            throw 'The elevated broker bootstrap exceeded the test deadline.'
        }
        return [PSCustomObject]@{ Status = $process.ExitCode; Output = $output.GetAwaiter().GetResult() + $errors.GetAwaiter().GetResult() }
    }
    finally { $process.Dispose() }
}

function Assert-Status([string]$Step, $Reply, [bool]$Ready) {
    if ($Reply.Status -ne 0 -or $Reply.Error) {
        throw "$Step failed (exit $($Reply.Status), stderr present $([bool]$Reply.Error))."
    }
    try { $envelope = $Reply.Output | ConvertFrom-Json }
    catch { throw "$Step returned invalid JSON." }
    if ($envelope.ok -ne $true) {
        $code = if ($envelope.PSObject.Properties['code'] -and $envelope.code -cin $safeCodes) { $envelope.code } else { 'UNKNOWN' }
        throw "$Step was declined ($code)."
    }
    if ($envelope.status -ne 200 -or $envelope.body.ready -ne $Ready -or $envelope.body.model -ne 'gpt-6.2-sol' -or
        $envelope.body.reasoning_effort -ne 'max' -or $envelope.body.requests_per_hour -ne 100) {
        throw "$Step returned inconsistent status (ready: $($envelope.body.ready -eq $true), expected: $Ready; quota: $($envelope.body.requests_per_hour), expected: 100)."
    }
    Write-Output "$Step passed."
}

function Write-SafeDiagnostic {
    $auditFile = Join-Path $root 'state\audit.jsonl'
    if (Test-Path -LiteralPath $auditFile) {
        $operations = @('service', 'status', 'response', 'admin', 'admin_check', 'enroll')
        $outcomes = $safeCodes + @('started', 'stopped', 'startup_failed', 'listener_failed', 'dpapi_unavailable', 'denied', 'success', 'reserved', 'ipc_closed')
        foreach ($line in (Get-Content -LiteralPath $auditFile -Tail 24)) {
            $entry = $line | ConvertFrom-Json
            if ($entry.operation -cin $operations -and $entry.outcome -cin $outcomes) {
                Write-Output ('Service audit {0}/{1}' -f $entry.operation, $entry.outcome)
            }
        }
    }
    if ($null -ne $allowed) {
        $probe = Invoke-TestUser $allowed $fixture ('ci-probe-status {0}' -f $allowed.Sid)
        $probeLines = $safeCodes + @('caller-sid-match', 'caller-sid-mismatch', 'pipe-open', 'pipe-owner-match', 'pipe-owner-mismatch',
            'scm-match', 'scm-mismatch', 'pipe-granted', 'pipe-denied', 'pipe-io-failed')
        foreach ($line in ($probe.Output -split '\r?\n')) {
            if ($line -cin $probeLines) { Write-Output "Status probe $line" }
        }
    }
}

if (Test-Path -LiteralPath $root) { throw 'An existing installation must not be used for this test.' }
$null = New-Item -Path $scratch -ItemType Directory
try {
    $scratchAcl = Get-Acl -LiteralPath $scratch
    $authenticated = [Security.Principal.SecurityIdentifier]::new('S-1-5-11')
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $scratchAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($authenticated, 'ReadAndExecute', $inherit, 'None', 'Allow'))
    Set-Acl -LiteralPath $scratch -AclObject $scratchAcl
    & $build -OutputPath $fixture -TestSource (Join-Path $PSScriptRoot 'sol-broker-windows.cs') -EntryPoint 'AiRule.Sol.Windows.NativeTests'
    Copy-Item -LiteralPath (Join-Path $repository 'bridges\sol\broker.mjs') -Destination (Join-Path $scratch 'broker.mjs')
    @'
import { brokerCall } from './broker.mjs';
try {
  process.stdout.write(JSON.stringify(await brokerCall({ op: 'status' }, AbortSignal.timeout(20000))));
} catch {
  process.exitCode = 1;
}
'@ | Set-Content -LiteralPath $nodeFixture -Encoding ASCII

    $allowed = New-TestAccount
    $unlisted = New-TestAccount
    $revision = (& $git -C $repository rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the CI checkout revision.' }
    $setup = New-SetupFixture $allowed $revision
    Test-SetupPreflight $allowed $setup
    $bundle = Join-Path $scratch "broker transfer's bundle.json"
    $prepare = Join-Path $PSScriptRoot 'sol-setup-fixture.mjs'
    $encoded = & $node $prepare $repository $git $revision $bundle $allowed.Sid
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the reviewed broker installation.' }
    $checkedBundle = [IO.File]::ReadAllBytes($bundle)
    [IO.File]::AppendAllText($bundle, 'modified')
    $deniedBundle = Invoke-ReviewedElevation $encoded
    if ($deniedBundle.Status -eq 0 -or $deniedBundle.Output -notmatch 'changed after revision verification' -or (Test-Path -LiteralPath $root)) {
        throw "The protected bootstrap did not reject a changed bundle: $($deniedBundle.Output)"
    }
    Write-Output 'Elevated bootstrap rejected the changed source bundle.'
    [IO.File]::WriteAllBytes($bundle, $checkedBundle)
    $installResult = Invoke-ReviewedElevation $encoded
    if ($installResult.Status -ne 0) { throw "The protected broker install failed: $($installResult.Output)" }
    $installed = $true
    $freshPolicy = Get-Content -LiteralPath (Join-Path $root 'policy.json') -Raw | ConvertFrom-Json
    if ($freshPolicy.requests_per_hour -ne 100) {
        throw "A fresh protected installation did not write requests_per_hour=100 (actual: $($freshPolicy.requests_per_hour))."
    }
    Write-Output 'Broker installation from protected staged source passed with explicit requests_per_hour=100.'
    $statusJson = '{"op":"status"}'
    Assert-Status 'Authorized native status before enrollment' (Invoke-TestUser $allowed $exe 'client' $statusJson) $false
    Assert-Status 'Authorized Node status before enrollment' (Invoke-TestUser $allowed $node ('"{0}"' -f $nodeFixture)) $false

    $denied = Invoke-TestUser $unlisted $exe 'client' $statusJson
    $errorEnvelope = $denied.Output | ConvertFrom-Json
    if ($denied.Status -ne 0 -or $errorEnvelope.ok -or $errorEnvelope.status -ne 403 -or $errorEnvelope.code -ne 'BROKER_FORBIDDEN') {
        throw 'The status pipe did not reject the unlisted Windows SID.'
    }
    if ((Invoke-TestUser $allowed $exe 'check').Status -eq 0) { throw 'An API client SID gained management access.' }

    & $fixture 'ci-enroll'
    if ($LASTEXITCODE -ne 0) { throw 'Offline synthetic enrollment failed.' }
    Assert-Status 'Authorized native status after enrollment' (Invoke-TestUser $allowed $exe 'client' $statusJson) $true
    [IO.File]::Delete($bundle)
    $encoded = & $node $prepare $repository $git $revision $bundle $allowed.Sid 'Enroll'
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare existing broker policy validation.' }
    $existingResult = Invoke-ReviewedElevation $encoded
    if ($existingResult.Status -ne 0) { throw "The protected broker did not reuse the existing key: $($existingResult.Output)" }
    Test-SetupApply $allowed $setup
    if ((Invoke-TestUser $allowed $fixture 'ci-deny-state').Status -ne 0) { throw 'The API client SID could read the broker credential file.' }
    [IO.File]::WriteAllBytes($cipherFixture, [IO.File]::ReadAllBytes($credentialFile))
    if ((Invoke-TestUser $allowed $fixture ('ci-deny-decrypt "{0}"' -f $cipherFixture)).Status -ne 0) {
        throw 'A different SID was able to decrypt the broker DPAPI blob.'
    }

    Restart-Service -Name $svc
    Assert-Status 'Authorized Node status after service restart' (Invoke-TestUser $allowed $node ('"{0}"' -f $nodeFixture)) $true
    $lines = Get-Content -LiteralPath (Join-Path $root 'state\audit.jsonl')
    foreach ($line in $lines) {
        $entry = $line | ConvertFrom-Json
        if ((($entry.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'operation,outcome,status,time') {
            throw 'An unexpected field appeared in the broker audit.'
        }
        if ($line -match 'offline-broker-synthetic-value|proj_ci_example|org-ci-example') { throw 'Broker audit contains credential or routing data.' }
    }
    'Windows service, distinct SID enforcement, Node status, restart and isolated DPAPI passed offline.'
}
catch {
    if ($installed) {
        try { Write-SafeDiagnostic }
        catch { Write-Output 'The status probe could not complete.' }
    }
    throw
}
finally {
    try { if ($installed) { & $install -Uninstall } }
    finally {
        foreach ($accountName in $accountNames) { Remove-LocalUser -Name $accountName -ErrorAction Continue }
        foreach ($leaf in @('NativeTests.exe', 'status.mjs', 'broker.mjs', 'encrypted-test-copy.bin', "broker transfer's bundle.json", 'reviewed-checkout.zip')) {
            [IO.File]::Delete((Join-Path $scratch $leaf))
        }
        $fixtureHome = Join-Path $scratch "ordinary caller's profile"
        if (Test-Path -LiteralPath $fixtureHome) { Remove-Item -LiteralPath $fixtureHome -Recurse -Force }
        [IO.Directory]::Delete($scratch, $false)
    }
}

if ((Test-Path -LiteralPath $root) -or (Get-Service -Name $svc -ErrorAction SilentlyContinue)) {
    throw 'The Windows integration runner retained a service or installation directory.'
}
