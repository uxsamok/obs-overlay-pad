# Перезапуск сервера.
. "$PSScriptRoot\common.ps1"
Assert-Admin
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-Process caddy -ErrorAction SilentlyContinue | Stop-Process -Force
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
& "$PSScriptRoot\status.ps1"
