$ErrorActionPreference = 'Stop'
$taskAppRoot = Split-Path -Parent $PSScriptRoot
$taskRunId = [guid]::NewGuid().ToString('N')
$taskRunRoot = Join-Path $taskAppRoot ('.local\ui-onboarding-' + $taskRunId)
$taskProfile = Join-Path $taskRunRoot 'profile'
$taskReportPath = Join-Path $taskRunRoot 'report.json'
$taskElectron = Join-Path $taskAppRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $taskElectron)) { throw 'Install the development Electron dependency before running this audit.' }
New-Item -ItemType Directory -Path $taskProfile | Out-Null
$taskNames = @('BEING_LOOM_URL', 'BEING_DATA_DIR', 'BEING_SMOKE_REPORT', 'BEING_SMOKE_EXIT', 'BEING_SMOKE_ID', 'BEING_UI_AUDIT', 'BEING_SCENARIOS', 'ELECTRON_RUN_AS_NODE')
$taskPrevious = @{}
foreach ($taskName in $taskNames) { $taskPrevious[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process') }
try {
  foreach ($taskName in $taskNames) { [Environment]::SetEnvironmentVariable($taskName, $null, 'Process') }
  $env:BEING_DATA_DIR = $taskProfile
  $env:BEING_SMOKE_REPORT = $taskReportPath
  $env:BEING_SMOKE_EXIT = '1'
  $env:BEING_SMOKE_ID = $taskRunId
  $env:BEING_UI_AUDIT = '1'
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  # The profile starts empty. No credentials, settings, or encryption state are copied.
  $taskProcess = Start-Process -FilePath $taskElectron -ArgumentList ('"' + $taskAppRoot + '"') -WorkingDirectory $taskAppRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRunRoot 'stdout.log') -RedirectStandardError (Join-Path $taskRunRoot 'stderr.log')
  [pscustomobject]@{Phase='started';RunId=$taskRunId;Pid=$taskProcess.Id;Report=$taskReportPath;ProfileStartedEmpty=$true}
  $taskDeadline = [DateTime]::UtcNow.AddSeconds(55)
  while (-not (Test-Path -LiteralPath $taskReportPath)) {
    $taskProcess.Refresh()
    if ($taskProcess.HasExited) { throw ('Onboarding audit exited without a report. RunId=' + $taskRunId + '; PID=' + $taskProcess.Id) }
    if ([DateTime]::UtcNow -gt $taskDeadline) {
      throw ('Onboarding audit timed out; no retry or process termination was performed. RunId=' + $taskRunId + '; PID=' + $taskProcess.Id + '; Report=' + $taskReportPath)
    }
    Start-Sleep -Milliseconds 200
  }
  $taskReport = Get-Content -LiteralPath $taskReportPath -Raw | ConvertFrom-Json
  if ($taskReport.runId -ne $taskRunId) { throw 'Onboarding audit report belongs to another run.' }
  $taskAudit = $taskReport.uiAudit
  $taskInitial = $taskAudit.observations | Where-Object phase -eq '01-chat-1440' | Select-Object -First 1
  $taskOnboardingChecks = @($taskAudit.checks | Where-Object name -like '*.onboarding-form-ready')
  $taskChecks = @(
    [pscustomobject]@{name='empty-profile-unconfigured';passed=($taskReport.connection.configured -eq $false)}
    [pscustomobject]@{name='empty-profile-no-native-loom';passed=($null -eq $taskReport.isolatedLoom -and $taskInitial.native.exists -eq $false)}
    [pscustomobject]@{name='onboarding-initial-mode';passed=($taskAudit.initialMode -eq 'onboarding')}
    [pscustomobject]@{name='onboarding-form-observed';passed=($taskOnboardingChecks.Count -gt 0 -and @($taskOnboardingChecks | Where-Object { -not $_.passed }).Count -eq 0)}
    [pscustomobject]@{name='ui-audit-passed';passed=($taskAudit.passed -eq $true)}
  )
  $taskExited = $taskProcess.WaitForExit(5000)
  $taskChecks += [pscustomobject]@{name='audit-owned-process-exited';passed=$taskExited}
  $taskSummary = [pscustomobject]@{
    RunId=$taskRunId;Pid=$taskProcess.Id;AppVersion=$taskReport.appVersion
    ProfileStartedEmpty=$true;SettingsCopied=$false;RemoteConnectionConfigured=$taskReport.connection.configured
    Passed=(@($taskChecks | Where-Object { -not $_.passed }).Count -eq 0)
    Checks=$taskChecks;UiChecks=@($taskAudit.checks).Count
    UiFailedChecks=@($taskAudit.checks | Where-Object { -not $_.passed } | ForEach-Object name)
    ElapsedMs=$taskAudit.elapsedMs;Report=$taskReportPath
    UiAuditReport=(Join-Path $taskRunRoot 'ui-audit\report.json')
    OnboardingScreenshot=(Join-Path $taskRunRoot 'ui-audit\01-chat-1440.shell.png')
    NarrowScreenshot=(Join-Path $taskRunRoot 'ui-audit\09-chat-1000.shell.png')
    Screenshots=@($taskAudit.screenshots).Count
  }
  $taskSummary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskRunRoot 'onboarding-result.json') -Encoding utf8
  $taskSummary
} finally {
  foreach ($taskName in $taskNames) { [Environment]::SetEnvironmentVariable($taskName, $taskPrevious[$taskName], 'Process') }
}
