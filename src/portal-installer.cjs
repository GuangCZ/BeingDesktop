'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

const PORTAL_RELEASE = Object.freeze({
  version: '0.8.0',
  url: 'https://github.com/d5z/heart-portal/releases/download/v0.8.0/heart-portal-windows-x86_64.exe',
  size: 12193280,
  sha256: '9f0fb1200d756b5c450cc3ff57752648ab4df70622b82df92033f4167426d355',
});
const DOWNLOAD_HOSTS = new Set([
  'github.com', 'release-assets.githubusercontent.com',
  'objects.githubusercontent.com', 'github-releases.githubusercontent.com',
]);

function isAllowedPortalAssetUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && (!url.port || url.port === '443') && DOWNLOAD_HOSTS.has(url.hostname);
  } catch { return false; }
}

function localPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Portal 安装目录无效。');
  }
  return path.resolve(value);
}

async function directoryChain(directory, createLeaf = false) {
  const parsed = path.parse(directory);
  let current = parsed.root;
  const segments = path.relative(parsed.root, directory).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !createLeaf || index !== segments.length - 1) throw error;
      await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Portal 安装目录不能包含符号链接或非目录路径。');
  }
}

class PortalInstaller {
  constructor({ userDataDir, requestImpl = https.request, createHashImpl = crypto.createHash } = {}) {
    this.userDataDir = localPath(userDataDir);
    this.managedDir = path.join(this.userDataDir, 'managed-portal');
    this.versionDir = path.join(this.managedDir, `v${PORTAL_RELEASE.version}`);
    this.executable = path.join(this.versionDir, 'heart-portal.exe');
    this.requestImpl = requestImpl;
    this.createHashImpl = createHashImpl;
    this._installation = null;
  }

  _state(status) {
    return {
      status, phase: 'not_started', version: PORTAL_RELEASE.version,
      executable: this.executable, verified: status === 'installed', started: false,
      size: PORTAL_RELEASE.size, sha256: PORTAL_RELEASE.sha256,
    };
  }

  _progress(callback, phase, receivedBytes = 0) {
    try { callback?.({ phase, receivedBytes, totalBytes: PORTAL_RELEASE.size }); }
    catch { /* Progress observers must not interrupt installation. */ }
  }

  async _directories(create = false) {
    for (const directory of [this.userDataDir, this.managedDir, this.versionDir]) {
      await directoryChain(directory, create);
    }
  }

  async _verifiedFile() {
    const before = await fs.lstat(this.executable);
    if (before.isSymbolicLink() || !before.isFile() || before.size !== PORTAL_RELEASE.size) return false;
    const handle = await fs.open(this.executable, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) return false;
      const hash = this.createHashImpl('sha256');
      const buffer = Buffer.allocUnsafe(128 * 1024);
      let received = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        received += bytesRead;
        if (received > PORTAL_RELEASE.size) return false;
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await fs.lstat(this.executable);
      return !after.isSymbolicLink() && after.ino === before.ino && after.dev === before.dev
        && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs
        && received === PORTAL_RELEASE.size
        && hash.digest('hex') === PORTAL_RELEASE.sha256;
    } finally { await handle.close(); }
  }

  async inspect() {
    try {
      await this._directories();
      return this._state(await this._verifiedFile() ? 'installed' : 'invalid');
    } catch (error) {
      if (error.code === 'ENOENT') return this._state('not_installed');
      throw new Error('无法安全检查 Portal 安装目录。');
    }
  }

  _response(value, redirects = 0) {
    if (!isAllowedPortalAssetUrl(value) || redirects > 4) return Promise.reject(new Error('Portal 下载跳转无效。'));
    return new Promise((resolve, reject) => {
      let request;
      try {
        request = this.requestImpl(new URL(value), {
          method: 'GET', headers: { 'User-Agent': 'Being-Desktop-Portal-Installer', Accept: 'application/octet-stream' },
        }, response => {
          response.on('error', () => reject(new Error('Portal 下载失败，请检查网络后重试。')));
          if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            response.resume();
            let next;
            try { next = new URL(response.headers.location, value).toString(); }
            catch { reject(new Error('Portal 下载跳转无效。')); return; }
            if (!response.headers.location || !isAllowedPortalAssetUrl(next)) {
              reject(new Error('Portal 下载跳转无效。')); return;
            }
            this._response(next, redirects + 1).then(resolve, reject);
            return;
          }
          if (response.statusCode !== 200) {
            response.resume(); reject(new Error('Portal 下载失败，请稍后重试。')); return;
          }
          const length = response.headers['content-length'];
          if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) !== PORTAL_RELEASE.size)) {
            response.destroy(); reject(new Error('Portal 下载文件大小不符。')); return;
          }
          resolve(response);
        });
        request.on('error', () => reject(new Error('Portal 下载失败，请检查网络后重试。')));
        request.end();
      } catch { reject(new Error('Portal 下载失败，请稍后重试。')); }
    });
  }

  install({ onProgress } = {}) {
    if (this._installation) return this._installation;
    this._installation = this._install(onProgress).finally(() => { this._installation = null; });
    return this._installation;
  }

  async _install(onProgress) {
    let temporary, temporaryOwned = false, handle, response;
    try {
      await this._directories(true);
      const existing = await this.inspect();
      if (existing.verified) {
        this._progress(onProgress, 'not_started', PORTAL_RELEASE.size);
        return existing;
      }
      // Never replace a user-created link or directory at the managed binary path.
      const prior = await fs.lstat(this.executable).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (prior && (prior.isSymbolicLink() || !prior.isFile())) throw new Error('Portal 安装目标不是实际文件。');
      temporary = path.join(this.versionDir, `heart-portal.${crypto.randomUUID()}.tmp`);
      handle = await fs.open(temporary, 'wx', 0o600);
      temporaryOwned = true;
      this._progress(onProgress, 'download');
      response = await this._response(PORTAL_RELEASE.url);
      const hash = this.createHashImpl('sha256');
      let received = 0;
      for await (const data of response) {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        received += chunk.length;
        if (received > PORTAL_RELEASE.size) throw new Error('Portal 下载文件超过大小限制。');
        hash.update(chunk);
        await handle.writeFile(chunk);
        this._progress(onProgress, 'download', received);
      }
      if (received !== PORTAL_RELEASE.size) throw new Error('Portal 下载不完整。');
      this._progress(onProgress, 'hash', received);
      if (hash.digest('hex') !== PORTAL_RELEASE.sha256) throw new Error('Portal 文件校验失败，未安装。');
      await handle.sync();
      await handle.close();
      handle = null;
      await this._directories();
      const target = await fs.lstat(this.executable).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (target && (target.isSymbolicLink() || !target.isFile())) throw new Error('Portal 安装目标不是实际文件。');
      this._progress(onProgress, 'install', received);
      await fs.rename(temporary, this.executable);
      temporary = null;
      temporaryOwned = false;
      this._progress(onProgress, 'not_started', received);
      return this._state('installed');
    } catch (error) {
      const safeMessages = new Set([
        'Portal 下载跳转无效。', 'Portal 下载失败，请稍后重试。', 'Portal 下载失败，请检查网络后重试。',
        'Portal 下载文件大小不符。', 'Portal 下载文件超过大小限制。', 'Portal 下载不完整。',
        'Portal 文件校验失败，未安装。', 'Portal 安装目标不是实际文件。',
      ]);
      throw new Error(safeMessages.has(error.message) ? error.message : 'Portal 安装失败，请检查本地目录和网络。');
    } finally {
      response?.destroy();
      if (handle) await handle.close().catch(() => {});
      if (temporaryOwned && temporary) await fs.unlink(temporary).catch(() => {});
    }
  }
}

module.exports = { PORTAL_RELEASE, PortalInstaller, isAllowedPortalAssetUrl };
