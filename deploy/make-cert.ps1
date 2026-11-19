param(
  [string]$SecretsDir = 'C:\Users\User\Desktop\netral2\secrets'
)
$ErrorActionPreference = 'Stop'
$log = Join-Path $SecretsDir 'cert-log.txt'
try {
New-Item -ItemType Directory -Force -Path $SecretsDir | Out-Null

$san = '2.5.29.17={text}DNS=app.home.arpa&DNS=192-168-50-150.sslip.io&DNS=WIN-KOIKRJSNRTL&DNS=localhost&IPAddress=192.168.50.150&IPAddress=127.0.0.1'

$cert = New-SelfSignedCertificate `
  -Subject 'CN=app.home.arpa' `
  -TextExtension @($san) `
  -CertStoreLocation 'Cert:\LocalMachine\My' `
  -NotAfter (Get-Date).AddYears(3) `
  -KeyExportPolicy Exportable `
  -KeyLength 2048 -KeyAlgorithm RSA -HashAlgorithm SHA256

$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$password = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
$secure = ConvertTo-SecureString -String $password -AsPlainText -Force

$pfx = Join-Path $SecretsDir 'rjadom-tls.pfx'
$cer = Join-Path $SecretsDir 'rjadom-tls.cer'
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure | Out-Null
Export-Certificate -Cert $cert -FilePath $cer | Out-Null
Set-Content -Path (Join-Path $SecretsDir 'tls-password.txt') -Value $password -NoNewline -Encoding ascii
Set-Content -Path (Join-Path $SecretsDir 'tls-thumbprint.txt') -Value $cert.Thumbprint -NoNewline -Encoding ascii

"cert=$($cert.Thumbprint) pfx=$pfx cer=$cer" | Tee-Object -FilePath $log
} catch {
  "ERROR: $($_.Exception.Message)" | Out-File $log -Encoding utf8
  throw
}
