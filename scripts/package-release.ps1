param([Parameter(Mandatory=$true)][string]$NodeExe,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$releaseNode=(Resolve-Path -LiteralPath $NodeExe).Path
$releaseVersion=& $releaseNode --version
if ($LASTEXITCODE -ne 0 -or "$releaseVersion" -notmatch '^v24\.') { throw 'Node 24 is required.' }
$releaseOutput=[IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $releaseOutput -Force | Out-Null
$releaseRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$releaseHarmony=Get-Content -LiteralPath (Join-Path $releaseRoot 'plugin\dsh-harmony\package.json') -Raw | ConvertFrom-Json
$releaseE2E=Get-Content -LiteralPath (Join-Path $releaseRoot 'plugin\dsh-e2e\package.json') -Raw | ConvertFrom-Json
$releaseName='dsh-harmony-'+$releaseHarmony.version+'-e2e-'+$releaseE2E.version+'-windows-source'
$releaseStage=Join-Path $releaseOutput $releaseName
$releaseZip=Join-Path $releaseOutput ($releaseName+'.zip')
if (Test-Path -LiteralPath $releaseZip) { throw 'Release ZIP already exists. Use a new output directory; no overwrite is performed.' }
& $releaseNode (Join-Path $PSScriptRoot 'prepare-release.mjs') $releaseStage
if ($LASTEXITCODE -ne 0) { throw 'Release staging failed.' }
& $releaseNode (Join-Path $releaseStage 'scripts\preflight.mjs') $releaseStage
if ($LASTEXITCODE -ne 0) { throw 'Release manifest verification failed.' }
Compress-Archive -LiteralPath $releaseStage -DestinationPath $releaseZip
$releaseHash=(Get-FileHash -LiteralPath $releaseZip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($releaseZip+'.sha256', $releaseHash+'  '+[IO.Path]::GetFileName($releaseZip)+[Environment]::NewLine, (New-Object Text.UTF8Encoding $false))
[PSCustomObject]@{Archive=$releaseZip;Sha256=$releaseHash;Stage=$releaseStage} | ConvertTo-Json
