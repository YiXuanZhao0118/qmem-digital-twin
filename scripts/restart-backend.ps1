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

function Get-UvicornPythonPids {
  # `uvicorn --reload` spawns a WatchFiles parent + a child worker. When
  # the parent exits ungracefully the child keeps the socket but
  # `Get-NetTCPConnection.OwningProcess` may still report the dead
  # parent PID, so the standard owner-kill path is a no-op. Falling
  # back to "kill any python.exe that has uvicorn / app.main in its
  # command line" catches the orphaned worker reliably.
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'uvicorn|app\.main:app' } |
    Select-Object -ExpandProperty ProcessId -Unique
}

function Stop-Pids($pids, $label) {
  foreach ($procId in $pids) {
    if (-not $procId) { continue }
    try {
      $proc = Get-Process -Id $procId -ErrorAction Stop
      Write-Host ("[backend] stopping $label PID {0} ({1})" -f $procId, $proc.Name) -ForegroundColor Yellow
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    } catch {
      # Process already gone — owner socket may still report it. Fine,
      # the orphan-worker sweep below will catch the real listener.
    }
  }
}

# Pass 1: kill whoever the kernel says owns :8010.
Stop-Pids (Get-PortOwner 8010) 'port-owner'
Start-Sleep -Milliseconds 500

# Pass 2: kill any orphan uvicorn-worker python.exe that survived.
$orphans = Get-UvicornPythonPids
if ($orphans) {
  Write-Host ("[backend] orphan uvicorn worker(s) detected: {0} — sweeping" -f ($orphans -join ',')) -ForegroundColor Yellow
  Stop-Pids $orphans 'orphan-worker'
  Start-Sleep -Milliseconds 500
}

# Pass 3: verify the port is actually free now. If something else
# still squats on :8010 (unrelated service?), abort rather than start
# a second uvicorn that'll silently lose the bind race.
$stillOwned = Get-PortOwner 8010
if ($stillOwned) {
  throw "Port :8010 still owned by PID(s) $($stillOwned -join ',') after pre-flight sweep. Investigate manually before retrying."
}

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
