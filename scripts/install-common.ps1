# ASCII-only source for Windows PowerShell 5.1 and PowerShell 7.
function Resolve-InstallEnvironment {
  param([string]$DshCli,[string]$DshExe,[string]$DataHome,[string]$NodeExe,[string]$NpmCli,[string]$DshProfile)
  if (!$DshCli -and $DshExe) { $DshCli=Join-Path (Split-Path ([IO.Path]::GetFullPath($DshExe))) 'resources\runtime\cli\bin\dsh.cmd' }
  if (!$DshCli) { $command=Get-Command dsh.cmd -ErrorAction SilentlyContinue; if ($command) { $DshCli=$command.Source } }
  if (!$DshCli) { throw 'DSH CLI not found. Supply -DshCli, or -DshExe for a packaged desktop installation.' }
  $cli=(Resolve-Path -LiteralPath $DshCli -ErrorAction Stop).Path
  if (!$DataHome) { if ($env:DSH_HOME) { $DataHome=$env:DSH_HOME } else { $DataHome=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' } }
  $data=[IO.Path]::GetFullPath($DataHome)
  $profile=Join-Path $data ('profiles\'+$DshProfile)
  if (!(Test-Path -LiteralPath (Join-Path $profile 'package.json') -PathType Leaf)) { throw 'Profile is not initialized. Start the intended DSH profile once with this DSH_HOME, then exit it before installation.' }
  $nodeCandidates=@()
  if ($NodeExe) { $nodeCandidates=@((Resolve-Path -LiteralPath $NodeExe -ErrorAction Stop).Path) }
  else {
    $packagedRoot=[IO.Path]::GetFullPath((Join-Path (Split-Path $cli) '..\..\..\..'))
    $nodeCandidates+=Join-Path $packagedRoot 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
    $nodeCommand=Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $nodeCandidates+=$nodeCommand.Source }
  }
  $node=$null
  foreach ($candidate in $nodeCandidates) {
    if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $version=& $candidate --version
    if ($LASTEXITCODE -eq 0 -and "$version" -match '^v24\.') { $node=(Resolve-Path -LiteralPath $candidate).Path; break }
  }
  if (!$node) { throw 'Node.js 24 not found. Supply -NodeExe with a genuine Node 24 executable.' }
  if (!$NpmCli) {
    $npmCandidates=@((Join-Path (Split-Path $node) 'node_modules\npm\bin\npm-cli.js'),(Join-Path (Split-Path (Split-Path $node)) 'lib\node_modules\npm\bin\npm-cli.js'))
    $npmCommand=Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npmCommand) { $npmCandidates+=Join-Path (Split-Path $npmCommand.Source) 'node_modules\npm\bin\npm-cli.js' }
    foreach ($candidate in $npmCandidates) { if (Test-Path -LiteralPath $candidate -PathType Leaf) { $NpmCli=$candidate; break } }
  }
  if (!$NpmCli) { throw 'npm-cli.js not found. Supply -NpmCli; npm always runs through the selected Node 24.' }
  $npm=(Resolve-Path -LiteralPath $NpmCli -ErrorAction Stop).Path
  $npmVersion=& $node $npm --version
  if ($LASTEXITCODE -ne 0) { throw 'npm preflight failed.' }
  $hostVersion=& $cli --version
  if ($LASTEXITCODE -ne 0) { throw 'DSH CLI version probe failed.' }
  if ("$hostVersion".Trim() -ne '0.2.0-rc.2') { throw ('Unverified DSH host: '+"$hostVersion".Trim()+'. This release targets 0.2.0-rc.2; no host upgrade or compatibility exemption is performed.') }
  [PSCustomObject]@{DshCli=$cli;DataHome=$data;Profile=$DshProfile;ProfilePath=$profile;NodeExe=$node;NodeVersion=(& $node --version);NpmCli=$npm;NpmVersion="$npmVersion".Trim();HostVersion="$hostVersion".Trim()}
}
