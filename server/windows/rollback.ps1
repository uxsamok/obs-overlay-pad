# Откат к предыдущей версии (меняет местами app и app.bak).
. "$PSScriptRoot\common.ps1"
$bak = "$AppDir.bak"; $tmp = "$AppDir.swap"
if (-not (Test-Path $bak)) { throw "Нет $bak — откатывать не к чему." }
Rename-Item $AppDir $tmp; Rename-Item $bak $AppDir; Rename-Item $tmp $bak
Write-Host 'Откат выполнен (повторный запуск вернёт обратно).' -ForegroundColor Green
