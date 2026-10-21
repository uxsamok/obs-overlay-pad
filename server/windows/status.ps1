# Проверка: задача, процесс, ответ сервера, брандмауэр, адреса.
. "$PSScriptRoot\common.ps1"
$ErrorActionPreference = 'Continue'
Write-Host "Папка: $KitDir, порт: $Port"
$t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $t) { Write-Host 'Задача: НЕ УСТАНОВЛЕНА (запустите install.bat)' -ForegroundColor Red }
elseif ($t.Actions[0].WorkingDirectory -ne $KitDir) { Write-Host "Задача указывает на ДРУГУЮ папку: $($t.Actions[0].WorkingDirectory) — запустите install.bat здесь" -ForegroundColor Red }
else { Write-Host "Задача '$TaskName': $($t.State)" }
$p = Get-Process caddy -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Caddy }
if ($p) { Write-Host "Процесс caddy: работает (PID $($p.Id -join ', '))" } else { Write-Host 'Процесс caddy: не запущен' -ForegroundColor Red }
try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 5
    Write-Host "HTTP: $($r.StatusCode) OK" -ForegroundColor Green
} catch { Write-Host "HTTP: нет ответа ($($_.Exception.Message))" -ForegroundColor Red }
$fw = Get-NetFirewallRule -DisplayName $FwRule -ErrorAction SilentlyContinue
Write-Host ('Брандмауэр: ' + $(if ($fw) { 'правило есть' } else { 'правила НЕТ' }))
Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "Сеть '$($_.Name)': $($_.NetworkCategory)" }
if (Test-Path "$AppDir\index.html") { Write-Host "Версия приложения от: $((Get-Item "$AppDir\index.html").LastWriteTime)" }
Write-Host "Лог: $LogDir\caddy.log"
Write-Host 'Адреса для планшета:'; Get-LanUrls | ForEach-Object { Write-Host "  $_" }
