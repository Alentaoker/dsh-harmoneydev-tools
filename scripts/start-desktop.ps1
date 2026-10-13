param(
  [Parameter(Mandatory=$true)][string]$DshExe,
  [Parameter(Mandatory=$true)][string]$DataHome,
  [string]$E2ENode
)
$ErrorActionPreference='Stop'
$launchDshExe=(Resolve-Path -LiteralPath $DshExe).Path
$launchDataRoot=[IO.Path]::GetFullPath($DataHome)
if(!(Test-Path -LiteralPath $launchDataRoot -PathType Container)) { throw 'DataHome does not exist.' }
if(!$E2ENode) { $E2ENode=Join-Path (Split-Path $launchDshExe) 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe' }
$launchNode=(Resolve-Path -LiteralPath $E2ENode).Path
$launchVersion=& $launchNode --version
if($LASTEXITCODE -ne 0 -or "$launchVersion" -notmatch '^v24\.') { throw 'The E2E runtime must be Node 24. Supply -E2ENode for nonstandard layouts.' }
$launchPreviousHome=$env:DSH_HOME
$launchPreviousNode=$env:DSH_E2E_NODE_PATH
$launchPreviousElectron=$env:ELECTRON_RUN_AS_NODE
try {
  $env:DSH_HOME=$launchDataRoot
  $env:DSH_E2E_NODE_PATH=$launchNode
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Start-Process -FilePath $launchDshExe -WorkingDirectory (Split-Path -Parent $launchDshExe)
} finally { $env:DSH_HOME=$launchPreviousHome; $env:DSH_E2E_NODE_PATH=$launchPreviousNode; $env:ELECTRON_RUN_AS_NODE=$launchPreviousElectron }

