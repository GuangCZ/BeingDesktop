'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DesktopConsole } = require('../src/desktop-console.cjs');
const execFileAsync = promisify(execFile);

if (process.platform !== 'win32') throw new Error('This hidden local integration check requires Windows.');

const observers = new Set();
const service = new DesktopConsole({
  getWorkspace: () => path.resolve(__dirname, '..'),
  onChange: state => { for (const observer of observers) observer(state); },
  environment: { ...process.env, BEING_LOOM_URL: 'test-secret-never-inherited', COWORK_TOKEN: 'test-secret-never-inherited', OPENAI_API_KEY: 'test-secret-never-inherited' },
  maxOutputBytes: 4096,
});

function waitFor(jobId, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { observers.delete(observer); reject(new Error('Hidden console integration condition was not reached.')); }, 20000);
    const observer = state => {
      const job = state.jobs.find(item => item.id === jobId);
      if (!job || !predicate(job)) return;
      clearTimeout(timer);
      observers.delete(observer);
      resolve(job);
    };
    observers.add(observer);
    observer(service.snapshot());
  });
}

function terminal(job) { return ['completed', 'failed', 'stopped'].includes(job.status); }
function output(job) { return job.output.map(item => item.text).join(''); }

async function processExists(pid) {
  const script = `$ErrorActionPreference='Stop'; if(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue){'alive'}else{'gone'}`;
  const { stdout } = await execFileAsync(service.shellPath, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, env: service.environment });
  return stdout.trim() === 'alive';
}

async function main() {
  const checks = [];
  try {
    const basic = await service.run({ command: "Write-Output '中文输出🙂'; [Console]::Error.WriteLine('stderr-ok'); Write-Output (Get-Location).Path; if($env:BEING_LOOM_URL -or $env:COWORK_TOKEN -or $env:OPENAI_API_KEY){throw 'private env leaked'}; exit 7" });
    const basicJob = await waitFor(basic.jobId, terminal);
    assert.equal(basicJob.exitCode, 7);
    assert.equal(basicJob.status, 'failed');
    assert.match(output(basicJob), /中文输出🙂/);
    assert.ok(basicJob.output.some(item => item.stream === 'stderr' && item.text.includes('stderr-ok')));
    assert.ok(output(basicJob).includes(path.resolve(__dirname, '..')));
    assert.ok(!output(basicJob).includes('private env leaked'));
    checks.push('UTF-8 stdout/stderr, cwd, exit code, and secret-free environment');

    const childCode = Buffer.from("Write-Output 'owned-descendant'; Start-Sleep -Seconds 120", 'utf16le').toString('base64');
    const tree = await service.run({ command: `$child=Start-Process -FilePath "$PSHOME\\powershell.exe" -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${childCode}' -WindowStyle Hidden -PassThru; Write-Output ('CHILD_PID:'+$child.Id); Start-Sleep -Seconds 120` });
    const treeReady = await waitFor(tree.jobId, job => /CHILD_PID:\d+/.test(output(job)) || terminal(job));
    assert.ok(!terminal(treeReady), output(treeReady));
    const treePid = Number(output(treeReady).match(/CHILD_PID:(\d+)/)[1]);
    assert.equal(await processExists(treePid), true);

    const unrelated = await service.run({ command: "Write-Output 'independent-ready'; Start-Sleep -Seconds 120" });
    await waitFor(unrelated.jobId, job => output(job).includes('independent-ready') || terminal(job));
    assert.deepEqual(await service.stop(tree.jobId), { stopped: true });
    assert.equal((await waitFor(tree.jobId, terminal)).status, 'stopped');
    assert.equal(await processExists(treePid), false);
    assert.equal(service.snapshot().jobs.find(job => job.id === unrelated.jobId).status, 'running');
    await service.stop(unrelated.jobId);
    checks.push('Stop terminates the owned Windows process tree and preserves an independent job');

    const natural = await service.run({ command: `$child=Start-Process -FilePath "$PSHOME\\powershell.exe" -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${childCode}' -WindowStyle Hidden -PassThru; Write-Output ('CHILD_PID:'+$child.Id)` });
    const naturalJob = await waitFor(natural.jobId, terminal);
    assert.equal(naturalJob.status, 'completed', output(naturalJob));
    const naturalPid = Number(output(naturalJob).match(/CHILD_PID:(\d+)/)[1]);
    assert.equal(await processExists(naturalPid), false);
    checks.push('Natural shell exit cleans up inherited descendants');

    const bounded = await service.run({ command: "Write-Output ('界' * 10000); Write-Output 'tail-visible'" });
    const boundedJob = await waitFor(bounded.jobId, terminal);
    assert.equal(boundedJob.status, 'completed', output(boundedJob));
    assert.equal(boundedJob.truncated, true);
    assert.ok(Buffer.byteLength(output(boundedJob)) <= 4096);
    assert.match(output(boundedJob), /tail-visible/);
    assert.ok(!output(boundedJob).includes('�'), JSON.stringify(boundedJob.output.map(item => ({ stream: item.stream, head: item.text.slice(0, 15), tail: item.text.slice(-15), replacement: item.text.indexOf('�') }))));
    checks.push('High-volume output is bounded and retains valid Unicode at the tail');
    process.stdout.write(JSON.stringify({ passed: true, checks }, null, 2) + '\n');
  } finally { await service.dispose(); }
}

main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
