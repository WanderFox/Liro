# Shared helpers for the Liro server scripts on Windows (dot-sourced by install/update/configure).
$ErrorActionPreference = 'Stop'

$Script:TaskName = 'Liro Server'
$Script:ConfigDir = Join-Path $env:ProgramData 'Liro'
$Script:ConfigFile = Join-Path $ConfigDir 'liro.env'
$Script:StateFile = Join-Path $ConfigDir 'install.json'
$Script:LogDir = Join-Path $ConfigDir 'logs'
$Script:SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Запустите PowerShell от имени администратора.'
    }
}

function Get-InstallState {
    if (Test-Path $StateFile) { return Get-Content $StateFile -Raw | ConvertFrom-Json }
    return $null
}

function Save-InstallState($installDir) {
    New-Item -ItemType Directory -Force $ConfigDir | Out-Null
    @{ installDir = $installDir; updated = (Get-Date).ToString('s') } | ConvertTo-Json | Set-Content -Encoding UTF8 $StateFile
}

function Get-EnvValue($key) {
    if (-not (Test-Path $ConfigFile)) { return $null }
    foreach ($line in Get-Content $ConfigFile) {
        if ($line -match "^\s*$key\s*=\s*(.*)$") { return $Matches[1].Trim().Trim('"') }
    }
    return $null
}

function Set-EnvValue($key, $value) {
    $lines = @()
    if (Test-Path $ConfigFile) { $lines = @(Get-Content $ConfigFile) }
    $found = $false
    $lines = $lines | ForEach-Object {
        if ($_ -match "^\s*$key\s*=") { $found = $true; "$key=$value" } else { $_ }
    }
    if (-not $found) { $lines += "$key=$value" }
    # UTF-8 without BOM keeps the file readable for both PowerShell and Node.
    [IO.File]::WriteAllLines($ConfigFile, [string[]]$lines, (New-Object Text.UTF8Encoding $false))
}

function Find-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Ensure-Node {
    $node = Find-Node
    if ($node) {
        $major = [int]((& $node -p 'process.versions.node').Split('.')[0])
        if ($major -ge 18) { return $node }
        Write-Host "Найден Node.js $major — нужен 18 или новее."
    }
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) { throw 'Node.js 18+ не найден. Установите Node.js LTS с https://nodejs.org и запустите скрипт снова.' }
    Write-Host 'Устанавливаю Node.js LTS через winget…'
    & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent | Out-Host
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $node = Find-Node
    if (-not $node) { throw 'Node.js установлен, но не найден. Откройте новое окно PowerShell и запустите скрипт снова.' }
    return $node
}

function Stop-Liro {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
    # The task starts cmd.exe -> node.exe; make sure the server process is gone too.
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*server*src*index.js*' -and $_.CommandLine -like '*Liro*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
}

function Start-Liro {
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    $port = Get-EnvValue 'LIRO_PORT'
    if (-not $port) { $port = 1919 }
    try {
        $info = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/info" -TimeoutSec 5
        Write-Host "Liro работает: $($info.name), версия $($info.version)"
    } catch {
        Write-Warning "Сервер пока не отвечает. Журнал: $LogDir\liro.log"
    }
}

function Copy-ServerFiles($installDir, $node) {
    New-Item -ItemType Directory -Force $installDir | Out-Null
    foreach ($part in 'server', 'web') {
        $dst = Join-Path $installDir $part
        if (Test-Path $dst) {
            # Keep nothing from the old code except installed node_modules (reinstalled below anyway).
            Get-ChildItem $dst -Force | Where-Object { $_.Name -ne 'node_modules' } | Remove-Item -Recurse -Force
        }
        $src = Join-Path $SourceRoot $part
        & robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP /XD node_modules data test | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "Не удалось скопировать $part (robocopy $LASTEXITCODE)" }
    }
    $npm = Join-Path (Split-Path $node) 'npm.cmd'
    if (-not (Test-Path $npm)) { $npm = 'npm.cmd' }
    Push-Location (Join-Path $installDir 'server')
    try { & $npm install --omit=dev --no-fund --no-audit | Out-Host } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'npm install завершился с ошибкой' }

    # Launcher used by the scheduled task: settings file + log file.
    $run = @"
@echo off
set LIRO_CONFIG=$ConfigFile
if not exist "$LogDir" mkdir "$LogDir"
"$node" "%~dp0server\src\index.js" >> "$LogDir\liro.log" 2>&1
"@
    Set-Content -Encoding ASCII -Path (Join-Path $installDir 'run-liro.cmd') -Value $run
}
