<#
  Updates an installed Liro server to the version this script is part of.
  Boards, settings, the scheduled task and firewall rules are kept.

    powershell -ExecutionPolicy Bypass -File deploy\windows\update.ps1
#>
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Admin

$state = Get-InstallState
if (-not $state) { throw 'Liro не установлен (нет C:\ProgramData\Liro\install.json). Используйте install.ps1.' }
$node = Ensure-Node

Write-Host 'Останавливаю сервер…'
Stop-Liro
Write-Host "Обновляю файлы в $($state.installDir)…"
Copy-ServerFiles $state.installDir $node
Save-InstallState $state.installDir
Start-Liro
