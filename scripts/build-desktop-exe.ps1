param(
  [switch]$SkipInstall,
  [switch]$Clean
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$clientDir = Join-Path $repoRoot "client-desktop"
$releaseDir = Join-Path $clientDir "release"

Write-Host "Building MediaViewer desktop .exe..." -ForegroundColor Cyan
Write-Host "Client dir: $clientDir" -ForegroundColor DarkGray

if (-not (Test-Path $clientDir)) {
  throw "client-desktop folder not found at: $clientDir"
}

Set-Location $clientDir

if ($Clean -and (Test-Path $releaseDir)) {
  Write-Host "Cleaning release folder: $releaseDir" -ForegroundColor DarkGray
  Remove-Item -Recurse -Force $releaseDir
}

if (-not $SkipInstall) {
  if (-not (Test-Path "node_modules")) {
    Write-Host "node_modules missing; running npm install" -ForegroundColor Yellow
    npm install
  }
}

Write-Host "Packaging (npm run package:win)..." -ForegroundColor DarkGray
npm run package:win

Write-Host "Done." -ForegroundColor Green
Write-Host "Output folder: $releaseDir" -ForegroundColor Cyan
