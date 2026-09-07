param([string]$LoomUrl, [switch]$Smoke, [switch]$ExitAfterSmoke, [switch]$Packaged, [switch]$Portable)
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
$taskLocal = Join-Path $taskAppRoot '.local'
New-Item -ItemType Directory -Path $taskLocal -Force | Out-Null
$taskOldValues = @{}
$taskNames = @('BEING_LOOM_URL','BEING_DATA_DIR','BEING_SMOKE_REPORT','BEING_SMOKE_EXIT','BEING_SMOKE_ID','ELECTRON_RUN_AS_NODE')
foreach ($taskName in $taskNames) { $taskOldValues[$taskName] = [Environment]::GetEnvironmentVariable($taskName,'Process') }
try {
  foreach ($taskName in $taskNames) { [Environment]::SetEnvironmentVariable($taskName,$null,'Process') }
  $env:BEING_DATA_DIR = Join-Path $taskLocal 'profile'
  if ($LoomUrl) { $env:BEING_LOOM_URL = $LoomUrl }
  if ($Smoke) {
    $env:BEING_SMOKE_ID = [guid]::NewGuid().ToString('N')
    $taskSmokeRoot = Join-Path $taskLocal ('smoke-' + $env:BEING_SMOKE_ID)
    $taskProfile = Join-Path $taskSmokeRoot 'profile'
    New-Item -ItemType Directory -Path $taskProfile -Force | Out-Null
    $taskSettings = Join-Path $env:BEING_DATA_DIR 'settings.json'
    if (Test-Path -LiteralPath $taskSettings) { Copy-Item -LiteralPath $taskSettings -Destination (Join-Path $taskProfile 'settings.json') }
    $taskEncryptionState = Join-Path $env:BEING_DATA_DIR 'Local State'
    if (Test-Path -LiteralPath $taskEncryptionState) { Copy-Item -LiteralPath $taskEncryptionState -Destination (Join-Path $taskProfile 'Local State') }
    $env:BEING_DATA_DIR = $taskProfile
    $env:BEING_SMOKE_REPORT = Join-Path $taskSmokeRoot 'report.json'
  }
  if ($ExitAfterSmoke) { $env:BEING_SMOKE_EXIT = '1' }
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $taskLaunchOptions = @{FilePath=$taskElectron;WorkingDirectory=$taskAppRoot;PassThru=$true;WindowStyle='Normal'}
  if (-not ($Packaged -or $Portable)) { $taskLaunchOptions.ArgumentList = '"' + $taskAppRoot + '"' }
  if ($Smoke) {
    $taskLaunchOptions.WindowStyle='Hidden'
    $taskLaunchOptions.RedirectStandardOutput=Join-Path $taskSmokeRoot 'stdout.log'
    $taskLaunchOptions.RedirectStandardError=Join-Path $taskSmokeRoot 'stderr.log'
  }
  $taskProcess = Start-Process @taskLaunchOptions
  if ($Smoke) {
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(55)
    while (-not (Test-Path -LiteralPath $env:BEING_SMOKE_REPORT)) {
      if ($taskProcess.HasExited) { throw 'Application exited without a new smoke report.' }
      if ([DateTime]::UtcNow -gt $taskDeadline) { throw 'Smoke report was not produced within 55 seconds.' }
      Start-Sleep -Milliseconds 200
    }
    $taskReport = Get-Content -LiteralPath $env:BEING_SMOKE_REPORT -Raw | ConvertFrom-Json
    if ($taskReport.runId -ne $env:BEING_SMOKE_ID) { throw 'Smoke report does not belong to this run.' }
    [pscustomobject]@{Application='Being Desktop';RunId=$taskReport.runId;Report=$env:BEING_SMOKE_REPORT;ShellLoaded=$taskReport.shellLoaded;Configured=$taskReport.connection.configured;Model=$taskReport.runtime.model}
  } else {
    [pscustomobject]@{LauncherPid=$taskProcess.Id;Application='Being Desktop';DataDirectory=$env:BEING_DATA_DIR}
  }
} finally {
  foreach ($taskName in $taskNames) { [Environment]::SetEnvironmentVariable($taskName,$taskOldValues[$taskName],'Process') }
}
