@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-entry.ps1" -Action stop %*
if errorlevel 1 pause
