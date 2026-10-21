# Перезапуск сервера этой папки.
. "$PSScriptRoot\common.ps1"
Assert-Admin
Stop-KitCaddy
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
& "$PSScriptRoot\status.ps1"
