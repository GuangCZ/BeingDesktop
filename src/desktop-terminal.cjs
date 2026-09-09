'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { consoleEnvironment } = require('./desktop-console.cjs');

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_REPLAY_BYTES = 1024 * 1024;
const MAX_SESSIONS = 8;

function dimensions(cols = 100, rows = 30) {
  if (!Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 1 || rows > 200) {
    throw new Error('终端尺寸无效。');
  }
  return { cols, rows };
}

function* outputChunks(text) {
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + 16384);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    yield text.slice(offset, end);
    offset = end;
  }
}

class DesktopTerminal {
  constructor({ getWorkspace = () => '', onChange = () => {}, onData = () => {}, pty,
    environment = process.env, platform = process.platform, shellPath } = {}) {
    this.getWorkspace = getWorkspace;
    this.onChange = onChange;
    this.onData = onData;
    this.pty = pty;
    this.platform = platform;
    this.environment = {
      ...consoleEnvironment(environment), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'BeingDesktop',
    };
    this.shellPath = shellPath || path.win32.join(environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    this.sessions = new Map();
    this.activeSessionId = null;
    this.pendingCreates = 0;
    this.disposed = false;
  }

  snapshot() {
    return {
      sessions: [...this.sessions.values()].map(item => ({
        id: item.id, title: item.title, cwd: item.cwd, status: item.status,
        pid: item.process?.pid || item.pid, cols: item.cols, rows: item.rows, exitCode: item.exitCode,
      })),
      activeSessionId: this.activeSessionId,
    };
  }

  changed() {
    try { this.onChange(this.snapshot()); } catch { /* Observers cannot interrupt terminal ownership. */ }
  }

  requireSession(id, running = false) {
    if (typeof id !== 'string' || !this.sessions.has(id)) throw new Error('终端会话不存在。');
    const item = this.sessions.get(id);
    if (running && (this.disposed || item.status !== 'running')) throw new Error('终端会话已结束。');
    return item;
  }

  async create({ cwd, cols, rows } = {}) {
    if (this.disposed) throw new Error('终端已经关闭。');
    if (this.platform !== 'win32') throw new Error('本版本的交互终端仅支持 Windows。');
    const size = dimensions(cols, rows);
    if (this.sessions.size + this.pendingCreates >= MAX_SESSIONS) throw new Error(`最多同时保留 ${MAX_SESSIONS} 个终端，请先关闭一个终端。`);
    this.pendingCreates++;
    try {
      const requested = cwd === undefined ? ((await this.getWorkspace()) || os.homedir()) : cwd;
      if (typeof requested !== 'string' || !path.isAbsolute(requested) || requested.includes('\0')) throw new Error('请先选择有效的本地工作区。');
      let directory;
      try {
        directory = await fs.realpath(requested);
        if (!(await fs.stat(directory)).isDirectory()) throw new Error('not a directory');
      } catch { throw new Error('终端工作目录不存在或无法访问。'); }
      if (this.disposed) throw new Error('终端已经关闭。');
      let processHandle;
      try {
        this.pty ||= require('node-pty');
        // ConPTY creates a pseudoconsole, never a separate visible console window.
        processHandle = this.pty.spawn(this.shellPath, ['-NoLogo', '-NoProfile'], {
          name: 'xterm-256color', cwd: directory, cols: size.cols, rows: size.rows,
          env: { ...this.environment }, useConpty: true,
          useConptyDll: true, conptyInheritCursor: false, handleFlowControl: false,
        });
      } catch (error) {
        throw new Error('无法启动 PowerShell 交互终端，请检查终端组件与系统安装。', { cause: error });
      }
      const item = {
        id: randomUUID(), title: 'PowerShell', cwd: directory, status: 'running',
        pid: processHandle.pid || null, ...size, exitCode: null, process: processHandle,
        sequence: 0, chunks: [], replayBytes: 0, truncated: false, subscriptions: [], closing: null,
        nativeReleased: false, didExit: false,
      };
      item.exited = new Promise(resolve => { item.resolveExit = resolve; });
      this.sessions.set(item.id, item);
      this.activeSessionId = item.id;
      try {
        item.subscriptions.push(processHandle.onData(data => this.append(item, data)));
        item.subscriptions.push(processHandle.onExit(({ exitCode }) => {
          if (item.didExit) return;
          item.didExit = true;
          item.pid = processHandle.pid || item.pid;
          item.status = 'exited';
          item.exitCode = Number.isInteger(exitCode) ? exitCode : null;
          // A naturally exited shell still owns ConPTY's input pipe until kill()
          // releases it. Keep the output history, not the native pipe handles.
          if (!item.nativeReleased) {
            item.nativeReleased = true;
            try { processHandle.kill(); } catch { item.nativeReleased = false; }
          }
          // node-pty 1.1.0 waits for another data event to dispose its ConPTY
          // worker; a naturally closed output pipe cannot produce that event.
          // Release only this exited PTY's resources until upstream fixes it.
          try { processHandle._agent?.inSocket?.destroy(); } catch { /* The owned input pipe may already be closed. */ }
          try { processHandle._agent?._conoutSocketWorker?.dispose(); } catch { /* The owned output worker may already be disposed. */ }
          if (item.nativeReleased) item.process = null;
          item.resolveExit();
          this.changed();
        }));
        if (typeof processHandle.on === 'function') {
          const onError = () => {
            if (item.didExit) return;
            item.status = 'failed';
            this.append(item, '\r\n\x1b[31mPowerShell 终端连接已中断。请关闭此会话并重新打开终端。\x1b[0m\r\n');
            this.changed();
            item.nativeReleased = true;
            try { processHandle.kill(); } catch { item.nativeReleased = false; }
          };
          processHandle.on('error', onError);
          item.subscriptions.push({ dispose: () => processHandle.removeListener('error', onError) });
        }
      } catch (error) {
        try { processHandle.kill(); } catch { /* Only this owned pseudoconsole may be stopped. */ }
        this.remove(item);
        throw new Error('无法连接 PowerShell 交互终端。', { cause: error });
      }
      this.changed();
      return { sessionId: item.id };
    } finally { this.pendingCreates--; }
  }

  append(item, text) {
    if (!this.sessions.has(item.id) || typeof text !== 'string' || !text) return;
    for (const data of outputChunks(text)) {
      item.sequence++;
      item.chunks.push(data);
      item.replayBytes += Buffer.byteLength(data, 'utf8');
      while (item.replayBytes > MAX_REPLAY_BYTES || item.chunks.length > 4096) {
        item.replayBytes -= Buffer.byteLength(item.chunks.shift(), 'utf8');
        item.truncated = true;
      }
      // Read and this event share one sequence: subscribe before replaying and discard
      // buffered events at or below the returned replay sequence to avoid duplicates.
      try { this.onData({ id: item.id, sequence: item.sequence, data }); } catch { /* The stream remains replayable after an observer error. */ }
    }
  }

  read(id) {
    const item = this.requireSession(id);
    return { id: item.id, sequence: item.sequence, data: item.chunks.join(''), truncated: item.truncated };
  }

  readSince(id, afterSequence = 0) {
    const item = this.requireSession(id);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > item.sequence) throw new Error('终端输出游标无效。');
    const first = item.sequence - item.chunks.length + 1;
    let data = '', bytes = 0, sequence = afterSequence;
    for (let index = Math.max(0, afterSequence - first + 1); index < item.chunks.length; index++) {
      const chunk = item.chunks[index], size = Buffer.byteLength(chunk, 'utf8');
      if (bytes + size > 128 * 1024) break;
      data += chunk; bytes += size; sequence = first + index;
    }
    return {id, data, sequence, latestSequence:item.sequence, hasMore:sequence < item.sequence, truncated:afterSequence < first - 1};
  }

  write({ id, data } = {}) {
    const item = this.requireSession(id, true);
    if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) throw new Error('终端输入不能超过 64 KiB。');
    if (data) item.process.write(data);
    return { written: true };
  }

  resize({ id, cols, rows } = {}) {
    const item = this.requireSession(id, true);
    const size = dimensions(cols, rows);
    if (item.cols !== size.cols || item.rows !== size.rows) {
      item.process.resize(size.cols, size.rows);
      Object.assign(item, size);
      this.changed();
    }
    return { resized: true };
  }

  activate(id) {
    const item = this.requireSession(id);
    this.activeSessionId = item.id;
    this.changed();
    return this.snapshot();
  }

  remove(item) {
    for (const subscription of item.subscriptions) subscription?.dispose();
    this.sessions.delete(item.id);
    if (this.activeSessionId === item.id) this.activeSessionId = [...this.sessions.keys()].at(-1) || null;
    this.changed();
  }

  async close(id) {
    const item = this.requireSession(id);
    if (item.closing) return item.closing;
    if (!item.process) { this.remove(item); return { closed: true }; }
    item.status = 'closing';
    this.changed();
    item.closing = Promise.resolve().then(async () => {
      let timeout;
      try {
        // node-pty owns the ConPTY and its attached console processes. No process
        // name matching or unrelated process-tree termination is performed here.
        item.nativeReleased = true;
        try { item.process.kill(); } catch (error) { item.nativeReleased = false; throw error; }
        await Promise.race([
          item.exited,
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('终端尚未结束，请稍后重试关闭。')), 7000); }),
        ]);
        this.remove(item);
        return { closed: true };
      } catch (error) {
        item.closing = null;
        if (item.process) item.status = 'running';
        this.changed();
        throw error;
      } finally { clearTimeout(timeout); }
    });
    return item.closing;
  }

  async dispose() {
    this.disposed = true;
    const results = await Promise.allSettled([...this.sessions.keys()].map(id => this.close(id)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) {
      this.disposed = false;
      throw failed.reason;
    }
  }
}

module.exports = { DesktopTerminal };
