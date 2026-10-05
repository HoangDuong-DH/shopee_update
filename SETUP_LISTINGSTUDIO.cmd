@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-entry.ps1" -Action setup %*
if errorlevel 1 pause
