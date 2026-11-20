[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BundlePath,
    [Parameter(Mandatory)][ValidatePattern('\A[0-9a-f]{64}\z')][string]$BundleSha256,
    [Parameter(Mandatory)][ValidatePattern('\AS-1-(?:5-21|12-1)(?:-[0-9]+){4}\z')][string]$ClientSid,
    [Parameter(Mandatory)][ValidatePattern('\A[a-z0-9][a-z0-9_.:-]{0,99}\z')][string]$Model,
    [Parameter(Mandatory)][ValidateSet('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')][string]$ReasoningEffort,
    [ValidatePattern('\Aproj_[A-Za-z0-9_-]{1,140}\z')][string]$ProjectId,
    [ValidatePattern('\Aorg[-_][A-Za-z0-9_-]{1,140}\z')][string]$OrganizationId,
    [switch]$Install,
    [switch]$SetKey
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -ne 'Desktop' -or
        -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Broker deployment requires elevated 64-bit Windows PowerShell.'
    }
}
finally { $identity.Dispose() }

function Get-PhysicalLocalItem([string]$Location) {
    $absolute = [IO.Path]::GetFullPath($Location)
    if ($Location -notmatch '^[A-Za-z]:[\\/]' -or $absolute.Substring(2).Contains(':')) {
        throw 'Broker deployment paths must be local drive paths.'
    }
    $item = Get-Item -LiteralPath $absolute -Force
    $ancestor = $item
    while ($null -ne $ancestor) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Broker deployment paths cannot use reparse points.' }
        $ancestor = if ($ancestor -is [IO.DirectoryInfo]) { $ancestor.Parent } else { $ancestor.Directory }
    }
    return $item
}

$programs = [Environment]::GetFolderPath('ProgramFiles')
$adminSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$trustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$serviceSid = 'S-1-5-80-2491726543-4042735884-3184637371-1420765198-420171591'
$trusted = @($adminSid.Value, $systemSid.Value, $trustedInstaller)
$writing = [Security.AccessControl.FileSystemRights]'Write, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'

function Confirm-ProtectedItem([string]$Location, [switch]$Directory, [string[]]$Writers = $trusted) {
    $item = Get-PhysicalLocalItem $Location
    if (($item -is [IO.DirectoryInfo]) -ne [bool]$Directory) { throw 'Unexpected protected broker path type.' }
    $acl = Get-Acl -LiteralPath $Location
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'A protected broker path has an unexpected owner.' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $writing) -and
            $rule.IdentityReference.Value -notin $Writers -and
            -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) {
            throw 'A protected broker path permits writes outside the administrator trust boundary.'
        }
    }
}

Confirm-ProtectedItem $programs -Directory
$root = Join-Path $programs 'AiRuleSolBroker'
$exe = Join-Path $root 'SolBroker.exe'
if ($Install) {
    $bundleItem = Get-PhysicalLocalItem $BundlePath
    if ($bundleItem.PSIsContainer) { throw 'The broker source bundle must be a regular file.' }
    $stream = [IO.File]::Open($bundleItem.FullName, 'Open', 'Read', 'Read')
    try {
        if ($stream.Length -lt 1 -or $stream.Length -gt 200000) { throw 'The broker source bundle has an invalid size.' }
        $reader = [IO.BinaryReader]::new($stream)
        $bytes = $reader.ReadBytes([int]$stream.Length)
    }
    finally { $stream.Dispose() }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '') }
    finally { $sha.Dispose() }
    if ($actual -ne $BundleSha256) { throw 'The broker source bundle changed after revision verification.' }
    $bundle = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
    $files = @('install.ps1', 'build.ps1', 'Protocol.cs', 'WindowsPipe.cs', 'BrokerState.cs', 'Upstream.cs', 'Program.cs')
    if (@($bundle.PSObject.Properties).Count -ne $files.Count) { throw 'The broker source bundle has unexpected entries.' }
    $stage = Join-Path $programs ('AiRuleSolBroker-setup-' + [Guid]::NewGuid().ToString('N'))
    $stageAcl = [Security.AccessControl.DirectorySecurity]::new()
    $stageAcl.SetOwner($adminSid)
    $stageAcl.SetAccessRuleProtection($true, $false)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($sid in @($adminSid, $systemSid)) {
        $stageAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, 'None', 'Allow'))
    }
    if (Test-Path -LiteralPath $stage) { throw 'The protected broker source directory already exists.' }
    $null = [IO.Directory]::CreateDirectory($stage, $stageAcl)
    $initialTemp = $env:TEMP
    $initialTmp = $env:TMP
    try {
        Confirm-ProtectedItem $stage -Directory
        foreach ($name in $files) {
            [IO.File]::WriteAllBytes((Join-Path $stage $name), [Convert]::FromBase64String($bundle.$name))
        }
        $parameters = @{ ClientSid = $ClientSid; Model = $Model; ReasoningEffort = $ReasoningEffort }
        if ($ProjectId) { $parameters.ProjectId = $ProjectId }
        if ($OrganizationId) { $parameters.OrganizationId = $OrganizationId }
        $env:TEMP = $stage
        $env:TMP = $stage
        & (Join-Path $stage 'install.ps1') @parameters
    }
    finally {
        $env:TEMP = $initialTemp
        $env:TMP = $initialTmp
        foreach ($name in $files) { [IO.File]::Delete((Join-Path $stage $name)) }
        [IO.Directory]::Delete($stage, $false)
    }
}

if ($SetKey) {
    Confirm-ProtectedItem $root -Directory
    Confirm-ProtectedItem (Join-Path $root 'state') -Directory -Writers ($trusted + $serviceSid)
    Confirm-ProtectedItem $exe
    $policyFile = Join-Path $root 'policy.json'
    Confirm-ProtectedItem $policyFile
    $policy = Get-Content -LiteralPath $policyFile -Raw | ConvertFrom-Json
    if ($policy.caller_sid -ne $ClientSid -or $policy.model -cne $Model -or $policy.reasoning_effort -cne $ReasoningEffort -or
        ($ProjectId -and (-not $policy.PSObject.Properties['project'] -or $policy.project -cne $ProjectId)) -or
        ($OrganizationId -and (-not $policy.PSObject.Properties['organization'] -or $policy.organization -cne $OrganizationId))) {
        throw 'The existing broker policy does not match the planned caller or API route.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'state\credential.dpapi'))) {
        & $exe set-key
        if ($LASTEXITCODE -ne 0) { throw 'The local credential prompt did not save a key.' }
    }
}
