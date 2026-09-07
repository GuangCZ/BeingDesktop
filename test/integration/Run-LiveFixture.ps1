[CmdletBinding()]
param(
  [switch]$Start,
  [switch]$Stop,
  [switch]$Check,
  [Guid]$RunId = [Guid]::Empty,
  [ValidateRange(1,300)][int]$DurationSeconds = 300
)

$ErrorActionPreference = 'Stop'
$taskAppRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskLocalRoot = Join-Path $taskAppRoot '.local'

function Assert-PlainDirectory([string]$DirectoryPath) {
  $taskDirectory = Get-Item -LiteralPath $DirectoryPath -Force
  if (-not $taskDirectory.PSIsContainer -or ($taskDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'A fixture directory must be a real local directory.'
  }
}

function Get-OwnedProfile([Guid]$FixtureRunId) {
  $taskExpectedName = 'being-desktop-live-' + $FixtureRunId.ToString('D')
  $taskProfilePath = [IO.Path]::GetFullPath((Join-Path $taskLocalRoot $taskExpectedName))
  if ([IO.Path]::GetDirectoryName($taskProfilePath) -ne [IO.Path]::GetFullPath($taskLocalRoot) -or [IO.Path]::GetFileName($taskProfilePath) -ne $taskExpectedName) {
    throw 'Refusing a profile outside the dedicated live fixture directory.'
  }
  return $taskProfilePath
}

if (@($Start,$Stop,$Check).Where({[bool]$_}).Count -gt 1) { throw 'Choose one of -Start, -Stop, or -Check.' }
if (-not $Start -and -not $Stop -and -not $Check) {
  [pscustomobject]@{
    Prepared = $true
    PortalName = 'desktop-diagnostics-<12 hex characters from this run UUID>'
    MaximumDurationSeconds = 300
    Start = '.\test\integration\Run-LiveFixture.ps1 -Start'
    Check = '.\test\integration\Run-LiveFixture.ps1 -Check (no network connection)'
    Stop = '.\test\integration\Run-LiveFixture.ps1 -Stop -RunId <run UUID>'
    Target = 'Only the existing encrypted connection in .local\profile; no URL argument is accepted.'
  }
  return
}

Assert-PlainDirectory $taskAppRoot
Assert-PlainDirectory $taskLocalRoot

if ($Stop) {
  if ($RunId -eq [Guid]::Empty) { throw '-Stop requires the UUID returned by this launcher.' }
  $taskRunText = $RunId.ToString('D')
  $taskProfilePath = Get-OwnedProfile $RunId
  Assert-PlainDirectory $taskProfilePath
  $taskReportPath = Join-Path $taskProfilePath 'live-report.json'
  $taskControlPath = Join-Path $taskProfilePath 'control.json'
  if (-not (Test-Path -LiteralPath $taskControlPath -PathType Leaf)) {
    if (Test-Path -LiteralPath $taskReportPath -PathType Leaf) {
      $taskReport = Get-Content -LiteralPath $taskReportPath -Raw | ConvertFrom-Json
      if ($taskReport.runId -eq $taskRunText -and $taskReport.handshakeStatus -in @('stopped','error','disconnected')) {
        [pscustomobject]@{RunId=$taskRunText;Stopped=$true;Report=$taskReportPath}
        return
      }
    }
    throw 'This run has no active control endpoint. No process was terminated.'
  }
  $taskControlItem = Get-Item -LiteralPath $taskControlPath -Force
  if ($taskControlItem.Length -gt 4096 -or ($taskControlItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid fixture control file.' }
  $taskControl = Get-Content -LiteralPath $taskControlPath -Raw | ConvertFrom-Json
  $taskExpectedPipe = 'being-desktop-live-' + $taskRunText
  if ($taskControl.runId -ne $taskRunText -or $taskControl.pipeName -ne $taskExpectedPipe -or $taskControl.capability -notmatch '^[a-f0-9]{64}$') {
    throw 'Control metadata does not belong to this fixture run. No process was terminated.'
  }
  $taskPipe = [IO.Pipes.NamedPipeClientStream]::new('.', $taskExpectedPipe, [IO.Pipes.PipeDirection]::InOut)
  $taskReader = $null
  $taskWriter = $null
  try {
    $taskPipe.Connect(3000)
    $taskWriter = [IO.StreamWriter]::new($taskPipe, [Text.UTF8Encoding]::new($false), 1024, $true)
    $taskReader = [IO.StreamReader]::new($taskPipe, [Text.UTF8Encoding]::new($false), $false, 1024, $true)
    $taskWriter.AutoFlush = $true
    $taskMessage = @{action='stop';runId=$taskRunText;capability=$taskControl.capability} | ConvertTo-Json -Compress
    $taskWriter.WriteLine($taskMessage)
    $taskRead = $taskReader.ReadLineAsync()
    if (-not $taskRead.Wait(5000)) { throw 'The fixture did not acknowledge stop. No process was force-terminated.' }
    $taskReply = $taskRead.Result | ConvertFrom-Json
    if ($taskReply.runId -ne $taskRunText -or $taskReply.stopped -ne $true) { throw 'Fixture stop was not confirmed.' }
    [pscustomobject]@{RunId=$taskRunText;Stopped=$true;Report=$taskReportPath}
  } finally {
    if ($taskReader) { $taskReader.Dispose() }
    if ($taskWriter) { $taskWriter.Dispose() }
    $taskPipe.Dispose()
    $taskMessage = $null
    $taskControl = $null
  }
  return
}

if ($RunId -ne [Guid]::Empty) { throw 'A new -Start or -Check always creates its own UUID; -RunId is only for -Stop.' }
$taskElectronPath = Join-Path $taskAppRoot 'node_modules\electron\dist\electron.exe'
$taskRunnerPath = Join-Path $PSScriptRoot 'run-live-fixture.cjs'
$taskSourceProfile = Join-Path $taskLocalRoot 'profile'
Assert-PlainDirectory $taskSourceProfile
foreach ($taskRequiredPath in @($taskElectronPath,$taskRunnerPath,(Join-Path $taskSourceProfile 'settings.json'),(Join-Path $taskSourceProfile 'Local State'))) {
  $taskRequiredItem = Get-Item -LiteralPath $taskRequiredPath -Force
  if ($taskRequiredItem.PSIsContainer -or ($taskRequiredItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'A required fixture input is not a regular file.' }
}
$taskRunId = [Guid]::NewGuid()
$taskRunText = $taskRunId.ToString('D')
$taskProfilePath = Get-OwnedProfile $taskRunId
New-Item -ItemType Directory -Path $taskProfilePath | Out-Null
Copy-Item -LiteralPath (Join-Path $taskSourceProfile 'settings.json') -Destination (Join-Path $taskProfilePath 'settings.json')
Copy-Item -LiteralPath (Join-Path $taskSourceProfile 'Local State') -Destination (Join-Path $taskProfilePath 'Local State')

$taskEnvironmentNames = @('BEING_LIVE_START','BEING_LIVE_CHECK','BEING_LIVE_RUN_ID','BEING_LIVE_DURATION_SECONDS','BEING_LOOM_URL','BEING_DATA_DIR','BEING_SCENARIOS','BEING_SMOKE_REPORT','BEING_SMOKE_EXIT','ELECTRON_RUN_AS_NODE','ELECTRON_ENABLE_LOGGING','ELECTRON_LOG_FILE','CHROME_LOG_FILE','NODE_OPTIONS')
$taskOldEnvironment = @{}
foreach ($taskName in $taskEnvironmentNames) { $taskOldEnvironment[$taskName] = [Environment]::GetEnvironmentVariable($taskName,'Process') }
try {
  foreach ($taskName in $taskEnvironmentNames) { [Environment]::SetEnvironmentVariable($taskName,$null,'Process') }
  if ($Check) { $env:BEING_LIVE_CHECK = '1' } else { $env:BEING_LIVE_START = '1' }
  $env:BEING_LIVE_RUN_ID = $taskRunText
  $env:BEING_LIVE_DURATION_SECONDS = [string]$DurationSeconds
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $taskProcess = Start-Process -FilePath $taskElectronPath -ArgumentList @('--disable-logging',('"' + $taskRunnerPath + '"')) -WorkingDirectory $taskAppRoot -WindowStyle Hidden -PassThru
  $taskOutputName = if ($Check) { 'check-report.json' } else { 'control.json' }
  $taskControlPath = Join-Path $taskProfilePath $taskOutputName
  $taskDeadline = [DateTime]::UtcNow.AddSeconds(12)
  $taskWatcher = [IO.FileSystemWatcher]::new($taskProfilePath, $taskOutputName)
  try {
    while (-not (Test-Path -LiteralPath $taskControlPath -PathType Leaf)) {
      if ($taskProcess.HasExited) { throw 'The fixture stopped during startup; inspect its fixed-field live-report.json.' }
      if ([DateTime]::UtcNow -gt $taskDeadline) { throw 'No control endpoint appeared. The bounded fixture will expire automatically; no process was force-terminated.' }
      $null = $taskWatcher.WaitForChanged([IO.WatcherChangeTypes]::All, 1000)
    }
  } finally { $taskWatcher.Dispose() }
  if ($Check) {
    $taskCheckReport = Get-Content -LiteralPath $taskControlPath -Raw | ConvertFrom-Json
    if ($taskCheckReport.runId -ne $taskRunText -or $taskCheckReport.checkOnly -ne $true -or $taskCheckReport.connectionAttempted -ne $false) { throw 'Invalid no-network check report.' }
    $taskCheckReport
    if ($taskCheckReport.passed -ne $true) { throw 'The no-network check failed; no external connection was attempted.' }
  } else {
    $taskPortalName = 'desktop-diagnostics-' + $taskRunId.ToString('N').Substring(0,12)
    [pscustomobject]@{RunId=$taskRunText;Launched=$true;PortalName=$taskPortalName;DurationSeconds=$DurationSeconds;Report=(Join-Path $taskProfilePath 'live-report.json')}
  }
} finally {
  foreach ($taskName in $taskEnvironmentNames) { [Environment]::SetEnvironmentVariable($taskName,$taskOldEnvironment[$taskName],'Process') }
}
