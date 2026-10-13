param([string]$DshCli,[string]$DshExe,[string]$DataHome,[ValidateSet('desktop','web')][string]$DshProfile='desktop',[string]$NodeExe,[string]$NpmCli,[switch]$PlanOnly)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'install-common.ps1')
$installRepoRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$installEnvironment=Resolve-InstallEnvironment -DshCli $DshCli -DshExe $DshExe -DataHome $DataHome -NodeExe $NodeExe -NpmCli $NpmCli -DshProfile $DshProfile
& $installEnvironment.NodeExe (Join-Path $PSScriptRoot 'preflight.mjs') $installRepoRoot $installEnvironment.ProfilePath
if ($LASTEXITCODE -ne 0) { throw 'Package/profile preflight failed. No installation has been performed.' }
$installPackagePaths=@((Join-Path $installRepoRoot 'plugins\dsh-harmony'),(Join-Path $installRepoRoot 'plugins\dsh-e2e'))
if ($PlanOnly) { $installEnvironment | Add-Member NoteProperty Packages $installPackagePaths; $installEnvironment | Add-Member NoteProperty Mutates $false; $installEnvironment | ConvertTo-Json -Depth 4; return }
$installPreviousPath=$env:PATH
$installPreviousDataHome=$env:DSH_HOME
$installPreviousTelemetry=$env:E2E_TELEMETRY_DISABLED
$env:PATH=(Split-Path $installEnvironment.NodeExe)+[IO.Path]::PathSeparator+$env:PATH
$env:DSH_HOME=$installEnvironment.DataHome
$env:E2E_TELEMETRY_DISABLED='1'
try {
  $installBackup=Join-Path $installEnvironment.DataHome ('backups\dsh-harmony-e2e-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
  New-Item -ItemType Directory -Path $installBackup | Out-Null
  foreach ($installConfig in @('package.json','pnpm-lock.yaml','cordis.yml','cordis.patch.yml','pnpm-workspace.yaml','compatibility.json')) {
    $installFile=Join-Path $installEnvironment.ProfilePath $installConfig
    if (Test-Path -LiteralPath $installFile -PathType Leaf) { Copy-Item -LiteralPath $installFile -Destination $installBackup }
  }
  # Build both packages before registering either, reducing partial profile updates.
  foreach ($installPackage in $installPackagePaths) {
    & $installEnvironment.NodeExe $installEnvironment.NpmCli --prefix $installPackage ci --legacy-peer-deps
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed: $installPackage. Backup: $installBackup" }
    & $installEnvironment.NodeExe $installEnvironment.NpmCli --prefix $installPackage run build
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $installPackage. Backup: $installBackup" }
  }
  foreach ($installPackage in $installPackagePaths) {
    & $installEnvironment.DshCli plugin --profile $DshProfile add $installPackage
    if ($LASTEXITCODE -ne 0) { throw "DSH registration failed: $installPackage. Backup: $installBackup. Stop and inspect partial changes; no automatic rollback is performed." }
  }
  & $installEnvironment.NodeExe (Join-Path $PSScriptRoot 'register-bundles.mjs') (Join-Path $installEnvironment.ProfilePath 'package.json')
  if ($LASTEXITCODE -ne 0) { throw "Bundle registration failed. Backup: $installBackup" }
  & $installEnvironment.NodeExe (Join-Path $PSScriptRoot 'verify-install.mjs') $installEnvironment.ProfilePath
  if ($LASTEXITCODE -ne 0) { throw "Installed package verification failed. Backup: $installBackup" }
  [PSCustomObject]@{Installed=$installPackagePaths;DataHome=$installEnvironment.DataHome;Profile=$DshProfile;Backup=$installBackup;Next='Cold-start DSH with the same DataHome; validate runtime and device separately.'} | ConvertTo-Json
} finally { $env:PATH=$installPreviousPath; $env:DSH_HOME=$installPreviousDataHome; $env:E2E_TELEMETRY_DISABLED=$installPreviousTelemetry }
