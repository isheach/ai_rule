[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$EnableDsh,
    [switch]$OffpeakSchedule,
    [switch]$DisableOffpeakSchedule,
    [switch]$AllowWrite,
    [switch]$Verify,
    [string]$DshEntry,
    [string[]]$DshInstance,
    [string[]]$RemoveDshInstance,
    [string]$WorkBuddyBridge,
    [string]$CodexHome,
    [string]$RollbackManifest
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$nodeArgs = @((Join-Path $PSScriptRoot 'manage.mjs'))
if ($Apply) { $nodeArgs += '--apply' }
if ($EnableDsh) { $nodeArgs += '--enable-dsh' }
if ($OffpeakSchedule) { $nodeArgs += '--offpeak-schedule' }
if ($DisableOffpeakSchedule) { $nodeArgs += '--disable-offpeak-schedule' }
if ($AllowWrite) { $nodeArgs += '--allow-write' }
if ($Verify) { $nodeArgs += '--verify' }
if ($DshEntry) { $nodeArgs += @('--dsh-entry', $DshEntry) }
if ($DshInstance) { foreach ($name in $DshInstance) { $nodeArgs += @('--dsh-instance', $name) } }
if ($RemoveDshInstance) { foreach ($name in $RemoveDshInstance) { $nodeArgs += @('--remove-dsh-instance', $name) } }
if ($WorkBuddyBridge) { $nodeArgs += @('--workbuddy-bridge', $WorkBuddyBridge) }
if ($CodexHome) { $nodeArgs += @('--codex-home', $CodexHome) }
if ($RollbackManifest) { $nodeArgs += @('--rollback', $RollbackManifest) }
& $node @nodeArgs
if ($LASTEXITCODE -ne 0) { throw "ai_rule installer failed with exit code $LASTEXITCODE" }
