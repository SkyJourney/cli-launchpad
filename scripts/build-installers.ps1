# Build the online and offline NSIS installer flavors and collect them into
# dist-installers/ under distinct names. Tauri names every NSIS output the same,
# so each build is copied out before the next one overwrites it.
# ASCII-only on purpose: Windows PowerShell 5.1 misreads UTF-8 scripts.
$ErrorActionPreference = "Stop"

$root = (Get-Location).Path
$nsisDir = Join-Path $root "src-tauri/target/release/bundle/nsis"
$outDir = Join-Path $root "dist-installers"

function Invoke-Build([string[]]$extra) {
  Write-Host "`n=== pnpm tauri build $($extra -join ' ') ===" -ForegroundColor Cyan
  & pnpm tauri build @extra
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }
}

function Copy-Installer([string]$label) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $exe = Get-ChildItem $nsisDir -Filter *-setup.exe |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $exe) { throw "No *-setup.exe found in $nsisDir" }
  # Insert the variant label before "-setup.exe", keeping Tauri's
  # {productName}_{version}_{arch} prefix so the architecture is auto-included.
  $base = $exe.Name -replace '-setup\.exe$', ''
  $dest = Join-Path $outDir "$base-$label-setup.exe"
  Copy-Item $exe.FullName $dest -Force
  Write-Host "-> $dest" -ForegroundColor Green
}

# Online: default config (downloadBootstrapper) - small installer, fetches
# WebView2 at install time if missing.
Invoke-Build @()
Copy-Installer "online"

# Offline: bundles the full WebView2 installer - larger, works without internet.
Invoke-Build @("--config", "src-tauri/tauri.offline.conf.json")
Copy-Installer "offline"

Write-Host "`nDone. Installers are in dist-installers/." -ForegroundColor Green
