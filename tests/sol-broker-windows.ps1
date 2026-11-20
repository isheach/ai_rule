#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$build = Join-Path $repository 'bridges\sol\broker\windows\build.ps1'
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('sol-broker-unit-' + [Guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($scratch)
try {
    $production = Join-Path $scratch 'SolBroker.exe'
    $tests = Join-Path $scratch 'NativeTests.exe'
    & $build -OutputPath $production
    & $build -OutputPath $tests -TestSource (Join-Path $PSScriptRoot 'sol-broker-windows.cs') -EntryPoint 'AiRule.Sol.Windows.NativeTests'
    & $tests unit $scratch
    if ($LASTEXITCODE -ne 0) { throw 'Windows Sol broker native tests failed.' }
}
finally {
    foreach ($name in @('SolBroker.exe', 'NativeTests.exe', 'rate.bin', 'rate.bin.new')) {
        [IO.File]::Delete((Join-Path $scratch $name))
    }
    [IO.Directory]::Delete($scratch, $false)
}
