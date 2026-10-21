@echo off
chcp 65001 >nul
rem Перезапуск с правами администратора, если их нет
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'" & exit /b)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart.ps1"
pause
