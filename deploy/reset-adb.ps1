$id = 'USB\VID_04E8&PID_6860&ADB\7&23e57791&0&0003'
$adb = 'C:\Users\User\Desktop\netral2\tools\platform-tools\adb.exe'
$log = 'C:\Users\User\Desktop\netral2\superapp-pc2\deploy\adb-reset.log'
"start $(Get-Date -Format o)" | Out-File $log -Encoding utf8
try {
  Disable-PnpDevice -InstanceId $id -Confirm:$false -ErrorAction Stop
  Start-Sleep -Seconds 2
  Enable-PnpDevice -InstanceId $id -Confirm:$false -ErrorAction Stop
  Start-Sleep -Seconds 2
  & $adb kill-server | Out-Null
  & $adb start-server | Out-Null
  Start-Sleep -Seconds 3
  & $adb devices -l | Out-File $log -Append -Encoding utf8
  "done" | Out-File $log -Append -Encoding utf8
} catch {
  "ERROR: $($_.Exception.Message)" | Out-File $log -Append -Encoding utf8
}
