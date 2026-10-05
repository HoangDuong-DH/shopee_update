param(
  [ValidateSet('setup','start','stop')][string]$Action = 'setup',
  [Parameter(ValueFromRemainingArguments=$true)][string[]]$AdditionalArguments
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $taskRoot
function Test-NodeVersion([string]$Executable) {
  try {
    $taskVersionText = & $Executable --version 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    $taskNodeVersion = [version]($taskVersionText.Trim().TrimStart('v'))
    return ($taskNodeVersion.Major -eq 24 -and $taskNodeVersion -ge [version]'24.20.0')
  } catch { return $false }
}
function Assert-SetupDiskSpace([string]$CheckoutPath, [long]$MinimumBytes = 1GB) {
  if ($MinimumBytes -lt 0) { throw 'Installer disk space budget is invalid.' }
  $taskDiskRoot = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($CheckoutPath))
  $taskDiskDrive = [IO.DriveInfo]::new($taskDiskRoot)
  if (!$taskDiskDrive.IsReady) { throw 'Cannot verify free space on the checkout drive before setup.' }
  $taskAvailableBytes = $taskDiskDrive.AvailableFreeSpace
  if ($taskAvailableBytes -lt $MinimumBytes) {
    throw ('Setup needs at least {0:N0} MiB of free space on the checkout drive; available: {1:N0} MiB. Free space or use another writable checkout before setup.' -f [math]::Ceiling($MinimumBytes / 1MB), [math]::Floor($taskAvailableBytes / 1MB))
  }
}
function Assert-RuntimeAncestors([string]$Path) {
  $taskAncestor = [IO.Path]::GetFullPath($Path)
  while ($taskAncestor) {
    if (Test-Path -LiteralPath $taskAncestor) {
      $taskAncestorItem = Get-Item -LiteralPath $taskAncestor -Force
      if ($taskAncestorItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime ancestor links are not allowed.' }
    }
    $taskParent = [IO.Path]::GetDirectoryName($taskAncestor)
    if ($taskParent -eq $taskAncestor) { break }
    $taskAncestor = $taskParent
  }
}
try {
  if ($Action -eq 'setup') { Assert-SetupDiskSpace $taskRoot }
  Assert-RuntimeAncestors (Join-Path $taskRoot '.local/runtime')
  $taskPinnedVersion = (Get-Content -LiteralPath (Join-Path $taskRoot '.node-version') -Raw).Trim()
  if ($taskPinnedVersion -notmatch '^24\.\d+\.\d+$') { throw 'Invalid pinned Node version.' }
  $taskArchitecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $taskNodeFolder = 'node-v' + $taskPinnedVersion + '-win-' + $taskArchitecture
  $taskRuntimeRoot = Join-Path $taskRoot '.local/runtime'
  $taskNodePath = Join-Path (Join-Path $taskRuntimeRoot $taskNodeFolder) 'node.exe'
  if (!(Test-NodeVersion $taskNodePath)) {
    $taskInstalledNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($taskInstalledNode -and (Test-NodeVersion $taskInstalledNode.Source)) {
      $taskNodePath = $taskInstalledNode.Source
    } elseif ($Action -ne 'setup') {
      throw 'Node 24.20+ is missing. Run SETUP_LISTINGSTUDIO.cmd first.'
    } else {
      Write-Host 'Downloading the pinned Node runtime from nodejs.org...'
      $taskRuntimeAbsolute = [IO.Path]::GetFullPath($taskRuntimeRoot)
      if (!$taskRuntimeAbsolute.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime path outside checkout.' }
      if (Test-Path -LiteralPath $taskRuntimeRoot) {
        $taskRuntimeItem = Get-Item -LiteralPath $taskRuntimeRoot -Force
        if ($taskRuntimeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime links are not allowed.' }
      }
      New-Item -ItemType Directory -Force -Path $taskRuntimeRoot | Out-Null
      $taskDownloadRoot = Join-Path $taskRuntimeRoot ('download-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $taskDownloadRoot | Out-Null
      $taskArchiveName = $taskNodeFolder + '.zip'
      $taskOfficialOrigin = 'https://nodejs.org/dist/v' + $taskPinnedVersion + '/'
      $taskChecksums = (Invoke-WebRequest -Uri ($taskOfficialOrigin + 'SHASUMS256.txt') -UseBasicParsing -TimeoutSec 45).Content
      $taskChecksumMatches = @($taskChecksums -split '\r?\n' | Where-Object { $_ -match ('^[a-fA-F0-9]{64}\s+' + [regex]::Escape($taskArchiveName) + '$') })
      if ($taskChecksumMatches.Count -ne 1) { throw 'Official checksum for this Node archive was not found.' }
      $taskExpectedHash = ($taskChecksumMatches[0] -split '\s+')[0]
      $taskArchivePath = Join-Path $taskDownloadRoot $taskArchiveName
      Invoke-WebRequest -Uri ($taskOfficialOrigin + $taskArchiveName) -OutFile $taskArchivePath -UseBasicParsing -TimeoutSec 300
      if ((Get-FileHash -LiteralPath $taskArchivePath -Algorithm SHA256).Hash -ne $taskExpectedHash) { throw 'Node checksum mismatch; downloaded runtime was not used.' }
      Assert-SetupDiskSpace $taskRoot
      Expand-Archive -LiteralPath $taskArchivePath -DestinationPath $taskDownloadRoot
      $taskExpandedNode = Join-Path (Join-Path $taskDownloadRoot $taskNodeFolder) 'node.exe'
      if (!(Test-NodeVersion $taskExpandedNode)) { throw 'Downloaded runtime failed the version check.' }
      $taskDestination = [IO.Path]::GetFullPath((Join-Path $taskRuntimeRoot $taskNodeFolder))
      if (!$taskDestination.StartsWith($taskRuntimeAbsolute + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid runtime destination.' }
      if (Test-Path -LiteralPath $taskDestination) { throw 'Existing runtime is invalid; retain it and ask the maintainer to inspect it.' }
      Move-Item -LiteralPath (Join-Path $taskDownloadRoot $taskNodeFolder) -Destination $taskDestination
      $taskNodePath = Join-Path $taskDestination 'node.exe'
      Remove-Item -LiteralPath $taskArchivePath
      Remove-Item -LiteralPath $taskDownloadRoot
    }
  }
  $env:PATH = (Split-Path -Parent $taskNodePath) + [IO.Path]::PathSeparator + $env:PATH
  if ($Action -eq 'setup') {
    & $taskNodePath (Join-Path $taskRoot 'scripts/bootstrap.mjs') --apply @AdditionalArguments
  } else {
    & $taskNodePath (Join-Path $taskRoot 'scripts/local-launcher.mjs') $Action @AdditionalArguments
  }
  exit $LASTEXITCODE
} catch {
  Write-Host ('Setup/start could not continue: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host 'Read docs/onboarding/START_HERE.md. Existing configuration and data were retained.'
  exit 1
}
