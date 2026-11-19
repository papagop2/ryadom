param(
  [string]$Root = 'C:\Users\User\Desktop\netral2',
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe'
)
$ErrorActionPreference = 'Stop'
$project = Join-Path $Root 'superapp-pc2'
Start-Transcript -Path (Join-Path $project 'deploy\service-install.log') -Force | Out-Null
trap { $_ | Out-String | Write-Host; Stop-Transcript; exit 1 }
$serviceDir = Join-Path $Root 'service'
$logDir = Join-Path $Root 'logs'
$envFile = Join-Path $Root 'secrets\rjadom-host.env'
$winsw = Join-Path $project 'deploy\bin\winsw.exe'
$svcExe = Join-Path $serviceDir 'rjadom-host.exe'
$svcXml = Join-Path $serviceDir 'rjadom-host.xml'

New-Item -ItemType Directory -Force -Path $serviceDir, $logDir | Out-Null

# Переменные окружения читаются из файла вне репозитория (KEY=VALUE).
$values = @{}
foreach ($line in Get-Content $envFile) {
  $trim = $line.Trim()
  if ($trim -eq '' -or $trim.StartsWith('#')) { continue }
  $i = $trim.IndexOf('=')
  if ($i -lt 1) { continue }
  $values[$trim.Substring(0, $i)] = $trim.Substring($i + 1)
}

function XmlEscape([string]$text) {
  return [System.Security.SecurityElement]::Escape($text)
}

$envXml = ($values.GetEnumerator() | Sort-Object Name | ForEach-Object {
  "    <env name=`"$(XmlEscape $_.Name)`" value=`"$(XmlEscape $_.Value)`"/>"
}) -join "`r`n"

$config = @"
<service>
  <id>rjadom-host</id>
  <name>Rjadom Host</name>
  <description>Rjadom: PWA and API over HTTPS on 192.168.50.150:443</description>
  <executable>$(XmlEscape $NodeExe)</executable>
  <arguments>"$(XmlEscape (Join-Path $project 'api\host.mjs'))"</arguments>
  <workingdirectory>$(XmlEscape $project)</workingdirectory>
  <serviceaccount>
    <username>NT AUTHORITY\LocalService</username>
  </serviceaccount>
  <logpath>$(XmlEscape $logDir)</logpath>
  <log mode="roll-by-size-time">
    <sizeThreshold>10485760</sizeThreshold>
    <pattern>yyyyMMdd</pattern>
    <autoRollAtTime>00:00:00</autoRollAtTime>
    <zipOlderThanNumDays>7</zipOlderThanNumDays>
  </log>
$envXml
  <onfailure action="restart" delay="10 sec"/>
  <stoptimeout>15 sec</stoptimeout>
</service>
"@
Set-Content -Path $svcXml -Value $config -Encoding utf8

Copy-Item $winsw $svcExe -Force

# Чтение проекта и вывод журналов; запись в проект службе не нужна.
$readAccounts = @('NT AUTHORITY\LOCAL SERVICE')
foreach ($account in $readAccounts) {
  & icacls.exe $project /grant "${account}:(OI)(CI)RX" /T /C /Q | Out-Null
  & icacls.exe $serviceDir /grant "${account}:(OI)(CI)RX" /T /C /Q | Out-Null
  & icacls.exe $logDir /grant "${account}:(OI)(CI)M" /T /C /Q | Out-Null
}

if (Get-Service -Name 'rjadom-host' -ErrorAction SilentlyContinue) {
  & $svcExe stop | Out-Null
  & $svcExe uninstall | Out-Null
  Start-Sleep -Seconds 2
}
& $svcExe install
& $svcExe start
Start-Sleep -Seconds 3

$svc = Get-Service -Name 'rjadom-host'
$rule = Get-NetFirewallRule -DisplayName 'Rjadom HTTPS LAN' -ErrorAction SilentlyContinue
if (-not $rule) {
  New-NetFirewallRule -DisplayName 'Rjadom HTTPS LAN' -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort 443 -RemoteAddress '192.168.50.0/24' -Profile Domain,Private | Out-Null
}

"service=$($svc.Status)"
"listening=" + ((netstat -ano | Select-String ':443\s' | Select-Object -First 1).Line)
Stop-Transcript
