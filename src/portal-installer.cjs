'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

const PORTAL_RELEASE = Object.freeze({
  version: '0.8.3',
  apiUrl:'https://api.github.com/repos/d5z/heart-portal/releases/assets/557419976',
  url: 'https://github.com/d5z/heart-portal/releases/download/v0.8.3/heart-portal-windows-x86_64.exe',
  size: 12004864,
  sha256: '5aec4a09bada241ebba3d8335042cc47cc552f4ff66e831ad5f0d370bab88032',
});
const PORTAL_RELEASES = Object.freeze({
  'win32-x64': PORTAL_RELEASE,
  'darwin-arm64': Object.freeze({version:'0.8.3',apiUrl:'https://api.github.com/repos/d5z/heart-portal/releases/assets/557419975',
    url:'https://github.com/d5z/heart-portal/releases/download/v0.8.3/heart-portal-macos-arm64',
    size:12205520, sha256:'dad9d81b491195cc302e2552d181d8dba43b8f2c800f079922f8cb350badab42'}),
  'darwin-x64': Object.freeze({version:'0.8.3',apiUrl:'https://api.github.com/repos/d5z/heart-portal/releases/assets/557419978',
    url:'https://github.com/d5z/heart-portal/releases/download/v0.8.3/heart-portal-macos-x86_64',
    size:12767152, sha256:'99e884f56ea6b755787fa99ba52bdf9f413d3bf17f64a92eba4e8aecabf39f6d'}),
});
function portalRelease(platform = process.platform, arch = process.arch) {
  return PORTAL_RELEASES[`${platform}-${arch}`] || null;
}
const DOWNLOAD_HOSTS = new Set([
  'api.github.com', 'github.com', 'release-assets.githubusercontent.com',
  'objects.githubusercontent.com', 'github-releases.githubusercontent.com',
]);

function isAllowedPortalAssetUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && (!url.port || url.port === '443') && DOWNLOAD_HOSTS.has(url.hostname)
      && (url.hostname !== 'api.github.com' || /^\/repos\/d5z\/heart-portal\/releases\/assets\/[1-9]\d*$/.test(url.pathname) && !url.search && !url.hash);
  } catch { return false; }
}

function validateRelease(release, platform = process.platform, arch = process.arch) {
  const target = portalRelease(platform, arch);
  const name = target && new URL(target.url).pathname.split('/').at(-1);
  if (!release || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.version)
      || !Number.isSafeInteger(release.size) || release.size <= 0 || release.size > 256 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(release.sha256)
      || release.url !== `https://github.com/d5z/heart-portal/releases/download/v${release.version}/${name}`
      || release.apiUrl !== undefined && !/^https:\/\/api\.github\.com\/repos\/d5z\/heart-portal\/releases\/assets\/[1-9]\d*$/.test(release.apiUrl)) {
    throw new Error('Portal 更新包元数据无效或缺少 SHA-256 校验。');
  }
  return Object.freeze({version:release.version, url:release.url, size:release.size, sha256:release.sha256,...(release.apiUrl?{apiUrl:release.apiUrl}:{})});
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
  constructor({ userDataDir, requestImpl = https.request, createHashImpl = crypto.createHash, platform = process.platform, arch = process.arch, release, runtimeRoot } = {}) {
    this.release = release ? validateRelease(release, platform, arch) : portalRelease(platform, arch);
    if (!this.release) throw new Error('当前平台没有已校验的 Portal 安装包。');
    this.platform = platform;
    this.arch = arch;
    this.userDataDir = localPath(userDataDir);
    this.runtimeRoot = runtimeRoot ? localPath(runtimeRoot) : this.userDataDir;
    this.managedDir = path.join(this.runtimeRoot, runtimeRoot ? 'desktop-runtime' : 'managed-portal');
    this.versionDir = path.join(this.managedDir, platform === 'win32' ? `v${this.release.version}` : `v${this.release.version}-${platform}-${arch}`);
    this.executable = path.join(this.versionDir, platform === 'win32' ? 'heart-portal.exe' : 'heart-portal');
    this.requestImpl = requestImpl;
    this.createHashImpl = createHashImpl;
    this._installation = null;
  }

  _state(status) {
    return {
      status, phase: 'not_started', version: this.release.version,
      executable: this.executable, verified: status === 'installed', started: false,
      size: this.release.size, sha256: this.release.sha256,
    };
  }

  _progress(callback, phase, receivedBytes = 0) {
    try { callback?.({ phase, receivedBytes, totalBytes: this.release.size }); }
    catch { /* Progress observers must not interrupt installation. */ }
  }

  async _directories(create = false) {
    for (const directory of [this.userDataDir, this.runtimeRoot, this.managedDir, this.versionDir]) {
      await directoryChain(directory, create);
    }
  }

  async _verifiedFile() {
    const before = await fs.lstat(this.executable);
    if (before.isSymbolicLink() || !before.isFile() || before.size !== this.release.size
      || (this.platform === 'darwin' && !(before.mode & 0o100))) return false;
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
        if (received > this.release.size) return false;
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await fs.lstat(this.executable);
      return !after.isSymbolicLink() && after.ino === before.ino && after.dev === before.dev
        && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs
        && received === this.release.size
        && hash.digest('hex') === this.release.sha256;
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

  _response(value, redirects = 0, signal) {
    if (!isAllowedPortalAssetUrl(value) || redirects > 4) return Promise.reject(new Error('Portal 下载跳转无效。'));
    return new Promise((resolve, reject) => {
      let request;
      const done = (error, response) => {
        clearTimeout(deadline); signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(response);
      };
      const abort = () => { done(new Error('Portal 下载已取消。')); request?.destroy?.(); };
      const deadline = setTimeout(() => { done(new Error('Portal 下载连接超时，请稍后重试。')); request?.destroy?.(); }, 20000);
      deadline.unref?.();
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, {once:true});
      try {
        request = this.requestImpl(new URL(value), {
          method: 'GET', headers: { 'User-Agent': 'Being-Desktop-Portal-Installer', Accept: 'application/octet-stream' },
        }, response => {
          response.on('error', () => done(new Error('Portal 下载失败，请检查网络后重试。')));
          if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            response.resume();
            let next;
            try { next = new URL(response.headers.location, value).toString(); }
            catch { done(new Error('Portal 下载跳转无效。')); return; }
            if (!response.headers.location || !isAllowedPortalAssetUrl(next)) {
              done(new Error('Portal 下载跳转无效。')); return;
            }
            clearTimeout(deadline); signal?.removeEventListener('abort', abort);
            this._response(next, redirects + 1, signal).then(resolve, reject);
            return;
          }
          if (response.statusCode !== 200) {
            response.resume(); done(new Error('Portal 下载失败，请稍后重试。')); return;
          }
          const length = response.headers['content-length'];
          if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) !== this.release.size)) {
            response.destroy(); done(new Error('Portal 下载文件大小不符。')); return;
          }
          done(null,response);
        });
        request.on('error', () => done(new Error('Portal 下载失败，请检查网络后重试。')));
        request.end();
      } catch { done(new Error('Portal 下载失败，请稍后重试。')); }
    });
  }

  install({ onProgress, signal } = {}) {
    if (this._installation) return this._installation;
    this._installation = this._install(onProgress, signal).finally(() => { this._installation = null; });
    return this._installation;
  }

  async _install(onProgress, signal) {
    let temporary, temporaryOwned = false, handle, response, bodyDeadline;
    const abort = () => response?.destroy(new Error('Portal 下载已取消。'));
    try {
      await this._directories(true);
      const existing = await this.inspect();
      if (existing.verified) {
        this._progress(onProgress, 'not_started', this.release.size);
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
      try { response = await this._response(this.release.url, 0, signal); }
      catch(error) {
        if (signal?.aborted || !this.release.apiUrl) throw error;
        response = await this._response(this.release.apiUrl, 0, signal);
      }
      if (signal?.aborted) throw new Error('Portal 下载已取消。');
      signal?.addEventListener('abort', abort, {once:true});
      bodyDeadline = setTimeout(() => response.destroy(new Error('Portal 下载超时，请稍后重试。')), 300000);
      bodyDeadline.unref?.();
      const hash = this.createHashImpl('sha256');
      let received = 0;
      for await (const data of response) {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        received += chunk.length;
        if (received > this.release.size) throw new Error('Portal 下载文件超过大小限制。');
        hash.update(chunk);
        await handle.writeFile(chunk);
        this._progress(onProgress, 'download', received);
      }
      if (received !== this.release.size) throw new Error('Portal 下载不完整。');
      this._progress(onProgress, 'hash', received);
      if (hash.digest('hex') !== this.release.sha256) throw new Error('Portal 文件校验失败，未安装。');
      if (this.platform === 'darwin') await handle.chmod(0o700);
      await handle.sync();
      await handle.close();
      handle = null;
      await this._directories();
      const target = await fs.lstat(this.executable).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (target && (target.isSymbolicLink() || !target.isFile())) throw new Error('Portal 安装目标不是实际文件。');
      if (signal?.aborted) throw new Error('Portal 下载已取消。');
      this._progress(onProgress, 'install', received);
      await fs.rename(temporary, this.executable);
      temporary = null;
      temporaryOwned = false;
      this._progress(onProgress, 'not_started', received);
      return this._state('installed');
    } catch (error) {
      const safeMessages = new Set([
        'Portal 下载已取消。', 'Portal 下载超时，请稍后重试。', 'Portal 下载连接超时，请稍后重试。',
        'Portal 下载跳转无效。', 'Portal 下载失败，请稍后重试。', 'Portal 下载失败，请检查网络后重试。',
        'Portal 下载文件大小不符。', 'Portal 下载文件超过大小限制。', 'Portal 下载不完整。',
        'Portal 文件校验失败，未安装。', 'Portal 安装目标不是实际文件。',
      ]);
      throw new Error(safeMessages.has(error.message) ? error.message : 'Portal 安装失败，请检查本地目录和网络。');
    } finally {
      clearTimeout(bodyDeadline);signal?.removeEventListener('abort',abort);
      response?.destroy();
      if (handle) await handle.close().catch(() => {});
      if (temporaryOwned && temporary) await fs.unlink(temporary).catch(() => {});
    }
  }
}

module.exports = { PORTAL_RELEASE, PORTAL_RELEASES, portalRelease, validateRelease, directoryChain, PortalInstaller, isAllowedPortalAssetUrl };
