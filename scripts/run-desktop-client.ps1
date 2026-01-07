param(
  [string]$ServerUrl = "http://localhost:3000",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$clientDir = Join-Path $repoRoot "client-desktop"

Write-Host "Starting MediaViewer desktop client..." -ForegroundColor Cyan
Write-Host "Client dir: $clientDir" -ForegroundColor DarkGray
Write-Host "SERVER_URL: $ServerUrl" -ForegroundColor DarkGray

Set-Location $clientDir

if (-not (Test-Path "node_modules")) {
  Write-Host "node_modules missing; running npm install" -ForegroundColor Yellow
  npm install
}

if (-not $SkipBuild) {
  Write-Host "Building desktop client..." -ForegroundColor DarkGray
  npm run build
}

$env:SERVER_URL = $ServerUrl

# Launch Electron directly (avoids npm cwd/script resolution issues).
& "$clientDir\node_modules\.bin\electron.cmd" "$clientDir\dist\main.js"
