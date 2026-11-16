# Run on demand from the local desktop. UAC is needed only for this scoped rule.
param([ValidateSet('Enable','Disable')][string]$Action='Enable',[switch]$ValidateOnly)
$ErrorActionPreference='Stop'
# Validate the selected installation before asking Windows for elevation.
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $PSScriptRoot 'layout.ps1')
$node=Join-Path (Resolve-StrataApplicationDirectory $root) 'node/node.exe'
$config=Get-Content -LiteralPath (Join-Path $root 'data/lan-ui/config.json') -Raw | ConvertFrom-Json
$port=[int]$config.port
$prefix=[int]$config.subnet
$address=[string]$config.address
if ($port -lt 1024 -or $port -gt 65535 -or $prefix -lt 8 -or $prefix -gt 30 -or
    $address -notmatch '^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)') { throw 'Неверные настройки Strata LAN.' }
$parsedAddress=[Net.IPAddress]::Parse($address)
if ($parsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'Нужен частный IPv4-адрес.' }
# The default name stays compatible with existing installations, while a
# custom prepared port gets its own narrowly scoped Windows firewall rule.
$name='StrataMod-LanUi-'+$port
if ($ValidateOnly) { Write-Output ($name+' '+$address+':'+$port+'/'+$prefix); return }
$admin=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (!$admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $process=Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @(
        '-NoProfile','-File',('"'+$PSCommandPath+'"'),'-Action',$Action
    ) -Verb RunAs -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw 'Windows не сохранила правило Strata LAN.' }
    return
}
$previous=Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
if ($previous -and $previous.DisplayName -ne 'Strata Mod LAN HTTPS') { throw 'Имя правила уже занято.' }
if ($Action -eq 'Disable') {
    if ($previous) { Remove-NetFirewallRule -InputObject $previous }
    return
}
$adapter=Get-NetIPAddress -AddressFamily IPv4 -IPAddress $address -ErrorAction Stop |
    Where-Object {$_.PrefixLength -eq $prefix} | Select-Object -First 1
if (!$adapter) { throw 'Сетевой адрес Strata LAN изменился.' }
$profile=(Get-NetConnectionProfile -InterfaceIndex $adapter.InterfaceIndex -ErrorAction Stop).NetworkCategory
if ($profile -eq 'DomainAuthenticated') { $profile='Domain' }
$bytes=[Net.IPAddress]::Parse($address).GetAddressBytes()
for ($i=0;$i -lt 4;$i++) {
    $bits=[Math]::Max(0,[Math]::Min(8,$prefix-8*$i))
    $bytes[$i]=$bytes[$i] -band ((255 -shl (8-$bits)) -band 255)
}
$network=($bytes -join '.')+'/'+$prefix
if ($previous) { Remove-NetFirewallRule -InputObject $previous }
New-NetFirewallRule -Name $name -DisplayName 'Strata Mod LAN HTTPS' -Direction Inbound -Action Allow -Protocol TCP `
    -LocalAddress $address -LocalPort $port -RemoteAddress $network -InterfaceAlias $adapter.InterfaceAlias `
    -Profile $profile -Program $node | Out-Null
