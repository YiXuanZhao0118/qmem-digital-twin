[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$BackendDir  = Join-Path $ProjectRoot "backend"
$VenvPython  = Join-Path $BackendDir ".venv\Scripts\python.exe"
$LogDir      = Join-Path $ProjectRoot ".claude-runtime"
$BackendLog  = Join-Path $LogDir "backend.log"
$BackendErr  = Join-Path $LogDir "backend.err"
$DatabaseUrl = "postgresql+asyncpg://qmem:qmem_password@localhost:55432/qmem_twin"

if (-not (Test-Path -LiteralPath $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir | Out-Null
}

function Get-PortOwner($port) {
  Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
}

# Stop whoever owns :8010
$pids = Get-PortOwner 8010
foreach ($procId in $pids) {
  if (-not $procId) { continue }
  try {
    $proc = Get-Process -Id $procId -ErrorAction Stop
    Write-Host ("[backend] stopping PID {0} ({1})" -f $procId, $proc.Name) -ForegroundColor Yellow
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  } catch {}
}
Start-Sleep -Milliseconds 500

if (-not (Test-Path -LiteralPath $VenvPython)) {
  throw "Backend venv not found at $VenvPython"
}

Write-Host ("[backend] starting uvicorn on :8010 (logs -> {0})" -f $BackendLog) -ForegroundColor Cyan
$psArgs = @(
  "-NoProfile",
  "-Command",
  "Set-Location -LiteralPath '$BackendDir'; `$env:DATABASE_URL='$DatabaseUrl'; & '$VenvPython' -m uvicorn app.main:app --host 0.0.0.0 --port 8010 --reload"
)
$proc = Start-Process -FilePath "powershell.exe" `
  -ArgumentList $psArgs `
  -WorkingDirectory $BackendDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $BackendLog `
  -RedirectStandardError  $BackendErr `
  -PassThru

# Wait until :8010 is bound (max 25s)
$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
  if (Get-PortOwner 8010) { break }
  Start-Sleep -Milliseconds 400
}
if (-not (Get-PortOwner 8010)) {
  throw "Backend did not bind :8010 within 25s. Tail $BackendErr"
}

# Health probe
try {
  $resp = Invoke-WebRequest -Uri "http://localhost:8010/api/health" -UseBasicParsing -TimeoutSec 5
  Write-Host ("[backend] up (PID {0}) — /api/health -> HTTP {1}" -f $proc.Id, [int]$resp.StatusCode) -ForegroundColor Green
} catch {
  Write-Host ("[backend] up (PID {0}) — health probe pending" -f $proc.Id) -ForegroundColor Yellow
}
