# Installed beside control.ps1. Uses existing executables; never kills components.
param([switch]$ValidateOnly)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $PSScriptRoot 'layout.ps1')
$desktop=Join-Path (Resolve-StrataApplicationDirectory $root) 'strata-desktop.exe'
$lan=Get-Content -LiteralPath (Join-Path $root 'data/lan-ui/config.json') -Raw | ConvertFrom-Json
$app=Join-Path $root 'Strata Extensions.exe'
$address='https://'+$lan.address+':'+$lan.port+'/'
if ($ValidateOnly) {
    if (!(Test-Path -LiteralPath $app)) { throw 'Не найдена установленная Strata.' }
    Write-Output 'Пути запуска проверены; компоненты не запускались.'
    return
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function IsListening([int]$port,[string]$addressToCheck='127.0.0.1') {
    $client=[Net.Sockets.TcpClient]::new()
    try { return $client.ConnectAsync($addressToCheck,$port).Wait(250) -and $client.Connected }
    catch { return $false }
    finally { $client.Dispose() }
}
$form=[Windows.Forms.Form]::new()
$form.Text='Strata · компьютер и телефон'
$form.Size=[Drawing.Size]::new(620,330)
$form.StartPosition='CenterScreen'
$status=[Windows.Forms.Label]::new()
$status.SetBounds(20,20,560,80)
$form.Controls.Add($status)
$url=[Windows.Forms.TextBox]::new()
$url.SetBounds(20,110,560,28)
$url.ReadOnly=$true
$url.Text=$address
$form.Controls.Add($url)
$hint=[Windows.Forms.Label]::new()
$hint.SetBounds(20,210,560,65)
$hint.Text='Телефон: откройте этот адрес в домашней сети и добавьте страницу на главный экран браузера. При первом подключении нужны сертификат и пароль Strata LAN.'
$form.Controls.Add($hint)
function Button($text,$x,$width,$callback) {
    $button=[Windows.Forms.Button]::new()
    $button.Text=$text
    $button.SetBounds($x,155,$width,40)
    $button.Add_Click($callback)
    $form.Controls.Add($button)
}
$lastStart=[datetime]::MinValue
Button 'Запустить компоненты' 20 205 {
    try {
        # Startup can take time; repeated clicks must not start duplicate windows.
        if (([datetime]::Now-$script:lastStart).TotalSeconds -lt 30) { return }
        $script:lastStart=[datetime]::Now
        if (!(IsListening $lan.upstreamPort)) {
            $existing=Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $app -or $_.Path -eq $desktop }
            if (!$existing) { Start-Process -FilePath $app -WorkingDirectory $root -WindowStyle Hidden }
        }
        & (Join-Path $PSScriptRoot 'control.ps1') -Action Start | Out-Null
    } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message,'Запуск Strata') | Out-Null }
}
Button 'Скопировать адрес' 235 170 { [Windows.Forms.Clipboard]::SetText($address) }
Button 'Открыть интерфейс' 415 165 { Start-Process $address }
$timer=[Windows.Forms.Timer]::new()
$timer.Interval=3000
$timer.Add_Tick({
    $status.Text='Strata: '+$(if(IsListening $lan.upstreamPort){'доступна'}else{'выключена / запускается'})+"`n"+
        'Доступ с телефона: '+$(if(IsListening $lan.port $lan.address){'доступен'}else{'выключен'})
})
$form.Add_FormClosed({$timer.Stop();$timer.Dispose()})
$timer.Start()
[void]$form.ShowDialog()
