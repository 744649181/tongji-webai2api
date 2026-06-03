@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

set "GREEN=[92m"
set "YELLOW=[93m"
set "RED=[91m"
set "CYAN=[96m"
set "GRAY=[90m"
set "RESET=[0m"

set "URL=http://127.0.0.1:3000/"

REM --- Check if server is up ---
set "LISTENING_PID="
for /f "tokens=*" %%p in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 3000 -State Listen -EA SilentlyContinue).OwningProcess | Select-Object -First 1" 2^>nul') do set "LISTENING_PID=%%p"

if defined LISTENING_PID (
    echo %GREEN%[OK]%RESET% Server is up. Opening %CYAN%%URL%%RESET% in your default browser...
    start "" "%URL%"
) else (
    echo %YELLOW%[!]%RESET% Server is NOT running. Start it first with %CYAN%start.bat%RESET%, then try again.
    echo.
    echo    Or: start.bat will auto-open the browser once it's ready.
    echo.
    pause
)
