# Builds desktop\dist\ClaimHiveDemoSetup.exe on Windows (CI: windows-latest).
# Needs Node 22 on PATH, Inno Setup 6, and PostgreSQL (the GitHub Windows image has it; PGROOT points at it).
$ErrorActionPreference = "Stop"
$root = (Resolve-Path "$PSScriptRoot\..").Path
$dist = "$PSScriptRoot\dist"
$stage = "$dist\stage"
Remove-Item -Recurse -Force $dist -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null

function Invoke-Checked([string]$what, [scriptblock]$cmd) { & $cmd; if ($LASTEXITCODE -ne 0) { throw "$what failed ($LASTEXITCODE)" } }
function Copy-Tree([string]$from, [string]$to, [string[]]$excludeDirs = @(), [string[]]$excludeFiles = @()) {
  $rc = @($from, $to, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1")
  if ($excludeDirs.Count) { $rc += "/XD"; $rc += $excludeDirs }
  if ($excludeFiles.Count) { $rc += "/XF"; $rc += $excludeFiles }
  & robocopy @rc | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "copy $from failed ($LASTEXITCODE)" }
  $global:LASTEXITCODE = 0
}

# 1. Build the app (placeholders only let the tools load their config; nothing connects).
Push-Location $root
$env:NEXT_TELEMETRY_DISABLED = "1"; $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"
$env:MIGRATION_DATABASE_URL = "postgresql://build@localhost:5432/build"; $env:DATABASE_URL = $env:MIGRATION_DATABASE_URL
Invoke-Checked "npm ci" { npm ci --no-audit --no-fund }
Invoke-Checked "prisma generate" { npx prisma generate }
Invoke-Checked "next build" { npm run build }
Pop-Location

# 2. The app, without development-only folders or secrets (full paths, so nothing inside node_modules is skipped).
$skip = ".git", ".github", "tests", "infra", "desktop", "docs", ".next\cache" | ForEach-Object { Join-Path $root $_ }
Copy-Tree $root "$stage\app" $skip @(".env", "*.tsbuildinfo")

# 3. Node.js: the same node.exe the app was built with.
$node = (Get-Command node).Source
New-Item -ItemType Directory -Force "$stage\node" | Out-Null
Copy-Item $node "$stage\node\node.exe"
$nodeLicense = Join-Path (Split-Path $node) "LICENSE"
if (Test-Path $nodeLicense) { Copy-Item $nodeLicense "$stage\node\LICENSE.txt" }

# 4. PostgreSQL: server binaries only (no pgAdmin, no installer).
$pgRoot = $env:PGROOT
if (-not $pgRoot -or -not (Test-Path "$pgRoot\bin\initdb.exe")) {
  $pgRoot = (Get-ChildItem "C:\Program Files\PostgreSQL" -Directory | Sort-Object { [int]($_.Name -replace '\D.*') } -Descending | Select-Object -First 1).FullName
}
if (-not (Test-Path "$pgRoot\bin\initdb.exe")) { throw "PostgreSQL not found (set PGROOT)" }
"Bundling PostgreSQL from ${pgRoot}: $(& "$pgRoot\bin\postgres.exe" --version)"
foreach ($d in "bin", "lib", "share") { Copy-Tree "$pgRoot\$d" "$stage\pgsql\$d" }
# The Visual C++ runtime PostgreSQL needs, next to it (app-local), for PCs that don't have it yet.
foreach ($dll in "vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll") {
  if (-not (Test-Path "$stage\pgsql\bin\$dll") -and (Test-Path "$env:WINDIR\System32\$dll")) { Copy-Item "$env:WINDIR\System32\$dll" "$stage\pgsql\bin\" }
}
@"
PostgreSQL is released under the PostgreSQL License (https://www.postgresql.org/about/licence/).
Copyright (c) 1996-2026, The PostgreSQL Global Development Group
Copyright (c) 1994, The Regents of the University of California
"@ | Set-Content "$stage\pgsql\LICENSE.txt"

# 5. Launcher, then the installer.
Copy-Item "$PSScriptRoot\launcher.mjs" "$stage\launcher.mjs"
$version = (Get-Content "$root\package.json" | ConvertFrom-Json).version
$iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $iscc)) { $iscc = "$env:ProgramFiles\Inno Setup 6\ISCC.exe" }
Invoke-Checked "Inno Setup" { & $iscc "/DAppVersion=$version" "/O$dist" "$PSScriptRoot\installer\ClaimHiveDemo.iss" }
"Built $dist\ClaimHiveDemoSetup.exe ($([math]::Round((Get-Item "$dist\ClaimHiveDemoSetup.exe").Length / 1MB)) MB)"
