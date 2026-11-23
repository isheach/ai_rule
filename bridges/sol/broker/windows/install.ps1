#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Install')]
    [ValidatePattern('\AS-1-(?:5-21|12-1)(?:-[0-9]+){4}\z')][string]$ClientSid,
    [Parameter(ParameterSetName = 'Install')]
    [ValidatePattern('\A[a-z0-9][a-z0-9_.:-]{0,99}\z')][string]$Model = 'gpt-6.2-sol',
    [Parameter(ParameterSetName = 'Install')]
    [ValidateSet('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')][string]$ReasoningEffort = 'max',
    [Parameter(ParameterSetName = 'Install')]
    [ValidatePattern('\Aproj_[A-Za-z0-9_-]{1,140}\z')][string]$ProjectId,
    [Parameter(ParameterSetName = 'Install')]
    [ValidatePattern('\Aorg[-_][A-Za-z0-9_-]{1,140}\z')][string]$OrganizationId,
    [Parameter(Mandatory, ParameterSetName = 'Uninstall')][switch]$Uninstall,
    [Parameter(Mandatory, ParameterSetName = 'EnableTerraApi')][switch]$EnableTerraApi,
    [Parameter(Mandatory, ParameterSetName = 'EnableLunaApi')][switch]$EnableLunaApi,
    [Parameter(ParameterSetName = 'EnableLunaApi')]
    [Parameter(ParameterSetName = 'EnableTerraApi')][ValidateRange(1, 1000)][int]$RequestsPerHour,
    [Parameter(ParameterSetName = 'EnableLunaApi')]
    [Parameter(ParameterSetName = 'EnableTerraApi')][switch]$AllowBriefRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitProcess) { throw 'Use a 64-bit PowerShell process.' }
if ($PSCmdlet.ParameterSetName -in @('EnableTerraApi', 'EnableLunaApi') -and -not ($EnableTerraApi -or $EnableLunaApi)) {
    throw 'Select the installed broker role to enable.'
}
$quotaRequested = $PSBoundParameters.ContainsKey('RequestsPerHour')
$name = 'AiRuleSolBroker'
$account = "NT SERVICE\$name"
$serviceSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-80-2491726543-4042735884-3184637371-1420765198-420171591')
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$adminSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$authenticatedSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-11')
$trustedInstallerSid = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$trustedWriters = @($adminSid.Value, $systemSid.Value, $trustedInstallerSid)
$writeRights = [Security.AccessControl.FileSystemRights]'Write, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
$policyModelPattern = [regex]'\A[a-z0-9][a-z0-9_.:-]{0,99}\z'
$policyHeaderPattern = [regex]'\A[A-Za-z0-9_.:@/-]{1,160}\z'
$policyEfforts = @('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
$parent = [Environment]::GetFolderPath('ProgramFiles')
$root = Join-Path $parent $name
$state = Join-Path $root 'state'
$exe = Join-Path $root 'SolBroker.exe'
$policyFile = Join-Path $root 'policy.json'
$image = '"{0}" service' -f $exe
$serviceRegistry = "HKLM:\SYSTEM\CurrentControlSet\Services\$name"
$sc = Join-Path ([Environment]::SystemDirectory) 'sc.exe'

function Require-RealDirectory([string]$Location) {
    $item = Get-Item -LiteralPath $Location -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The fixed installation directory must be a local directory without a reparse point.'
    }
}

function Protect-Directory([string]$Location, [bool]$IsState) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($adminSid)
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($sid in @($systemSid, $adminSid)) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, 'None', 'Allow'))
    }
    $rights = if ($IsState) { 'Modify' } else { 'ReadAndExecute' }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($serviceSid, $rights, $inherit, 'None', 'Allow'))
    if (-not $IsState) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($authenticatedSid, 'ReadAndExecute', $inherit, 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $Location -AclObject $acl
}

function Protect-InstalledFile([string]$Location, [bool]$IsExecutable) {
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($adminSid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($systemSid, $adminSid)) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
    }
    $rights = if ($IsExecutable) { 'ReadAndExecute' } else { 'Read' }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($serviceSid, $rights, 'Allow'))
    if ($IsExecutable) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($authenticatedSid, 'ReadAndExecute', 'Allow'))
    }
    Set-Acl -LiteralPath $Location -AclObject $acl
}

function Get-PhysicalLocalItem([string]$Location) {
    $absolute = [IO.Path]::GetFullPath($Location)
    if ($Location -notmatch '^[A-Za-z]:[\\/]' -or $absolute.Substring(2).Contains(':')) {
        throw 'Broker upgrade paths must be local drive paths.'
    }
    $item = Get-Item -LiteralPath $absolute -Force
    $ancestor = $item
    while ($null -ne $ancestor) {
        if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Broker upgrade paths cannot use reparse points.'
        }
        $ancestor = if ($ancestor -is [IO.DirectoryInfo]) { $ancestor.Parent } else { $ancestor.Directory }
    }
    return $item
}

function Assert-ProtectedPath([string]$Location, [switch]$Directory, [string[]]$Writers = $trustedWriters) {
    $item = Get-PhysicalLocalItem $Location
    if (($item -is [IO.DirectoryInfo]) -ne [bool]$Directory) {
        throw 'The installed broker path has an unexpected file type.'
    }
    $acl = Get-Acl -LiteralPath $Location
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trustedWriters) {
        throw 'The installed broker path has an unexpected owner.'
    }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $writeRights) -and
            $rule.IdentityReference.Value -notin $Writers -and
            -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) {
            throw 'The installed broker path permits writes outside the administrator trust boundary.'
        }
    }
}

function Get-BrokerFileHash([string]$Location) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::Open($Location, 'Open', 'Read', 'Read')
        try { $bytes = $sha.ComputeHash($stream) }
        finally { $stream.Dispose() }
    }
    finally { $sha.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

function Copy-ExactBrokerFile([string]$Source, [string]$Destination) {
    if (Test-Path -LiteralPath $Destination) { throw 'An upgrade backup already exists.' }
    $input = [IO.File]::Open($Source, 'Open', 'Read', 'Read')
    try {
        $output = [IO.File]::Open($Destination, 'CreateNew', 'Write', 'None')
        try {
            $buffer = New-Object byte[] 81920
            while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $output.Write($buffer, 0, $count)
            }
            $output.Flush($true)
        }
        finally { $output.Dispose() }
    }
    finally { $input.Dispose() }
    [IO.File]::SetLastWriteTimeUtc($Destination, [IO.File]::GetLastWriteTimeUtc($Source))
    return Get-BrokerFileHash $Destination
}

function Restore-ExactBrokerFile([string]$Backup, [string]$Destination, [Security.AccessControl.FileSecurity]$Acl,
    [string]$ExpectedHash, [string]$RestoreDirectory) {
    $temporary = Join-Path $RestoreDirectory ('restore-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::Copy($Backup, $temporary, $false)
        if ((Get-BrokerFileHash $temporary) -cne $ExpectedHash) { throw 'A broker backup failed its SHA-256 check.' }
        Set-Acl -LiteralPath $temporary -AclObject $Acl
        [IO.File]::Replace($temporary, $Destination, [System.Management.Automation.Language.NullString]::Value)
        Set-Acl -LiteralPath $Destination -AclObject $Acl
        if ((Get-Acl -LiteralPath $Destination).Sddl -cne $Acl.Sddl) { throw 'The restored broker file permissions differ from the captured permissions.' }
        if ((Get-BrokerFileHash $Destination) -cne $ExpectedHash) { throw 'The restored broker file failed its SHA-256 check.' }
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) }
    }
}

function Read-InstalledBrokerPolicy {
    $item = Get-PhysicalLocalItem $policyFile
    if ($item.PSIsContainer -or $item.Length -lt 1 -or $item.Length -gt 4096) {
        throw 'The installed broker policy has an invalid type or size.'
    }
    $bytes = [IO.File]::ReadAllBytes($policyFile)
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    try { $text = $encoding.GetString($bytes) } catch { throw 'The installed broker policy is not strict UTF-8.' }
    try { $value = ConvertFrom-Json -InputObject $text -ErrorAction Stop } catch { throw 'The installed broker policy is not valid JSON.' }
    if ($null -eq $value -or $value -is [array]) { throw 'The installed broker policy must be one JSON object.' }
    $names = @($value.PSObject.Properties.Name)
    foreach ($name in @('caller_sid', 'model', 'reasoning_effort')) {
        if ($names -cnotcontains $name) { throw 'The installed broker policy is missing a required field.' }
    }
    $allowed = @('caller_sid', 'model', 'reasoning_effort', 'project', 'organization', 'allow_terra_api', 'allow_luna_api', 'requests_per_hour')
    foreach ($name in $names) {
        if ($allowed -cnotcontains $name) { throw 'The installed broker policy has an unexpected field.' }
    }
    try { $caller = [Security.Principal.SecurityIdentifier]::new([string]$value.caller_sid) }
    catch { throw 'The installed broker policy has an invalid caller SID.' }
    if ((-not $caller.IsAccountSid() -and -not $caller.Value.StartsWith('S-1-12-1-')) -or $caller.Equals($serviceSid)) {
        throw 'The installed broker policy has an invalid caller SID.'
    }
    if ($value.model -isnot [string] -or -not $policyModelPattern.IsMatch($value.model) -or
        $value.model -cin @('gpt-6.1-terra', 'gpt-6-luna')) {
        throw 'The installed broker policy has an invalid Sol model.'
    }
    if ($value.reasoning_effort -isnot [string] -or $policyEfforts -notcontains $value.reasoning_effort) {
        throw 'The installed broker policy has an invalid Sol reasoning effort.'
    }
    foreach ($name in @('project', 'organization')) {
        if ($names -notcontains $name) { continue }
        $header = $value.PSObject.Properties[$name].Value
        if ($header -isnot [string] -or -not $policyHeaderPattern.IsMatch($header)) {
            throw 'The installed broker policy has an invalid project or organization header.'
        }
    }
    foreach ($name in @('allow_terra_api', 'allow_luna_api')) {
        $property = $value.PSObject.Properties[$name]
        if ($null -ne $property -and $property.Value -isnot [bool]) {
            throw ('The installed broker policy has a non-boolean {0} field.' -f $name)
        }
    }
    $requestsPerHour = 24
    if ($names -contains 'requests_per_hour') {
        $quota = $value.PSObject.Properties['requests_per_hour'].Value
        if ($quota -isnot [int] -and $quota -isnot [long]) {
            throw 'The installed broker policy has a non-integer requests_per_hour field.'
        }
        if ([long]$quota -lt 1 -or [long]$quota -gt 1000) {
            throw 'The installed broker policy has a requests_per_hour field outside the supported range.'
        }
        $requestsPerHour = [int]$quota
    }
    return [pscustomobject]@{ Value = $value; RequestsPerHour = $requestsPerHour }
}

function New-InstallBrokerPolicy([string]$CallerSid, [string]$Model, [string]$Effort, [string]$Project, [string]$Organization) {
    # New protected installations opt in to the current 100/hour default explicitly.
    # Policies from older installations without this field keep the broker's historical
    # 24/hour interpretation until an operator applies the reviewed upgrade.
    $policy = [ordered]@{
        caller_sid = $CallerSid
        model = $Model
        reasoning_effort = $Effort.ToLowerInvariant()
        requests_per_hour = 100
    }
    if ($Project) { $policy.project = $Project }
    if ($Organization) { $policy.organization = $Organization }
    return $policy
}

function New-BrokerUpgradePolicy([object]$Policy, [string]$EnableField, [bool]$SetQuota, [int]$RequestsPerHour) {
    $ordered = [ordered]@{}
    foreach ($property in $Policy.Value.PSObject.Properties) {
        if ($property.Name -ceq $EnableField) { continue }
        if ($SetQuota -and $property.Name -ceq 'requests_per_hour') { continue }
        $ordered[$property.Name] = $property.Value
    }
    if ($EnableField) { $ordered[$EnableField] = $true }
    if ($SetQuota) { $ordered['requests_per_hour'] = $RequestsPerHour }
    $json = $ordered | ConvertTo-Json -Compress -Depth 4
    try { $parsed = ConvertFrom-Json -InputObject $json -ErrorAction Stop } catch { throw 'The new broker policy is not valid JSON.' }
    if ($null -eq $parsed -or $parsed -is [array]) { throw 'The new broker policy must be one JSON object.' }
    foreach ($property in $Policy.Value.PSObject.Properties) {
        if ($property.Name -ceq $EnableField) { continue }
        if ($SetQuota -and $property.Name -ceq 'requests_per_hour') { continue }
        $after = $parsed.PSObject.Properties[$property.Name]
        if ($null -eq $after -or [string]$after.Value -cne [string]$property.Value) {
            throw 'The new broker policy changed an existing field.'
        }
    }
    if ($EnableField -and $parsed.PSObject.Properties[$EnableField].Value -ne $true) {
        throw ('The new broker policy did not enable {0}.' -f $EnableField)
    }
    if ($SetQuota -and [int]$parsed.PSObject.Properties['requests_per_hour'].Value -ne $RequestsPerHour) {
        throw 'The new broker policy did not set the requested hourly quota.'
    }
    return [pscustomobject]@{ Json = $json }
}

function Get-BrokerServiceSnapshot {
    if (-not (Test-Path -LiteralPath $serviceRegistry)) { throw 'The fixed AiRuleSolBroker service is not installed.' }
    try { $configuration = Get-ItemProperty -LiteralPath $serviceRegistry -Name ImagePath, ObjectName -ErrorAction Stop }
    catch { throw 'The fixed AiRuleSolBroker service registration cannot be read.' }
    if ([string]$configuration.ImagePath -cne $image -or [string]$configuration.ObjectName -cne $account) {
        throw 'The fixed AiRuleSolBroker service registration or identity was changed.'
    }
    $service = Get-Service -Name $name -ErrorAction Stop
    try { $state = [string]$service.Status }
    finally { $service.Dispose() }
    if ($state -cnotin @('Running', 'Stopped')) {
        throw ("The AiRuleSolBroker service is {0}. The broker API role upgrade requires a stable Running or Stopped service. No production file was changed." -f $state)
    }
    try { $registered = Get-CimInstance -ClassName Win32_Service -Filter ("Name='{0}'" -f $name) -ErrorAction Stop }
    catch { throw 'The fixed AiRuleSolBroker service state cannot be read; the upgrade is refused without changing production files.' }
    if ($null -eq $registered) { throw 'The fixed AiRuleSolBroker service state could not be identified; the upgrade is refused.' }
    if ([string]$registered.PathName -cne $image -or [string]$registered.StartName -cne $account) {
        throw 'The fixed AiRuleSolBroker service registration or identity was changed.'
    }
    if ([string]$registered.State -cne $state) {
        throw 'The fixed AiRuleSolBroker service state could not be verified consistently; the upgrade is refused.'
    }
    $serviceProcessId = [int]$registered.ProcessId
    if ($state -eq 'Running' -and $serviceProcessId -le 0) {
        throw 'The running AiRuleSolBroker service did not report a stable process ID; the upgrade is refused.'
    }
    if ($state -eq 'Stopped' -and $serviceProcessId -ne 0) {
        throw 'The stopped AiRuleSolBroker service reported an unexpected process ID; the upgrade is refused.'
    }
    return [pscustomobject]@{
        State = $state
        ProcessId = $serviceProcessId
        Status = $state
    }
}

function Assert-BrokerUpgradeGate([object]$Before, [bool]$AllowBriefRestart) {
    $current = Get-BrokerServiceSnapshot
    if ($current.State -cne $Before.State -or $current.ProcessId -ne $Before.ProcessId) {
        throw ("The AiRuleSolBroker service changed from {0} (PID {1}) to {2} (PID {3}) during the upgrade. No production file was replaced and the service was not stopped." -f
            $Before.State, $Before.ProcessId, $current.State, $current.ProcessId)
    }
    if ($current.State -eq 'Stopped') { return $current }
    if (-not $AllowBriefRestart) {
        throw ("The installed AiRuleSolBroker service is Running (PID {0}). This command does not stop a running service by default. Wait for a short maintenance window, let in-flight API calls finish, and rerun the same upgrade with -AllowBriefRestart. The old service has no atomic drain or refusal barrier, so even with that explicit consent a caller can start between the final check and the stop. No production file was replaced and the service was not stopped." -f $current.ProcessId)
    }
    return $current
}

function Get-ProtectedBrokerClientProcessIds([int]$ServiceProcessId) {
    try { $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='SolBroker.exe'" -ErrorAction Stop) }
    catch { throw 'SolBroker.exe client processes could not be enumerated; the upgrade is refused without stopping the service.' }
    $expected = [IO.Path]::GetFullPath($exe)
    $clients = New-Object 'System.Collections.Generic.List[int]'
    foreach ($process in $processes) {
        $processId = [int]$process.ProcessId
        # The service PID comes from SCM. Every other same-image process is treated as a possible caller.
        if ($processId -eq $ServiceProcessId) { continue }
        $path = [string]$process.ExecutablePath
        if ([string]::IsNullOrWhiteSpace($path)) {
            throw ("The executable path of SolBroker.exe process {0} could not be read; the upgrade is refused without stopping the service." -f $processId)
        }
        try { $resolved = [IO.Path]::GetFullPath($path) }
        catch { throw ("The executable path of SolBroker.exe process {0} is not a valid local path; the upgrade is refused without stopping the service." -f $processId) }
        # A different image path is verified unrelated. A same-image non-service process may be an in-flight caller.
        if (-not [string]::Equals($resolved, $expected, [StringComparison]::OrdinalIgnoreCase)) { continue }
        [void]$clients.Add($processId)
    }
    return @($clients.ToArray())
}

function Wait-ForIdleBrokerClients([object]$Snapshot) {
    $samples = 5
    $intervalMilliseconds = 600
    for ($sample = 1; $sample -le $samples; $sample++) {
        if ($sample -gt 1) { Start-Sleep -Milliseconds $intervalMilliseconds }
        $current = Get-BrokerServiceSnapshot
        if ($current.State -cne 'Running' -or $current.ProcessId -ne $Snapshot.ProcessId) {
            throw ("The AiRuleSolBroker service changed from Running (PID {0}) to {1} (PID {2}) during idle sampling. No service stop or caller termination was attempted." -f
                $Snapshot.ProcessId, $current.State, $current.ProcessId)
        }
        $clients = @(Get-ProtectedBrokerClientProcessIds $current.ProcessId)
        if ($clients.Count -gt 0) {
            throw ("Detected {0} protected SolBroker.exe client process(es) (PID {1}). The service was not stopped and no caller was terminated. Wait for in-flight API calls to finish and retry in a maintenance window." -f
                $clients.Count, ($clients -join ', '))
        }
    }
}

function Assert-BrokerCanStop([object]$Snapshot) {
    $service = Get-Service -Name $name -ErrorAction Stop
    try {
        if ($service.Status -ne [ServiceProcess.ServiceControllerStatus]::Running) {
            throw ("The AiRuleSolBroker service is {0}, not Running; it was not stopped." -f $service.Status)
        }
        $dependents = @($service.DependentServices | Where-Object {
            $_.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped
        })
        if ($dependents.Count -gt 0) {
            $names = @($dependents | ForEach-Object { $_.ServiceName }) -join ', '
            throw ("The AiRuleSolBroker service has running dependent service(s): {0}. They were not stopped or forced; the upgrade is refused." -f $names)
        }
    }
    finally { $service.Dispose() }
}

function Stop-BrokerServiceOnce {
    $service = Get-Service -Name $name -ErrorAction Stop
    try {
        if ($service.Status -ne [ServiceProcess.ServiceControllerStatus]::Running) {
            throw ("The AiRuleSolBroker service is {0}, not Running; the one allowed stop was not sent." -f $service.Status)
        }
        $service.Stop()
        $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(20))
        if ($service.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped) {
            throw 'The AiRuleSolBroker service did not reach Stopped within 20 seconds.'
        }
    }
    finally { $service.Dispose() }
}

function Wait-ForBrokerSnapshot([string]$ExpectedState) {
    $lastError = $null
    for ($attempt = 1; $attempt -le 20; $attempt++) {
        try {
            $snapshot = Get-BrokerServiceSnapshot
            if ($snapshot.State -ceq $ExpectedState) { return $snapshot }
            $lastError = ('observed state ' + $snapshot.State)
        }
        catch { $lastError = $_.Exception.Message }
        if ($attempt -lt 20) { Start-Sleep -Milliseconds 250 }
    }
    throw ("The AiRuleSolBroker service did not reach a verified {0} state: {1}" -f $ExpectedState, $lastError)
}

function Remove-UpgradeDirectory([string]$Location) {
    $full = [IO.Path]::GetFullPath($Location)
    if ([IO.Path]::GetDirectoryName($full) -ne [IO.Path]::GetFullPath($parent) -or
        [IO.Path]::GetFileName($full) -notmatch '\AAiRuleSolBroker-upgrade-[0-9a-f]{32}\z') {
        throw 'Refusing to remove an unexpected upgrade directory.'
    }
    $item = Get-Item -LiteralPath $full -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Refusing to remove an unexpected upgrade directory.'
    }
    [IO.Directory]::Delete($full, $true)
}

function Invoke-ServiceTool([string[]]$ServiceArguments) {
    & $sc @ServiceArguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "The Sol broker service operation failed (SCM error $LASTEXITCODE)." }
}

function Remove-ServiceRegistration {
    $configuration = Get-ItemProperty -LiteralPath $serviceRegistry -Name ImagePath, ObjectName
    if ($configuration.ImagePath -ne $image -or $configuration.ObjectName -ne $account) {
        throw 'The existing service does not match the fixed Sol broker installation.'
    }
    $service = Get-Service -Name $name
    try {
        if ($service.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped) {
            $service.Stop()
            $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(15))
        }
    }
    finally { $service.Dispose() }
    Invoke-ServiceTool @('delete', $name)
}

function Remove-KnownFiles {
    if (-not (Test-Path -LiteralPath $root)) { return }
    Require-RealDirectory $root
    if ((Get-Acl -LiteralPath $root).GetOwner([Security.Principal.SecurityIdentifier]) -ne $adminSid) {
        throw 'The existing installation directory has an unexpected owner.'
    }
    if (Test-Path -LiteralPath $state) {
        Require-RealDirectory $state
        foreach ($leaf in @('credential.dpapi', 'credential.dpapi.new', 'rate.bin', 'rate.bin.new', 'audit.jsonl', 'audit.previous.jsonl')) {
            [IO.File]::Delete((Join-Path $state $leaf))
        }
        [IO.Directory]::Delete($state, $false)
    }
    [IO.File]::Delete($exe)
    [IO.File]::Delete($policyFile)
    [IO.Directory]::Delete($root, $false)
}

function Invoke-BrokerUpgrade([ValidateSet('Terra', 'Luna')][string]$Role, [switch]$SetQuota, [int]$RequestsPerHour) {
    $setupMutex = $null
    $ownsSetupMutex = $false
    try {
        $setupMutex = [Threading.Mutex]::new($false, 'Global\AiRuleSolBroker.Setup.v1')
        try { $ownsSetupMutex = $setupMutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $ownsSetupMutex = $true }
        if (-not $ownsSetupMutex) {
            throw 'Another AiRuleSolBroker setup or upgrade operation is in progress. No production file was changed.'
        }

        Assert-ProtectedPath $parent -Directory
        Assert-ProtectedPath $root -Directory
        Assert-ProtectedPath $exe
        Assert-ProtectedPath $policyFile
        $serviceBefore = Get-BrokerServiceSnapshot
        $currentPolicy = Read-InstalledBrokerPolicy
        $policyField = 'allow_{0}_api' -f $Role.ToLowerInvariant()
        $property = $currentPolicy.Value.PSObject.Properties[$policyField]
        $enableField = if ($null -eq $property -or $property.Value -eq $false) { $policyField } else { '' }
        $changeQuota = $SetQuota -and ($RequestsPerHour -ne $currentPolicy.RequestsPerHour)
        if ($SetQuota -and $RequestsPerHour -lt $currentPolicy.RequestsPerHour) {
            throw ("The requested hourly quota {0} is below the installed quota {1}. This operation only raises the bound; no production file was written and the service was not stopped or started." -f
                $RequestsPerHour, $currentPolicy.RequestsPerHour)
        }
        if (-not $enableField -and -not $changeQuota) {
            Write-Output ("The installed broker already has {0} API enabled and requests_per_hour {1}. No production file was written and the service was not stopped or started (state: {2}, PID {3})." -f
                $Role, $currentPolicy.RequestsPerHour,
                $serviceBefore.State, $serviceBefore.ProcessId)
            return
        }
        $operation = if ($enableField -and $changeQuota) { "$Role API and hourly quota" } elseif ($enableField) { "$Role API" } else { 'hourly quota' }

        $upgradeDirectory = Join-Path $parent ('AiRuleSolBroker-upgrade-' + [Guid]::NewGuid().ToString('N'))
        $backupDirectory = Join-Path $upgradeDirectory 'backup'
        $upgradeAcl = [Security.AccessControl.DirectorySecurity]::new()
        $upgradeAcl.SetOwner($adminSid)
        $upgradeAcl.SetAccessRuleProtection($true, $false)
        $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        foreach ($sid in @($adminSid, $systemSid)) {
            $upgradeAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, 'None', 'Allow'))
        }
        $null = [IO.Directory]::CreateDirectory($upgradeDirectory, $upgradeAcl)
        $null = [IO.Directory]::CreateDirectory($backupDirectory, $upgradeAcl)
        $preserveForRecovery = $false
        $exeReplaced = $false
        $policyReplaced = $false
        $stopRequested = $false
        $originalState = $serviceBefore.State
        $originalServicePid = $serviceBefore.ProcessId
        $originalExeAcl = $null
        $originalPolicyAcl = $null
        $originalExeHash = $null
        $originalPolicyHash = $null
        $candidateExeHash = $null
        $newPolicyHash = $null
        $backupExe = Join-Path $backupDirectory 'SolBroker.exe'
        $backupPolicy = Join-Path $backupDirectory 'policy.json'
        $transactionFile = Join-Path $backupDirectory 'transaction.json'
        try {
            Assert-ProtectedPath $upgradeDirectory -Directory
            Assert-ProtectedPath $backupDirectory -Directory
            $originalExeAcl = Get-Acl -LiteralPath $exe
            $originalPolicyAcl = Get-Acl -LiteralPath $policyFile
            $originalExeHash = Get-BrokerFileHash $exe
            $originalPolicyHash = Get-BrokerFileHash $policyFile

            $candidateExe = Join-Path $upgradeDirectory 'SolBroker.exe.candidate'
            $candidatePolicy = Join-Path $upgradeDirectory 'policy.json.candidate'
            & (Join-Path $PSScriptRoot 'build.ps1') -OutputPath $candidateExe
            if (-not (Test-Path -LiteralPath $candidateExe -PathType Leaf)) {
                throw 'The protected candidate broker executable was not produced.'
            }
            $candidateItem = Get-PhysicalLocalItem $candidateExe
            if ($candidateItem.Length -lt 2) { throw 'The protected candidate broker executable is empty.' }
            $stream = [IO.File]::Open($candidateExe, 'Open', 'Read', 'Read')
            try {
                $mz = New-Object byte[] 2
                if ($stream.Read($mz, 0, 2) -ne 2 -or $mz[0] -ne 0x4D -or $mz[1] -ne 0x5A) {
                    throw 'The protected candidate broker executable is not a Windows image.'
                }
            }
            finally { $stream.Dispose() }
            Protect-InstalledFile $candidateExe $true
            Assert-ProtectedPath $candidateExe
            $candidateExeHash = Get-BrokerFileHash $candidateExe

            $newPolicy = New-BrokerUpgradePolicy $currentPolicy $enableField $changeQuota $RequestsPerHour
            [IO.File]::WriteAllText($candidatePolicy, $newPolicy.Json, [Text.UTF8Encoding]::new($false))
            Protect-InstalledFile $candidatePolicy $false
            Assert-ProtectedPath $candidatePolicy
            $newPolicyHash = Get-BrokerFileHash $candidatePolicy

            if ((Copy-ExactBrokerFile $exe $backupExe) -cne $originalExeHash) {
                throw 'The exact broker executable backup failed its SHA-256 check.'
            }
            if ((Copy-ExactBrokerFile $policyFile $backupPolicy) -cne $originalPolicyHash) {
                throw 'The exact broker policy backup failed its SHA-256 check.'
            }
            $transaction = [ordered]@{
                created_utc = [DateTime]::UtcNow.ToString('o')
                service_state_before = $originalState
                service_pid_before = $originalServicePid
                operation = $operation
                enabled_policy_field = $enableField
                requests_per_hour_before = $currentPolicy.RequestsPerHour
                requests_per_hour_after = $(if ($changeQuota) { $RequestsPerHour } else { $currentPolicy.RequestsPerHour })
                allow_brief_restart = [bool]$AllowBriefRestart
                service_control = 'At most one stop and one start, only with explicit consent and only when the service was Running. No caller termination, no forced dependent stop.'
                drain = 'None. Protected SolBroker.exe client processes are sampled read-only; a caller can still race the final check and the stop.'
                exe_path = $exe
                exe_sha256 = $originalExeHash
                exe_acl_sddl = $originalExeAcl.Sddl
                policy_path = $policyFile
                policy_sha256 = $originalPolicyHash
                policy_acl_sddl = $originalPolicyAcl.Sddl
                candidate_exe_sha256 = $candidateExeHash
                candidate_policy_sha256 = $newPolicyHash
                backup_exe = $backupExe
                backup_policy = $backupPolicy
            }
            [IO.File]::WriteAllText($transactionFile, ($transaction | ConvertTo-Json -Depth 3),
                [Text.UTF8Encoding]::new($false))

            # Phase 2: authoritative local gate. Compilation, backups and policy validation above
            # must succeed before any service stop or production replacement is attempted.
            $gate = Assert-BrokerUpgradeGate $serviceBefore ([bool]$AllowBriefRestart)
            if ($gate.State -eq 'Running') {
                Wait-ForIdleBrokerClients $gate
                $gate = Assert-BrokerUpgradeGate $serviceBefore ([bool]$AllowBriefRestart)
                $clients = @(Get-ProtectedBrokerClientProcessIds $gate.ProcessId)
                if ($clients.Count -gt 0) {
                    throw ("Detected {0} protected SolBroker.exe client process(es) (PID {1}) at the final check. The service was not stopped and no caller was terminated." -f
                        $clients.Count, ($clients -join ', '))
                }
                Assert-BrokerCanStop $gate
                $stopRequested = $true
                Stop-BrokerServiceOnce
                $stopped = Wait-ForBrokerSnapshot 'Stopped'
                if ($stopped.ProcessId -ne 0) { throw 'The stopped AiRuleSolBroker service still reported a process ID.' }
            }
            else {
                $stopped = Get-BrokerServiceSnapshot
                if ($stopped.State -cne 'Stopped' -or $stopped.ProcessId -ne 0) {
                    throw 'The installed AiRuleSolBroker service changed state before replacement. No production file was replaced.'
                }
            }

            # Phase 3: replace only the two production files after the gate and the one allowed stop.
            [IO.File]::Replace($candidateExe, $exe, [System.Management.Automation.Language.NullString]::Value)
            $exeReplaced = $true
            [IO.File]::Replace($candidatePolicy, $policyFile, [System.Management.Automation.Language.NullString]::Value)
            $policyReplaced = $true
            Set-Acl -LiteralPath $exe -AclObject $originalExeAcl
            Set-Acl -LiteralPath $policyFile -AclObject $originalPolicyAcl
            if ((Get-Acl -LiteralPath $exe).Sddl -cne $originalExeAcl.Sddl -or
                (Get-Acl -LiteralPath $policyFile).Sddl -cne $originalPolicyAcl.Sddl) {
                throw 'The replaced broker files did not retain their captured production permissions.'
            }
            if ((Get-BrokerFileHash $exe) -cne $candidateExeHash -or
                (Get-BrokerFileHash $policyFile) -cne $newPolicyHash) {
                throw 'The replaced broker files failed their SHA-256 check.'
            }
            $after = Read-InstalledBrokerPolicy
            if ($after.Value.PSObject.Properties[$policyField].Value -ne $true) {
                throw ("The installed policy does not enable {0} API after replacement." -f $Role)
            }
            $expectedQuota = if ($changeQuota) { $RequestsPerHour } else { $currentPolicy.RequestsPerHour }
            if ($after.RequestsPerHour -ne $expectedQuota) {
                throw 'The installed policy does not expose the expected hourly quota after replacement.'
            }
            foreach ($field in @('caller_sid', 'model', 'reasoning_effort', 'project', 'organization')) {
                $beforeHas = $currentPolicy.Value.PSObject.Properties.Name -contains $field
                $afterHas = $after.Value.PSObject.Properties.Name -contains $field
                if ($beforeHas -ne $afterHas) { throw 'The replaced policy changed an existing routing field.' }
                if ($beforeHas -and
                    [string]$currentPolicy.Value.PSObject.Properties[$field].Value -cne
                    [string]$after.Value.PSObject.Properties[$field].Value) {
                    throw 'The replaced policy changed an existing routing field.'
                }
            }

            if ($originalState -eq 'Running') {
                Start-Service -Name $name
                $null = Wait-ForBrokerSnapshot 'Running'
                & $exe check
                if ($LASTEXITCODE -ne 0) { throw 'The upgraded Sol broker service identity or DPAPI check failed.' }
                $finalService = Wait-ForBrokerSnapshot 'Running'
                Write-Output ("{0} updated in place. exe SHA-256 {1}; policy SHA-256 {2}; requests_per_hour {3}; service state Running after exactly one explicit-consent stop and restart (PID {4}). The old service has no atomic drain: a caller can still start between the final check and the stop. Original caller, project, organization, Sol model and effort were preserved; existing state, credential, rolling rate records and audit files were not reset or edited." -f
                    $operation, $candidateExeHash, $newPolicyHash, $expectedQuota, $finalService.ProcessId)
            }
            else {
                $finalService = Get-BrokerServiceSnapshot
                if ($finalService.State -cne 'Stopped') { throw 'The service changed state while the upgrade was replacing stopped-service files.' }
                Write-Output ("{0} updated in place. exe SHA-256 {1}; policy SHA-256 {2}; requests_per_hour {3}; service state Stopped (unchanged; it was not started). The runtime service identity/DPAPI check was not run because the service remained stopped. Original caller, project, organization, Sol model and effort were preserved; existing state, credential, rolling rate records and audit files were not reset or edited." -f
                    $operation, $candidateExeHash, $newPolicyHash, $expectedQuota)
            }
        }
        catch {
            $failure = $_.Exception.Message
            $filesTouched = $exeReplaced -or $policyReplaced
            $recoveryNeeded = $stopRequested -or $filesTouched
            if (-not $recoveryNeeded) {
                throw ("The broker API role upgrade stopped before any service stop or production replacement. Cause: {0}. The service was not stopped and no production file was replaced." -f $failure)
            }
            $rollbackErrors = New-Object 'System.Collections.Generic.List[string]'
            $actualState = 'unknown'
            $filesRestored = -not $filesTouched

            if ($filesTouched) {
                $safeToRestoreFiles = $false
                try {
                    $current = Get-BrokerServiceSnapshot
                    $actualState = $current.State
                    if ($current.State -eq 'Stopped') {
                        $safeToRestoreFiles = $true
                    }
                    elseif ($current.State -eq 'Running') {
                        if (-not $stopRequested -and $originalState -eq 'Stopped') {
                            [void]$rollbackErrors.Add('service started unexpectedly after the stopped-state gate; it was not stopped because the original state was Stopped and no brief stop was requested')
                        }
                        else {
                            # Stop the replacement image before restoring files. This is a normal stop, never a force stop.
                            try {
                                Assert-BrokerCanStop $current
                                Stop-BrokerServiceOnce
                                $stopped = Wait-ForBrokerSnapshot 'Stopped'
                                $actualState = $stopped.State
                                $safeToRestoreFiles = $true
                            }
                            catch { [void]$rollbackErrors.Add('stop before file restore: ' + $_.Exception.Message) }
                        }
                    }
                }
                catch { [void]$rollbackErrors.Add('service state before file restore: ' + $_.Exception.Message) }

                if ($safeToRestoreFiles) {
                    if ($policyReplaced) {
                        try {
                            Restore-ExactBrokerFile $backupPolicy $policyFile $originalPolicyAcl $originalPolicyHash $upgradeDirectory
                            $policyReplaced = $false
                        }
                        catch { [void]$rollbackErrors.Add('policy restore: ' + $_.Exception.Message) }
                    }
                    if ($exeReplaced) {
                        try {
                            Restore-ExactBrokerFile $backupExe $exe $originalExeAcl $originalExeHash $upgradeDirectory
                            $exeReplaced = $false
                        }
                        catch { [void]$rollbackErrors.Add('executable restore: ' + $_.Exception.Message) }
                    }
                    $filesRestored = -not ($exeReplaced -or $policyReplaced)
                }
            }

            # Only restore the original running state after both original files are back and verified.
            # If file recovery failed, leave the service stopped rather than claim a false recovery.
            if ($filesRestored) {
                try {
                    $current = Get-BrokerServiceSnapshot
                    $actualState = $current.State
                    if ($originalState -eq 'Running') {
                        if ($current.State -eq 'Stopped') {
                            Start-Service -Name $name
                            $actualState = (Wait-ForBrokerSnapshot 'Running').State
                        }
                    }
                    else {
                        if ($current.State -eq 'Running') {
                            throw 'The service is Running although it was Stopped before the transaction; it was not stopped without an explicit brief-restart request.'
                        }
                        $actualState = (Wait-ForBrokerSnapshot 'Stopped').State
                    }
                }
                catch {
                    [void]$rollbackErrors.Add('original service state restore: ' + $_.Exception.Message)
                    try { $actualState = (Get-BrokerServiceSnapshot).State } catch { $actualState = 'unknown' }
                }
            }

            if ($rollbackErrors.Count -gt 0) {
                $preserveForRecovery = $true
                $failureFile = Join-Path $backupDirectory 'ROLLBACK-FAILED.txt'
                $failureText = @(
                    ('Broker API role upgrade failed: {0}' -f $failure),
                    ('Rollback errors: {0}' -f ($rollbackErrors -join '; ')),
                    ('Original service state: {0} (PID {1})' -f $originalState, $originalServicePid),
                    ('Actual service state: {0}' -f $actualState),
                    ('Original files restored: {0}; executable replacement still present: {1}; policy replacement still present: {2}' -f
                        $filesRestored, $exeReplaced, $policyReplaced),
                    ('Original executable backup: {0}' -f $backupExe),
                    ('Original policy backup: {0}' -f $backupPolicy),
                    ('Transaction record: {0}' -f $transactionFile),
                    'Do not start the service until the original exe and policy are restored and checked. No caller or dependent service was terminated, and no force stop was attempted.'
                ) -join "`r`n"
                try { [IO.File]::WriteAllText($failureFile, $failureText, [Text.UTF8Encoding]::new($false)) } catch { }
                throw ("Broker API role upgrade failed: {0}. Rollback was incomplete: {1}. Actual service state: {2}. Original files restored: {3}. Recovery material is preserved at {4}. Do not start the service until the original exe and policy are restored and checked." -f
                    $failure, ($rollbackErrors -join '; '), $actualState, $filesRestored, $upgradeDirectory)
            }
            if ($originalState -eq 'Running') {
                throw ("Broker API role upgrade failed: {0}. The original exe and policy were restored, and the service was returned to its original Running state. No state, credential, rolling rate record or audit file was reset or edited. The upgrade scratch directory and its backups are removed after this clean rollback." -f $failure)
            }
            throw ("Broker API role upgrade failed: {0}. The original exe and policy were restored, and the service remains Stopped as it was before the transaction. No state, credential, rolling rate record or audit file was reset or edited. The upgrade scratch directory and its backups are removed after this clean rollback." -f $failure)
        }
        finally {
            if (-not $preserveForRecovery) {
                try { Remove-UpgradeDirectory $upgradeDirectory }
                catch { Write-Warning ('The upgrade completed but its protected scratch directory could not be removed: {0}' -f $upgradeDirectory) }
            }
        }
    }
    finally {
        if ($ownsSetupMutex) {
            try { $setupMutex.ReleaseMutex() }
            finally { $setupMutex.Dispose() }
        }
        elseif ($null -ne $setupMutex) { $setupMutex.Dispose() }
    }
}

Require-RealDirectory $parent
if ($EnableTerraApi -or $EnableLunaApi) {
    $role = if ($EnableLunaApi) { 'Luna' } else { 'Terra' }
    Invoke-BrokerUpgrade -Role $role -SetQuota:$quotaRequested -RequestsPerHour $RequestsPerHour
    return
}
if ($Uninstall) {
    if (Test-Path -LiteralPath $serviceRegistry) { Remove-ServiceRegistration }
    Remove-KnownFiles
    Write-Output 'Sol broker removed.'
    return
}

if ((Test-Path -LiteralPath $root) -or (Test-Path -LiteralPath $serviceRegistry)) {
    throw 'A Sol broker installation already exists. Use the installed set-key command to rotate its credential.'
}
$caller = [Security.Principal.SecurityIdentifier]::new($ClientSid)
$createdRoot = $false
$createdService = $false

# Passing the virtual account's null password and the precise quoted service image directly to SCM
# avoids PowerShell's native command-line quoting when registering an executable in Program Files.
if (-not ('AiRuleSolBrokerInstaller' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AiRuleSolBrokerInstaller {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr OpenSCManagerW(string machine, string database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr CreateServiceW(IntPtr scm, string name, string displayName, uint access, uint type,
        uint start, uint control, string binary, string group, IntPtr tag, string dependencies, string account, string password);
    [DllImport("advapi32.dll")]
    private static extern bool CloseServiceHandle(IntPtr handle);

    public static void Create(string name, string image, string account) {
        IntPtr scm = OpenSCManagerW(null, null, 2);
        if (scm == IntPtr.Zero) throw new Win32Exception();
        try {
            IntPtr service = CreateServiceW(scm, name, "AI Rule Sol Broker", 4, 0x10, 3, 1, image, null, IntPtr.Zero, null, account, null);
            if (service == IntPtr.Zero) throw new Win32Exception();
            CloseServiceHandle(service);
        }
        finally { CloseServiceHandle(scm); }
    }
}
'@
}

try {
    $null = New-Item -Path $root -ItemType Directory
    $createdRoot = $true
    Protect-Directory $root $false
    $null = New-Item -Path $state -ItemType Directory
    Protect-Directory $state $true
    & (Join-Path $PSScriptRoot 'build.ps1') -OutputPath $exe
    Protect-InstalledFile $exe $true

    $policy = New-InstallBrokerPolicy $caller.Value $Model $ReasoningEffort $ProjectId $OrganizationId
    $json = $policy | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($policyFile, '', [Text.UTF8Encoding]::new($false))
    Protect-InstalledFile $policyFile $false
    [IO.File]::WriteAllText($policyFile, $json, [Text.UTF8Encoding]::new($false))

    [AiRuleSolBrokerInstaller]::Create($name, $image, $account)
    $createdService = $true
    Invoke-ServiceTool @('privs', $name, 'SeChangeNotifyPrivilege')
    $serviceDacl = 'D:P(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;LC;;;{0})' -f $caller.Value
    Invoke-ServiceTool @('sdset', $name, $serviceDacl)
    Start-Service -Name $name
    & $exe check
    if ($LASTEXITCODE -ne 0) { throw 'Sol broker startup or the service-account DPAPI check failed.' }
    Invoke-ServiceTool @('config', $name, 'start=', 'delayed-auto')
    Write-Output 'The Sol broker is installed. Run the installed SolBroker.exe set-key from an elevated interactive console.'
}
catch {
    if ($createdService) { Remove-ServiceRegistration }
    if ($createdRoot) { Remove-KnownFiles }
    throw
}
