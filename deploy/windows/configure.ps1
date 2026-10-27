<#
  Changes server settings. For now: moves the board storage to another folder.

    powershell -ExecutionPolicy Bypass -File deploy\windows\configure.ps1 -DataDir D:\LiroData

  The server is stopped, all boards/media/stickers/fonts are moved to the new folder, the settings file is
  updated and the server is started again with the new path.
#>
param(
    [Parameter(Mandatory = $true)][string]$DataDir
)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Admin

$old = Get-EnvValue 'LIRO_DATA'
if (-not $old) { $old = Join-Path $ConfigDir 'data' }
$new = [IO.Path]::GetFullPath($DataDir)
if ($old.TrimEnd('\') -ieq $new.TrimEnd('\')) { Write-Host 'Хранилище уже находится в этой папке.'; return }
if ($new.StartsWith($old.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Новая папка не может находиться внутри старой.' }

Write-Host 'Останавливаю сервер…'
Stop-Liro
New-Item -ItemType Directory -Force $new | Out-Null
if (Test-Path $old) {
    Write-Host "Переношу хранилище: $old -> $new"
    & robocopy $old $new /E /MOVE /COPY:DAT /R:2 /W:2 /NFL /NDL /NJH /NP | Out-Host
    if ($LASTEXITCODE -ge 8) {
        Start-Liro
        throw "Перенос не удался (robocopy $LASTEXITCODE). Сервер запущен со старым путём."
    }
}
Set-EnvValue 'LIRO_DATA' $new
Write-Host "Новый путь записан в $ConfigFile"
Start-Liro
