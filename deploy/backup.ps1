param(
  [string]$BackupDir = '',
  [string]$MirrorDir = '',
  [int]$KeepDays = 30,
  [string]$PgDump = 'C:\Program Files\PostgreSQL\16\bin\pg_dump.exe',
  [string]$PgRestore = 'C:\Program Files\PostgreSQL\16\bin\pg_restore.exe',
  [switch]$RequireMirror
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$base = Split-Path -Parent $project
if (-not $BackupDir) { $BackupDir = Join-Path $base 'backups' }
if (-not $MirrorDir) { $MirrorDir = $env:RJADOM_BACKUP_MIRROR }
$logDir = Join-Path $base 'logs'
$logFile = Join-Path $logDir 'backup.log'
$envFile = Join-Path $base 'secrets\rjadom.env'

New-Item -ItemType Directory -Force -Path $BackupDir, $logDir | Out-Null

function Write-Log([string]$message) {
  $line = "{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $message
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
  Write-Host $line
}

function Read-EnvFile([string]$path) {
  $values = @{}
  if (-not (Test-Path -LiteralPath $path)) { throw "Не найден файл окружения: $path" }
  foreach ($line in Get-Content -LiteralPath $path) {
    if ($line -match '^\s*([^#=]+?)\s*=\s*(.*?)\s*$') {
      $values[$matches[1].Trim()] = $matches[2].Trim().Trim('"').Trim("'")
    }
  }
  return $values
}

function Invoke-Dump([string]$file) {
  & $PgDump -Fc --file=$file
  if ($LASTEXITCODE -ne 0) { throw "pg_dump завершился с кодом $LASTEXITCODE" }
  if (-not (Test-Path -LiteralPath $file)) { throw "pg_dump не создал файл $file" }
  $size = (Get-Item -LiteralPath $file).Length
  if ($size -lt 1024) { throw "Дамп слишком мал: $size байт" }
  & $PgRestore --list $file | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "pg_restore не смог прочитать оглавление дампа" }
  return $size
}

function Write-Checksum([string]$file) {
  $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  $name = Split-Path -Leaf $file
  $sidecar = "$file.sha256"
  Set-Content -LiteralPath $sidecar -Value "$hash  $name" -Encoding ASCII
  return $hash
}

function Remove-OldFiles([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return }
  $cutoff = (Get-Date).AddDays(-$KeepDays)
  Get-ChildItem -LiteralPath $dir -File -Filter 'rjadom-*.dump' |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    ForEach-Object {
      $sidecar = "$($_.FullName).sha256"
      Remove-Item -LiteralPath $_.FullName -Force
      if (Test-Path -LiteralPath $sidecar) { Remove-Item -LiteralPath $sidecar -Force }
      Write-Log "удалён старый дамп: $($_.Name)"
    }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dumpFile = Join-Path $BackupDir "rjadom-$stamp.dump"
$mirrorFile = $null

try {
  $envValues = Read-EnvFile $envFile
  $db = $envValues['PGDATABASE']
  $dbUser = if ($envValues['PGMIGRATOR_USER']) { $envValues['PGMIGRATOR_USER'] } else { $envValues['PGUSER'] }
  $dbPassword = if ($envValues['PGMIGRATOR_PASSWORD']) { $envValues['PGMIGRATOR_PASSWORD'] } else { $envValues['PGPASSWORD'] }
  if (-not $db -or -not $dbUser -or -not $dbPassword) { throw 'В rjadom.env нет PGDATABASE/PGUSER/PGPASSWORD' }
  $env:PGHOST = $envValues['PGHOST']; $env:PGPORT = $envValues['PGPORT']
  $env:PGDATABASE = $db; $env:PGUSER = $dbUser; $env:PGPASSWORD = $dbPassword

  Write-Log "начало дампа $db"
  $size = Invoke-Dump $dumpFile
  $hash = Write-Checksum $dumpFile
  Write-Log "дамп готов: $dumpFile ($size байт, sha256 $hash)"

  if ($MirrorDir) {
    if (-not (Test-Path -LiteralPath $MirrorDir)) {
      New-Item -ItemType Directory -Force -Path $MirrorDir | Out-Null
    }
    $mirrorFile = Join-Path $MirrorDir (Split-Path -Leaf $dumpFile)
    Copy-Item -LiteralPath $dumpFile -Destination $mirrorFile -Force
    $mirrorHash = Write-Checksum $mirrorFile
    if ($mirrorHash -ne $hash) { throw 'Контрольная сумма внешней копии не совпала' }
    Write-Log "внешняя копия: $mirrorFile"
  } elseif ($RequireMirror) {
    throw 'Не задан MirrorDir/RJADOM_BACKUP_MIRROR, внешняя копия обязательна'
  } else {
    Write-Log 'внешняя копия не настроена: задайте -MirrorDir или RJADOM_BACKUP_MIRROR'
  }

  Remove-OldFiles $BackupDir
  if ($MirrorDir) { Remove-OldFiles $MirrorDir }
  exit 0
} catch {
  Write-Log "ОШИБКА: $($_.Exception.Message)"
  if (Test-Path -LiteralPath $dumpFile) { Remove-Item -LiteralPath $dumpFile -Force }
  exit 1
}
