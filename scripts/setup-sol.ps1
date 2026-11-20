#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('\A[0-9a-f]{40}\z')][string]$ExpectedRevision,
    [switch]$Apply,
    [string]$SolCoordinatorConfig,
    [string]$SolWorkspaceRoot,
    [string]$SolModel,
    [ValidateSet('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')][string]$SolReasoningEffort,
    [string]$DshEntry,
    [string]$CodexHome,
    [ValidatePattern('\Aproj_[A-Za-z0-9_-]{1,140}\z')][string]$ProjectId,
    [ValidatePattern('\Aorg[-_][A-Za-z0-9_-]{1,140}\z')][string]$OrganizationId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$os = [Environment]::OSVersion.VersionString
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess) {
    throw "This process is running on $os ($([IntPtr]::Size * 8)-bit). Run setup in 64-bit PowerShell on the target Windows computer."
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run setup in the ordinary non-elevated Windows session that runs Codex. Setup asks for UAC separately when needed.'
    }
    $clientSid = $identity.User.Value
}
finally { $identity.Dispose() }
Write-Host ("Local Windows computer {0}, PowerShell {1}, ordinary caller {2}" -f [Environment]::MachineName, $PSVersionTable.PSVersion, $clientSid)

$framework = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -Name Release -ErrorAction SilentlyContinue
if (-not $framework -or $framework.Release -lt 528040) { throw 'The Windows Sol broker requires .NET Framework 4.8 or later.' }
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$git = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$helper = Join-Path $PSScriptRoot 'sol-setup.mjs'
$programs = [Environment]::GetFolderPath('ProgramFiles')
$nodeArguments = @('--revision', $ExpectedRevision, '--git', $git, '--program-files', $programs)
if ($SolCoordinatorConfig) { $nodeArguments += @('--config', $SolCoordinatorConfig) }
if ($SolWorkspaceRoot) { $nodeArguments += @('--workspace', $SolWorkspaceRoot) }
if ($SolModel) { $nodeArguments += @('--model', $SolModel) }
if ($SolReasoningEffort) { $nodeArguments += @('--effort', $SolReasoningEffort) }
if ($DshEntry) { $nodeArguments += @('--dsh-entry', $DshEntry) }
if ($CodexHome) { $nodeArguments += @('--codex-home', $CodexHome) }

$output = & $node $helper plan @nodeArguments
if ($LASTEXITCODE -ne 0) { throw 'Sol setup preflight failed.' }
$plan = ($output -join "`n") | ConvertFrom-Json
$plan.status | ConvertTo-Json -Depth 6
if (-not $Apply) { return }
if ($plan.status.workbuddy_sdk -and -not $plan.status.workbuddy_sdk.installed) {
    $directory = $plan.status.workbuddy_sdk.directory.Replace("'", "''")
    Write-Host "Install the pinned SDK in the reviewed worktree: npm.cmd ci --ignore-scripts --prefix '$directory'"
    throw 'WorkBuddy SDK installation is required before applying this configuration.'
}

$brokerRoot = Join-Path $programs 'AiRuleSolBroker'
if (-not $plan.status.broker.ready) {
    if ($plan.status.broker.code -eq 'SOL_BROKER_NOT_READY') {
        $action = 'Enroll'
    } elseif ($plan.status.broker.code -eq 'SOL_BROKER_UNAVAILABLE' -and -not (Test-Path -LiteralPath $brokerRoot) -and
        -not (Get-Service -Name 'AiRuleSolBroker' -ErrorAction SilentlyContinue)) {
        $action = 'Install'
    } else {
        throw ('Sol broker status is {0}. Check the existing service and its caller and model policy locally.' -f $plan.status.broker.code)
    }
    if (-not [Environment]::UserInteractive) { throw 'Run setup in a local interactive PowerShell window for UAC and key entry.' }
    $transfer = Join-Path ([IO.Path]::GetTempPath()) ('ai-rule-sol-' + [Guid]::NewGuid().ToString('N'))
    $null = New-Item -Path $transfer -ItemType Directory
    $bundle = Join-Path $transfer 'broker-source.json'
    $lock = $null
    try {
        $acl = Get-Acl -LiteralPath $transfer
        $admins = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($admins, 'ReadAndExecute', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
        Set-Acl -LiteralPath $transfer -AclObject $acl
        $elevationArgs = @('--fingerprint', $plan.fingerprint, '--bundle-path', $bundle, '--client-sid', $clientSid, '--action', $action)
        if ($ProjectId) { $elevationArgs += @('--project', $ProjectId) }
        if ($OrganizationId) { $elevationArgs += @('--organization', $OrganizationId) }
        $encoded = & $node $helper elevation @nodeArguments @elevationArgs
        if ($LASTEXITCODE -ne 0 -or $encoded -notmatch '\A[A-Za-z0-9+/]+={0,2}\z') { throw 'The reviewed elevation command could not be prepared.' }
        $lock = [IO.File]::Open($bundle, 'Open', 'Read', 'Read')
        $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
        Write-Host 'Approve UAC. Type an API key only at the installed Sol Broker prompt in the elevated window.'
        $elevated = Start-Process -FilePath $powershell -WorkingDirectory ([Environment]::SystemDirectory) `
            -ArgumentList @('-NoLogo', '-NoProfile', '-EncodedCommand', $encoded) -Verb RunAs -PassThru -Wait
        try { if ($elevated.ExitCode -ne 0) { throw 'The elevated Sol broker operation did not complete. Review its local message and run setup again.' } }
        finally { $elevated.Dispose() }
    }
    finally {
        if ($null -ne $lock) { $lock.Dispose() }
        [IO.File]::Delete($bundle)
        [IO.Directory]::Delete($transfer, $false)
    }
} elseif ($ProjectId -or $OrganizationId) {
    throw 'The existing broker is ready. Project and organization options are for the broker installation or key enrollment step.'
}

& $node $helper apply @nodeArguments --fingerprint $plan.fingerprint
if ($LASTEXITCODE -ne 0) { throw 'Sol coordinator registration failed.' }
Write-Host 'When affected tasks finish, load the updated sol-coordinator registration through the Codex host and run get_sol_coordinator_mode in that session.'
