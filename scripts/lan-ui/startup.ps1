# Own shortcut only; no scheduled task, elevated service or model auto-loading.
param([ValidateSet('Run','Enable','Disable','Status')][string]$Action='Status')
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $PSScriptRoot 'layout.ps1')
$desktop=Join-Path (Resolve-StrataApplicationDirectory $root) 'strata-desktop.exe'
# Strata redirects APPDATA/USERPROFILE for its own files. The Windows shell
# registry retains the real user's expanded Startup path, independent of that.
$shellFolders=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders'
$startupFolder=$shellFolders.Startup
if (!$startupFolder -or ![IO.Path]::IsPathRooted($startupFolder) -or $startupFolder.Contains('%')) { throw 'Не удалось определить папку автозапуска Windows.' }
$shortcut=Join-Path $startupFolder 'Strata LAN.lnk'
$scriptPath=Join-Path $PSScriptRoot 'startup.ps1'
$shell=New-Object -ComObject WScript.Shell
function OwnedShortcut {
    if (!(Test-Path -LiteralPath $shortcut)) { return $false }
    return $shell.CreateShortcut($shortcut).Arguments.Contains('"'+$scriptPath+'"')
}
if ($Action -eq 'Status') { Write-Output (OwnedShortcut); return }
if ($Action -eq 'Enable') {
    if ((Test-Path -LiteralPath $shortcut) -and !(OwnedShortcut)) { throw 'Это имя ярлыка уже занято другим приложением.' }
    $link=$shell.CreateShortcut($shortcut)
    $link.TargetPath=(Get-Process -Id $PID).Path
    $link.Arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$scriptPath+'" -Action Run'
    $link.WorkingDirectory=$root
    $link.WindowStyle=7
    $link.Save()
    return
}
if ($Action -eq 'Disable') {
    if (OwnedShortcut) { Remove-Item -LiteralPath $shortcut }
    return
}
# Windows login can precede Wi-Fi readiness. Retry only during this boot window.
$config=Get-Content -LiteralPath (Join-Path $root 'data/lan-ui/config.json') -Raw | ConvertFrom-Json
$upstreamPort=if ($null -ne $config.upstreamPort) { [int]$config.upstreamPort } else { 47831 }
if ($upstreamPort -lt 1024 -or $upstreamPort -gt 65535) { throw 'Неверный локальный порт Strata.' }
$app=Join-Path $root 'Strata Extensions.exe'
$running=Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $app -or $_.ExecutablePath -eq $desktop}
$client=[Net.Sockets.TcpClient]::new()
$listening=$false
try { $listening=$client.ConnectAsync('127.0.0.1',$upstreamPort).Wait(500) -and $client.Connected }
catch { $listening=$false }
finally { $client.Dispose() }
if (!$running -and !$listening) { Start-Process -FilePath $app -WorkingDirectory $root -WindowStyle Hidden }
for ($attempt=0; $attempt -lt 12; $attempt++) {
    try { & (Join-Path $PSScriptRoot 'control.ps1') Start; break }
    catch { if ($attempt -eq 11) { throw }; Start-Sleep -Seconds 5 }
}
