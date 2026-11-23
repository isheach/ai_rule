#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('\A[0-9a-f]{40}\z')][string]$ExpectedRevision,
    [switch]$EnableTerraApi,
    [switch]$EnableLunaApi,
    [ValidateRange(1, 1000)][int]$RequestsPerHour,
    [switch]$AllowBriefRestart,
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
$quotaRequested = $PSBoundParameters.ContainsKey('RequestsPerHour')
if ($EnableTerraApi -and $EnableLunaApi) {
    throw 'Enable one broker role per upgrade. The other role keeps its existing setting.'
}
$upgradeRequested = $EnableTerraApi -or $EnableLunaApi
if ($quotaRequested -and -not $upgradeRequested) {
    throw '-RequestsPerHour is accepted only with -EnableTerraApi or -EnableLunaApi for the installed broker.'
}
if ($AllowBriefRestart -and (-not $upgradeRequested -or -not $Apply)) {
    throw '-AllowBriefRestart is accepted only with -Apply and either -EnableTerraApi or -EnableLunaApi for one brief stop during a maintenance window.'
}
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
$brokerName = 'AiRuleSolBroker'
$brokerRoot = Join-Path $programs $brokerName
$brokerExe = Join-Path $brokerRoot 'SolBroker.exe'
$brokerPolicy = Join-Path $brokerRoot 'policy.json'
$serviceRegistry = "HKLM:\SYSTEM\CurrentControlSet\Services\$brokerName"
$serviceAccount = "NT SERVICE\$brokerName"
$expectedImage = '"{0}" service' -f $brokerExe

if ($upgradeRequested) {
    $role = if ($EnableLunaApi) { 'Luna' } else { 'Terra' }
    $operation = 'Enable{0}Api' -f $role
    $enableArgument = '-' + $operation
    $roleKey = $role.ToLowerInvariant()
    $policyFieldName = 'allow_{0}_api' -f $roleKey
    if ($SolCoordinatorConfig -or $SolWorkspaceRoot -or $SolModel -or $SolReasoningEffort -or $DshEntry -or $CodexHome -or
        $ProjectId -or $OrganizationId) {
        throw 'The API role upgrade applies only to the installed broker. Coordinator, workspace, model, project, organization, DSH and Codex settings are managed separately.'
    }
    $previewArguments = @("${roleKey}-plan", '--revision', $ExpectedRevision, '--git', $git, '--program-files', $programs)
    if ($quotaRequested) { $previewArguments += @('--requests-per-hour', [string]$RequestsPerHour) }
    $previewOutput = & $node $helper @previewArguments
    if ($LASTEXITCODE -ne 0) { throw 'The fixed-revision API role preview could not be verified.' }
    try { $sourcePlan = ($previewOutput -join "`n") | ConvertFrom-Json }
    catch { throw 'The API role preview returned invalid source status.' }
    if ($sourcePlan.status.operation -cne $operation -or $sourcePlan.status.revision -ne $ExpectedRevision.ToLowerInvariant() -or
        $sourcePlan.status.source_bundle_sha256 -notmatch '\A[0-9a-f]{64}\z') {
        throw 'The API role preview did not identify the reviewed operation, revision and source bundle.'
    }

    $service = Get-Service -Name $brokerName -ErrorAction SilentlyContinue
    $serviceState = 'NotInstalled'
    if ($null -ne $service) {
        try { $serviceState = $service.Status.ToString() }
        finally { $service.Dispose() }
    }
    $registration = $null
    try {
        $registration = Get-ItemProperty -LiteralPath $serviceRegistry -Name ImagePath, ObjectName -ErrorAction Stop
    }
    catch { $registration = $null }
    $registrationState = 'unknown'
    $registeredImage = $null
    $registeredAccount = $null
    if ($null -ne $registration) {
        $registeredImage = [string]$registration.ImagePath
        $registeredAccount = [string]$registration.ObjectName
        $registrationState = if ($registeredImage -eq $expectedImage -and $registeredAccount -eq $serviceAccount) { 'matches' } else { 'mismatch' }
    }
    foreach ($leaf in @($brokerRoot, $brokerExe)) {
        if (-not (Test-Path -LiteralPath $leaf)) { continue }
        $item = Get-Item -LiteralPath $leaf -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'The installed broker path contains a reparse point. The upgrade is refused without changing production files.'
        }
    }
    $policyItem = if (Test-Path -LiteralPath $brokerRoot -PathType Container) {
        Get-ChildItem -LiteralPath $brokerRoot -Filter 'policy.json' -File -Force
    }
    if ($null -ne $policyItem -and ($policyItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The installed broker policy is a reparse point. The upgrade is refused without changing production files.'
    }
    $installedFiles = (Test-Path -LiteralPath $brokerExe -PathType Leaf) -and ($null -ne $policyItem)
    $installed = $installedFiles -and ($null -ne $service) -and ($registrationState -eq 'matches')
    $roleAlreadyEnabled = $null
    $installedRequestsPerHour = $null
    $installedQuotaSource = 'not-installed'
    $legacyQuotaField = $null
    if ($installedFiles) {
        $policyReadable = $false
        try {
            $policyText = Get-Content -LiteralPath $brokerPolicy -Raw -ErrorAction Stop
            $policyReadable = $true
        }
        catch {
            if ($_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::PermissionDenied -and
                $_.Exception -isnot [UnauthorizedAccessException]) { throw }
            $installedQuotaSource = 'protected-policy-unreadable'
        }
        if ($policyReadable) {
            $installedQuotaSource = 'policy'
            $legacyQuotaField = $false
            $installedPolicy = ConvertFrom-Json -InputObject $policyText -ErrorAction Stop
            if ($null -eq $installedPolicy -or $installedPolicy -is [array] -or $installedPolicy -isnot [pscustomobject]) {
                throw 'The installed broker policy must be one JSON object.'
            }
            foreach ($requiredField in @('caller_sid', 'model', 'reasoning_effort')) {
                if ($null -eq $installedPolicy.PSObject.Properties[$requiredField]) {
                    throw ('The installed broker policy is missing the required field {0}.' -f $requiredField)
                }
            }
            $policyField = $installedPolicy.PSObject.Properties[$policyFieldName]
            $roleAlreadyEnabled = $false
            if ($null -ne $policyField) {
                if ($policyField.Value -isnot [bool]) { throw ('The installed broker policy has a non-boolean {0} field.' -f $policyFieldName) }
                $roleAlreadyEnabled = $policyField.Value
            }
            $quotaField = $installedPolicy.PSObject.Properties['requests_per_hour']
            if ($null -eq $quotaField) {
                # Compatibility only for policies written before the quota field existed.
                $installedRequestsPerHour = 24
                $installedQuotaSource = 'legacy-missing-field'
                $legacyQuotaField = $true
            } else {
                if ($quotaField.Value -isnot [int] -and $quotaField.Value -isnot [long]) {
                    throw 'The installed broker requests_per_hour field is not an integer.'
                }
                if ([long]$quotaField.Value -lt 1 -or [long]$quotaField.Value -gt 1000) {
                    throw 'The installed broker requests_per_hour field is outside the supported range.'
                }
                $installedRequestsPerHour = [int]$quotaField.Value
            }
        }
        elseif ($installed -and $serviceState -eq 'Running') {
            # The caller can use the status pipe without reading the protected policy file.
            $brokerStatus = $null
            try {
                $statusOutput = '{"op":"status"}' | & $brokerExe client
                if ($LASTEXITCODE -eq 0) {
                    $envelope = ($statusOutput -join "`n") | ConvertFrom-Json -ErrorAction Stop
                    if ($envelope.ok -eq $true -and $envelope.status -eq 200) { $brokerStatus = $envelope.body }
                }
            }
            catch { $brokerStatus = $null }
            if ($null -ne $brokerStatus) {
                $roleProperty = $brokerStatus.PSObject.Properties[('{0}_enabled' -f $roleKey)]
                $roleAlreadyEnabled = $null -ne $roleProperty -and $roleProperty.Value -eq $true
                $quotaProperty = $brokerStatus.PSObject.Properties['requests_per_hour']
                if ($null -ne $quotaProperty) {
                    $value = $quotaProperty.Value
                    if (($value -is [int] -or $value -is [long]) -and $value -ge 1 -and $value -le 1000) {
                        $installedRequestsPerHour = [int]$value
                        $installedQuotaSource = 'broker-status'
                    }
                }
            }
        }
    }
    $quotaChange = if ($installed -and $quotaRequested -and $null -eq $installedRequestsPerHour) {
        $null
    } else {
        $installed -and $quotaRequested -and ($RequestsPerHour -ne $installedRequestsPerHour)
    }
    if ($installed -and $quotaRequested -and $null -ne $installedRequestsPerHour -and $RequestsPerHour -lt $installedRequestsPerHour) {
        throw ("The requested hourly quota {0} is below the installed quota {1}. This operation only raises the bound. Nothing was changed." -f $RequestsPerHour, $installedRequestsPerHour)
    }
    $needsChange = if ($null -ne $roleAlreadyEnabled -and $null -ne $quotaChange) {
        (-not $roleAlreadyEnabled) -or $quotaChange
    }
    $applyState = if (-not $installed) {
        'unavailable: no complete installed broker was found'
    } elseif ($needsChange -eq $false) {
        ('no-op: {0} is already true and requests_per_hour is already {1}. Apply verifies the installed policy and leaves the service in its current state' -f $policyFieldName, $installedRequestsPerHour)
    } elseif ($serviceState -eq 'Running') {
        if ($AllowBriefRestart) {
            'conditional: -AllowBriefRestart requests one brief stop after compilation, backup, policy validation and repeated read-only client sampling; busy, unclear or changing state still refuses'
        } elseif ($needsChange -eq $true) {
            'blocked by default: the running service is not stopped without explicit -AllowBriefRestart; stop it at a maintenance point or rerun with that consent switch'
        } else {
            'conditional: elevation verifies whether a change is needed. A Running service can only stop with explicit -AllowBriefRestart consent'
        }
    } elseif ($serviceState -eq 'Stopped') {
        'available after UAC verification; the service remains Stopped and is not started'
    } else {
        ('blocked: the service is {0}; it must be stable Running or Stopped before the protected upgrade can proceed' -f $serviceState)
    }
    $quotedEntry = "'{0}'" -f $PSCommandPath.Replace("'", "''")
    $quotaArgument = if ($quotaRequested) { ' -RequestsPerHour {0}' -f $RequestsPerHour } else { '' }
    $applyCommand = ('& {0} -ExpectedRevision {1} {2}{3} -Apply' -f $quotedEntry, $ExpectedRevision, $enableArgument, $quotaArgument)
    $applyCommandBriefRestart = ('& {0} -ExpectedRevision {1} {2}{3} -AllowBriefRestart -Apply' -f $quotedEntry, $ExpectedRevision, $enableArgument, $quotaArgument)
    $preview = [ordered]@{
        operation = $operation
        expected_revision = $sourcePlan.status.revision
        source_bundle_sha256 = $sourcePlan.status.source_bundle_sha256
        source_files = $sourcePlan.status.source_files
        installed_broker_present = [bool]$installed
        service_state = $serviceState
        service_registration = $registrationState
        registered_image_path = $registeredImage
        registered_account = $registeredAccount
        changed_files = $sourcePlan.status.changed_files
        requests_per_hour = [ordered]@{
            current = $installedRequestsPerHour
            current_source = $installedQuotaSource
            legacy_missing_field = $legacyQuotaField
            new_protected_install = 100
            legacy_fallback = 24
            requested = $(if ($quotaRequested) { $RequestsPerHour } else { $null })
            change = $quotaChange
            maximum = 1000
            field = 'requests_per_hour'
            increases_only = $true
        }
        policy_change = ('Set {0} to true and preserve the other role setting, caller_sid, model, reasoning_effort, project and organization. Change requests_per_hour only when the operator supplies -RequestsPerHour. Existing explicit limits remain in effect without that request. An old policy without a quota field keeps the historical 24/hour limit.' -f $policyFieldName)
        preserved = @('service registration and service identity', 'state directory', 'DPAPI credential', 'rolling rate records', 'audit logs', 'MCP registration', 'DSH schedule and rules')
        administrator_consent = 'A UAC prompt is requested only with -Apply and authorizes only the installed SolBroker.exe and policy.json replacement. A brief stop and restart are authorized only by the separate explicit -AllowBriefRestart consent switch.'
        service_stop_condition = 'The default apply refuses to stop a Running service. With explicit restart consent during a maintenance window, the protected installer compiles, backs up and validates the policy, then checks the service registration, account, stable state/PID and protected SolBroker.exe clients before one brief stop.'
        brief_restart = [ordered]@{
            requested = [bool]$AllowBriefRestart
            default = 'refuse to stop a Running service'
            consent_switch = '-AllowBriefRestart'
            accepted_only_with = "$enableArgument -Apply"
            no_atomic_drain = $true
            maintenance_window_required = $true
            client_sampling = 'Five short-interval read-only samples of protected SolBroker.exe client processes. A busy, unreadable or changing service/process state refuses the upgrade; no caller is terminated.'
            residual_race = 'The old service has no atomic drain or refusal barrier. A caller can still start between the final check and the stop even with explicit consent.'
        }
        apply_state = $applyState
        preview_side_effects = $false
        apply_command = $applyCommand
        apply_command_with_brief_restart = $applyCommandBriefRestart
    }
    $preview | ConvertTo-Json -Depth 6
    if (-not $Apply) { return }
    if (-not $installed) { throw 'The broker API role upgrade only applies to an existing installed Sol broker. Nothing was changed.' }
    if ($serviceState -eq 'Running' -and -not $AllowBriefRestart -and $needsChange -eq $true) {
        throw ('The installed AiRuleSolBroker service is Running. The default broker API role upgrade does not stop it. Wait for a short maintenance window and rerun with -AllowBriefRestart only after in-flight API calls finish, or stop the service yourself and rerun without the switch. The old service has no atomic drain, so a caller can still race the stop even with consent. Nothing was changed.')
    }
    if (-not [Environment]::UserInteractive) { throw 'Run the broker API role upgrade in a local interactive PowerShell window for UAC.' }

    $transfer = Join-Path ([IO.Path]::GetTempPath()) ('ai-rule-sol-upgrade-' + [Guid]::NewGuid().ToString('N'))
    $null = New-Item -Path $transfer -ItemType Directory
    $bundle = Join-Path $transfer 'broker-source.json'
    $lock = $null
    try {
        $acl = Get-Acl -LiteralPath $transfer
        $admins = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($admins, 'ReadAndExecute', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
        Set-Acl -LiteralPath $transfer -AclObject $acl
        $elevationArguments = @("${roleKey}-elevation", '--revision', $ExpectedRevision, '--git', $git,
            '--program-files', $programs, '--bundle-path', $bundle)
        if ($AllowBriefRestart) { $elevationArguments += '--allow-brief-restart' }
        if ($quotaRequested) { $elevationArguments += @('--requests-per-hour', [string]$RequestsPerHour) }
        $encoded = & $node $helper @elevationArguments
        if ($LASTEXITCODE -ne 0 -or $encoded -notmatch '\A[A-Za-z0-9+/]+={0,2}\z') {
            throw 'The reviewed broker API role elevation command could not be prepared.'
        }
        $lock = [IO.File]::Open($bundle, 'Open', 'Read', 'Read')
        $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
        if ($AllowBriefRestart -and $serviceState -eq 'Running' -and $needsChange -ne $false) {
            Write-Host 'Approve UAC for the reviewed broker API role upgrade. The protected installer compiles, backs up and validates first, then refuses if a protected SolBroker.exe client is busy or the service state/PID changes. Only an idle service is stopped once and restarted once. No caller is terminated; the old service still has no atomic drain.'
        }
        else {
            Write-Host 'Approve UAC to replace only SolBroker.exe and policy.json. No credential, state, audit, rate record, MCP or schedule file is in this operation.'
        }
        $elevated = Start-Process -FilePath $powershell -WorkingDirectory ([Environment]::SystemDirectory) `
            -ArgumentList @('-NoLogo', '-NoProfile', '-EncodedCommand', $encoded) -Verb RunAs -PassThru -Wait
        try {
            if ($elevated.ExitCode -ne 0) {
                throw 'The elevated broker API role upgrade did not complete. Review its local message; no partial success is assumed.'
            }
        }
        finally { $elevated.Dispose() }
    }
    finally {
        if ($null -ne $lock) { $lock.Dispose() }
        [IO.File]::Delete($bundle)
        [IO.Directory]::Delete($transfer, $false)
    }
    Write-Host 'The elevated broker API role upgrade exited successfully. Verify the installed policy, effective requests_per_hour and service on the target machine before reporting it as active.'
    return
}

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
