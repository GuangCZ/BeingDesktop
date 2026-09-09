'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const ENVIRONMENT_KEYS = new Set([
  'systemroot', 'windir', 'systemdrive', 'comspec', 'pathext', 'path',
  'home', 'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata',
  'temp', 'tmp', 'username', 'userdomain', 'computername', 'os',
  'number_of_processors', 'processor_architecture', 'processor_identifier',
  'processor_level', 'processor_revision', 'programfiles', 'programfiles(x86)',
  'programw6432', 'commonprogramfiles', 'commonprogramfiles(x86)',
  'commonprogramw6432', 'allusersprofile', 'public', 'psmodulepath',
]);

function consoleEnvironment(source = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (ENVIRONMENT_KEYS.has(key.toLowerCase()) && typeof value === 'string' && !value.includes('\0')) result[key] = value;
  }
  return result;
}

// The shell owns this non-inheritable handle. Windows closes it when the shell
// exits or Node terminates its process handle, killing only that job's tree.
// Command text travels through stdin, never through a shell-quoted argument.
const WINDOWS_RUNNER = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class BeingConsoleJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr Minimum, Maximum;
    public uint ActiveLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Counters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic Basic;
    public Counters Counters;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr data, uint length);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static IntPtr ownedJob;
  public static void Enter() {
    ownedJob = CreateJobObject(IntPtr.Zero, null);
    if (ownedJob == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    Extended info = new Extended();
    info.Basic.Flags = 0x2000;
    int size = Marshal.SizeOf(typeof(Extended));
    IntPtr memory = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info, memory, false);
      if (!SetInformationJobObject(ownedJob, 9, memory, (uint)size))
        throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(memory); }
    if (!AssignProcessToJobObject(ownedJob, GetCurrentProcess()))
      throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
  [BeingConsoleJob]::Enter()
  $commandText = [Console]::In.ReadToEnd()
} catch {
  [Console]::Error.WriteLine('[Being Console] Unable to initialize the owned command process: ' + $_.Exception.Message)
  exit 125
}
$ErrorActionPreference = 'Continue'
$global:LASTEXITCODE = 0
try {
  & ([ScriptBlock]::Create($commandText))
  $commandSucceeded = $?
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  if (-not $commandSucceeded) { exit 1 }
} catch {
  [Console]::Error.WriteLine($_.ToString())
  exit 1
}
`;

function outputTail(text, bytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= bytes) return text;
  let start = buffer.length - bytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString('utf8');
}

class DesktopConsole {
  constructor({ getWorkspace = () => '', onChange = () => {}, shellPath,
    maxOutputBytes = 256 * 1024, maxJobs = 20, maxConcurrent = 3,
    spawnImpl = spawn, environment = process.env, platform = process.platform } = {}) {
    this.getWorkspace = getWorkspace;
    this.onChange = onChange;
    this.platform = platform;
    this.environment = consoleEnvironment(environment);
    this.shellPath = shellPath || path.win32.join(environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    this.maxOutputBytes = Math.max(1024, Math.min(1024 * 1024, Number(maxOutputBytes) || 256 * 1024));
    this.maxJobs = Math.max(1, Math.min(50, Math.floor(Number(maxJobs) || 20)));
    this.maxConcurrent = Math.max(1, Math.min(this.maxJobs, 5, Math.floor(Number(maxConcurrent) || 3)));
    this.spawnImpl = spawnImpl;
    this._jobs = [];
    this._children = new Map();
    this._pendingRuns = 0;
    this._disposed = false;
    this._changeTimer = null;
  }

  snapshot() {
    return {
      shell: 'PowerShell',
      limits: { maxConcurrent: this.maxConcurrent, maxOutputBytes: this.maxOutputBytes, maxJobs: this.maxJobs },
      jobs: this._jobs.map(({ outputBytes, ...job }) => ({ ...job, output: job.output.map(item => ({ ...item })) })),
    };
  }

  _notify(immediate = false) {
    if (immediate && this._changeTimer) {
      clearTimeout(this._changeTimer);
      this._changeTimer = null;
    }
    const emit = () => {
      this._changeTimer = null;
      try { this.onChange(this.snapshot()); } catch { /* Observers cannot interrupt command ownership. */ }
    };
    if (immediate) emit();
    else if (!this._changeTimer) this._changeTimer = setTimeout(emit, 50);
  }

  _append(job, stream, text) {
    if (!text) return;
    const clean = String(text).replace(/\0/g, '');
    if (!clean) return;
    job.output.push({ stream, text: clean });
    job.outputBytes += Buffer.byteLength(clean, 'utf8');
    while (job.output.length > 1000) {
      job.outputBytes -= Buffer.byteLength(job.output.shift().text, 'utf8');
      job.truncated = true;
    }
    while (job.outputBytes > this.maxOutputBytes && job.output.length) {
      const first = job.output[0];
      const size = Buffer.byteLength(first.text, 'utf8');
      const excess = job.outputBytes - this.maxOutputBytes;
      if (size <= excess) {
        job.output.shift();
        job.outputBytes -= size;
      } else {
        first.text = outputTail(first.text, size - excess);
        job.outputBytes -= size - Buffer.byteLength(first.text, 'utf8');
      }
      job.truncated = true;
    }
    this._notify();
  }

  async run({ command, cwd, signal } = {}) {
    if (this._disposed) throw new Error('控制台已经关闭。');
    if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw new Error('命令取消信号无效。');
    const checkCancelled = () => { if (signal?.aborted) throw new Error('命令调用已取消，尚未启动。'); };
    checkCancelled();
    if (this.platform !== 'win32') throw new Error('本版本的本机控制台仅支持 Windows PowerShell。');
    if (typeof command !== 'string' || !command.trim() || command.includes('\0') || command.length > 65536) throw new Error('请输入有效命令，长度不能超过 65536 个字符。');
    if (this._children.size + this._pendingRuns >= this.maxConcurrent) throw new Error(`最多同时运行 ${this.maxConcurrent} 个命令，请先停止或等待现有命令。`);
    this._pendingRuns++;
    try {
      const requested = cwd === undefined ? await this.getWorkspace() : cwd;
      checkCancelled();
      if (typeof requested !== 'string' || !path.isAbsolute(requested) || requested.includes('\0')) throw new Error('请先选择有效的本地工作区。');
      let directory;
      try {
        directory = await fs.realpath(requested);
        checkCancelled();
        const stat = await fs.stat(directory);
        checkCancelled();
        if (!stat.isDirectory()) throw new Error('not a directory');
      } catch { checkCancelled(); throw new Error('命令工作目录不存在或无法访问，请重新选择工作区。'); }
      if (this._disposed) throw new Error('控制台已经关闭。');
      checkCancelled();
      while (this._jobs.length >= this.maxJobs) {
        const oldest = this._jobs.findIndex(job => !this._children.has(job.id));
        if (oldest < 0) throw new Error('请先等待现有命令结束。');
        this._jobs.splice(oldest, 1);
      }
      const job = {
        id: randomUUID(), command, cwd: directory, status: 'starting',
        startedAt: new Date().toISOString(), endedAt: null,
        exitCode: null, signal: null, output: [], outputBytes: 0, truncated: false,
      };
      this._jobs.push(job);
      let child;
      try {
        child = this.spawnImpl(this.shellPath,
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(WINDOWS_RUNNER, 'utf16le').toString('base64')],
          { cwd: directory, env: { ...this.environment }, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        job.status = 'failed';
        job.endedAt = new Date().toISOString();
        this._append(job, 'stderr', '无法启动 PowerShell，请检查系统安装。\n');
        this._notify(true);
        return { jobId: job.id };
      }
      let resolveClosed;
      const owned = { child, stopping: false, closed: new Promise(resolve => { resolveClosed = resolve; }) };
      this._children.set(job.id, owned);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', text => this._append(job, 'stdout', text));
      child.stderr.on('data', text => this._append(job, 'stderr', text));
      const removeAbort = () => signal?.removeEventListener('abort', abortStartup);
      const abortStartup = () => {
        removeAbort();
        void this.stop(job.id).catch(() => this._append(job, 'stderr', '启动已取消，但进程未能停止，请在控制台重试停止。\n'));
      };
      child.once('spawn', () => {
        removeAbort();
        if (!owned.stopping) job.status = 'running';
        this._notify(true);
      });
      child.once('error', () => {
        job.status = 'failed';
        this._append(job, 'stderr', '命令进程启动或运行失败。\n');
        this._notify(true);
      });
      child.stdin.on('error', () => { /* A failed or stopped shell can close input before it is written. */ });
      child.once('close', (code, signal) => {
        removeAbort();
        job.exitCode = Number.isInteger(code) ? code : null;
        job.signal = signal || null;
        job.status = owned.stopping ? 'stopped' : (job.status === 'failed' || code !== 0 ? 'failed' : 'completed');
        job.endedAt = new Date().toISOString();
        this._children.delete(job.id);
        this._notify(true);
        resolveClosed();
      });
      signal?.addEventListener('abort', abortStartup, { once: true });
      if (signal?.aborted) {
        removeAbort();
        await this.stop(job.id);
        checkCancelled();
      }
      child.stdin.end(command, 'utf8');
      this._notify(true);
      return { jobId: job.id };
    } finally { this._pendingRuns--; }
  }

  async stop(jobId) {
    if (typeof jobId !== 'string') throw new Error('请选择有效的命令。');
    const owned = this._children.get(jobId);
    if (!owned) return { stopped: false };
    if (owned.stopping) {
      await owned.closed;
      return { stopped: true };
    }
    // ChildProcess.kill uses its retained Windows process handle, not a new PID
    // lookup. The job object's handle closes with this exact shell instance.
    if (owned.child.exitCode !== null || owned.child.signalCode !== null) {
      await owned.closed;
      return { stopped: false };
    }
    owned.stopping = true;
    const job = this._jobs.find(item => item.id === jobId);
    if (job) job.status = 'stopping';
    this._notify(true);
    if (!owned.child.kill()) {
      owned.stopping = false;
      if (job) job.status = 'running';
      this._notify(true);
      throw new Error('未能停止该命令，请重试。');
    }
    await owned.closed;
    return { stopped: true };
  }

  clear(jobId) {
    if (jobId !== undefined && typeof jobId !== 'string') throw new Error('请选择有效的命令。');
    const jobs = this._jobs.filter(job => jobId === undefined || job.id === jobId);
    for (const job of jobs) {
      job.output = [];
      job.outputBytes = 0;
      job.truncated = false;
    }
    this._notify(true);
    return { cleared: jobs.length };
  }

  async dispose() {
    this._disposed = true;
    const results = await Promise.allSettled([...this._children.keys()].map(id => this.stop(id)));
    if (this._changeTimer) clearTimeout(this._changeTimer);
    this._changeTimer = null;
    const failure = results.find(result => result.status === 'rejected');
    if (failure) {
      this._disposed = false;
      throw failure.reason;
    }
  }
}

module.exports = { DesktopConsole, consoleEnvironment, WINDOWS_RUNNER };
