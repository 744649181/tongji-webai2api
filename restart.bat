@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

set "GREEN=[92m"
set "YELLOW=[93m"
set "CYAN=[96m"
set "GRAY=[90m"
set "RESET=[0m"

echo.
echo %CYAN%Restarting tongji-webai2api...%RESET%
echo.

call "%~dp0stop.bat" 2>nul >nul
timeout /t 2 /nobreak >nul 2>&1
call "%~dp0start.bat"

exit /b %errorlevel%
