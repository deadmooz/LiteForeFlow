# Downloads a private copy of Node.js (the current v22 LTS line) into <Dest>\node. No administrator rights needed,
# nothing else on the computer is changed. Used by start.bat when Node.js is missing or too old.
param([Parameter(Mandatory = $true)][string]$Dest)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

try {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
  $base = 'https://nodejs.org/dist/latest-v22.x'
  $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content -split "`n"
  $line = $sums | Where-Object { $_ -match "node-v[\d.]+-win-$arch\.zip\s*$" } | Select-Object -First 1
  if (-not $line) { throw "no Windows $arch build found at nodejs.org" }
  $hash, $name = $line.Trim() -split '\s+'

  $zip = Join-Path $env:TEMP $name
  Write-Host "  Downloading $name (about 30 MB)..."
  Invoke-WebRequest "$base/$name" -OutFile $zip -UseBasicParsing
  if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $hash) { Remove-Item $zip -Force; throw 'the download is damaged (checksum does not match)' }

  Write-Host '  Unpacking...'
  $stage = Join-Path $Dest '_unpack'
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  New-Item -ItemType Directory -Force $stage | Out-Null
  Expand-Archive $zip -DestinationPath $stage -Force
  $target = Join-Path $Dest 'node'
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  Move-Item (Get-ChildItem $stage -Directory | Select-Object -First 1).FullName $target
  Remove-Item $stage, $zip -Recurse -Force
  Write-Host '  Node.js is ready.'
} catch {
  Write-Host ''
  Write-Host "  Could not get Node.js: $($_.Exception.Message)"
  Write-Host '  Check your internet connection, or install it yourself from https://nodejs.org (LTS).'
  exit 1
}
