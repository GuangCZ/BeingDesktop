$ErrorActionPreference = 'Stop'
$taskAppRoot = Split-Path -Parent $PSScriptRoot
$taskRunId = [guid]::NewGuid().ToString('N')
$taskRunRoot = Join-Path $taskAppRoot ('.local\reading-restore-' + $taskRunId)
$taskProfile = Join-Path $taskRunRoot 'profile'
$taskReportPath = Join-Path $taskRunRoot 'report.json'
$taskElectron = Join-Path $taskAppRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $taskElectron)) { throw 'Install the development Electron dependency before running this audit.' }
if ((Split-Path -Leaf $taskRunRoot) -notmatch '^reading-restore-[a-f0-9]{32}$') { throw 'Refusing an unexpected reading restore directory.' }
New-Item -ItemType Directory -Path $taskProfile | Out-Null
# This newly created profile contains only nonsensitive display preferences.
[IO.File]::WriteAllText((Join-Path $taskProfile 'settings.json'), '{"typography":{"chatFontSize":16,"codeFontSize":14}}')
$taskNames = @('BEING_LOOM_URL', 'BEING_DATA_DIR', 'BEING_SMOKE_REPORT', 'BEING_SMOKE_EXIT', 'BEING_SMOKE_ID', 'BEING_UI_AUDIT', 'BEING_SCENARIOS', 'ELECTRON_RUN_AS_NODE')
$taskPrevious = @{}
foreach ($taskName in $taskNames) { $taskPrevious[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process') }
try {
  foreach ($taskName in $taskNames) { Remove-Item -LiteralPath ('Env:' + $taskName) -ErrorAction SilentlyContinue }
  $env:BEING_DATA_DIR = $taskProfile
  $env:BEING_SMOKE_REPORT = $taskReportPath
  $env:BEING_SMOKE_EXIT = '1'
  $env:BEING_SMOKE_ID = $taskRunId
  $taskProcess = Start-Process -FilePath $taskElectron -ArgumentList ('"' + $taskAppRoot + '"') -WorkingDirectory $taskAppRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRunRoot 'stdout.log') -RedirectStandardError (Join-Path $taskRunRoot 'stderr.log')
  [pscustomobject]@{Phase='started';RunId=$taskRunId;Pid=$taskProcess.Id;Report=$taskReportPath;ConnectionDataCopied=$false}
  $taskDeadline = [DateTime]::UtcNow.AddSeconds(45)
  while (-not (Test-Path -LiteralPath $taskReportPath)) {
    $taskProcess.Refresh()
    if ($taskProcess.HasExited) { throw ('Reading restore audit exited without a report. RunId=' + $taskRunId) }
    if ([DateTime]::UtcNow -gt $taskDeadline) { throw ('Reading restore audit timed out; no retry or process termination was performed. RunId=' + $taskRunId) }
    Start-Sleep -Milliseconds 200
  }
  $taskReport = Get-Content -LiteralPath $taskReportPath -Raw | ConvertFrom-Json
  if ($taskReport.runId -ne $taskRunId) { throw 'Reading restore report belongs to another run.' }
  $taskSaved = (Get-Content -LiteralPath (Join-Path $taskProfile 'settings.json') -Raw | ConvertFrom-Json).typography
  $taskCode = @($taskReport.shellTypography | Where-Object selector -eq 'code')
  $taskInput = @($taskReport.shellTypography | Where-Object selector -eq 'input')
  $taskBody = @($taskReport.shellTypography | Where-Object selector -eq 'body')
  $taskChecks = @(
    [pscustomobject]@{name='saved-typography-restored';passed=($taskReport.settingsTypography.chatFontSize -eq 16 -and $taskReport.settingsTypography.codeFontSize -eq 14)}
    [pscustomobject]@{name='preferences-preserved-on-disk';passed=($taskSaved.chatFontSize -eq 16 -and $taskSaved.codeFontSize -eq 14)}
    [pscustomobject]@{name='shell-code-size-applied';passed=($taskCode.Count -eq 1 -and $taskCode[0].present -eq $true -and $taskCode[0].fontSize -eq '14px')}
    [pscustomobject]@{name='shell-input-size-unchanged';passed=($taskInput.Count -eq 1 -and $taskInput[0].present -eq $true -and $taskInput[0].fontSize -eq '14px')}
    [pscustomobject]@{name='shell-body-size-unchanged';passed=($taskBody.Count -eq 1 -and $taskBody[0].present -eq $true -and $taskBody[0].fontSize -eq '14px')}
    [pscustomobject]@{name='no-connection-configured';passed=($taskReport.connection.configured -eq $false -and $null -eq $taskReport.isolatedLoom)}
    [pscustomobject]@{name='shell-loaded';passed=($taskReport.shellLoaded -eq $true)}
    [pscustomobject]@{name='reading-ui-audit-not-run';passed=($null -eq $taskReport.uiAudit)}
  )
  $taskChecks += [pscustomobject]@{name='audit-owned-process-exited';passed=$taskProcess.WaitForExit(5000)}
  $taskSummary = [pscustomobject]@{
    RunId=$taskRunId;Pid=$taskProcess.Id;AppVersion=$taskReport.appVersion
    ProfileCreatedFresh=$true;ConnectionDataCopied=$false
    Passed=(@($taskChecks | Where-Object { -not $_.passed }).Count -eq 0)
    Checks=$taskChecks;Report=$taskReportPath
    SettingsTypography=$taskReport.settingsTypography
    ShellCodeFontSize=$taskCode[0].fontSize;ShellInputFontSize=$taskInput[0].fontSize;ShellBodyFontSize=$taskBody[0].fontSize
  }
  $taskSummary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskRunRoot 'reading-restore-result.json') -Encoding utf8
  $taskSummary
  if (-not $taskSummary.Passed) { throw ('Reading restore checks failed. RunId=' + $taskRunId) }
} finally {
  foreach ($taskName in $taskNames) {
    if ($null -eq $taskPrevious[$taskName]) { Remove-Item -LiteralPath ('Env:' + $taskName) -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($taskName, $taskPrevious[$taskName], 'Process') }
  }
}
