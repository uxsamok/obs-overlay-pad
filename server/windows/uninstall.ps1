# Удаление: задача + правило брандмауэра + остановка caddy. Папку удаляет по желанию.
. "$PSScriptRoot\common.ps1"
Assert-Admin
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Get-Process caddy -ErrorAction SilentlyContinue | Stop-Process -Force
Get-NetFirewallRule -DisplayName $FwRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host 'Задача и правило брандмауэра удалены.' -ForegroundColor Green
$a = Read-Host "Удалить и папку $InstallDir целиком? (y/N)"
if ($a -eq 'y') {
    Set-Location $env:TEMP
    Remove-Item $InstallDir -Recurse -Force
    Write-Host 'Папка удалена.'
}
