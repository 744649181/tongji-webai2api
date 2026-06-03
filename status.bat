@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

cd /d "%~dp0"

set "GREEN=[92m"
set "YELLOW=[93m"
set "RED=[91m"
set "CYAN=[96m"
set "GRAY=[90m"
set "BOLD=[1m"
set "RESET=[0m"

echo.
echo %CYAN%========================================%RESET%
echo %CYAN%  tongji-webai2api  -  status%RESET%
echo %CYAN%========================================%RESET%
echo.

REM --- Check port 3000 ---
set "LISTENING_PID="
for /f "tokens=*" %%p in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 3000 -State Listen -EA SilentlyContinue).OwningProcess | Select-Object -First 1" 2^>nul') do set "LISTENING_PID=%%p"

if defined LISTENING_PID (
    echo %GREEN%[RUNNING]%RESET% supervisor / server is %BOLD%UP%RESET%
    echo   PID:           %BOLD%!LISTENING_PID!%RESET%
    echo   Endpoint:      http://127.0.0.1:3000
    echo.

    for /f "tokens=*" %%i in ('powershell -NoProfile -Command "Get-Process -Id !LISTENING_PID! -EA SilentlyContinue | Select-Object -ExpandProperty StartTime" 2^>nul') do set "START_TIME=%%i"
    echo   Started:       !START_TIME!
    echo.

    echo %GRAY%Testing /v1/models ...%RESET%
    for /f "tokens=*" %%r in ('powershell -NoProfile -Command "try { (Invoke-WebRequest 'http://127.0.0.1:3000/v1/models' -TimeoutSec 5 -EA Stop).StatusCode } catch { 0 }" 2^>nul') do set "HTTP_CODE=%%r"
    if "!HTTP_CODE!"=="200" (
        echo   HTTP status:   %GREEN%!HTTP_CODE! OK%RESET%
    ) else (
        echo   HTTP status:   %YELLOW%!HTTP_CODE! - auth wall, server is up%RESET%
    )
) else (
    echo %RED%[STOPPED]%RESET% no server listening on port 3000
    echo.
    echo   Run %CYAN%start.bat%RESET% to start, or %CYAN%login.bat%RESET% if first time.
    echo.
)

REM --- Show tail of system log ---
if exist data\logs\system.log (
    echo.
    echo %GRAY%--- recent log - data\logs\system.log - last 12 lines ---%RESET%
    powershell -NoProfile -Command "Get-Content 'data\logs\system.log' -Tail 12 -Encoding utf8 -EA SilentlyContinue"
) else (
    echo %GRAY%- no system.log yet -%RESET%
)

echo.
echo.
pause
exit /b 0
