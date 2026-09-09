param([string]$LoomUrl, [switch]$Packaged, [switch]$Portable)
$ErrorActionPreference = 'Stop'
$taskAppRoot = $PSScriptRoot
$taskVersion = (Get-Content -LiteralPath (Join-Path $taskAppRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($taskVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Unexpected application version.' }
$taskBuildRoot = Join-Path $taskAppRoot 'dist'
$taskReleaseRoot = Join-Path $taskAppRoot ('dist-' + $taskVersion)
# A versioned release can be prepared while the previous desktop remains open.
if (Test-Path -LiteralPath (Join-Path $taskReleaseRoot 'win-unpacked\Being Desktop.exe')) { $taskBuildRoot = $taskReleaseRoot }
$taskElectron = if ($Packaged) { Join-Path $taskBuildRoot 'win-unpacked\Being Desktop.exe' } else { Join-Path $taskAppRoot 'node_modules\electron\dist\electron.exe' }
if ($Portable) {
  $taskElectron = Join-Path $taskBuildRoot ('Being-Desktop-' + $taskVersion + '-win-x64.exe')
}
if (-not (Test-Path -LiteralPath $taskElectron)) { throw 'Run npm install, or npm run pack for the packaged application.' }
$taskOldValues = @{}
$taskNames = @('BEING_LOOM_URL','BEING_DATA_DIR','ELECTRON_RUN_AS_NODE')
foreach ($taskName in $taskNames) { $taskOldValues[$taskName] = [Environment]::GetEnvironmentVariable($taskName,'Process') }
try {
  foreach ($taskName in $taskNames) { [Environment]::SetEnvironmentVariable($taskName,$null,'Process') }
  $env:BEING_DATA_DIR = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Being Desktop'
  if ($LoomUrl) { $env:BEING_LOOM_URL = $LoomUrl }
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $taskLaunchOptions = @{FilePath=$taskElectron;WorkingDirectory=$taskAppRoot;PassThru=$true;WindowStyle='Normal'}
  if (-not ($Packaged -or $Portable)) { $taskLaunchOptions.ArgumentList = '"' + $taskAppRoot + '"' }
  $taskProcess = Start-Process @taskLaunchOptions
  [pscustomobject]@{LauncherPid=$taskProcess.Id;Application='Being Desktop';DataDirectory=$env:BEING_DATA_DIR}
} finally {
  foreach ($taskName in $taskNames) { [Environment]::SetEnvironmentVariable($taskName,$taskOldValues[$taskName],'Process') }
}
