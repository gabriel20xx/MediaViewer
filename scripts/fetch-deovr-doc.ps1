# Downloads the DeoVR App documentation page and writes:
# - DeoVR_JSON_API.txt (plain text extracted ONLY from div.c-reachtext)
#
# Note: The resulting files are gitignored by default.
# Source: https://deovr.com/app/doc

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$docsDir = Join-Path $repoRoot 'docs'
New-Item -ItemType Directory -Force -Path $docsDir | Out-Null

$outTextFile = Join-Path $docsDir 'DeoVR_JSON_API.txt'
$url = 'https://deovr.com/app/doc'

# Use basic parsing for compatibility with Windows PowerShell 5.1
$response = Invoke-WebRequest -Uri $url -UseBasicParsing

$html = [string]$response.Content

# Normalize newlines
$html = ($html -replace "`r`n", "`n") -replace "`r", "`n"

function Find-ReachtextDivStartIndex([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return -1 }

  $idx = $s.IndexOf('class="c-reachtext"', [System.StringComparison]::OrdinalIgnoreCase)
  if ($idx -lt 0) {
    $idx = $s.IndexOf("class='c-reachtext'", [System.StringComparison]::OrdinalIgnoreCase)
  }
  if ($idx -lt 0) {
    # class list containing c-reachtext
    $idx = $s.IndexOf('c-reachtext', [System.StringComparison]::OrdinalIgnoreCase)
  }
  if ($idx -lt 0) { return -1 }

  return $s.LastIndexOf('<div', $idx, [System.StringComparison]::OrdinalIgnoreCase)
}

function Extract-DivBlock([string]$s, [int]$startIndex) {
  if ($startIndex -lt 0 -or $startIndex -ge $s.Length) { return $null }

  $i = $startIndex
  $depth = 0
  $len = $s.Length
  $end = -1

  while ($i -lt $len) {
    # Find next tag boundary
    $lt = $s.IndexOf('<', $i)
    if ($lt -lt 0) { break }

    if ($lt + 4 -le $len -and $s.Substring($lt, [Math]::Min(5, $len - $lt)).StartsWith('<div', [System.StringComparison]::OrdinalIgnoreCase)) {
      $depth++
      $gt = $s.IndexOf('>', $lt)
      if ($gt -lt 0) { break }
      $i = $gt + 1
      continue
    }

    if ($lt + 5 -le $len -and $s.Substring($lt, [Math]::Min(6, $len - $lt)).StartsWith('</div', [System.StringComparison]::OrdinalIgnoreCase)) {
      $depth--
      $gt = $s.IndexOf('>', $lt)
      if ($gt -lt 0) { break }
      $i = $gt + 1
      if ($depth -le 0) {
        $end = $i
        break
      }
      continue
    }

    $i = $lt + 1
  }

  if ($end -lt 0) { return $null }
  return $s.Substring($startIndex, $end - $startIndex)
}

function Html-ToPlainText([string]$fragment) {
  if ([string]::IsNullOrEmpty($fragment)) { return '' }
  $t = $fragment

  # Remove non-content blocks
  $t = [regex]::Replace($t, '<script\b[^>]*>[\s\S]*?<\/script>', '', 'IgnoreCase')
  $t = [regex]::Replace($t, '<style\b[^>]*>[\s\S]*?<\/style>', '', 'IgnoreCase')
  $t = [regex]::Replace($t, '<noscript\b[^>]*>[\s\S]*?<\/noscript>', '', 'IgnoreCase')

  # Structural newlines
  $t = [regex]::Replace($t, '<\s*br\s*\/?>', "`n", 'IgnoreCase')
  $t = [regex]::Replace($t, '<\s*\/\s*(p|div|section|article|header|footer|main)\s*>', "`n", 'IgnoreCase')
  $t = [regex]::Replace($t, '<\s*h[1-6]\b[^>]*>', "`n`n", 'IgnoreCase')
  $t = [regex]::Replace($t, '<\s*\/\s*h[1-6]\s*>', "`n`n", 'IgnoreCase')
  $t = [regex]::Replace($t, '<\s*li\b[^>]*>', "`n- ", 'IgnoreCase')
  $t = [regex]::Replace($t, '<\s*\/\s*li\s*>', '', 'IgnoreCase')
  $t = [regex]::Replace($t, '<\s*(ul|ol)\b[^>]*>', "`n", 'IgnoreCase')
  $t = [regex]::Replace($t, '<\s*\/\s*(ul|ol)\s*>', "`n", 'IgnoreCase')

  # Strip remaining tags
  $t = [regex]::Replace($t, '<[^>]+>', '')

  # Decode entities
  $t = [System.Net.WebUtility]::HtmlDecode($t)

  # Normalize whitespace
  $t = ($t -replace "`r`n", "`n") -replace "`r", "`n"
  $t = [regex]::Replace($t, '[\t\f\v]+', ' ')
  $t = [regex]::Replace($t, '[ ]{2,}', ' ')
  $t = [regex]::Replace($t, "`n[ ]+", "`n")
  $t = [regex]::Replace($t, "`n{3,}", "`n`n")

  return $t.Trim()
}

$start = Find-ReachtextDivStartIndex $html
if ($start -lt 0) {
  throw "Could not find div with class 'c-reachtext' in downloaded HTML."
}

$block = Extract-DivBlock $html $start
if ([string]::IsNullOrEmpty($block)) {
  throw "Failed to extract the div.c-reachtext block (unbalanced <div> tags?)."
}

$plain = Html-ToPlainText $block
Set-Content -Path $outTextFile -Value ($plain + "`n") -Encoding utf8

Write-Host "Saved extracted text: $outTextFile"