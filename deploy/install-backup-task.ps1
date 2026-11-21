param(
  [string]$Time = '03:30',
  [string]$TaskName = 'RjadomBackup',
  [string]$MirrorDir = '',
  [int]$KeepDays = 30
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$base = Split-Path -Parent $project
$script = Join-Path $PSScriptRoot 'backup.ps1'
$backupDir = Join-Path $base 'backups'

$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -BackupDir `"$backupDir`" -KeepDays $KeepDays"
if ($MirrorDir) { $arguments += " -MirrorDir `"$MirrorDir`"" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$userId = "$env:USERDOMAIN\$env:USERNAME"

try {
  # S4U позволяет запускать задачу без сохранения пароля; доступ к локальным
  # secrets/backups остаётся под текущей учётной записью.
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force `
    -Description 'Ежедневный pg_dump «Рядом» с проверкой и внешней копией' | Out-Null
  Write-Host "Задача $TaskName зарегистрирована для $userId, ежедневно в $Time"
} catch {
  Write-Warning "S4U не сработал: $($_.Exception.Message). Пробую обычную интерактивную задачу."
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force `
    -Description 'Ежедневный pg_dump «Рядом» с проверкой и внешней копией' | Out-Null
  Write-Host "Задача $TaskName зарегистрирована (интерактивно), ежедневно в $Time"
}

Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-Table -AutoSize
