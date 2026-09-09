$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskProfile=Join-Path (Join-Path $taskRoot '.local') ('being-desktop-scenarios-'+[guid]::NewGuid().ToString('D'))
New-Item -ItemType Directory -Path $taskProfile -Force | Out-Null
$taskVars=@('BEING_DATA_DIR','BEING_SCENARIOS','BEING_LOOM_URL','BEING_SMOKE_REPORT','BEING_SMOKE_EXIT','ELECTRON_RUN_AS_NODE')
$taskOld=@{}
foreach($taskName in $taskVars){$taskOld[$taskName]=[Environment]::GetEnvironmentVariable($taskName,'Process')}
try {
  foreach($taskName in $taskVars){Remove-Item -LiteralPath ('Env:'+$taskName) -ErrorAction SilentlyContinue}
  $env:BEING_DATA_DIR=$taskProfile
  $env:BEING_SCENARIOS='1'
  $taskProcess=Start-Process -FilePath (Join-Path $taskRoot 'node_modules\electron\dist\electron.exe') -ArgumentList ('"'+(Join-Path $taskRoot 'test\desktop-harness.cjs')+'"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskProfile 'stdout.log') -RedirectStandardError (Join-Path $taskProfile 'stderr.log') -PassThru
  [pscustomobject]@{Pid=$taskProcess.Id;Report=(Join-Path $taskProfile 'scenarios-report.json');Profile=$taskProfile}
} finally {
  foreach($taskName in $taskVars){[Environment]::SetEnvironmentVariable($taskName,$taskOld[$taskName],'Process')}
}
