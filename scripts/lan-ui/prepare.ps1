# Generate a dedicated CA for one LAN server. The CA key is never exported.
param(
    [Parameter(Mandatory)][string]$Directory,
    [Parameter(Mandatory)][string]$Address,
    [Parameter(Mandatory)][ValidateRange(8,30)][int]$Subnet,
    [ValidateRange(1024,65535)][int]$Port=48443,
    [ValidateRange(1024,65535)][int]$UpstreamPort=47831
)
$ErrorActionPreference='Stop'
$Directory=[IO.Path]::GetFullPath($Directory)
if (Test-Path -LiteralPath $Directory) { throw 'Папка Strata LAN уже существует.' }
if ($Address -notmatch '^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)') { throw 'Нужен частный IPv4-адрес.' }
$ip=[Net.IPAddress]::Parse($Address)
$from=[DateTimeOffset]::UtcNow.AddMinutes(-5)
$until=$from.AddYears(1)
$curve=[Security.Cryptography.ECCurve+NamedCurves]::nistP256
$caKey=[Security.Cryptography.ECDsa]::Create($curve)
$serverKey=[Security.Cryptography.ECDsa]::Create($curve)
try {
    $hash=[Security.Cryptography.HashAlgorithmName]::SHA256
    $caRequest=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Strata LAN '+$Address,$caKey,$hash)
    $caRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$true,0,$true))
    $usage=[Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign
    $caRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($usage,$true))
    $ca=$caRequest.CreateSelfSigned($from,$until)
    $request=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN='+$Address,$serverKey,$hash)
    $san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddIpAddress($ip)
    $request.CertificateExtensions.Add($san.Build())
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
    $usage=[Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($usage,$true))
    $oid=[Security.Cryptography.OidCollection]::new()
    [void]$oid.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oid,$true))
    $serial=[Security.Cryptography.RandomNumberGenerator]::GetBytes(16)
    $leaf=$request.Create($ca,$from,$until,$serial)
    $cert=[Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::CopyWithPrivateKey($leaf,$serverKey)
    $pfx=$cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx,'')
    $trust=$ca.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)
} finally {
    if ($cert) { $cert.Dispose() }
    if ($leaf) { $leaf.Dispose() }
    if ($ca) { $ca.Dispose() }
    $caKey.Dispose()
    $serverKey.Dispose()
}

[void][IO.Directory]::CreateDirectory($Directory)
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rights=@("*${sid}:(OI)(CI)F",'*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F')
& icacls.exe $Directory /inheritance:r /grant:r $rights | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Не удалось ограничить доступ к файлам Strata LAN.' }
[IO.File]::WriteAllBytes((Join-Path $Directory 'Strata-LAN-CA.cer'),$trust)
[IO.File]::WriteAllBytes((Join-Path $Directory 'server.pfx'),$pfx)
$password=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(16)).ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $Directory 'access.txt'),$password)
@{address=$Address;subnet=$Subnet;port=$Port;upstreamPort=$UpstreamPort} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Directory 'config.json') -Encoding utf8NoBOM
Write-Output "Strata LAN: https://${Address}:$Port/"
