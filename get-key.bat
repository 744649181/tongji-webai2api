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

if not exist data\config.yaml (
    echo %RED%[X] data\config.yaml not found. Run install.bat first.%RESET%
    echo(
    pause
    exit /b 1
)

REM Use node to parse YAML and extract server.auth
set "API_KEY="
for /f "delims=" %%k in ('node -e "const y=require('js-yaml');try{const c=y.load(require('fs').readFileSync('data/config.yaml','utf8'));process.stdout.write(c&&c.server&&c.server.auth||'')}catch(e){process.exit(1)}" 2^>nul') do set "API_KEY=%%k"

if not defined API_KEY (
    REM Fallback: pure regex via node (no js-yaml needed)
    for /f "delims=" %%k in ('node -e "const c=require('fs').readFileSync('data/config.yaml','utf8');const m=c.match(/^\s*auth:\s*['\x22]?([^\x22'\s]+)['\x22]?/m);process.stdout.write(m?m[1]:'')" 2^>nul') do set "API_KEY=%%k"
)

if not defined API_KEY (
    echo %YELLOW%[!]%RESET% No auth key found in data\config.yaml
    echo    Expected: %CYAN%server:%RESET% block with %CYAN%auth:%RESET% field
    echo(
    echo    Run: %CYAN%node scripts\genkey.js%RESET% to generate one
    pause
    exit /b 1
)

echo(
echo %CYAN%Current API key:%RESET%
echo(
echo     %API_KEY%
echo(
echo %GRAY%Use it as: Authorization: Bearer %API_KEY%%RESET%
echo(
echo   Quick test:
echo     curl http://127.0.0.1:3000/v1/models -H "Authorization: Bearer %API_KEY%"
echo(
