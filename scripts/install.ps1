# Installs the DSH half and stages the browser half.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -StageOnly
#
# The browser half is always manual on first install: Chrome only accepts an
# unpacked extension through chrome://extensions (see the printed steps).
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [switch]$StageOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $root 'extension'
$staged = Join-Path $env:USERPROFILE '.dsh\site-bridge\extension'

if (-not (Test-Path (Join-Path $extension 'manifest.json'))) {
  throw "extension/manifest.json not found next to $root"
}

Write-Host "Staging the extension to $staged"
New-Item -ItemType Directory -Force $staged | Out-Null
Copy-Item -Path (Join-Path $extension '*') -Destination $staged -Recurse -Force

if ($StageOnly) {
  Write-Host "Staged only. Load it via chrome://extensions: $staged"
  return
}

$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) {
  throw "dsh CLI not found on PATH. Install the plugin by hand: dsh plugin --profile $Profile add `"$root`""
}

Write-Host "Installing dsh-site-bridge into profile '$Profile'"
& $dsh.Source plugin --profile $Profile add $root
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed with exit code $LASTEXITCODE" }

$credentials = Join-Path $env:USERPROFILE '.dsh\site-bridge\bridge.json'
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Restart DSH so the host half loads.'
Write-Host "  2. chrome://extensions -> Developer mode -> Load unpacked -> $staged"
Write-Host "  3. Open the popup, paste port and token from: $credentials"
Write-Host '  4. Click "Connect this tab" on the page you want to capture.'
Write-Host '  5. In DSH ask for site_status, then site_capture.'
