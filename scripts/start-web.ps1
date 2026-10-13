param([Parameter(Mandatory=$true)][string]$DshCli,[Parameter(Mandatory=$true)][string]$DataHome,[Parameter(Mandatory=$true)][string]$NodeExe)
$ErrorActionPreference='Stop'
$launchCli=(Resolve-Path -LiteralPath $DshCli).Path
$launchNode=(Resolve-Path -LiteralPath $NodeExe).Path
$launchData=[IO.Path]::GetFullPath($DataHome)
if (!(Test-Path -LiteralPath (Join-Path $launchData 'profiles\web\package.json'))) { throw 'The web profile has not been initialized.' }
$launchVersion=& $launchNode --version
if ($LASTEXITCODE -ne 0 -or "$launchVersion" -notmatch '^v24\.') { throw 'Node 24 is required.' }
$launchPreviousHome=$env:DSH_HOME
$launchPreviousNode=$env:DSH_E2E_NODE_PATH
$launchPreviousPath=$env:PATH
try {
  $env:DSH_HOME=$launchData; $env:DSH_E2E_NODE_PATH=$launchNode
  $env:PATH=(Split-Path $launchNode)+[IO.Path]::PathSeparator+$env:PATH
  & $launchCli web
  if ($LASTEXITCODE -ne 0) { throw ('DSH web exited with '+$LASTEXITCODE) }
} finally { $env:DSH_HOME=$launchPreviousHome; $env:DSH_E2E_NODE_PATH=$launchPreviousNode; $env:PATH=$launchPreviousPath }
