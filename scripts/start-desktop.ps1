param(
  [Parameter(Mandatory=$true)][string]$DshExe,
  [Parameter(Mandatory=$true)][string]$DataHome,
  [string]$E2ENode
)
$ErrorActionPreference='Stop'
$launchDshExe=(Resolve-Path -LiteralPath $DshExe).Path
$launchDataRoot=[IO.Path]::GetFullPath($DataHome)
if(!(Test-Path -LiteralPath $launchDataRoot -PathType Container)) { throw 'DataHome 不存在，请核对目标数据目录。' }
$env:DSH_HOME=$launchDataRoot
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
if($E2ENode) { $env:DSH_E2E_NODE_PATH=(Resolve-Path -LiteralPath $E2ENode).Path }
Start-Process -FilePath $launchDshExe -WorkingDirectory (Split-Path -Parent $launchDshExe)

