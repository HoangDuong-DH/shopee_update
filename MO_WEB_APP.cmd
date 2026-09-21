@echo off
cd /d "%~dp0"
"%~dp0.local\runtime\node-v24.20.0-win-x64\node.exe" "%~dp0scripts\start-local.mjs"
if errorlevel 1 (
  echo.
  echo Khong khoi dong duoc. Xem thong bao phia tren.
  pause
)
