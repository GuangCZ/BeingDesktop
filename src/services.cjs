'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const PORTAL_NAME = /^heart-portal(?:[a-z0-9._-]*\.exe)?$/i;
const INSPECT_WINDOWS_SCRIPT = "@(Get-CimInstance Win32_Process -Filter \"Name LIKE 'heart-portal%'\" -ErrorAction Stop | Select-Object ProcessId,Name,ExecutablePath) | ConvertTo-Json -Compress";

function sanitizeText(value, secrets = []) {
  let text = String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[redacted]');
  }
  text = text.replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, (match) => {
    try {
      const url = new URL(match);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch { return '[redacted URL]'; }
  });
  text = text
    .replace(/\b(?:Cookie|Set-Cookie|Authorization|Proxy-Authorization)\s*:[^\r\n]*/gi, '[redacted header]')
    .replace(/\bBearer\s+[^\s,"']+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:[\w-]*(?:token|secret|password|credential)[\w-]*|api[_-]?key|key|authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\bsk-[a-z0-9_-]+\b/gi, '[redacted]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)?\b/g, '[redacted]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[redacted]')
    .replace(/\b[a-zA-Z0-9_+/=-]{48,}\b/g, '[redacted]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return text.slice(0, 2000);
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function safeListWorkspace(root, relative = '') {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) throw new Error('请选择有效的本地工作区。');
  if (typeof relative !== 'string' || relative.includes('\0') || /[:]/.test(relative) || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) throw new Error('工作区路径无效。');
  const segments = relative.split(/[\\/]/).filter((part) => part && part !== '.');
  if (segments.includes('..')) throw new Error('不能访问工作区之外的目录。');
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('工作区必须是实际目录，不能是符号链接。');
  const realRoot = await fs.realpath(root);
  let target = realRoot;
  for (const segment of segments) {
    target = path.join(target, segment);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('目录不存在或是符号链接。');
    if (!isContained(realRoot, await fs.realpath(target))) throw new Error('不能访问工作区之外的目录。');
  }
  const entries = (await fs.readdir(target, { withFileTypes: true }))
    .filter((entry) => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const result = [];
  for (const entry of entries) {
    if (result.length === 200) break;
    const fullPath = path.join(target, entry.name);
    try {
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || !isContained(realRoot, await fs.realpath(fullPath))) continue;
      result.push({ name: entry.name, type: stat.isDirectory() ? 'directory' : 'file', size: stat.isFile() ? stat.size : 0, relativePath: [...segments, entry.name].join('/') });
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
    }
  }
  return result;
}

async function inspectWindowsProcesses() {
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', INSPECT_WINDOWS_SCRIPT], { windowsHide: true, shell: false, maxBuffer: 1024 * 1024 });
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map((item) => ({ pid: Number(item.ProcessId), name: String(item.Name || ''), executable: item.ExecutablePath || '' }));
}

class PortalService {
  constructor({ onEvent = () => {}, workspace = '', spawnImpl = spawn, inspectProcesses, platform = process.platform } = {}) {
    this.onEvent = onEvent;
    this.workspace = workspace;
    this.spawnImpl = spawnImpl;
    this.platform = platform;
    this.inspectProcesses = inspectProcesses || (platform === 'win32' ? inspectWindowsProcesses : async () => { throw new Error('此版本的 Portal 进程识别仅支持 Windows。'); });
    this._state = { status: 'not_configured', health: 'unknown', executable: '', configPath: '', pid: null, owned: false, detail: '' };
    this._child = null;
    this._logs = [];
    this._droppedLogLines = 0;
    this._secrets = [];
    this._startPromise = null;
    this._stopPromise = null;
    this._stopping = false;
    this._lifecycleVersion = 0;
  }

  get state() { return { ...this._state }; }
  get logs() { return this._logs.map((item) => ({ ...item })); }

  configure({ executable, configPath } = {}) {
    if (this._child || this._startPromise) throw new Error('请先停止由桌面端启动的 Portal，再修改配置路径。');
    for (const [key, value] of Object.entries({ executable, configPath })) {
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.includes('\0') || value.includes('\n') || value.includes('\r')) throw new Error('Portal 路径无效。');
      this._state[key] = value;
    }
    this._state = { ...this._state, status: this._configured ? 'stopped' : 'not_configured', health: 'unknown', pid: null, owned: false, detail: '' };
    this._lifecycleVersion++;
    return this.state;
  }

  get _configured() { return Boolean(this._state.executable && this._state.configPath); }

  _event(level, title, detail) {
    const event = { time: new Date().toISOString(), level, title: sanitizeText(title, this._secrets), detail: sanitizeText(detail, this._secrets) };
    this._logs.push(event);
    if (this._logs.length > 100) this._logs.shift();
    try { this.onEvent({ ...event }); } catch { /* Observers must not interrupt process management. */ }
  }

  async inspect() {
    if (this._child) return this.state;
    const lifecycleVersion = this._lifecycleVersion;
    try {
      const processes = await this.inspectProcesses();
      if (this._child || lifecycleVersion !== this._lifecycleVersion) return this.state;
      const configured = this._state.executable.toLowerCase();
      const existing = processes.find((item) => Number.isInteger(item.pid) && item.pid > 0 && (PORTAL_NAME.test(item.name || '') || (configured && String(item.executable || '').toLowerCase() === configured)));
      if (existing) {
        this._state = { ...this._state, status: 'external', health: 'unknown', pid: existing.pid, owned: false, detail: '检测到已有 Portal。桌面端不会重复启动或停止它；中继连接尚未验证。' };
      } else {
        this._state = { ...this._state, status: this._configured ? 'stopped' : 'not_configured', health: 'unknown', pid: null, owned: false, detail: '' };
      }
    } catch {
      if (this._child || lifecycleVersion !== this._lifecycleVersion) return this.state;
      this._state = { ...this._state, status: 'error', health: 'unknown', pid: null, owned: false, detail: '无法确认已有 Portal 进程。为避免重复启动，已阻止启动。' };
    }
    return this.state;
  }

  async _validatePaths() {
    const { executable, configPath } = this._state;
    if (!this._configured || !path.isAbsolute(executable) || !path.isAbsolute(configPath) || !PORTAL_NAME.test(path.basename(executable))) throw new Error('请选择 heart-portal 可执行文件和现有配置文件。');
    for (const file of [executable, configPath]) {
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error('Portal 可执行文件或配置文件不存在，或不是实际文件。');
    }
    const configStat = await fs.stat(configPath);
    if (configStat.size > 1024 * 1024) throw new Error('Portal 配置文件过大，请选择有效配置。');
    const contents = await fs.readFile(configPath, 'utf8');
    this._secrets = [...contents.matchAll(/(?:[\w-]*(?:token|secret|password|credential)[\w-]*|api[_-]?key)\s*=\s*["']([^"'\r\n]+)["']/gi)].map((match) => match[1]);
  }

  start(options = {}) {
    if (this._startPromise) return this._startPromise;
    if (this._stopPromise) return this._stopPromise.then(() => this.start(options));
    this._startPromise = this._start(options).finally(() => { this._startPromise = null; });
    return this._startPromise;
  }

  async _start({ connectUrl, portalName = 'being-desktop', coworkToken } = {}) {
    if (this._child) return this.state;
    let url;
    try { url = new URL(connectUrl); } catch { throw new Error('请先连接 Being，再启动 Portal。'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password) throw new Error('Portal 需要 HTTPS Loom 地址或本机 HTTP 地址。');
    if (typeof portalName !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(portalName)) throw new Error('Portal 名称无效。');
    if (coworkToken !== undefined && (typeof coworkToken !== 'string' || !/^[a-f0-9]{64}$/.test(coworkToken))) throw new Error('Portal 本机接口凭据无效。');
    await this._validatePaths();
    this._secrets.push(String(connectUrl));
    if (coworkToken) this._secrets.push(coworkToken);
    for (const [key, value] of url.searchParams) {
      if (/token|secret|password|credential|api[_-]?key|^key$/i.test(key)) this._secrets.push(value);
    }
    await this.inspect();
    if (this._state.status === 'external') {
      this._event('warning', '检测到已有 Portal', this._state.detail);
      return this.state;
    }
    if (this._state.status === 'error') throw new Error(this._state.detail);
    const { executable, configPath } = this._state;
    let child;
    try {
      child = this.spawnImpl(executable, ['--config', configPath, '--connect', url.toString(), '--name', portalName], { cwd: path.dirname(configPath), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], ...(coworkToken ? {env:{...process.env,PORTAL_TOKEN:coworkToken}} : {}) });
    } catch {
      this._state.status = 'error';
      this._state.detail = 'Portal 启动失败。请检查可执行文件。';
      this._event('error', 'Portal 启动失败', this._state.detail);
      throw new Error(this._state.detail);
    }
    this._child = child;
    this._lifecycleVersion++;
    this._stopping = false;
    this._droppedLogLines = 0;
    let spawned = false;
    child.once('spawn', () => {
      spawned = true;
      this._state = { ...this._state, status: 'running', health: 'unknown', pid: child.pid || null, owned: true, detail: '桌面端已启动 Portal 并请求连接当前 Being；中继握手尚未验证。' };
      this._event('info', 'Portal 已启动', this._state.detail);
    });
    child.on('exit', (code, signal) => {
      if (this._child !== child) return;
      this._child = null;
      const stopped = this._stopping;
      this._state = { ...this._state, status: stopped || code === 0 ? 'stopped' : 'error', health: 'unknown', pid: null, owned: false, detail: stopped ? (this.platform === 'win32' ? '已终止桌面端启动的 Portal（Windows 强制终止）；未确认其工具子进程清理状态。' : '已停止桌面端启动的 Portal；未确认其工具子进程清理状态。') : `Portal 已退出（${code === null ? String(signal || '未知信号') : `退出码 ${code}`}）。` };
      this._event(stopped || code === 0 ? 'info' : 'error', 'Portal 已退出', this._state.detail);
    });
    child.on('error', () => {
      if (this._child !== child) return;
      if (!spawned) this._child = null;
      this._state = { ...this._state, status: 'error', health: 'unknown', pid: spawned ? child.pid : null, owned: spawned, detail: spawned ? 'Portal 进程操作失败，尚未确认退出。桌面端保留此进程的管理权。' : 'Portal 进程发生错误。请检查路径和本地权限。' };
      this._event('error', 'Portal 进程错误', this._state.detail);
    });
    this._attachLogs(child.stdout, child);
    this._attachLogs(child.stderr, child);
    await new Promise((resolve, reject) => {
      const onSpawn = () => { child.removeListener('error', onError); resolve(); };
      const onError = () => { child.removeListener('spawn', onSpawn); reject(new Error('Portal 启动失败。请检查文件和本地权限。')); };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    return this.state;
  }

  _attachLogs(stream, child) {
    if (!stream) return;
    let pending = '';
    let discarding = false;
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!discarding && line.length <= 65536) this._processLog(line, child);
        else this._droppedLogLines++;
        discarding = false;
      }
      if (pending.length > 65536) { pending = ''; discarding = true; }
    });
    stream.on('end', () => {
      if (pending && !discarding) this._processLog(pending, child);
      else if (discarding) this._droppedLogLines++;
    });
  }

  _processLog(raw, child) {
    const line = String(raw).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
    if (!line) return;
    if (this._child !== child || !this._state.owned) { this._droppedLogLines++; return; }
    // Accept known tracing prefixes only. Payloads are never forwarded or retained.
    const message = line.replace(/^(?:\d{4}-\d{2}-\d{2}T\S+\s+)?(?:(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+)?(?:(?:heart_portal|portal)(?:::[a-zA-Z0-9_]+)*:\s*)?/, '');
    // These lifecycle messages are observed in d5z/heart-portal main.rs and relay_client.rs.
    if (/^Portal tools: [A-Za-z0-9_, -]+$/.test(message)) {
      this._event('info', 'Portal 工具已注册', message);
    } else if (message === 'Portal relay handshake OK — starting MCP server on WebSocket bridge') {
      this._state.health = 'connected';
      this._state.detail = 'Portal 日志报告中继握手成功。';
      this._event('info', 'Portal 中继已连接', this._state.detail);
    } else if (/^relay session (?:ended:|ended cleanly;|error after \d|ran \d[^\r\n]* before error:)/.test(message)) {
      this._state.health = 'disconnected';
      this._state.detail = 'Portal 日志报告中继断开，进程可能正在自动重连。';
      this._event('warning', 'Portal 中继已断开', this._state.detail);
    } else if (/^Portal connect mode: relay /.test(message)) {
      this._event('info', 'Portal 正在连接中继', 'Portal 已进入连接模式，等待中继握手结果。');
    } else if (/^invalid Loom link:/.test(message)) {
      this._event('error', 'Portal 连接地址无效', 'Portal 无法解析已配置的 Loom 地址。');
    } else if (/^Portal shutting down(?: \(Ctrl\+C\))?$/.test(message)) {
      this._state.health = 'unknown';
      this._event('info', 'Portal 正在退出', 'Portal 日志报告正在退出，尚未确认进程结束或工具清理完成。');
    } else {
      this._droppedLogLines++;
    }
  }

  stop() {
    if (this._stopPromise) return this._stopPromise;
    this._stopPromise = this._stop().finally(() => { this._stopPromise = null; });
    return this._stopPromise;
  }

  async _stop() {
    if (this._startPromise) await this._startPromise.catch(() => {});
    const child = this._child;
    if (!child) return this.state;
    this._stopping = true;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('尚未确认 Portal 已退出；请检查本机进程。')); }, 5000);
      const cleanup = () => { clearTimeout(timer); child.removeListener('exit', onExit); child.removeListener('error', onError); };
      const onExit = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('停止 Portal 失败。')); };
      child.once('exit', onExit);
      child.once('error', onError);
      // On Windows, Node terminates the owned process; it does not send Ctrl+C.
      try { if (!child.kill('SIGTERM')) { cleanup(); reject(new Error('未能停止桌面端启动的 Portal。')); } }
      catch { cleanup(); reject(new Error('停止 Portal 失败。')); }
    });
    return this.state;
  }

  async dispose() { return this.stop(); }
}

module.exports = { PortalService, safeListWorkspace, sanitizeText };
