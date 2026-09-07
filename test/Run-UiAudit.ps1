$ErrorActionPreference = 'Stop'
$taskPreviousAudit = [Environment]::GetEnvironmentVariable('BEING_UI_AUDIT', 'Process')
try {
  $env:BEING_UI_AUDIT = '1'
  $taskResult = & (Join-Path $PSScriptRoot '..\Start.ps1') -Smoke -ExitAfterSmoke
  $taskAuditPath = Join-Path (Split-Path -Parent $taskResult.Report) 'ui-audit\report.json'
  if (-not (Test-Path -LiteralPath $taskAuditPath)) { throw 'This development build did not produce a UI audit report.' }
  $taskAudit = Get-Content -LiteralPath $taskAuditPath -Raw | ConvertFrom-Json
  [pscustomobject]@{
    Application = 'Being Desktop'
    RunId = $taskResult.RunId
    UiAuditReport = $taskAuditPath
    Passed = $taskAudit.passed
    Checks = @($taskAudit.checks).Count
    FailedChecks = @($taskAudit.checks | Where-Object { -not $_.passed } | ForEach-Object { $_.name })
    ElapsedMs = $taskAudit.elapsedMs
    Screenshots = @($taskAudit.screenshots).Count
  }
} finally {
  [Environment]::SetEnvironmentVariable('BEING_UI_AUDIT', $taskPreviousAudit, 'Process')
}
