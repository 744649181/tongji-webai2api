# ============================================
# tongji-webai2api - Windows system tray app
# ============================================
# Right-click menu:
#   Open WebUI / Status / Start / Stop / Restart / Re-login
#   Open logs / Open data folder / Auto-start at login / Quit
# Double-click: open WebUI in browser
# Talks to existing supervisor IPC for stop/restart.
# Falls back to .bat shell-outs if IPC unavailable.
# ============================================

# Self-elevate if not admin (needed for some operations; harmless if not)
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$script:projectRoot = Split-Path -Parent $PSCommandPath

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# --- Tray icon ---
# Try a few candidates; fall back to the system app icon.
$iconCandidates = @(
    (Join-Path $script:projectRoot "assets\tray.ico"),
    (Join-Path $script:projectRoot "assets\tray.png")
)
$icon = $null
foreach ($p in $iconCandidates) {
    if (Test-Path $p) {
        try { $icon = New-Object System.Drawing.Icon($p); break } catch {}
    }
}
if ($null -eq $icon) {
    $icon = [System.Drawing.SystemIcons]::Application
}

# --- NotifyIcon ---
$script:notify = New-Object System.Windows.Forms.NotifyIcon
$script:notify.Icon = $icon
$script:notify.Visible = $true
$script:notify.Text = "tongji-webai2api"

# --- Context menu ---
$menu = New-Object System.Windows.Forms.ContextMenuStrip

# Open WebUI
$openWebUI = $menu.Items.Add("Open WebUI in browser")
$openWebUI.add_Click({ Open-Url "http://127.0.0.1:3000/" })

# Open status page (admin)
$openAdmin = $menu.Items.Add("Open admin panel")
$openAdmin.add_Click({ Open-Url "http://127.0.0.1:3000/admin" })

$menu.Items.Add("-") | Out-Null

# Live status (label only)
$script:statusItem = $menu.Items.Add("Status: checking...")

$menu.Items.Add("-") | Out-Null

# Start server
$startItem = $menu.Items.Add("Start server")
$startItem.add_Click({ Run-Script "start.bat" "Start" })

# Stop server
$stopItem = $menu.Items.Add("Stop server")
$stopItem.add_Click({ Run-Script "stop.bat" "Stop" })

# Restart server
$restartItem = $menu.Items.Add("Restart server")
$restartItem.add_Click({
    # Fast path: send RESTART to supervisor via IPC, no need to stop/start manually
    $ok = Send-Ipc "RESTART"
    if (-not $ok) {
        # Fallback: stop then start
        Run-Script "stop.bat" "Restart (stop)" -NoBalloon
        Start-Sleep -Seconds 2
        Run-Script "start.bat" "Restart (start)"
    } else {
        Show-Balloon "Restart" "Restart signal sent to supervisor."
    }
})

# Re-login (refresh cookies)
$loginItem = $menu.Items.Add("Re-login (refresh SSO cookies)")
$loginItem.add_Click({ Run-Script "login.bat" "Re-login" -Wait })

$menu.Items.Add("-") | Out-Null

# Open folders
$logsItem = $menu.Items.Add("Open logs folder")
$logsItem.add_Click({ Open-Folder (Join-Path $script:projectRoot "data\logs") })

$dataItem = $menu.Items.Add("Open data folder")
$dataItem.add_Click({ Open-Folder (Join-Path $script:projectRoot "data") })

$projectItem = $menu.Items.Add("Open project folder")
$projectItem.add_Click({ Open-Folder $script:projectRoot })

$menu.Items.Add("-") | Out-Null

# Auto-start at login (toggle)
$script:autoStartItem = $menu.Items.Add("Auto-start at Windows login")
$script:autoStartItem.CheckOnClick = $true
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runName = "tongji-webai2api-tray"
$existing = Get-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
$script:autoStartItem.Checked = ($null -ne $existing)
$script:autoStartItem.add_CheckStateChanged({
    $ps = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
    if ($script:autoStartItem.Checked) {
        Set-ItemProperty -Path $runKey -Name $runName -Value $ps
        Show-Balloon "Auto-start" "Will launch on Windows login."
    } else {
        Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
        Show-Balloon "Auto-start" "Disabled."
    }
})

# Help
$helpItem = $menu.Items.Add("Open README")
$helpItem.add_Click({ Open-Url "https://github.com/744649181/tongji-webai2api#readme" })

$menu.Items.Add("-") | Out-Null

# Quit (server keeps running)
$quitItem = $menu.Items.Add("Quit tray (server keeps running)")
$quitItem.add_Click({
    $script:notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

$script:notify.ContextMenuStrip = $menu
$script:notify.add_DoubleClick({ Open-Url "http://127.0.0.1:3000/" })

# --- Status checker ---
$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 5000
$script:timer.add_Tick({
    $up = Test-ServerUp
    if ($up) {
        $script:statusItem.Text = "Status: UP - http://127.0.0.1:3000"
        $script:statusItem.ForeColor = [System.Drawing.Color]::FromArgb(0, 130, 0)   # dark green
    } else {
        $script:statusItem.Text = "Status: DOWN - right-click to start"
        $script:statusItem.ForeColor = [System.Drawing.Color]::FromArgb(180, 0, 0)  # dark red
    }
})
$script:timer.Start()

# --- Initial state ---
$script:statusItem.Text = "Status: checking..."
Show-Balloon "tongji-webai2api" "Tray app is running. Right-click for menu."

# --- Helpers ---
function Open-Url($url) {
    try { Start-Process $url } catch { Show-Balloon "Error" "Could not open $url" }
}
function Open-Folder($path) {
    if (Test-Path $path) {
        Start-Process explorer.exe $path
    } else {
        Show-Balloon "Error" "Path does not exist: $path"
    }
}
function Show-Balloon($title, $text) {
    try { $script:notify.ShowBalloonTip(3000, $title, $text, [System.Windows.Forms.ToolTipIcon]::Info) } catch {}
}
function Run-Script($batName, $label, [switch]$NoBalloon, [switch]$Wait) {
    $bat = Join-Path $script:projectRoot $batName
    if (-not (Test-Path $bat)) {
        Show-Balloon "Error" "$batName not found"
        return
    }
    if (-not $NoBalloon) { Show-Balloon $label "Running $batName..." }
    if ($Wait) {
        Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $batName -WorkingDirectory $script:projectRoot -Wait
    } else {
        Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $batName -WorkingDirectory $script:projectRoot
    }
}
function Test-ServerUp {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:3000/v1/models" `
            -Headers @{Authorization="Bearer healthcheck"} `
            -TimeoutSec 2 -ErrorAction SilentlyContinue
        return ($r.StatusCode -eq 200 -or $r.StatusCode -eq 401)
    } catch {
        return $false
    }
}
function Send-Ipc($msg) {
    # Windows named pipe IPC to supervisor.
    # Falls back silently if not on Windows or pipe not present.
    if ($env:OS -ne "Windows_NT") { return $false }
    $pipeName = "\\.\pipe\webai2api-supervisor"
    if (-not [System.IO.Pipe]::Exists) { return $false }
    try {
        $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", "webai2api-supervisor", [System.IO.Pipes.PipeDirection]::InOut)
        $pipe.Connect(2000)
        $writer = New-Object System.IO.StreamWriter($pipe)
        $writer.WriteLine($msg); $writer.Flush()
        $pipe.Close()
        return $true
    } catch {
        return $false
    }
}

# --- Run message loop ---
[System.Windows.Forms.Application]::Run()
$script:notify.Visible = $false
