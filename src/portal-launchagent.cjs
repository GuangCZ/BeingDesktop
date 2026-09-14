'use strict';

// All launchd output and plist contents stay in the main process. A plist can
// contain credentials; never expose it, argv, or child-process errors to the UI.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {setTimeout: delay} = require('node:timers/promises');
const {inspectMacProcesses, PORTAL_NAME} = require('./services.cjs');
const {directoryChain} = require('./portal-installer.cjs');
const execute = promisify(execFile);
const safePath = value => typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function regular(file, limit = 1024 * 1024) {
  if (!safePath(file)) throw new Error('Portal 部署路径无效。');
  await directoryChain(path.dirname(file));
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Portal 部署文件无法安全读取。');
  return fs.readFile(file);
}

function argument(args, flag) {
  const indexes = args.map((value, index) => value === flag ? index : -1).filter(index => index >= 0);
  return indexes.length === 1 ? args[indexes[0] + 1] : '';
}

// Recognize the saved executable/configuration, rather than inferring ownership
// from a filename containing "portal". Unknown launchers remain observable.
async function launchBinding(definition) {
  const args = definition.ProgramArguments;
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) return null;
  const program = definition.Program || args[0];
  if (safePath(program) && PORTAL_NAME.test(path.basename(program))) {
    const configPath = argument(args, '--config') || argument(args, '-c');
    return safePath(configPath) ? {executable:program, configPath, wrapper:'', wrapperHash:''} : null;
  }
  const wrapper = /^(?:\/bin\/(?:sh|bash|zsh))$/.test(program) ? args[1] : program;
  if (!safePath(wrapper)) return null;
  const bytes = await regular(wrapper);
  const text = bytes.toString('utf8');
  if (path.basename(wrapper) === 'auto-connect.zsh') {
    const binary = [...text.matchAll(/^portal_binary='([^'\r\n]+)'$/gm)];
    const config = [...text.matchAll(/^portal_config='([^'\r\n]+)'$/gm)];
    if (binary.length !== 1 || config.length !== 1 || !text.includes('exec "$portal_binary" --config "$portal_config"')) return null;
    const executable = binary[0][1], configPath = config[0][1];
    if (!safePath(executable) || !safePath(configPath) || !PORTAL_NAME.test(path.basename(executable))) return null;
    return {executable, configPath, wrapper, wrapperHash:hash(bytes)};
  }
  if (path.basename(wrapper) === 'portal-launchagent.sh' && path.basename(path.dirname(wrapper)) === 'scripts') {
    const root = path.dirname(path.dirname(wrapper));
    if (args[2] !== root || args[3] !== definition.Label) return null;
    let executable = path.join(root, 'target', 'release', 'heart-portal'), pointerHash = '';
    try { const bytes = await regular(path.join(root,'.portal-executable')); executable = bytes.toString('utf8').trim(); pointerHash = hash(bytes); }
    catch (error) { if (error.code !== 'ENOENT') return null; }
    if (!safePath(executable) || !PORTAL_NAME.test(path.basename(executable))) return null;
    const configPath = args[4] || path.join(root, 'portal.toml');
    if (!safePath(configPath)) return null;
    return {executable, configPath, wrapper, wrapperHash:hash(bytes), pointerHash,
      runtimeLogPath:path.join(root,'portal-runtime.log'), runtimeErrorLogPath:path.join(root,'portal-runtime.err.log')};
  }
  return null;
}

class LaunchAgentPortal {
  constructor({descriptor, execImpl = execute, inspectProcesses = inspectMacProcesses, uid = process.getuid?.(), wait = delay} = {}) {
    Object.assign(this, {descriptor, execImpl, inspectProcesses, uid, wait});
    this.kind = 'launchagent';
  }
  async command(file, args) {
    try { return await this.execImpl(file, args, {shell:false, timeout:20000, maxBuffer:1024 * 1024}); }
    catch { throw new Error('Portal 系统服务操作未完成，请刷新状态后重试。'); }
  }
  async definition() {
    const bytes = await regular(this.descriptor.plist);
    const {stdout} = await this.command('/usr/bin/plutil', ['-convert','json','-o','-',this.descriptor.plist]);
    const value = JSON.parse(stdout);
    const binding = await launchBinding(value);
    const d = this.descriptor;
    if (hash(bytes) !== d.plistHash || value.Label !== d.label || !binding
        || ['executable','configPath','wrapper','wrapperHash','pointerHash'].some(key => binding[key] !== d[key])) {
      throw new Error('Portal 启动方式已变化，请重新检查部署。');
    }
    return value;
  }
  async state() {
    await this.definition();
    const processes = await this.inspectProcesses();
    const matches = processes.filter(item => item.executable === this.descriptor.executable);
    if (matches.length > 1) throw new Error('检测到多个相同 Portal 实例，暂缓管理。');
    let pid = null, loaded = false;
    try {
      const {stdout} = await this.execImpl('/bin/launchctl', ['print',`gui/${this.uid}/${this.descriptor.label}`], {shell:false,timeout:5000,maxBuffer:1024*1024});
      loaded = true;
      const match = /^\s*pid = (\d+)\s*$/m.exec(stdout);
      pid = match ? Number(match[1]) : null;
    } catch (error) {
      if (typeof error.code !== 'number') throw new Error('无法确认 Portal 系统服务状态。');
    }
    if (matches.length && (!loaded || matches[0].pid !== pid)) {
      // Never stop a manually launched process just because its path matches.
      throw new Error('Portal 进程与原系统服务不匹配，暂缓接管。');
    }
    return {...this.descriptor, kind:this.kind, loaded, running:matches.length === 1, pid:matches[0]?.pid || null};
  }
  async stop() {
    const state = await this.state();
    if (state.loaded) await this.command('/bin/launchctl', ['bootout',`gui/${this.uid}/${state.label}`]);
    for (let n = 0; n < 60; n++) {
      if (!(await this.inspectProcesses()).some(item => item.executable === state.executable)) return;
      await this.wait(250);
    }
    throw new Error('原 Portal 尚未退出，更新未应用。');
  }
  async start() {
    const current = await this.state();
    if (!current.loaded) await this.command('/bin/launchctl', ['bootstrap',`gui/${this.uid}`,current.plist]);
    else if (!current.running) await this.command('/bin/launchctl', ['kickstart',`gui/${this.uid}/${current.label}`]);
  }
  async mark() {
    return Promise.all([this.descriptor.logPath, this.descriptor.errorLogPath].filter(Boolean).map(async file => {
      try { const stat = await fs.lstat(file); return {file, ino:stat.ino, size:stat.size}; }
      catch { return {file,ino:0,size:0}; }
    }));
  }
  async health(markers) {
    let connected = false, tools = false;
    for (const marker of markers || []) {
      let handle;
      try {
        await directoryChain(path.dirname(marker.file));
        const stat = await fs.lstat(marker.file);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const start = stat.ino === marker.ino && stat.size >= marker.size ? marker.size : 0;
        // Only fresh, bounded log bytes count. Historical handshakes cannot
        // certify the replacement process; raw log content is never returned.
        if (stat.size - start > 1024 * 1024) continue;
        handle = await fs.open(marker.file,'r');
        const buffer = Buffer.alloc(stat.size - start);
        await handle.read(buffer,0,buffer.length,start);
        const text = buffer.toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
        connected ||= text.includes('Portal relay handshake OK — starting MCP server on WebSocket bridge');
        tools ||= /Portal tools: [A-Za-z0-9_, -]*\bportal_status\b/.test(text);
        if (/relay session (?:ended|error)/.test(text.slice(text.lastIndexOf('Portal relay handshake OK')))) connected = false;
      } catch { /* Missing telemetry is unknown, never a successful check. */ }
      finally { await handle?.close(); }
    }
    return {connected, tools};
  }
  async prepareUpdate() {
    const root = await fs.realpath(this.descriptor.runtimeRoot || path.join(os.homedir(),'.heart-portal'));
    const relative = path.relative(root, await fs.realpath(this.descriptor.executable));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('此 Portal 位于官方运行目录之外；自动迁移会改变原部署，暂不能原位更新。');
    }
  }
  async prepareSupervision() {
    const definition = await this.definition();
    if (definition.EnvironmentVariables?.HEART_PORTAL_SUPERVISED === '1') return;
    // 0.8.3 otherwise adds its own supervisor. Tell it launchd already owns the
    // lifecycle, preserving the original launcher, config and Keychain access.
    definition.EnvironmentVariables = {...definition.EnvironmentVariables, HEART_PORTAL_SUPERVISED:'1'};
    const temporary = `${this.descriptor.plist}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(definition), {flag:'wx',mode:0o600});
      await this.command('/usr/bin/plutil', ['-convert','xml1',temporary]);
      await this.definition();
      await fs.rename(temporary, this.descriptor.plist);
      this.descriptor.plistHash = hash(await regular(this.descriptor.plist));
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async restorePlist(backup) {
    await this.definition();
    const bytes = await regular(backup);
    const temporary = `${this.descriptor.plist}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, bytes, {flag:'wx',mode:0o600});
      await fs.rename(temporary, this.descriptor.plist);
      this.descriptor.plistHash = hash(bytes);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
}

async function discoverLaunchAgent({executable, configPath, home = os.homedir(), execImpl = execute, inspectProcesses = inspectMacProcesses, uid = process.getuid?.()} = {}) {
  if (!safePath(executable) || !safePath(configPath)) return null;
  const directory = path.join(home, 'Library', 'LaunchAgents');
  let files;
  try { await directoryChain(directory); files = await fs.readdir(directory); } catch { return null; }
  const candidates = [];
  for (const file of files.filter(name => /^town\.beings\.heart-portal(?:\.[a-zA-Z0-9_-]+)*\.plist$/.test(name) && !name.includes('.upgrade.'))) {
    try {
      const plist = path.join(directory, file), bytes = await regular(plist);
      const {stdout} = await execImpl('/usr/bin/plutil', ['-convert','json','-o','-',plist], {shell:false,timeout:5000,maxBuffer:1024*1024});
      const definition = JSON.parse(stdout), binding = await launchBinding(definition);
      if (definition.Label !== file.slice(0, -6) || !binding || binding.executable !== executable || binding.configPath !== configPath) continue;
      const descriptor = {...binding, runtimeRoot:path.join(home,'.heart-portal'), plist, plistHash:hash(bytes), label:definition.Label,
        logPath:binding.runtimeLogPath || (safePath(definition.StandardOutPath) ? definition.StandardOutPath : ''),
        errorLogPath:binding.runtimeErrorLogPath || (safePath(definition.StandardErrorPath) ? definition.StandardErrorPath : '')};
      const adapter = new LaunchAgentPortal({descriptor,execImpl,inspectProcesses,uid});
      await adapter.state();
      candidates.push(adapter);
    } catch { /* An unknown or changed launcher is observable, not controllable. */ }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

module.exports = {LaunchAgentPortal, discoverLaunchAgent, launchBinding, regular, hash};
