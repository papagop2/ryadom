$ErrorActionPreference = 'Continue'
$out = Join-Path $PSScriptRoot 'iis-state.txt'
"=== IIS sites ===" | Out-File $out -Encoding utf8
Import-Module WebAdministration
Get-Website | ForEach-Object {
  "$($_.Name) | state=$($_.State) | path=$($_.PhysicalPath) | bindings=$($_.Bindings.Collection -join ',')"
} | Out-File $out -Append -Encoding utf8
"=== app pools ===" | Out-File $out -Append -Encoding utf8
Get-IISAppPool | ForEach-Object { "$($_.Name) | $($_.State) | $($_.ManagedRuntimeVersion)" } | Out-File $out -Append -Encoding utf8
"=== proxy modules ===" | Out-File $out -Append -Encoding utf8
Get-WebGlobalModule | Where-Object { $_.Name -match 'Rewrite|ARR|proxy|Fault' } |
  ForEach-Object { $_.Name } | Out-File $out -Append -Encoding utf8
"=== port 443 listeners ===" | Out-File $out -Append -Encoding utf8
(netstat -ano | Select-String ':443\s') | ForEach-Object { $_.Line } | Out-File $out -Append -Encoding utf8
