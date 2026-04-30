param(
  [int]$Port = 55432,
  [string]$Database = "qmem_twin",
  [string]$User = "qmem",
  [string]$Password = "qmem_password"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LocalRoot = Join-Path $RepoRoot ".local-postgres"
$DataDir = Join-Path $LocalRoot "data"
$LogFile = Join-Path $LocalRoot "postgres.log"
$PwFile = Join-Path $LocalRoot "pwfile.txt"
$EnvFile = Join-Path $RepoRoot ".env"

function Find-PostgresBin {
  $pgCtl = Get-Command pg_ctl.exe -ErrorAction SilentlyContinue
  if ($pgCtl) {
    return Split-Path -Parent $pgCtl.Source
  }

  $candidate = Get-ChildItem -Path "$env:ProgramFiles\PostgreSQL" -Recurse -Filter pg_ctl.exe -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if (-not $candidate) {
    throw "Could not find pg_ctl.exe. Install PostgreSQL or Docker Desktop."
  }
  return Split-Path -Parent $candidate.FullName
}

$PgBin = Find-PostgresBin
New-Item -ItemType Directory -Force -Path $LocalRoot | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $DataDir "PG_VERSION"))) {
  Set-Content -LiteralPath $PwFile -Value $Password -NoNewline
  try {
    & (Join-Path $PgBin "initdb.exe") -D $DataDir -U $User -A scram-sha-256 --pwfile=$PwFile --encoding=UTF8 --locale=C
    if ($LASTEXITCODE -ne 0) {
      throw "initdb failed with exit code $LASTEXITCODE"
    }
  }
  finally {
    Remove-Item -LiteralPath $PwFile -Force -ErrorAction SilentlyContinue
  }
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
  & (Join-Path $PgBin "pg_ctl.exe") -D $DataDir -l $LogFile -o "-p $Port -c listen_addresses=localhost" start
  if ($LASTEXITCODE -ne 0) {
    throw "pg_ctl failed with exit code $LASTEXITCODE. Check $LogFile"
  }
}

$env:PGPASSWORD = $Password
$exists = & (Join-Path $PgBin "psql.exe") -h localhost -p $Port -U $User -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$Database'"
if ($exists -ne "1") {
  & (Join-Path $PgBin "createdb.exe") -h localhost -p $Port -U $User $Database
  if ($LASTEXITCODE -ne 0) {
    throw "createdb failed with exit code $LASTEXITCODE"
  }
}

$databaseUrl = "postgresql+asyncpg://$User`:$Password@localhost:$Port/$Database"
$envLines = @(
  "DATABASE_URL=$databaseUrl",
  "CORS_ORIGINS=http://localhost:5173,http://localhost:3000",
  "ASSET_ROOT=assets",
  "ONSHAPE_ACCESS_KEY=",
  "ONSHAPE_SECRET_KEY=",
  "ONSHAPE_BASE_URL=https://cad.onshape.com"
)

if (Test-Path -LiteralPath $EnvFile) {
  $current = Get-Content -LiteralPath $EnvFile
  $hasDatabaseUrl = $false
  $next = foreach ($line in $current) {
    if ($line -match "^DATABASE_URL=") {
      $hasDatabaseUrl = $true
      "DATABASE_URL=$databaseUrl"
    }
    else {
      $line
    }
  }
  if (-not $hasDatabaseUrl) {
    $next = @("DATABASE_URL=$databaseUrl") + $next
  }
  $next | Set-Content -LiteralPath $EnvFile
}
else {
  @(
    $envLines
  ) | Set-Content -LiteralPath $EnvFile
}

Write-Host "PostgreSQL is ready on localhost:$Port"
Write-Host "DATABASE_URL=$databaseUrl"
