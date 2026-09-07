$ErrorActionPreference = 'Stop'
$taskProject = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskRunId = [Guid]::NewGuid().ToString('N')
$taskReportDir = Join-Path $taskProject ('.local\portal-deployment-integration-' + $taskRunId)
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskStart = [System.Diagnostics.ProcessStartInfo]::new()
$taskStart.FileName = $taskNode
$taskStart.ArgumentList.Add((Join-Path $PSScriptRoot 'portal-deployment-integration.cjs'))
$taskStart.WorkingDirectory = $taskProject
$taskStart.UseShellExecute = $false
$taskStart.CreateNoWindow = $true
$taskStart.Environment.Clear()
foreach ($taskKey in @('SystemRoot','SystemDrive','TEMP','TMP')) {
  $taskValue = [Environment]::GetEnvironmentVariable($taskKey)
  if ($taskValue) { $taskStart.Environment[$taskKey] = $taskValue }
}
$taskStart.Environment['PATH'] = (Split-Path -Parent $taskNode) + ';' + (Join-Path $env:SystemRoot 'System32')
$taskStart.Environment['BEING_PORTAL_DEPLOYMENT_TEST'] = '1'
$taskStart.Environment['BEING_PORTAL_DEPLOYMENT_REPORT_DIR'] = $taskReportDir
$taskStart.Environment['RUST_LOG'] = 'info'
$taskProcess = [System.Diagnostics.Process]::Start($taskStart)
Write-Output ([pscustomobject]@{ RunId=$taskRunId; OwnedNodePid=$taskProcess.Id; ReportDir=$taskReportDir } | ConvertTo-Json -Compress)
$taskProcess.WaitForExit()
exit $taskProcess.ExitCode
