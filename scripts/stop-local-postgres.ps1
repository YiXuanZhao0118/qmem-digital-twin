param(
  [string]$Mode = "fast"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $RepoRoot ".local-postgres\data"

function Find-PgCtl {
  $command = Get-Command pg_ctl.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $candidate = Get-ChildItem -Path "$env:ProgramFiles\PostgreSQL" -Recurse -Filter pg_ctl.exe -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if ($candidate) {
    return $candidate.FullName
  }

  throw "Could not find pg_ctl.exe."
}

$pgCtl = Find-PgCtl

if (Test-Path -LiteralPath (Join-Path $DataDir "PG_VERSION")) {
  & $pgCtl -D $DataDir -m $Mode stop
}
