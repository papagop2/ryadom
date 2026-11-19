param(
  [string]$Root = 'C:\Users\User\Desktop\netral2',
  [int]$Port = 8443
)
$ErrorActionPreference = 'Stop'
$project = Join-Path $Root 'superapp-pc2'
$envFile = Join-Path $Root 'secrets\rjadom-host.env'
$logDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

foreach ($line in Get-Content $envFile) {
  $trim = $line.Trim()
  if ($trim -eq '' -or $trim.StartsWith('#')) { continue }
  $i = $trim.IndexOf('=')
  if ($i -lt 1) { continue }
  $name = $trim.Substring(0, $i)
  if ($name -in @('HOST', 'PORT', 'TLS_PFX', 'TLS_PFX_PASSPHRASE')) { continue }
  [Environment]::SetEnvironmentVariable($name, $trim.Substring($i + 1), 'Process')
}
[Environment]::SetEnvironmentVariable('HOST', '127.0.0.1', 'Process')
[Environment]::SetEnvironmentVariable('PORT', "$Port", 'Process')

$node = 'C:\Program Files\nodejs\node.exe'
$out = Join-Path $logDir 'host-http.out.log'
$err = Join-Path $logDir 'host-http.err.log'
$p = Start-Process -FilePath $node -ArgumentList (Join-Path $project 'api\host.mjs') `
  -WorkingDirectory $project -WindowStyle Hidden `
  -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
"pid=$($p.Id) port=$Port"
