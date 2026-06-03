@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

cd /d "%~dp0"

set "GREEN=[92m"
set "YELLOW=[93m"
set "RED=[91m"
set "CYAN=[96m"
set "GRAY=[90m"
set "RESET=[0m"

REM --- Sanity checks ---
if not exist node_modules (
    echo %RED%[X] node_modules/ missing. Run install.bat first.%RESET%
    echo(
    pause
    exit /b 1
)
if not exist data\config.yaml (
    echo %RED%[X] data\config.yaml missing. Run install.bat first.%RESET%
    echo(
    pause
    exit /b 1
)

REM --- Check if already running ---
set "RUNNING_PID="
for /f "tokens=*" %%p in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 3000 -State Listen -EA SilentlyContinue).OwningProcess | Select-Object -First 1" 2^>nul') do set "RUNNING_PID=%%p"
if defined RUNNING_PID (
    echo %YELLOW%[!] Server already running on port 3000 - PID !RUNNING_PID!%RESET%
    echo     Run status.bat to check, or stop.bat to stop.
    echo(
    pause
    exit /b 0
)

REM --- Start in background ---
set "LOG_FILE=%~dp0startup.log"
set "ERR_FILE=%~dp0startup.err"
set "PID_FILE=%TEMP%\tongji_pid.txt"
echo %GRAY%Starting supervisor in background...%RESET%
echo   log: %LOG_FILE%
echo   err: %ERR_FILE%
echo(

REM PowerShell starts the process and writes its PID to a file
powershell -NoProfile -Command "$p = Start-Process -FilePath 'node' -ArgumentList 'supervisor.js' -WorkingDirectory '%CD%' -RedirectStandardOutput '%LOG_FILE%' -RedirectStandardError '%ERR_FILE%' -WindowStyle Hidden -PassThru; Set-Content -Path '%PID_FILE%' -Value $p.Id -Encoding ascii" >nul 2>&1

if not exist "%PID_FILE%" goto :start_failed_early
set /p "NEW_PID=" < "%PID_FILE%"
del "%PID_FILE%" 2>nul
echo   PID: !NEW_PID!
echo(

REM --- Wait for server to be ready (up to 25s) ---
echo %GRAY%Waiting for server to come up - max 25s...%RESET%
set "READY=0"
for /l %%i in (1,1,25) do (
    timeout /t 1 /nobreak >nul 2>&1
    for /f "tokens=*" %%p in ('powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:3000/v1/models' -Headers @{Authorization='Bearer healthcheck'} -TimeoutSec 2 -EA Stop).StatusCode } catch { 0 }" 2^>nul') do set "HEALTH=%%p"
    if "!HEALTH!"=="401" (
        echo %GREEN%[OK] server is up - HTTP 401 = auth required, healthy%RESET%
        set "READY=1"
        goto :start_ok
    )
    if "!HEALTH!"=="200" (
        echo %GREEN%[OK] server is up - HTTP 200%RESET%
        set "READY=1"
        goto :start_ok
    )
)

REM Server didn't come up
echo %YELLOW%[!] Server didn't respond in 25s. Check startup.err for errors:%RESET%
if exist "!ERR_FILE!" (
    echo(
    powershell -NoProfile -Command "Get-Content '!ERR_FILE!' -Tail 20"
)
echo(
echo Press any key to close.
pause >nul
exit /b 1

:start_failed_early
echo %RED%[X]%RESET% Could not start supervisor. Check startup.err.
if exist "!ERR_FILE!" (
    powershell -NoProfile -Command "Get-Content '!ERR_FILE!' -Tail 20"
)
echo(
pause
exit /b 1

:start_ok
echo(
echo %CYAN%========================================%RESET%
echo %GREEN%  Server is running on http://127.0.0.1:3000%RESET%
echo %CYAN%========================================%RESET%
echo(
echo   Commands:
echo     status.bat  - check status and view logs
echo     stop.bat    - stop the server
echo     login.bat   - re-login - refresh SSO cookies
echo(
echo   Test:
echo     curl http://127.0.0.1:3000/v1/models -H "Authorization: Bearer YOUR_KEY"
echo(
exit /b 0
