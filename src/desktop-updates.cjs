'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {compareVersions, parseVersion} = require('./portal-updates.cjs');
const RELEASE_URL = 'https://github.com/GuangCZ/BeingDesktop/releases/latest';
const RELEASE_API = 'https://api.github.com/repos/GuangCZ/BeingDesktop/releases/latest';
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

async function readPublishedVersion({fetchImpl = globalThis.fetch, timeoutMs = 10000} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const response = await fetchImpl(RELEASE_API, {method: 'GET', credentials: 'omit', redirect: 'error',
      cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
      headers: {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Being-Desktop-Updates'}});
    if (!response.ok) {await response.body?.cancel();throw new Error('Published version unavailable');}
    reader = response.body.getReader();
    const chunks = [];let size = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error('Release metadata too large');
      chunks.push(Buffer.from(value));
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const parsed = parseVersion(data.tag_name);
    if (data.draft !== false || data.prerelease !== false || !parsed || parsed.prerelease.length) throw new Error('Invalid stable release');
    return parsed.version;
  } finally {
    clearTimeout(timer);
    if (reader) {await reader.cancel().catch(() => {});reader.releaseLock();}
  }
}

function updateSupport({packaged, platform, portable, resourcesPath, executable, exists = fs.existsSync}) {
  if (!packaged) return '开发模式不自动更新，请使用已安装的 Being Desktop。';
  if (!['darwin', 'win32'].includes(platform)) return '此平台暂不支持自动安装，可前往发布页面下载。';
  if (platform === 'win32' && (portable || !exists(path.join(path.dirname(executable), 'Uninstall Being Desktop.exe')))) {
    return '便携版请从发布页面安装 Windows 安装版，以启用自动更新。';
  }
  if (!exists(path.join(resourcesPath, 'app-update.yml'))) return '此构建未配置自动更新，请从发布页面安装新版。';
  return '';
}

// Squirrel validates the downloaded app's signature before any application
// services are shut down. electron-updater's own downloaded event only means
// that the ZIP checksum passed, not that native signature validation finished.
function prepareMacUpdate(nativeUpdater, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      nativeUpdater.removeListener('update-downloaded', ready);
      nativeUpdater.removeListener('error', failed);
      error ? reject(error) : resolve();
    };
    const ready = () => finish();
    const failed = () => finish(new Error('macOS 未能验证更新，请重试或从发布页面下载。'));
    const timer = setTimeout(() => finish(new Error('macOS 验证更新超时，请稍后重试。')), timeoutMs);
    nativeUpdater.once('update-downloaded', ready);
    nativeUpdater.once('error', failed);
    try { nativeUpdater.checkForUpdates(); } catch { failed(); }
  });
}

class DesktopUpdates {
  constructor({version, unsupported = '', createUpdater, getEnabled = () => true, getPublishedVersion = readPublishedVersion,
    onChange = () => {}, onReady = () => {}, onInstallError = () => {}, prepareInstall = async () => {},
    now = Date.now, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval} = {}) {
    Object.assign(this, {createUpdater, getEnabled, getPublishedVersion, onChange, onReady, onInstallError, prepareInstall, now, setIntervalImpl, clearIntervalImpl});
    this._state = {currentVersion: version, latestVersion: '', supported: !unsupported,
      status: unsupported ? 'unsupported' : 'idle', detail: unsupported, progress: 0, available: false, checkedAt: null};
    this._pending = null;
    this._timer = null;
    this._nextCheck = 0;
    this._installing = false;
  }
  state() { return {...this._state, enabled: this.getEnabled()}; }
  _publish(patch) {
    Object.assign(this._state, patch);
    try { this.onChange(this.state()); } catch { /* UI observers cannot break updating. */ }
  }
  _failure() {
    this._publish({status: 'error', detail: '更新未完成，可能是网络、安装包校验或系统权限问题。请重试，或前往发布页面下载。'});
  }
  _updater() {
    if (this.updater) return this.updater;
    const updater = this.createUpdater();
    this.updater = updater;
    updater.logger = null; // Do not expose signed download URLs or native credentials in logs.
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on('error', () => this._failure());
    updater.on('download-progress', value => {
      const progress = Number.isFinite(value.percent) ? Math.max(0, Math.min(100, value.percent)) : 0;
      this._publish({status: 'downloading', progress, detail: '正在后台下载更新…'});
    });
    updater.on('update-downloaded', () => {
      this._publish({status: 'ready', available: false, progress: 100, detail: '更新已下载。重启安装前请保存工作；安装时会校验应用。'});
      try { this.onReady(this.state()); } catch { /* Notification is optional. */ }
    });
    return updater;
  }
  start() {
    if (!this._state.supported || !this.getEnabled() || this._timer !== null) return;
    this._timer = this.setIntervalImpl(() => { void this.check(); }, CHECK_INTERVAL_MS);
    this._timer?.unref?.();
    void this.check();
  }
  stop() {
    if (this._timer !== null) this.clearIntervalImpl(this._timer);
    this._timer = null;
  }
  settingsChanged() {
    this.stop();
    this._publish({});
    this.start();
  }
  check({manual = false} = {}) {
    if (!this._state.supported || this._installing || this._state.status === 'ready') return Promise.resolve(this.state());
    if (this._pending) return this._pending;
    if (!manual && (!this.getEnabled() || this.now() < this._nextCheck)) return Promise.resolve(this.state());
    this._nextCheck = this.now() + CHECK_INTERVAL_MS;
    const operation = this._check().finally(() => { if (this._pending === operation) this._pending = null; });
    this._pending = operation;
    return operation;
  }
  async _check() {
    try {
      this._publish({status: 'checking', available: false, detail: '正在检查 Being Desktop 新版本…', progress: 0});
      // Releases predating auto-update have no latest*.yml. Compare the release
      // tag first, so an equal/older release never requires that missing file.
      // Generic-feed transport fixtures explicitly disable this GitHub preflight.
      if (this.getPublishedVersion) {
        const published = parseVersion(await this.getPublishedVersion());
        if (!published || published.prerelease.length) throw new Error('Invalid published version');
        if (this._noUpdateRequired(published.version)) return this.state();
        this._publish({latestVersion: published.version, checkedAt: new Date(this.now()).toISOString()});
      }
      const updater = this._updater();
      const result = await updater.checkForUpdates();
      const parsed = parseVersion(result?.updateInfo?.version);
      const latest = parsed?.version;
      if (!latest || parsed.prerelease.length) throw new Error('Missing stable version');
      if (this._noUpdateRequired(latest)) return this.state();
      const available = result.isUpdateAvailable === true && compareVersions(latest, this._state.currentVersion) > 0;
      this._publish({latestVersion: latest, checkedAt: new Date(this.now()).toISOString(),
        available, status: available ? 'available' : 'current', detail: available ? `Being Desktop ${latest} 可更新。` : '当前没有适用于此设备的更新。'});
    } catch { this._failure(); }
    return this.state();
  }
  download() {
    if (this._pending) return this._pending;
    if (!this._state.supported || this._installing || !this._state.available ||
      !['available', 'error'].includes(this._state.status)) return Promise.resolve(this.state());
    const operation = this._download().finally(() => { if (this._pending === operation) this._pending = null; });
    this._pending = operation;
    return operation;
  }
  async _download() {
    try {
      this._publish({status: 'downloading', progress: 0, detail: '正在后台下载更新…'});
      await this._updater().downloadUpdate();
      if (this._state.status !== 'ready') throw new Error('Download not confirmed');
    } catch { this._failure(); }
    return this.state();
  }
  _noUpdateRequired(latest) {
    const comparison = compareVersions(this._state.currentVersion, latest);
    if (comparison === null) throw new Error('Invalid current version');
    if (comparison < 0) return false;
    this._publish({status: comparison > 0 ? 'ahead' : 'current', available: false, latestVersion: latest,
      checkedAt: new Date(this.now()).toISOString(), progress: 0,
      detail: comparison > 0
        ? `当前版本 ${this._state.currentVersion} 高于最新发布版 ${latest}，无需更新。`
        : `当前版本 ${this._state.currentVersion} 已是最新发布版。`});
    return true;
  }
  async install(shutdown) {
    if (this._installing || this._state.status !== 'ready') return this.state();
    this._installing = true;
    try {
      this._publish({status: 'installing', detail: '正在验证更新并准备重启…'});
      await this.prepareInstall();
      const completed = await shutdown(() => {
        let failed = false;
        const recover = () => {
          if (failed) return;
          failed = true;
          this.updater.removeListener('error', recover);
          this._failure();
          this.onInstallError();
        };
        this.updater.once('error', recover);
        try { this.updater.quitAndInstall(false, true); } catch { recover(); }
      });
      if (!completed) this._publish({status: 'ready', detail: '重启已取消或未完成，请处理运行中的任务后重试。'});
    } catch { this._failure(); }
    finally { this._installing = false; }
    return this.state();
  }
}

module.exports = {DesktopUpdates, updateSupport, prepareMacUpdate, readPublishedVersion, RELEASE_URL, RELEASE_API, CHECK_INTERVAL_MS};
