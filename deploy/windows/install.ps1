<#
  Installs the Liro server on Windows (run in PowerShell as administrator):

    powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1
    powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -DataDir D:\LiroData -Port 1919

  Code goes to "C:\Program Files\Liro Server", settings to C:\ProgramData\Liro\liro.env, boards to -DataDir.
  The server runs as a scheduled task "Liro Server" (SYSTEM, at startup, restarted on failure).
#>
param(
    [string]$InstallDir = (Join-Path $env:ProgramFiles 'Liro Server'),
    [string]$DataDir = (Join-Path $env:ProgramData 'Liro\data'),
    [int]$Port = 1919,
    [string]$Name = "Liro ($env:COMPUTERNAME)"
)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Admin

$node = Ensure-Node
Write-Host "Node.js: $(& $node -v) ($node)"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-Liro }
Copy-ServerFiles $InstallDir $node
Save-InstallState $InstallDir

New-Item -ItemType Directory -Force $DataDir, $LogDir | Out-Null
if (-not (Test-Path $ConfigFile)) {
    $template = Get-Content (Join-Path $SourceRoot 'deploy\liro.env') | Where-Object { $_ -notmatch '^\s*LIRO_(DATA|PORT|NAME)\s*=' }
    [IO.File]::WriteAllLines($ConfigFile, [string[]]$template, (New-Object Text.UTF8Encoding $false))
    Set-EnvValue 'LIRO_NAME' $Name
    Set-EnvValue 'LIRO_PORT' $Port
    Set-EnvValue 'LIRO_DATA' $DataDir
    Write-Host "Создан $ConfigFile — отредактируйте при необходимости."
}

# Scheduled task: starts with Windows, runs as SYSTEM (can bind ports 80 and 53), restarts on failure.
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$(Join-Path $InstallDir 'run-liro.cmd')`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

# Firewall: web/API, discovery, mDNS, optional port 80 and DNS for liro.loc.
Get-NetFirewallRule -Group 'Liro' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
$p = (Get-EnvValue 'LIRO_PORT'); if (-not $p) { $p = $Port }
New-NetFirewallRule -Group 'Liro' -DisplayName 'Liro (TCP)' -Direction Inbound -Protocol TCP -LocalPort @($p, 80) -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -Group 'Liro' -DisplayName 'Liro (UDP)' -Direction Inbound -Protocol UDP -LocalPort @($p, 5353, 53) -Action Allow -Profile Any | Out-Null

Start-Liro
Write-Host ''
Write-Host 'Адреса сервера:'
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    ForEach-Object { Write-Host "  http://$($_.IPAddress):$p" }
Write-Host "Журнал: $LogDir\liro.log"
