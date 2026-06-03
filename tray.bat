@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

set "CYAN=[96m"
set "GREEN=[92m"
set "YELLOW=[93m"
set "GRAY=[90m"
set "RESET=[0m"

echo.
echo %CYAN%========================================%RESET%
echo %CYAN%  tongji-webai2api  -  system tray%RESET%
echo %CYAN%========================================%RESET%
echo.
echo %GRAY%Starting tray app (PowerShell)...%RESET%
echo   Look for the icon in your system tray (^bottom-right).
echo   Right-click for menu. Double-click opens WebUI.
echo.
echo %YELLOW%This window will close when the tray app starts.%RESET%
echo %YELLOW%To stop the tray, right-click its icon -^> Quit.%RESET%
echo.

REM Launch the PowerShell tray app in a new (hidden) window
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tray.ps1"
