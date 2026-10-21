# Удаление автозапуска и правила брандмауэра этой установки. Папку можно удалить потом вручную.
. "$PSScriptRoot\common.ps1"
Assert-Admin
Stop-KitCaddy
$t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($t -and $t.Actions[0].WorkingDirectory -eq $KitDir) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Get-NetFirewallRule -DisplayName $FwRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Write-Host 'Задача и правило брандмауэра удалены.' -ForegroundColor Green
} else {
    Write-Host "Задача '$TaskName' этой папки не найдена — нечего удалять." -ForegroundColor Yellow
}
Write-Host "Теперь папку $KitDir можно просто удалить."
