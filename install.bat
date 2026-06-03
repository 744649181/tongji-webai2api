@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

REM ============================================
REM tongji-webai2api one-click installer
REM First-time setup: Node check, deps, init, config
REM ============================================

cd /d "%~dp0"

REM Color helpers (kept simple, no nested parens in echo bodies)
set "GREEN=[92m"
set "YELLOW=[93m"
set "RED=[91m"
set "CYAN=[96m"
set "GRAY=[90m"
set "RESET=[0m"

echo.
echo %CYAN%========================================%RESET%
echo %CYAN%  tongji-webai2api  -  one-click setup%RESET%
echo %CYAN%========================================%RESET%
echo.

REM --- Step 1: Check Node.js ---
echo %GRAY%[1/5]%RESET% Checking Node.js...
where node >nul 2>&1
if errorlevel 1 goto :no_node
for /f "tokens=1 delims=v" %%i in ('node -v') do set "NODE_VER=%%i"
echo %GREEN%[OK]%RESET% Node.js !NODE_VER! found
echo.
goto :step2

:no_node
echo %RED%[X]%RESET% Node.js not found
echo.
echo    Please install Node.js 18+ from:
echo    https://nodejs.org/
echo.
pause
exit /b 1

:step2
REM --- Step 2: Install dependencies ---
echo %GRAY%[2/5]%RESET% Installing dependencies - npm ci...
if exist node_modules goto :deps_present
if not exist package-lock.json goto :no_lockfile
echo     running npm ci, please wait...
call npm ci
if errorlevel 1 goto :npm_failed
echo %GREEN%[OK]%RESET% dependencies installed
echo.
goto :step3

:deps_present
echo %GREEN%[OK]%RESET% dependencies already present - skipping
echo.
goto :step3

:no_lockfile
echo %RED%[X]%RESET% package-lock.json missing
echo.
echo    This repo should ship with one. Did you download the source as a .zip?
echo    If so, use git clone https://github.com/^<user^>/tongji-webai2api.git instead.
echo.
pause
exit /b 1

:npm_failed
echo %RED%[X]%RESET% npm install failed
echo    Try: npm install --no-audit --no-fund
echo.
pause
exit /b 1

:step3
REM --- Step 3: Create data/ if missing ---
echo %GRAY%[3/5]%RESET% Setting up data/ directory...
if not exist data mkdir data
if not exist data\logs mkdir data\logs
if not exist data\temp mkdir data\temp
echo %GREEN%[OK]%RESET% data/ ready
echo.

REM --- Step 4: Copy config.example.yaml if no data/config.yaml ---
echo %GRAY%[4/5]%RESET% Setting up data\config.yaml...
if not exist data\config.yaml goto :need_config_copy
echo %GREEN%[OK]%RESET% data\config.yaml already exists - skipping
echo.
goto :step5

:need_config_copy
if exist config.example.yaml goto :have_example
echo %RED%[X]%RESET% config.example.yaml missing from project root
echo.
pause
exit /b 1

:have_example
copy /Y config.example.yaml data\config.yaml >nul
echo %GREEN%[OK]%RESET% copied config.example.yaml -^> data\config.yaml
echo.

:step5
REM --- Step 5: Initialize database + check API key ---
echo %GRAY%[5/5]%RESET% Initializing SQLite database...
if exist data\history.db goto :db_present
echo     creating empty data\history.db ...
node -e "try{require('better-sqlite3');}catch(e){console.error('better-sqlite3 not loadable:',e.message);process.exit(1);}" 2>nul
if errorlevel 1 goto :db_fail
node -e "const D=require('better-sqlite3');const d=new D('data/history.db');d.close();console.log('ok');" 2>nul
if errorlevel 1 goto :db_fail
echo %GREEN%[OK]%RESET% database ready
echo.
goto :check_key

:db_present
echo %GREEN%[OK]%RESET% database already exists
echo.
goto :check_key

:db_fail
echo %YELLOW%[!]%RESET% Could not auto-init database. Run: node scripts\init.js when network is available.
echo.

:check_key
findstr /C:"sk-xxxxxxxx" data\config.yaml >nul 2>&1
if errorlevel 1 goto :key_ok
echo %YELLOW%[!]%RESET% API key in data\config.yaml is still the placeholder
echo     Generating a new one...
for /f "tokens=2" %%k in ('node scripts\genkey.js 2^>nul ^| findstr /C:"sk-"') do set "NEW_KEY=%%k"
if defined NEW_KEY goto :key_replaced
echo %YELLOW%[!]%RESET% Auto-replace failed. Run manually: node scripts\genkey.js
echo.
goto :done

:key_replaced
powershell -NoProfile -Command "$c = Get-Content 'data\config.yaml' -Raw; $c = $c -replace 'sk-xxxxxxxx[^\r\n]*', '!NEW_KEY!'; Set-Content -Path 'data\config.yaml' -Value $c -Encoding utf8 -NoNewline" >nul 2>&1
echo %GREEN%[OK]%RESET% API key replaced in data\config.yaml
echo     New key: !NEW_KEY!
echo.
goto :done

:key_ok
echo %GREEN%[OK]%RESET% API key already configured
echo.

:done
echo %CYAN%========================================%RESET%
echo %GREEN%  Setup complete.%RESET%
echo %CYAN%========================================%RESET%
echo.
echo   Next steps:
echo.
echo   1. First-time login - SSO via browser:
echo      %CYAN%login.bat%RESET%
echo.
echo   2. Start the server:
echo      %CYAN%start.bat%RESET%
echo.
echo   3. Check status:
echo      %CYAN%status.bat%RESET%
echo.
echo   4. Use it from Chatbox / curl / your favorite OpenAI client.
echo      See README.md for details.
echo.
pause
exit /b 0
