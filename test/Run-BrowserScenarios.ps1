$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskProfile=Join-Path (Join-Path $taskRoot '.local') ('desktop-browser-fixture-'+[guid]::NewGuid().ToString('D'))
New-Item -ItemType Directory -Path $taskProfile -Force | Out-Null
$taskVars=@('BEING_BROWSER_TEST_PROFILE','ELECTRON_RUN_AS_NODE')
$taskOld=@{}
foreach($taskName in $taskVars){$taskOld[$taskName]=[Environment]::GetEnvironmentVariable($taskName,'Process')}
try {
  foreach($taskName in $taskVars){Remove-Item -LiteralPath ('Env:'+$taskName) -ErrorAction SilentlyContinue}
  $env:BEING_BROWSER_TEST_PROFILE=$taskProfile
  $taskScript=Join-Path $taskRoot 'test\desktop-browser-electron.cjs'
  $taskProcess=Start-Process -FilePath (Join-Path $taskRoot 'node_modules\electron\dist\electron.exe') -ArgumentList ('"'+$taskScript+'"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskProfile 'stdout.log') -RedirectStandardError (Join-Path $taskProfile 'stderr.log') -PassThru
  if(-not $taskProcess.WaitForExit(70000)){throw 'Isolated browser fixture did not finish in time.'}
  $taskReport=Join-Path $taskProfile 'browser-report.json'
  if(-not (Test-Path -LiteralPath $taskReport)){Get-Content -LiteralPath (Join-Path $taskProfile 'stderr.log'); throw 'Browser fixture did not write a report.'}
  $taskResult=Get-Content -LiteralPath $taskReport -Raw | ConvertFrom-Json
  [pscustomobject]@{Passed=$taskResult.passed;Checks=$taskResult.checks.Count;Report=$taskReport;Error=$taskResult.error} | ConvertTo-Json -Compress
  if(-not $taskResult.passed){Get-Content -LiteralPath (Join-Path $taskProfile 'stderr.log'); exit 1}
} finally {
  foreach($taskName in $taskVars){[Environment]::SetEnvironmentVariable($taskName,$taskOld[$taskName],'Process')}
}
