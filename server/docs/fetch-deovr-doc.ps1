# Downloads the DeoVR App documentation page as plain text into this folder.
# Note: The resulting file is gitignored by default.
# Source: https://deovr.com/app/doc

$ErrorActionPreference = 'Stop'

$outFile = Join-Path $PSScriptRoot 'DeoVR_App_Documentation_Full.txt'
$url = 'https://deovr.com/app/doc'

# Use basic parsing for compatibility with Windows PowerShell 5.1
$response = Invoke-WebRequest -Uri $url -UseBasicParsing

# Prefer text content (strips most markup) and keep UTF-8 encoding.
$text = $response.Content

# Some PowerShell versions expose ParsedHtml; if available, try to use it for cleaner text.
try {
  if ($null -ne $response.ParsedHtml) {
    $text = $response.ParsedHtml.body.innerText
  }
} catch {
  # ignore and keep $response.Content
}

# Normalize newlines
$text = ($text -replace "`r`n", "`n") -replace "`r", "`n"

Set-Content -Path $outFile -Value $text -Encoding utf8
Write-Host "Saved: $outFile"