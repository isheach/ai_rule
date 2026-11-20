[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$EnableDsh,
    [switch]$OffpeakSchedule,
    [switch]$DisableOffpeakSchedule,
    [switch]$AllowWrite,
    [switch]$ReadOnly,
    [switch]$Verify,
    [string]$DshEntry,
    [string[]]$DshInstance,
    [string[]]$RemoveDshInstance,
    [string]$WorkBuddyBridge,
    [string]$SolCoordinatorConfig,
    [string]$SolWorkspaceRoot,
    [string]$SolModel,
    [string]$SolReasoningEffort,
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
if ($ReadOnly) { $nodeArgs += '--read-only' }
if ($Verify) { $nodeArgs += '--verify' }
if ($DshEntry) { $nodeArgs += @('--dsh-entry', $DshEntry) }
if ($DshInstance) { foreach ($name in $DshInstance) { $nodeArgs += @('--dsh-instance', $name) } }
if ($RemoveDshInstance) { foreach ($name in $RemoveDshInstance) { $nodeArgs += @('--remove-dsh-instance', $name) } }
if ($WorkBuddyBridge) { $nodeArgs += @('--workbuddy-bridge', $WorkBuddyBridge) }
if ($SolCoordinatorConfig) { $nodeArgs += @('--sol-coordinator-config', $SolCoordinatorConfig) }
if ($SolWorkspaceRoot) { $nodeArgs += @('--sol-workspace-root', $SolWorkspaceRoot) }
if ($SolModel) { $nodeArgs += @('--sol-model', $SolModel) }
if ($SolReasoningEffort) { $nodeArgs += @('--sol-reasoning-effort', $SolReasoningEffort) }
if ($CodexHome) { $nodeArgs += @('--codex-home', $CodexHome) }
if ($RollbackManifest) { $nodeArgs += @('--rollback', $RollbackManifest) }
& $node @nodeArgs
if ($LASTEXITCODE -ne 0) { throw "ai_rule installer failed with exit code $LASTEXITCODE" }
