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
echo %CYAN%========================================%RESET%
echo %CYAN%  tongji-webai2api  -  SSO Login Mode%RESET%
echo %CYAN%========================================%RESET%
echo.
echo This will:
echo   1. Stop any running server.
echo   2. Open a browser window to the tongji agent portal.
echo   3. Wait for you to complete SSO - scan QR / use campus account.
echo   4. Save the new cookies to data\camoufoxUserData_tongji\.
echo.
echo %YELLOW%After login, close this window and run start.bat.%RESET%
echo.

REM --- Stop any running instance first ---
call "%~dp0stop.bat" 2>nul >nul
timeout /t 2 /nobreak >nul 2>&1

REM --- Pre-flight: check node_modules and data ---
if not exist node_modules (
    echo %RED%[X] node_modules/ missing. Run install.bat first.%RESET%
    pause
    exit /b 1
)
if not exist data\config.yaml (
    echo %RED%[X] data\config.yaml missing. Run install.bat first.%RESET%
    pause
    exit /b 1
)

REM --- Start supervisor with -login=tongji - foreground so user sees the browser ---
echo %GRAY%Starting supervisor in login mode...%RESET%
echo.
echo %CYAN%The browser will open shortly. Complete the SSO flow in the browser window.%RESET%
echo %CYAN%When the page loads the chat interface, you are done. Press Ctrl+C here to exit.%RESET%
echo.

REM Use cmd start to spawn a new console for the user to see the browser
start "tongji-login" /WAIT cmd /c "node supervisor.js -- -login=tongji"

echo.
echo %GRAY%Login window closed. If cookies were saved, you can now run start.bat.%RESET%
echo.
pause
exit /b 0
