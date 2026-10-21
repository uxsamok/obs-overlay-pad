# Установка: caddy.exe + приложение + автозапуск + брандмауэр. Можно запускать повторно.
. "$PSScriptRoot\common.ps1"
Assert-Admin

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

# 1. Серверные файлы (скрипты, Caddyfile, README) копируем в C:\obs-overlay-pad
if ((Resolve-Path $PSScriptRoot).Path -ne (Resolve-Path $InstallDir).Path) {
    Get-ChildItem $PSScriptRoot -File | Copy-Item -Destination $InstallDir -Force
}

# 2. Останавливаем старый запуск (если переустановка)
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-Process caddy -ErrorAction SilentlyContinue | Stop-Process -Force

# 3. caddy.exe — официальная сборка Windows amd64
$caddy = Join-Path $InstallDir 'caddy.exe'
Write-Host "Скачиваю Caddy: $CaddyUrl"
Invoke-WebRequest -Uri $CaddyUrl -OutFile "$caddy.download" -UseBasicParsing
Move-Item "$caddy.download" $caddy -Force
& $caddy version

# 4. Приложение
Update-App

# 5. Задача планировщика: при старте Windows, от SYSTEM (без окна, без входа в систему),
#    перезапуск при сбое, без ограничения времени работы.
$action   = New-ScheduledTaskAction -Execute $caddy -Argument "run --config `"$InstallDir\Caddyfile`" --adapter caddyfile" -WorkingDirectory $InstallDir
$trigger  = New-ScheduledTaskTrigger -AtStartup
$principal= New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

# 6. Брандмауэр: входящие TCP 8080, только частная сеть
Get-NetFirewallRule -DisplayName $FwRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $FwRule -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private | Out-Null

# 7. Запуск
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
Write-Host ''
Write-Host 'Готово. Откройте на планшете один из адресов:' -ForegroundColor Green
Get-LanUrls | ForEach-Object { Write-Host "  $_" -ForegroundColor Green }
Write-Host 'Если сеть Windows помечена как "Общедоступная" — переключите на "Частная" (см. README).'
