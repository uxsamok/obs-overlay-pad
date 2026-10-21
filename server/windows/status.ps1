# Проверка: задача, процесс, ответ сервера, адреса.
. "$PSScriptRoot\common.ps1"
$ErrorActionPreference = 'Continue'
$t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($t) { Write-Host "Задача: $($t.State)" } else { Write-Host 'Задача: НЕ УСТАНОВЛЕНА (запустите install.bat)' -ForegroundColor Red }
$p = Get-Process caddy -ErrorAction SilentlyContinue
if ($p) { Write-Host "Процесс caddy: работает (PID $($p.Id -join ', '))" } else { Write-Host 'Процесс caddy: не запущен' -ForegroundColor Red }
try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 5
    Write-Host "HTTP: $($r.StatusCode) OK" -ForegroundColor Green
} catch { Write-Host "HTTP: нет ответа ($($_.Exception.Message))" -ForegroundColor Red }
$fw = Get-NetFirewallRule -DisplayName $FwRule -ErrorAction SilentlyContinue
Write-Host ('Брандмауэр: ' + $(if ($fw) { 'правило есть' } else { 'правила НЕТ' }))
Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "Сеть '$($_.Name)': $($_.NetworkCategory)" }
if (Test-Path $AppDir) { Write-Host "Версия приложения от: $((Get-Item (Join-Path $AppDir 'index.html')).LastWriteTime)" }
Write-Host 'Адреса для планшета:'; Get-LanUrls | ForEach-Object { Write-Host "  $_" }
