@echo off
pwsh.exe -NoProfile -File "%~dp0firewall.ps1" -Action Enable
if errorlevel 1 pause
