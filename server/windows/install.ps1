# Установка в ЭТУ папку: caddy.exe + app\ + Caddyfile + автозапуск + брандмауэр.
# Повторный запуск безопасен. Перенесли папку или сменили порт — запустите снова.
. "$PSScriptRoot\common.ps1"
Assert-Admin
Write-Host "Папка установки: $KitDir, порт: $Port"

# Убрать задачи/правила этой же папки, оставшиеся от прошлого порта
Get-ScheduledTask -TaskName 'OBS Overlay Pad (port *)' -ErrorAction SilentlyContinue |
    Where-Object { $_.TaskName -ne $TaskName -and $_.Actions[0].WorkingDirectory -eq $KitDir } |
    ForEach-Object {
        Write-Host "Удаляю старую задачу $($_.TaskName)"
        Stop-ScheduledTask -TaskName $_.TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false
        $old = $_.TaskName -replace '^OBS Overlay Pad \(port (\d+)\)$', 'OBS Overlay Pad HTTP $1'
        Get-NetFirewallRule -DisplayName $old -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    }
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and $existing.Actions[0].WorkingDirectory -ne $KitDir) {
    Write-Host "Порт $Port уже занимала установка в $($existing.Actions[0].WorkingDirectory) — она будет заменена этой." -ForegroundColor Yellow
}

Stop-KitCaddy
if ($existing) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

Install-Caddy
& $Caddy version

if (Test-Path (Join-Path $AppDir 'index.html')) {
    Write-Host 'Приложение уже есть (обновить: update.bat).'
} else {
    Update-App
}

Write-Caddyfile
& $Caddy validate --config $CaddyFile --adapter caddyfile
if ($LASTEXITCODE -ne 0) { throw 'Caddyfile не прошёл проверку.' }

# Задача: при старте Windows от SYSTEM (без окна и без входа), перезапуск при сбое.
$action   = New-ScheduledTaskAction -Execute $Caddy -Argument "run --config `"$CaddyFile`" --adapter caddyfile" -WorkingDirectory $KitDir
$trigger  = New-ScheduledTaskTrigger -AtStartup
$principal= New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Get-NetFirewallRule -DisplayName $FwRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $FwRule -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
Write-Host ''
Write-Host 'Готово. Откройте на планшете один из адресов:' -ForegroundColor Green
Get-LanUrls | ForEach-Object { Write-Host "  $_" -ForegroundColor Green }
Write-Host 'Если сеть Windows помечена как "Общедоступная" — переключите на "Частная" (см. README).'
