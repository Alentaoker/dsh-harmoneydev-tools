param(
  [Parameter(Mandatory=$true)][string]$DshCli,
  [Parameter(Mandatory=$true)][string]$DataHome,
  [ValidateSet('desktop','web')][string]$DshProfile='desktop',
  [switch]$PlanOnly
)
$ErrorActionPreference='Stop'
$installRepoRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$installCliPath=(Resolve-Path -LiteralPath $DshCli).Path
$installDataRoot=[IO.Path]::GetFullPath($DataHome)
$installProfilePath=Join-Path $installDataRoot ('profiles\'+$DshProfile)
if (!(Test-Path -LiteralPath (Join-Path $installProfilePath 'package.json'))) { throw '目标 profile 尚未初始化，请先启动一次 DSH，并确认 DataHome 与启动环境一致。' }
$installPackagePaths=@((Join-Path $installRepoRoot 'plugins\dsh-harmony'),(Join-Path $installRepoRoot 'plugins\dsh-e2e'))
if ($PlanOnly) { [PSCustomObject]@{DataHome=$installDataRoot;Profile=$DshProfile;DshCli=$installCliPath;Packages=$installPackagePaths;Mutates=$false} | ConvertTo-Json; return }
$installNodeVersion=& node.exe --version
if ($LASTEXITCODE -ne 0 -or $installNodeVersion -notmatch '^v24\.') { throw '请使用 Node.js 24。' }
$installNpm=Get-Command npm.cmd -ErrorAction Stop
$env:DSH_HOME=$installDataRoot
$installBackup=Join-Path $installDataRoot ('backups\dsh-harmony-e2e-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $installBackup | Out-Null
foreach($installConfig in @('package.json','pnpm-lock.yaml','cordis.yml','cordis.patch.yml','pnpm-workspace.yaml')) { $installFile=Join-Path $installProfilePath $installConfig; if(Test-Path -LiteralPath $installFile) { Copy-Item -LiteralPath $installFile -Destination $installBackup } }
foreach($installPackage in $installPackagePaths) {
  & $installNpm.Source --prefix $installPackage ci --legacy-peer-deps
  if($LASTEXITCODE -ne 0) { throw "依赖安装失败：$installPackage；备份：$installBackup" }
  & $installNpm.Source --prefix $installPackage run build
  if($LASTEXITCODE -ne 0) { throw "构建失败：$installPackage；备份：$installBackup" }
  & $installCliPath plugin --profile $DshProfile add $installPackage
  if($LASTEXITCODE -ne 0) { throw "DSH 注册失败：$installPackage；备份：$installBackup。请检查是否部分安装，脚本不自动回滚。" }
}
& node.exe (Join-Path $PSScriptRoot 'register-bundles.mjs') (Join-Path $installProfilePath 'package.json')
if($LASTEXITCODE -ne 0) { throw "注册 bundle 失败；备份：$installBackup" }
[PSCustomObject]@{Installed=$installPackagePaths;DataHome=$installDataRoot;Profile=$DshProfile;Backup=$installBackup;Next='使用相同 DataHome 重启 DSH'} | ConvertTo-Json

