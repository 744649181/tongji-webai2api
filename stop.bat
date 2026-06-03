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

echo.
echo %CYAN%Stopping tongji-webai2api...%RESET%
echo.

REM --- Kill node processes via taskkill /FI (image name eq node.exe) ---
set "KILLED=0"
taskkill /F /IM node.exe /T >nul 2>&1
if not errorlevel 1 set /a KILLED+=1

REM --- Stop camoufox / firefox ---
taskkill /F /IM camoufox.exe /T >nul 2>&1
if not errorlevel 1 set /a KILLED+=1
taskkill /F /IM firefox.exe /T >nul 2>&1
if not errorlevel 1 set /a KILLED+=1

REM --- Wait + check port 3000 ---
timeout /t 2 /nobreak >nul 2>&1
set "STILL_LISTENING="
for /f "tokens=*" %%p in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 3000 -State Listen -EA SilentlyContinue).OwningProcess | Select-Object -First 1" 2^>nul') do set "STILL_LISTENING=%%p"
if defined STILL_LISTENING (
    echo %YELLOW%[!] port 3000 still listening - PID !STILL_LISTENING!. May be another app. Skipping.%RESET%
) else (
    echo %GREEN%[OK] port 3000 is free%RESET%
)

if "!KILLED!"=="0" (
    echo %YELLOW%[!] No node.exe processes found - server may already be stopped.%RESET%
) else (
    echo %GREEN%[OK] stopped all node.exe + camoufox + firefox%RESET%
)

echo(
exit /b 0
