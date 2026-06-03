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

echo.
echo %CYAN%========================================%RESET%
echo %CYAN%  tongji-webai2api  -  update%RESET%
echo %CYAN%========================================%RESET%
echo.

REM --- Pre-flight: must be a git repo ---
if not exist .git (
    echo %RED%[X] Not a git repository. Cannot auto-update.%RESET%
    echo    Re-clone: git clone https://github.com/^<user^>/tongji-webai2api.git
    pause
    exit /b 1
)

REM --- Stop server first ---
echo %GRAY%[1/4]%RESET% Stopping running server...
call "%~dp0stop.bat" 2>nul >nul
timeout /t 2 /nobreak >nul 2>&1

REM --- git pull ---
echo %GRAY%[2/4]%RESET% Pulling latest source...
git pull --rebase --autostash
if errorlevel 1 (
    echo %RED%[X] git pull failed. Resolve conflicts manually:%RESET%
    echo    git status
    echo    git pull
    pause
    exit /b 1
)
echo %GREEN%[OK] source updated%RESET%
echo.

REM --- Reinstall deps ---
echo %GRAY%[3/4]%RESET% Re-installing dependencies (npm ci)...
call npm ci
if errorlevel 1 (
    echo %RED%[X] npm ci failed. Try: npm install%RESET%
    pause
    exit /b 1
)
echo %GREEN%[OK] dependencies refreshed%RESET%
echo.

REM --- Restart server ---
echo %GRAY%[4/4]%RESET% Restarting server...
call "%~dp0start.bat"
exit /b %errorlevel%
