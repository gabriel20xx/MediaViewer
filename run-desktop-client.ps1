param(
  [string]$ServerUrl = "http://localhost:3000"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$clientDir = Join-Path $root "client-desktop"

Write-Host "Starting MediaViewer desktop client..." -ForegroundColor Cyan
Write-Host "Client dir: $clientDir" -ForegroundColor DarkGray
Write-Host "SERVER_URL: $ServerUrl" -ForegroundColor DarkGray

Set-Location $clientDir

if (-not (Test-Path "node_modules")) {
  Write-Host "node_modules missing; running npm install" -ForegroundColor Yellow
  npm install
}

if (-not (Test-Path "dist\main.js")) {
  Write-Host "dist missing; running npm run build" -ForegroundColor Yellow
  npm run build
}

$env:SERVER_URL = $ServerUrl
npm run start
