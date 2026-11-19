$log = Join-Path $PSScriptRoot 'firewall-fix.log'
"start $(Get-Date -Format o)" | Out-File $log -Encoding utf8
$rules = Get-NetFirewallApplicationFilter -Program 'C:\Program Files\nodejs\node.exe' -ErrorAction SilentlyContinue |
  Get-NetFirewallRule |
  Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' }
foreach ($rule in $rules) {
  "$($rule.DisplayName) | $($rule.Name)" | Out-File $log -Append -Encoding utf8
  Disable-NetFirewallRule -Name $rule.Name -ErrorAction Continue
}
$allow = Get-NetFirewallRule -DisplayName 'Rjadom HTTPS LAN' -ErrorAction SilentlyContinue
if (-not $allow) {
  New-NetFirewallRule -DisplayName 'Rjadom HTTPS LAN' -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort 443 -RemoteAddress '192.168.50.0/24' -Profile Domain,Private | Out-Null
  "created allow rule" | Out-File $log -Append -Encoding utf8
} else {
  Enable-NetFirewallRule -DisplayName 'Rjadom HTTPS LAN' -ErrorAction Continue
}
"after:" | Out-File $log -Append -Encoding utf8
Get-NetFirewallApplicationFilter -Program 'C:\Program Files\nodejs\node.exe' -ErrorAction SilentlyContinue |
  Get-NetFirewallRule |
  ForEach-Object { "$($_.DisplayName) | $($_.Direction) | $($_.Action) | $($_.Enabled)" } |
  Out-File $log -Append -Encoding utf8
