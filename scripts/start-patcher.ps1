# start-patcher.ps1 — Start the standalone GenAI Patcher workbench.
# The MCP server invokes this script automatically when the app is needed.

param(
    [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 3000
$url = "http://127.0.0.1:$port"

function Test-Workbench {
    try {
        $request = [System.Net.HttpWebRequest]::Create($url)
        $request.Proxy = $null
        $request.Timeout = 2000
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        $body = $reader.ReadToEnd()
        $reader.Dispose()
        $response.Close()
        return $body -match 'GenAI Patcher'
    } catch {
        return $false
    }
}

$logDir = Join-Path $env:LOCALAPPDATA 'genai-image-patcher'
try {
    New-Item -ItemType Directory -Path $logDir -Force -ErrorAction Stop | Out-Null
} catch {
    # Restricted runners may not allow writes to LOCALAPPDATA; keep startup
    # functional and place diagnostics in the user/system temp directory.
    $logDir = Join-Path ([System.IO.Path]::GetTempPath()) 'genai-image-patcher'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$stdout = Join-Path $logDir 'vite.log'
$stderr = Join-Path $logDir 'vite.err.log'

$mutex = $null
$ownsMutex = $false
try {
    # MCP calls can arrive concurrently (or from more than one MCP process).
    # Serialize the check-and-spawn sequence so two Vite instances cannot race
    # for port 3000. A named mutex is scoped to this Windows user/session.
    $mutex = New-Object System.Threading.Mutex($false, 'LEON.GenAIImagePatcher.Startup')
    $ownsMutex = $mutex.WaitOne([TimeSpan]::FromSeconds(5))

    if (-not $ownsMutex) {
        Write-Host "[patcher] Another startup is in progress; waiting for its Vite instance ..." -ForegroundColor DarkGray
    } elseif (-not (Test-Workbench)) {
        Write-Host "[patcher] Starting Vite workbench on $url ..." -ForegroundColor Cyan
        Start-Process -FilePath 'npm.cmd' `
            -ArgumentList @('run', 'dev', '--', '--host', '127.0.0.1', '--strictPort') `
            -WorkingDirectory $root `
            -WindowStyle Hidden `
            -RedirectStandardOutput $stdout `
            -RedirectStandardError $stderr | Out-Null

        # predev launches optional IOPaint asynchronously; only wait for Vite.
    }

    for ($i = 0; $i -lt 120; $i++) {
        if (Test-Workbench) { break }
        Start-Sleep -Seconds 1
    }

    if (-not (Test-Workbench)) {
        Write-Error "Vite did not open port $port within 120 seconds. Check $stderr"
        exit 1
    }

    Write-Host "[patcher] Workbench available at $url" -ForegroundColor Green
    if ($OpenBrowser) {
        Start-Process $url | Out-Null
        Write-Host "[patcher] Browser opened"
    }
    exit 0
} finally {
    if ($ownsMutex -and $mutex) {
        try { $mutex.ReleaseMutex() } catch { }
    }
    if ($mutex) { $mutex.Dispose() }
}
