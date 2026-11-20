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
    [Parameter(Mandatory, ParameterSetName = 'Uninstall')][switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitProcess) { throw 'Use a 64-bit PowerShell process.' }
$name = 'AiRuleSolBroker'
$account = "NT SERVICE\$name"
$serviceSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-80-2491726543-4042735884-3184637371-1420765198-420171591')
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$adminSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$authenticatedSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-11')
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

Require-RealDirectory $parent
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

    $policy = [ordered]@{ caller_sid = $caller.Value; model = $Model; reasoning_effort = $ReasoningEffort.ToLowerInvariant() }
    if ($ProjectId) { $policy.project = $ProjectId }
    if ($OrganizationId) { $policy.organization = $OrganizationId }
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
