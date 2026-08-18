# start-iopaint.ps1 — Idempotently ensure IOPaint is running on port 8080.
# Runs as the `predev` npm hook so `npm run dev` also brings up IOPaint.
# Always exits 0 so it never blocks the Vite dev server.

$ErrorActionPreference = 'SilentlyContinue'
$port = 8080

# Already listening? Nothing to do (works for both manual starts and prior auto-start).
if (Get-NetTCPConnection -LocalPort $port -State Listen) {
    Write-Host "[predev] IOPaint already running on 127.0.0.1:$port - skipping"
    exit 0
}

$python = 'd:\anaconda3\envs\llm\python.exe'
if (-not (Test-Path $python)) {
    Write-Host "[predev] WARN: $python not found - cannot auto-start IOPaint."
    Write-Host "[predev] Start it manually: iopaint start --model=anime-lama"
    exit 0
}

$logDir = Join-Path $env:LOCALAPPDATA 'iopaint'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$stdout = Join-Path $logDir 'iopaint.log'
$stderr = Join-Path $logDir 'iopaint.err.log'

Write-Host "[predev] Starting IOPaint (anime-lama) in background..."
Start-Process -FilePath $python -ArgumentList '-m', 'iopaint', 'start', '--model=anime-lama' `
    -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr

# Wait up to 60s for the port (first run may download the model, which is slow).
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    if (Get-NetTCPConnection -LocalPort $port -State Listen) {
        Write-Host "[predev] IOPaint up on http://127.0.0.1:$port (logs: $stdout)"
        exit 0
    }
}
Write-Host "[predev] WARN: IOPaint did not open port $port within 60s - check $stderr"
exit 0
