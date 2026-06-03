$ErrorActionPreference = 'Continue'
Set-Location E:\NEW-toy\WebAI2API

# 0. clean lingering processes
Get-Process camoufox,firefox -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Get-Process node -EA SilentlyContinue | Where-Object {
    try { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -EA Stop).CommandLine -like '*supervisor.js*' } catch { $false }
} | Stop-Process -Force -EA SilentlyContinue
Start-Sleep -Milliseconds 800

# 1. cookies check
$cookieFile = 'E:\NEW-toy\WebAI2API\data\camoufoxUserData_tongji\cookies.sqlite'
if (-not (Test-Path $cookieFile)) {
    Write-Host 'FAIL cookies.sqlite NOT FOUND' -ForegroundColor Red
    exit 1
}

# 2. spawn supervisor
$logF = 'E:\NEW-toy\WebAI2API\smoke-test-v2.log'
$errF = 'E:\NEW-toy\WebAI2API\smoke-test-v2.err'
if (Test-Path $logF) { Remove-Item -LiteralPath $logF -Force }
if (Test-Path $errF) { Remove-Item -LiteralPath $errF -Force }
$p = Start-Process node -ArgumentList 'supervisor.js' -NoNewWindow -PassThru -RedirectStandardOutput $logF -RedirectStandardError $errF -WorkingDirectory 'E:\NEW-toy\WebAI2API'
Write-Host "supervisor PID=$($p.Id), waiting 20s for browser+discoverModels..." -ForegroundColor Cyan
Start-Sleep -Seconds 20

$AUTH = @{ Authorization = 'Bearer sk-283629c3a933460254adddd5e9dff3e5c4af571c1435ad9b' }
$BASE = 'http://127.0.0.1:3000'

# ===== TEST 1: streaming =====
Write-Host ''
Write-Host '=== TEST 1: streaming (stream=true) ===' -ForegroundColor Cyan
$body1 = @{ model = 'DeepSeek-V4-Pro'; messages = @(@{ role = 'user'; content = 'Count from 1 to 5, one number per line.' }); stream = $true } | ConvertTo-Json -Depth 3
$start1 = Get-Date
$chunks = New-Object System.Collections.Generic.List[object]
$firstChunkAt = $null
$lastChunkAt = $null
$contentBuf = New-Object System.Text.StringBuilder
try {
    $req = [System.Net.HttpWebRequest]::Create("$BASE/v1/chat/completions")
    $req.Method = 'POST'
    $req.Headers.Add('Authorization', $AUTH.Authorization)
    $req.ContentType = 'application/json; charset=utf-8'
    $req.Timeout = 180000
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body1)
    $req.ContentLength = $bytes.Length
    $reqStream = $req.GetRequestStream()
    $reqStream.Write($bytes, 0, $bytes.Length)
    $reqStream.Close()
    $resp = $req.GetResponse()
    $stream = $resp.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
    while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        if (-not $line) { continue }
        if ($line.StartsWith('data:')) {
            $ds = $line.Substring(5).Trim()
            if ($ds -eq '[DONE]') { break }
            try {
                $obj = $ds | ConvertFrom-Json
                $chunks.Add($obj)
                if ($null -eq $firstChunkAt) { $firstChunkAt = Get-Date }
                $lastChunkAt = Get-Date
                $d = $obj.choices[0].delta
                if ($d.content) { [void]$contentBuf.Append($d.content) }
            } catch {}
        }
    }
    $reader.Close()
    $resp.Close()
    $elapsed = [math]::Round(((Get-Date) - $start1).TotalSeconds, 2)
    $span = if ($firstChunkAt -and $lastChunkAt) { [math]::Round(($lastChunkAt - $firstChunkAt).TotalSeconds, 2) } else { 0 }
    Write-Host "[elapsed=${elapsed}s first→last=${span}s chunks=$($chunks.Count)]" -ForegroundColor Yellow
    Write-Host ("content: " + $contentBuf.ToString()) -ForegroundColor Green
    if ($chunks.Count -ge 3 -and $contentBuf.Length -gt 0) {
        Write-Host 'OK streaming delivered multiple chunks + content' -ForegroundColor Green
    } elseif ($chunks.Count -eq 1) {
        Write-Host 'WARN only 1 chunk received (server may have buffered — check onDelta path)' -ForegroundColor Yellow
    } else {
        Write-Host "FAIL streaming: chunks=$($chunks.Count) content_len=$($contentBuf.Length)" -ForegroundColor Red
    }
} catch {
    $elapsed = [math]::Round(((Get-Date) - $start1).TotalSeconds, 2)
    Write-Host "FAIL streaming after ${elapsed}s: $($_.Exception.Message)" -ForegroundColor Red
}

# ===== TEST 2: native multi-turn via two HTTP calls (proper session reuse) =====
Write-Host ''
Write-Host '=== TEST 2: native multi-turn (call 1: introduce, call 2: recall) ===' -ForegroundColor Cyan

# Call 1: introduce the name
$body2a = @{
    model = 'DeepSeek-V4-Pro'
    messages = @(@{ role = 'user'; content = 'My name is Alice. Reply with just OK.' })
    stream = $false
} | ConvertTo-Json -Depth 3
$start2a = Get-Date
try {
    $resp2a = Invoke-RestMethod -Uri "$BASE/v1/chat/completions" -Headers $AUTH -Method Post -Body $body2a -ContentType 'application/json; charset=utf-8' -TimeoutSec 150
    $elapsed2a = [math]::Round(((Get-Date) - $start2a).TotalSeconds, 1)
    $ans2a = $resp2a.choices[0].message.content
    Write-Host "  Call 1 [${elapsed2a}s]: Assistant: $ans2a" -ForegroundColor Green
} catch {
    $elapsed2a = [math]::Round(((Get-Date) - $start2a).TotalSeconds, 1)
    Write-Host "FAIL call 1 after ${elapsed2a}s: $($_.Exception.Message)" -ForegroundColor Red
}

# Call 2: ask the name (OpenAI multi-turn format: include full history)
$body2b = @{
    model = 'DeepSeek-V4-Pro'
    messages = @(
        @{ role = 'user'; content = 'My name is Alice. Reply with just OK.' }
        @{ role = 'assistant'; content = $ans2a }
        @{ role = 'user'; content = 'What is my name?' }
    )
    stream = $false
} | ConvertTo-Json -Depth 3
$start2b = Get-Date
try {
    $resp2b = Invoke-RestMethod -Uri "$BASE/v1/chat/completions" -Headers $AUTH -Method Post -Body $body2b -ContentType 'application/json; charset=utf-8' -TimeoutSec 150
    $elapsed2b = [math]::Round(((Get-Date) - $start2b).TotalSeconds, 1)
    $ans2b = $resp2b.choices[0].message.content
    Write-Host "  Call 2 [${elapsed2b}s]: Assistant: $ans2b" -ForegroundColor Green
    if ($ans2b -match 'Alice') {
        Write-Host 'OK multi-turn context preserved (assistant remembered Alice across HTTP calls)' -ForegroundColor Green
    } else {
        Write-Host "WARN assistant did NOT mention Alice (got: '$ans2b')" -ForegroundColor Yellow
    }
} catch {
    $elapsed2b = [math]::Round(((Get-Date) - $start2b).TotalSeconds, 1)
    Write-Host "FAIL call 2 after ${elapsed2b}s: $($_.Exception.Message)" -ForegroundColor Red
}

# ===== TEST 3: dynamic model list =====
Write-Host ''
Write-Host '=== TEST 3: dynamic model discovery (count + non-default) ===' -ForegroundColor Cyan
try {
    $models3 = Invoke-RestMethod -Uri "$BASE/v1/models" -Headers $AUTH -Method Get -TimeoutSec 10
    $tongjiModels = @($models3.data | Where-Object { $_.owned_by -eq 'tongji' })
    Write-Host "tongji models count: $($tongjiModels.Count)" -ForegroundColor Yellow
    Write-Host (' - ' + (($tongjiModels | ForEach-Object { $_.id }) -join "`n - ")) -ForegroundColor Gray
    if ($tongjiModels.Count -ge 5) {
        Write-Host "OK dynamic discovery found $($tongjiModels.Count) models (>= 5)" -ForegroundColor Green
    } else {
        Write-Host "WARN only $($tongjiModels.Count) models discovered" -ForegroundColor Yellow
    }
} catch {
    Write-Host "FAIL /v1/models: $($_.Exception.Message)" -ForegroundColor Red
}

# ===== TEST 4: model switching (reuse session, switch to different model) =====
Write-Host ''
Write-Host '=== TEST 4: model switching (DeepSeek-V4-Pro -> GLM-5.1) ===' -ForegroundColor Cyan
$body4 = @{
    model = 'GLM-5.1'
    messages = @(@{ role = 'user'; content = 'Reply with exactly: MODEL_OK' })
    stream = $false
} | ConvertTo-Json -Depth 3
$start4 = Get-Date
try {
    $resp4 = Invoke-RestMethod -Uri "$BASE/v1/chat/completions" -Headers $AUTH -Method Post -Body $body4 -ContentType 'application/json; charset=utf-8' -TimeoutSec 150
    $elapsed4 = [math]::Round(((Get-Date) - $start4).TotalSeconds, 1)
    $ans4 = $resp4.choices[0].message.content
    $modelUsed = $resp4.model
    Write-Host "[took ${elapsed4}s] model=$modelUsed" -ForegroundColor Yellow
    Write-Host "Assistant: $ans4" -ForegroundColor Green
    if ($modelUsed -match 'GLM') {
        Write-Host "OK model switched to $modelUsed" -ForegroundColor Green
    } else {
        Write-Host "WARN response model=$modelUsed (expected GLM-5.1)" -ForegroundColor Yellow
    }
} catch {
    $elapsed4 = [math]::Round(((Get-Date) - $start4).TotalSeconds, 1)
    Write-Host "FAIL model-switch after ${elapsed4}s: $($_.Exception.Message)" -ForegroundColor Red
}

# ===== tear down =====
try { Stop-Process -Id $p.Id -Force -EA Stop } catch {}
Get-Process camoufox,firefox -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Get-Process node -EA SilentlyContinue | Where-Object {
    try { $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -EA Stop).CommandLine; $cmd -like '*supervisor.js*' -or $cmd -like '*server.js*' } catch { $false }
} | Stop-Process -Force -EA SilentlyContinue
Start-Sleep -Milliseconds 800

# logs
Write-Host ''
Write-Host '=========== smoke-test-v2.log (last 30) ===========' -ForegroundColor Magenta
if (Test-Path $logF) { Get-Content $logF -Tail 30 -Encoding utf8 }
Write-Host ''
Write-Host '=========== tongji-related log lines ===========' -ForegroundColor Magenta
if (Test-Path 'E:\NEW-toy\WebAI2API\data\logs\system.log') {
    Select-String -LiteralPath 'E:\NEW-toy\WebAI2API\data\logs\system.log' -Pattern 'tongji' -EA SilentlyContinue | Select-Object -Last 20 | ForEach-Object { $_.Line }
}
