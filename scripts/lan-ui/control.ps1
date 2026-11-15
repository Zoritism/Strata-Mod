# This script is installed under tools/lan-ui in the Strata-Mod directory.
param([ValidateSet('Start','Stop','Status')][string]$Action='Status')
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $PSScriptRoot 'layout.ps1')
$node=Join-Path (Resolve-StrataApplicationDirectory $root) 'node/node.exe'
$data=Join-Path $root 'data/lan-ui'
$config=Get-Content -LiteralPath (Join-Path $data 'config.json') -Raw | ConvertFrom-Json
$gateway=Join-Path $PSScriptRoot 'gateway.mjs'
$pidFile=Join-Path $data 'gateway.pid'
$job=$null
if (Test-Path -LiteralPath $pidFile) {
    $id=0
    if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(),[ref]$id) -and $id -gt 0) {
        $job=Get-CimInstance Win32_Process -Filter "ProcessId=$id" |
            Where-Object {$_.ExecutablePath -eq $node -and $_.CommandLine -and $_.CommandLine.Contains($gateway)}
    }
}
if ($Action -eq 'Stop') {
    if ($job) { Stop-Process -Id $job.ProcessId }
    if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile }
    return
}
if ($Action -eq 'Start' -and !$job) {
    if (!(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $config.address -ErrorAction SilentlyContinue |
        Where-Object {$_.PrefixLength -eq $config.subnet})) { throw 'Изменился локальный адрес компьютера.' }
    $arguments=@(('"'+$gateway+'"'),('"'+$data+'"'))
    $job=Start-Process -FilePath $node -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $job.Id | Set-Content -LiteralPath $pidFile
    if ($job.WaitForExit(300)) { throw 'Strata LAN не запустилась. Проверьте адрес и порт.' }
}
if ($job) { Write-Output ('Strata LAN: https://'+$config.address+':'+$config.port+'/') }
else { Write-Output 'Strata LAN выключена.' }
