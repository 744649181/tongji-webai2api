$ErrorActionPreference = 'Continue'
Set-Location E:\NEW-toy\WebAI2API

# 0. clean lingering processes
Get-Process camoufox,firefox -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Get-Process node -EA SilentlyContinue | Where-Object {
    try { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -EA Stop).CommandLine -like '*supervisor.js*' } catch { $false }
} | Stop-Process -Force -EA SilentlyContinue

# 1. cookies file check
$cookieFile = 'E:\NEW-toy\WebAI2API\data\camoufoxUserData_tongji\cookies.sqlite'
if (Test-Path $cookieFile) {
    $sz = (Get-Item $cookieFile).Length
    Write-Host "OK cookies.sqlite = $sz bytes" -ForegroundColor Green
} else {
    Write-Host "FAIL cookies.sqlite NOT FOUND" -ForegroundColor Red
    exit 1
}

# 2. spawn supervisor in background
$logF = 'E:\NEW-toy\WebAI2API\smoke-test.log'
$errF = 'E:\NEW-toy\WebAI2API\smoke-test.err'
if (Test-Path $logF) { Remove-Item -LiteralPath $logF -Force }
if (Test-Path $errF) { Remove-Item -LiteralPath $errF -Force }
$p = Start-Process node -ArgumentList 'supervisor.js' -NoNewWindow -PassThru -RedirectStandardOutput $logF -RedirectStandardError $errF -WorkingDirectory 'E:\NEW-toy\WebAI2API'
Write-Host "supervisor PID=$($p.Id), waiting 15s..." -ForegroundColor Cyan
Start-Sleep -Seconds 15

# 3. /v1/models
$AUTH = @{ Authorization = 'Bearer sk-283629c3a933460254adddd5e9dff3e5c4af571c1435ad9b' }
Write-Host ''
Write-Host '=== GET /v1/models ===' -ForegroundColor Cyan
try {
    $models = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/v1/models' -Headers $AUTH -Method Get -TimeoutSec 10
    $models | ConvertTo-Json -Depth 5 -Compress
    Write-Host ''
    if (($models.data | Where-Object { $_.id -eq 'DeepSeek-V4-Pro' -or $_.id -eq 'tongji/DeepSeek-V4-Pro' }).Count -gt 0) {
        Write-Host 'OK DeepSeek-V4-Pro registered' -ForegroundColor Green
    } else {
        Write-Host 'FAIL DeepSeek-V4-Pro NOT in models list' -ForegroundColor Red
    }
} catch {
    Write-Host "FAIL /v1/models: $($_.Exception.Message)" -ForegroundColor Red
}

# 4. /v1/chat/completions
Write-Host ''
Write-Host '=== POST /v1/chat/completions (timeout 150s) ===' -ForegroundColor Cyan
$body = @{ model = 'DeepSeek-V4-Pro'; messages = @(@{ role = 'user'; content = 'Hello, please introduce yourself in one short sentence.' }); stream = $false } | ConvertTo-Json -Depth 3
$start = Get-Date
try {
    $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/v1/chat/completions' -Headers $AUTH -Method Post -Body $body -ContentType 'application/json; charset=utf-8' -TimeoutSec 150
    $elapsed = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
    Write-Host "[took ${elapsed}s]" -ForegroundColor Yellow
    $resp | ConvertTo-Json -Depth 5
    Write-Host ''
    if ($resp.choices -and $resp.choices[0].message -and $resp.choices[0].message.content) {
        Write-Host '==== SMOKE TEST PASS ====' -ForegroundColor Green
        Write-Host "Assistant: $($resp.choices[0].message.content)" -ForegroundColor Green
    } else {
        Write-Host 'FAIL Response shape unexpected' -ForegroundColor Red
    }
} catch {
    $elapsed = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
    Write-Host "FAIL after ${elapsed}s: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails) { Write-Host "   $($_.ErrorDetails.Message)" -ForegroundColor Red }
}

# 5. tear down
try { Stop-Process -Id $p.Id -Force -EA Stop } catch {}
Get-Process camoufox,firefox -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Get-Process node -EA SilentlyContinue | Where-Object {
    try { $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -EA Stop).CommandLine; $cmd -like '*supervisor.js*' -or $cmd -like '*server.js*' } catch { $false }
} | Stop-Process -Force -EA SilentlyContinue
Start-Sleep -Milliseconds 800

# 6. logs
Write-Host ''
Write-Host '=========== smoke-test.log (last 60) ===========' -ForegroundColor Magenta
if (Test-Path $logF) { Get-Content $logF -Tail 60 -Encoding utf8 } else { Write-Host '(empty)' }
Write-Host ''
Write-Host '=========== smoke-test.err (last 30) ===========' -ForegroundColor Yellow
if (Test-Path $errF) { Get-Content $errF -Tail 30 -Encoding utf8 } else { Write-Host '(empty)' }
Write-Host ''
Write-Host '=========== ERROR/WARN lines from system.log ===========' -ForegroundColor Magenta
if (Test-Path 'E:\NEW-toy\WebAI2API\data\logs\system.log') {
    Select-String -LiteralPath 'E:\NEW-toy\WebAI2API\data\logs\system.log' -Pattern 'tongji|ERROR|WARN' -EA SilentlyContinue | Select-Object -Last 30 | ForEach-Object { $_.Line }
}
