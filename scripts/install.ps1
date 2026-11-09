[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$EnableDsh,
    [switch]$AllowWrite,
    [switch]$Verify,
    [string]$DshEntry,
    [string]$WorkBuddyBridge,
    [string]$CodexHome,
    [string]$RollbackManifest
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$nodeArgs = @((Join-Path $PSScriptRoot 'manage.mjs'))
if ($Apply) { $nodeArgs += '--apply' }
if ($EnableDsh) { $nodeArgs += '--enable-dsh' }
if ($AllowWrite) { $nodeArgs += '--allow-write' }
if ($Verify) { $nodeArgs += '--verify' }
if ($DshEntry) { $nodeArgs += @('--dsh-entry', $DshEntry) }
if ($WorkBuddyBridge) { $nodeArgs += @('--workbuddy-bridge', $WorkBuddyBridge) }
if ($CodexHome) { $nodeArgs += @('--codex-home', $CodexHome) }
if ($RollbackManifest) { $nodeArgs += @('--rollback', $RollbackManifest) }
& $node @nodeArgs
if ($LASTEXITCODE -ne 0) { throw "ai_rule installer failed with exit code $LASTEXITCODE" }
