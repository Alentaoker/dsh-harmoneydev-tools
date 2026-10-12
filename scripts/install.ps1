param(
  [Parameter(Mandatory=$true)][string]$DshCli,
  [Parameter(Mandatory=$true)][string]$DataHome,
  [ValidateSet('desktop','web')][string]$DshProfile='desktop',
  [string]$NodeExe,
  [string]$NpmCli,
  [switch]$PlanOnly
)
$ErrorActionPreference='Stop'
$installRepoRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$installCliPath=(Resolve-Path -LiteralPath $DshCli).Path
$installDataRoot=[IO.Path]::GetFullPath($DataHome)
$installProfilePath=Join-Path $installDataRoot ('profiles\'+$DshProfile)
if (!(Test-Path -LiteralPath (Join-Path $installProfilePath 'package.json'))) { throw '目标 profile 尚未初始化，请先启动一次 DSH，并确认 DataHome 与启动环境一致。' }
$installPackagePaths=@((Join-Path $installRepoRoot 'plugins\dsh-harmony'),(Join-Path $installRepoRoot 'plugins\dsh-e2e'))
if (!$NodeExe) { $NodeExe=(Get-Command node.exe -ErrorAction Stop).Source }
$installNodePath=(Resolve-Path -LiteralPath $NodeExe).Path
if (!$NpmCli) {
  $installNpmCommand=(Get-Command npm.cmd -ErrorAction Stop).Source
  $NpmCli=Join-Path (Split-Path $installNpmCommand) 'node_modules\npm\bin\npm-cli.js'
}
$installNpmPath=(Resolve-Path -LiteralPath $NpmCli).Path
if ($PlanOnly) { [PSCustomObject]@{DataHome=$installDataRoot;Profile=$DshProfile;DshCli=$installCliPath;NodeExe=$installNodePath;NpmCli=$installNpmPath;Packages=$installPackagePaths;Mutates=$false} | ConvertTo-Json; return }
$installNodeVersion=& $installNodePath --version
if ($LASTEXITCODE -ne 0 -or $installNodeVersion -notmatch '^v24\.') { throw '请使用 Node.js 24。' }
$installPreviousPath=$env:PATH
$installPreviousDataHome=$env:DSH_HOME
$env:PATH=(Split-Path $installNodePath)+[IO.Path]::PathSeparator+$env:PATH
$env:DSH_HOME=$installDataRoot
try {
$installBackup=Join-Path $installDataRoot ('backups\dsh-harmony-e2e-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $installBackup | Out-Null
foreach($installConfig in @('package.json','pnpm-lock.yaml','cordis.yml','cordis.patch.yml','pnpm-workspace.yaml')) { $installFile=Join-Path $installProfilePath $installConfig; if(Test-Path -LiteralPath $installFile) { Copy-Item -LiteralPath $installFile -Destination $installBackup } }
foreach($installPackage in $installPackagePaths) {
  & $installNodePath $installNpmPath --prefix $installPackage ci --legacy-peer-deps
  if($LASTEXITCODE -ne 0) { throw "依赖安装失败：$installPackage；备份：$installBackup" }
  & $installNodePath $installNpmPath --prefix $installPackage run build
  if($LASTEXITCODE -ne 0) { throw "构建失败：$installPackage；备份：$installBackup" }
  & $installCliPath plugin --profile $DshProfile add $installPackage
  if($LASTEXITCODE -ne 0) { throw "DSH 注册失败：$installPackage；备份：$installBackup。请检查是否部分安装，脚本不自动回滚。" }
}
& $installNodePath (Join-Path $PSScriptRoot 'register-bundles.mjs') (Join-Path $installProfilePath 'package.json')
if($LASTEXITCODE -ne 0) { throw "注册 bundle 失败；备份：$installBackup" }
[PSCustomObject]@{Installed=$installPackagePaths;DataHome=$installDataRoot;Profile=$DshProfile;Backup=$installBackup;Next='使用相同 DataHome 重启 DSH'} | ConvertTo-Json
} finally { $env:PATH=$installPreviousPath; $env:DSH_HOME=$installPreviousDataHome }

