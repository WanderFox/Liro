<#
  Removes the Liro server (task, firewall rules, program files). Boards and settings stay in place.

    powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall.ps1
#>
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Admin

$state = Get-InstallState
Stop-Liro
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Get-NetFirewallRule -Group 'Liro' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($state -and (Test-Path $state.installDir)) { Remove-Item -Recurse -Force $state.installDir }
Remove-Item -Force $StateFile -ErrorAction SilentlyContinue
Write-Host "Liro удалён. Данные досок и настройки остались: $(Get-EnvValue 'LIRO_DATA'), $ConfigFile"
