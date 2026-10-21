# Общие настройки и функции. Подключается остальными скриптами.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'   # иначе Invoke-WebRequest очень медленный

$InstallDir = 'C:\obs-overlay-pad'
$AppDir     = Join-Path $InstallDir 'app'
$TaskName   = 'OBS Overlay Pad (Caddy)'
$FwRule     = 'OBS Overlay Pad HTTP 8080'
$Port       = 8080
$RepoZipUrl = 'https://codeload.github.com/uxsamok/obs-overlay-pad/zip/refs/heads/main'
$CaddyUrl   = 'https://caddyserver.com/api/download?os=windows&arch=amd64'

function Assert-Admin {
    $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Нужны права администратора. Запустите .bat-файл (он сам попросит права).'
    }
}

function Get-LanUrls {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        ForEach-Object { "http://$($_.IPAddress):$Port" }
}

# Скачивает main из GitHub и кладёт файлы приложения в $AppDir (старая версия -> app.bak).
function Update-App {
    $tmp = Join-Path $env:TEMP ('overlay-pad-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $zip = Join-Path $tmp 'main.zip'
        Write-Host "Скачиваю $RepoZipUrl"
        Invoke-WebRequest -Uri $RepoZipUrl -OutFile $zip -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
        if (-not $src -or -not (Test-Path (Join-Path $src.FullName 'index.html'))) {
            throw 'В архиве нет index.html — обновление отменено, текущая версия не тронута.'
        }
        # Новая версия собирается рядом (app.new), затем быстрая подмена папок.
        $new = "$AppDir.new"; $bak = "$AppDir.bak"
        if (Test-Path $new) { Remove-Item $new -Recurse -Force }
        New-Item -ItemType Directory -Path $new | Out-Null
        Get-ChildItem $src.FullName -Force |
            Where-Object { $_.Name -notin @('server', '.git', '.github') } |
            Copy-Item -Destination $new -Recurse -Force
        if (Test-Path $bak) { Remove-Item $bak -Recurse -Force }
        if (Test-Path $AppDir) { Rename-Item $AppDir $bak }
        Rename-Item $new $AppDir
        Write-Host "Приложение обновлено: $AppDir (прошлая версия: $bak)"
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
