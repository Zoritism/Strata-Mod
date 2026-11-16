# Read code-layout metadata only; no credentials or user profile are required.
# Legacy receipts use app/, while a public overlay runs the native flat tree.
function Resolve-StrataApplicationDirectory([string]$Root) {
    $appDir='app'
    $receipt=Join-Path $Root 'installation.json'
    if (Test-Path -LiteralPath $receipt) {
        $metadata=Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
        if ($null -ne $metadata.appDir) { $appDir=[string]$metadata.appDir }
    }
    if ($appDir -notin @('.','app')) { throw 'Неверный каталог приложения в installation.json.' }
    return [IO.Path]::GetFullPath((Join-Path $Root $appDir))
}
