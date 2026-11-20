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
$scratch = Join-Path ([Environment]::GetFolderPath('CommonDocuments')) ('sol-broker-ci-' + [Guid]::NewGuid().ToString('N'))
$build = Join-Path $native 'build.ps1'
$fixture = Join-Path $scratch 'NativeTests.exe'
$nodeFixture = Join-Path $scratch 'status.mjs'
$cipherFixture = Join-Path $scratch 'encrypted-test-copy.bin'
$accountNames = [Collections.Generic.List[string]]::new()
$installed = $false

function New-TestAccount {
    $name = 'SolBrokerCI_' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $password = [Security.SecureString]::new()
    foreach ($character in ('aB1!' + [Guid]::NewGuid().ToString('N')).ToCharArray()) { $password.AppendChar($character) }
    $password.MakeReadOnly()
    $account = New-LocalUser -Name $name -Password $password -PasswordNeverExpires -UserMayNotChangePassword
    $accountNames.Add($name)
    return [PSCustomObject]@{ Name = $name; Password = $password; Sid = $account.SID.Value }
}

function Invoke-TestUser($Account, [string]$File, [string]$ArgumentLine, [string]$InputText = '') {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $File
    $info.Arguments = $ArgumentLine
    $info.WorkingDirectory = $scratch
    $info.Domain = [Environment]::MachineName
    $info.UserName = $Account.Name
    $info.Password = $Account.Password
    $info.LoadUserProfile = $true
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    try {
        $process.StandardInput.Write($InputText)
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

function Assert-Status($Reply, [bool]$Ready) {
    if ($Reply.Status -ne 0 -or $Reply.Error) { throw 'The authorized Windows status client failed.' }
    $envelope = $Reply.Output | ConvertFrom-Json
    if (-not $envelope.ok -or $envelope.status -ne 200 -or $envelope.body.ready -ne $Ready -or
        $envelope.body.model -ne 'gpt-6.2-sol' -or $envelope.body.reasoning_effort -ne 'max') {
        throw 'The Windows status client returned an unexpected reply.'
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
    & $install -ClientSid $allowed.Sid -ProjectId 'proj_ci_example' -OrganizationId 'org-ci-example'
    $installed = $true
    $statusJson = '{"op":"status"}'
    Assert-Status (Invoke-TestUser $allowed $exe 'client' $statusJson) $false
    Assert-Status (Invoke-TestUser $allowed $node ('"{0}"' -f $nodeFixture)) $false

    $denied = Invoke-TestUser $unlisted $exe 'client' $statusJson
    $errorEnvelope = $denied.Output | ConvertFrom-Json
    if ($denied.Status -ne 0 -or $errorEnvelope.ok -or $errorEnvelope.status -ne 403 -or $errorEnvelope.code -ne 'BROKER_FORBIDDEN') {
        throw 'The status pipe did not reject the unlisted Windows SID.'
    }
    if ((Invoke-TestUser $allowed $exe 'check').Status -eq 0) { throw 'An API client SID gained management access.' }

    & $fixture 'ci-enroll'
    if ($LASTEXITCODE -ne 0) { throw 'Offline synthetic enrollment failed.' }
    Assert-Status (Invoke-TestUser $allowed $exe 'client' $statusJson) $true
    if ((Invoke-TestUser $allowed $fixture 'ci-deny-state').Status -ne 0) { throw 'The API client SID could read the broker credential file.' }
    [IO.File]::WriteAllBytes($cipherFixture, [IO.File]::ReadAllBytes($credentialFile))
    if ((Invoke-TestUser $allowed $fixture ('ci-deny-decrypt "{0}"' -f $cipherFixture)).Status -ne 0) {
        throw 'A different SID was able to decrypt the broker DPAPI blob.'
    }

    Restart-Service -Name $svc
    Assert-Status (Invoke-TestUser $allowed $node ('"{0}"' -f $nodeFixture)) $true
    $lines = Get-Content -LiteralPath (Join-Path $root 'state\audit.jsonl')
    foreach ($line in $lines) {
        $entry = $line | ConvertFrom-Json
        if (($entry.PSObject.Properties.Name | Sort-Object) -join ',' -ne 'operation,outcome,status,time') {
            throw 'An unexpected field appeared in the broker audit.'
        }
        if ($line -match 'offline-broker-synthetic-value|proj_ci_example|org-ci-example') { throw 'Broker audit contains credential or routing data.' }
    }
    'Windows service, distinct SID enforcement, Node status, restart and isolated DPAPI passed offline.'
}
finally {
    try { if ($installed) { & $install -Uninstall } }
    finally {
        foreach ($accountName in $accountNames) { Remove-LocalUser -Name $accountName -ErrorAction Continue }
        foreach ($leaf in @('NativeTests.exe', 'status.mjs', 'broker.mjs', 'encrypted-test-copy.bin')) {
            [IO.File]::Delete((Join-Path $scratch $leaf))
        }
        [IO.Directory]::Delete($scratch, $false)
    }
}

if ((Test-Path -LiteralPath $root) -or (Get-Service -Name $svc -ErrorAction SilentlyContinue)) {
    throw 'The Windows integration runner retained a service or installation directory.'
}
