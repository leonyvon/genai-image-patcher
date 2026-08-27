# start-iopaint.ps1 — Request IOPaint in the background without blocking Vite.
# Runs as the `predev` npm hook so `npm run dev` can also bring up IOPaint.
# This script deliberately exits immediately after launching the optional service.

$ErrorActionPreference = 'SilentlyContinue'
$port = 8080
$url = "http://127.0.0.1:$port/"

function Test-Iopaint {
    try {
        # Do not use the user's HTTP proxy for a loopback health probe.
        $request = [System.Net.HttpWebRequest]::Create($url)
        $request.Proxy = $null
        $request.Timeout = 750
        $response = $request.GetResponse()
        $response.Close()
        return $true
    } catch {
        # A HTTP error response still proves that something is listening.
        if ($_.Exception.Response) {
            $_.Exception.Response.Close()
            return $true
        }
        return $false
    }
}

# Already ready? Nothing to do.
if (Test-Iopaint) {
    Write-Host "[predev] IOPaint already reachable at $url - skipping"
    exit 0
}

$python = 'd:\anaconda3\envs\llm\python.exe'
if (-not (Test-Path $python)) {
    Write-Host "[predev] WARN: $python not found - cannot auto-start IOPaint."
    Write-Host "[predev] Start it manually when needed: iopaint start --model=anime-lama"
    exit 0
}

# Avoid launching a second copy when an earlier background start is still
# loading its model. If process inspection is unavailable, continue anyway:
# the optional service must never be allowed to block Vite.
$existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^python(w)?\.exe$' -and $_.CommandLine -match '(?i)(-m\s+iopaint|iopaint.*\sstart)' }
if ($existing) {
    Write-Host "[predev] IOPaint is already starting in the background - continuing without waiting"
    exit 0
}

$logDir = Join-Path $env:LOCALAPPDATA 'iopaint'
try {
    New-Item -ItemType Directory -Path $logDir -Force -ErrorAction Stop | Out-Null
} catch {
    $logDir = Join-Path ([System.IO.Path]::GetTempPath()) 'iopaint'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$stdout = Join-Path $logDir 'iopaint.log'
$stderr = Join-Path $logDir 'iopaint.err.log'

try {
    Write-Host "[predev] Requesting IOPaint (anime-lama) in background; Vite will not wait..."
    Start-Process -FilePath $python -ArgumentList '-m', 'iopaint', 'start', '--model=anime-lama' `
        -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
        -ErrorAction Stop | Out-Null
    Write-Host "[predev] IOPaint launch requested (logs: $stdout / $stderr)"
} catch {
    Write-Host "[predev] WARN: could not launch IOPaint: $($_.Exception.Message)"
}

# IOPaint may take a minute (or longer) to load anime-lama. It is optional for
# the Vite workbench, so return immediately and let the UI report it as
# unavailable until the service becomes reachable.
exit 0
