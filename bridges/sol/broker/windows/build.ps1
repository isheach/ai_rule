#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutputPath,
    [string]$TestSource,
    [string]$EntryPoint = 'AiRule.Sol.Windows.Program'
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess) {
    throw 'The Sol broker requires 64-bit Windows and a 64-bit PowerShell process.'
}
$dotNet = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -Name Release
if ($dotNet.Release -lt 528040) { throw 'The Sol broker requires .NET Framework 4.8 or later.' }
$framework = Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
$sources = @('Protocol.cs', 'WindowsPipe.cs', 'BrokerState.cs', 'Upstream.cs', 'Program.cs') | ForEach-Object { Join-Path $PSScriptRoot $_ }
if ($TestSource) { $sources += (Resolve-Path -LiteralPath $TestSource).Path }
$references = @('System.dll', 'System.Core.dll', 'System.Net.Http.dll', 'System.Runtime.Serialization.dll',
    'System.Security.dll', 'System.ServiceProcess.dll', 'System.Web.Extensions.dll', 'System.Xml.dll') |
    ForEach-Object { '/reference:' + (Join-Path $framework $_) }
$absolute = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
& $compiler /nologo /noconfig /target:exe /platform:anycpu /optimize+ /warnaserror+ "/main:$EntryPoint" "/out:$absolute" @references @sources
if ($LASTEXITCODE -ne 0) { throw 'The Sol broker build failed.' }
