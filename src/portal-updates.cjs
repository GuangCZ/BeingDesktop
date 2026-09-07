'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');

const execFileAsync = promisify(execFile);
const RELEASE_API = 'https://api.github.com/repos/d5z/heart-portal/releases/latest';
const RELEASE_ROOT = 'https://github.com/d5z/heart-portal/releases';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 15 * 60 * 1000;
const MAX_RELEASE_BYTES = 1024 * 1024;

function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4]?.split('.') || [];
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null;
  return {version: value.replace(/^v/, ''), major, minor, patch, prerelease};
}

function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index], y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn !== yn) return xn ? -1 : 1;
    if (xn && x.length !== y.length) return x.length > y.length ? 1 : -1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function parsePortalRelease(value) {
  const tag = value?.tag_name;
  const parsed = parseVersion(tag);
  if (!parsed || !/^v?\d+\.\d+\.\d+$/.test(tag) || value.draft !== false || value.prerelease !== false
      || value.html_url !== `${RELEASE_ROOT}/tag/${tag}` || !Array.isArray(value.assets)) {
    throw new Error('官方 Portal 版本信息暂不可用，请稍后重试。');
  }
  const name = 'heart-portal-windows-x86_64.exe';
  const asset = value.assets.find(item => item?.name === name && item.state === 'uploaded'
    && Number.isSafeInteger(item.size) && item.size > 0
    && item.browser_download_url === `${RELEASE_ROOT}/download/${tag}/${name}`);
  if (!asset) throw new Error('官方 Portal 的 Windows 新版本尚未就绪，请稍后重试。');
  return {version: parsed.version, url: value.html_url};
}

async function readPortalVersion(executable, {statImpl = fs.lstat, execImpl = execFileAsync} = {}) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || /[\x00-\x1f\x7f]/.test(executable)
      || !/^heart-portal(?:[a-z0-9._-]*\.exe)?$/i.test(path.basename(executable))) return '';
  try {
    const stat = await statImpl(executable);
    if (!stat.isFile() || stat.isSymbolicLink()) return '';
    // This deadline applies only to a local version probe, never to a Portal session.
    const result = await execImpl(executable, ['--version'], {windowsHide: true, shell: false, timeout: 5000, maxBuffer: 4096});
    const match = /^heart-portal\s+(\S+)$/.exec(String(result.stdout || '').trim());
    return match ? parseVersion(match[1])?.version || '' : '';
  } catch { return ''; }
}

async function readReleaseResponse(response) {
  if (!response?.ok || response.status !== 200) {
    await response?.body?.cancel().catch(() => {});
    throw new Error('暂时无法检查 Portal 更新，请稍后重试。');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('官方 Portal 版本信息暂不可用，请稍后重试。');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RELEASE_BYTES) throw new Error('官方 Portal 版本信息暂不可用，请稍后重试。');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function emptyState() {
  return {status: 'idle', currentVersion: '', latestVersion: '', releaseUrl: '', checkedAt: null, detail: '', checking: false, available: false};
}

class PortalUpdates {
  constructor({getExecutable = () => '', readVersion = readPortalVersion, fetchImpl = globalThis.fetch, now = Date.now,
    onChange = () => {}, onAvailable = () => {}, getNotifiedVersion = () => '',
    setIntervalImpl = setInterval, clearIntervalImpl = clearInterval} = {}) {
    Object.assign(this, {getExecutable, readVersion, fetchImpl, now, onChange, onAvailable, getNotifiedVersion, setIntervalImpl, clearIntervalImpl});
    this._state = emptyState();
    this._executable = '';
    this._nextCheck = 0;
    this._revision = 0;
    this._pending = null;
    this._controller = null;
    this._timer = null;
    this._notified = '';
  }

  state() {
    return {...(this.getExecutable() === this._executable ? this._state : emptyState())};
  }

  _publish(patch) {
    Object.assign(this._state, patch);
    try { this.onChange(this.state()); } catch { /* Observers cannot stop update checks. */ }
  }

  start() {
    if (this._timer === null) {
      this._timer = this.setIntervalImpl(() => { void this.check(); }, RETRY_INTERVAL_MS);
      this._timer?.unref?.();
    }
    void this.check();
  }

  stop() {
    if (this._timer !== null) this.clearIntervalImpl(this._timer);
    this._timer = null;
    this._revision++;
    this._controller?.abort();
    this._controller = null;
    this._pending = null;
    if (this._state.checking) this._publish({checking: false, status: this._state.available ? 'available' : 'idle'});
  }

  changed() {
    this._revision++;
    this._controller?.abort();
    this._controller = null;
    this._pending = null;
    this._executable = this.getExecutable();
    this._state = emptyState();
    this._nextCheck = 0;
    return this.check({force: true});
  }

  check({force = false} = {}) {
    const executable = this.getExecutable();
    if (executable !== this._executable) return this.changed();
    if (this._pending) return this._pending;
    if (!force && this.now() < this._nextCheck) return Promise.resolve(this.state());
    if (!executable) {
      this._publish({...emptyState(), status: 'not_installed', detail: '配置 Portal 后会自动检查更新。'});
      return Promise.resolve(this.state());
    }
    const revision = ++this._revision;
    const controller = new AbortController();
    this._controller = controller;
    const current = () => revision === this._revision && executable === this.getExecutable() && !controller.signal.aborted;
    this._publish({checking: true, status: 'checking', detail: '正在检查官方 Portal 新版本…'});
    const pending = this._check(executable, controller.signal, current).finally(() => {
      if (this._pending === pending) { this._pending = null; this._controller = null; }
    });
    this._pending = pending;
    return pending;
  }

  async _check(executable, signal, current) {
    try {
      const version = parseVersion(await this.readVersion(executable))?.version || '';
      if (!current()) return this.state();
      this._publish({currentVersion: version, available: Boolean(version && this._state.latestVersion
        && compareVersions(this._state.latestVersion, version) > 0)});
      const response = await this.fetchImpl(RELEASE_API, {method: 'GET', credentials: 'omit', redirect: 'error',
        referrerPolicy: 'no-referrer', cache: 'no-store', signal,
        headers: {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Being-Desktop-Portal-Updates'}});
      const release = parsePortalRelease(await readReleaseResponse(response));
      if (!current()) return this.state();
      this._nextCheck = this.now() + CHECK_INTERVAL_MS;
      const available = Boolean(version && compareVersions(release.version, version) > 0);
      this._publish({status: !version ? 'unknown' : available ? 'available' : 'current', checking: false,
        currentVersion: version, latestVersion: release.version, releaseUrl: release.url, available,
        checkedAt: new Date(this.now()).toISOString(), detail: !version
          ? `无法识别所选 Portal 的版本，官方最新稳定版为 ${release.version}。`
          : available ? `Portal ${release.version} 已发布，当前版本为 ${version}。`
            : compareVersions(version, release.version) > 0 ? `当前版本为 ${version}，官方最新稳定版为 ${release.version}。` : `Portal ${version} 已是最新稳定版。`});
      const previouslyNotified = [this._notified, this.getNotifiedVersion()].some(value => compareVersions(value, release.version) >= 0 && parseVersion(value));
      if (available && !previouslyNotified && current()) {
        try {
          const delivered = await this.onAvailable(this.state());
          if (delivered !== false && current()) this._notified = release.version;
        } catch { /* Failed notifications remain eligible for a later check. */ }
      }
    } catch {
      if (current()) {
        this._nextCheck = this.now() + RETRY_INTERVAL_MS;
        this._publish({status: 'error', checking: false, detail: '暂时无法检查 Portal 更新，请检查网络后重试。'});
      }
    }
    return this.state();
  }
}

module.exports = {PortalUpdates, parseVersion, compareVersions, parsePortalRelease, readPortalVersion, RELEASE_API, CHECK_INTERVAL_MS, RETRY_INTERVAL_MS};
