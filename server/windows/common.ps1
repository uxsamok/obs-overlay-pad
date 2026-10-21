# Общие пути и функции. Всё вычисляется от папки, где лежат скрипты ($PSScriptRoot),
# поэтому набор работает из любой папки. Настройки — в config.ps1.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'   # иначе Invoke-WebRequest очень медленный

. (Join-Path $PSScriptRoot 'config.ps1')

$KitDir     = $PSScriptRoot
$AppDir     = Join-Path $KitDir 'app'
$LogDir     = Join-Path $KitDir 'logs'
$Caddy      = Join-Path $KitDir 'caddy.exe'
$CaddyFile  = Join-Path $KitDir 'Caddyfile'
# Имя включает порт: на одном компьютере у каждой установки свой порт -> свои имена.
$TaskName   = "OBS Overlay Pad (port $Port)"
$FwRule     = "OBS Overlay Pad HTTP $Port"
$RepoZipUrl = 'https://codeload.github.com/uxsamok/obs-overlay-pad/zip/refs/heads/main'
$CaddyReleaseApi = 'https://api.github.com/repos/caddyserver/caddy/releases/latest'

# Скачивает последнюю официальную сборку Caddy (Windows amd64) с GitHub в $Caddy.
function Install-Caddy {
    $rel = Invoke-RestMethod -Uri $CaddyReleaseApi -UseBasicParsing
    $asset = $rel.assets | Where-Object { $_.name -like '*_windows_amd64.zip' } | Select-Object -First 1
    if (-not $asset) { throw "Не нашёл windows_amd64.zip в релизе Caddy $($rel.tag_name)" }
    Write-Host "Скачиваю Caddy $($rel.tag_name): $($asset.browser_download_url)"
    $tmp = Join-Path $env:TEMP ('caddy-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile "$tmp\caddy.zip" -UseBasicParsing
        Expand-Archive "$tmp\caddy.zip" -DestinationPath $tmp -Force
        Copy-Item "$tmp\caddy.exe" $Caddy -Force
    } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

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

# Останавливает только caddy из ЭТОЙ папки (другие установки не трогает).
function Stop-KitCaddy {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Get-Process caddy -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $Caddy } | Stop-Process -Force
}

# Caddyfile генерируется из config.ps1 (руками не правьте — перезапишется).
function Write-Caddyfile {
    $c = @"
# СГЕНЕРИРОВАНО install.ps1 из config.ps1 — правки здесь перезапишутся.
# Обычный HTTP: приложение ходит в OBS по ws://, со страницы https:// это запрещено.
{
	auto_https off
	admin off
	log {
		output file "$($LogDir -replace '\\','/')/caddy.log" {
			roll_size 5MiB
			roll_keep 3
		}
	}
}

:$Port {
	root * "$($AppDir -replace '\\','/')"
	encode gzip
	# no-cache: браузер всегда сверяется с сервером, обновления доходят сразу
	header Cache-Control "no-cache"
	file_server
}
"@
    [IO.File]::WriteAllText($CaddyFile, $c)
}

# Скачивает main с GitHub и кладёт файлы приложения в app\ (старая версия -> app.bak).
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
