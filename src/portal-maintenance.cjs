'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {readPortalVersion, compareVersions, parseVersion} = require('./portal-updates.cjs');
const {directoryChain, validateRelease} = require('./portal-installer.cjs');
const {regular, hash} = require('./portal-launchagent.cjs');
const execute = promisify(execFile);
const json = async file => JSON.parse((await regular(file)).toString('utf8'));
const fileHash = async file => hash(await regular(file, 256 * 1024 * 1024));

async function durableJson(file, value) {
  await directoryChain(path.dirname(file));
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(temporary, file);
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

async function replaceBinary(source, target, {sourceHash, targetHashes} = {}) {
  await regular(target, 256 * 1024 * 1024);
  await regular(source, 256 * 1024 * 1024);
  const temporary = path.join(path.dirname(target), `.portal-desktop-${crypto.randomUUID()}.tmp`);
  try {
    await fs.copyFile(source, temporary, require('node:fs').constants.COPYFILE_EXCL);
    await fs.chmod(temporary, 0o700);
    if (sourceHash && await fileHash(temporary) !== sourceHash) throw new Error('Portal 更新文件在应用前发生变化。');
    if (targetHashes && !targetHashes.includes(await fileHash(target))) throw new Error('Portal 目标程序在应用前发生变化。');
    const handle = await fs.open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, target);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

// Discovery never establishes version compatibility. This Desktop has been
// tested against the 0.8 protocol; new minor/major lines require a new validation.
function compatibleRelease(version) {
  const v = parseVersion(version);
  return Boolean(v && v.major === 0 && v.minor === 8 && v.patch >= 3 && !v.prerelease.length);
}

class PortalMaintenance {
  constructor({userDataDir, resolveAdapter, createInstaller, verify, getContext = () => '', onChange = () => {},
    readVersion = readPortalVersion, execImpl = execute, platform = process.platform, arch = process.arch} = {}) {
    Object.assign(this, {resolveAdapter, createInstaller, verify, getContext, onChange, readVersion, execImpl, platform, arch});
    this.directory = path.join(userDataDir, 'portal-updates');
    this.pendingFile = path.join(this.directory, 'pending.json');
    this.journalFile = path.join(this.directory, 'transaction.json');
    this.lockFile = path.join(this.directory, 'operation.lock');
    this._state = {phase:'idle', busy:false, supported:false, kind:'unknown', version:'', detail:''};
    this._operation = null;
    this._pending = null;
  }
  state() { return {...this._state}; }
  publish(patch) { Object.assign(this._state, patch); try { this.onChange(this.state()); } catch {} }
  async refresh() {
    if (this._operation) return this.state();
    try {
      const adapter = await this.resolveAdapter();
      const current = adapter && await adapter.state();
      this.publish({supported:Boolean(adapter), kind:adapter?.kind || 'unknown', running:current?.running === true});
    } catch { this.publish({supported:false, kind:'unknown'}); }
    return this.state();
  }
  async initialize() {
    await directoryChain(this.directory, true);
    try { this._pending = await json(this.pendingFile); }
    catch (error) { if (error.code !== 'ENOENT') this.publish({phase:'error',detail:'更新记录无法读取，请重新下载更新。'}); }
    if (this._pending) this.publish({phase:'ready',version:this._pending.release?.version || '',detail:'更新包已准备，应用时将重启 Portal。'});
    await this.refresh();
    try {
      await regular(this.journalFile);
      await this.run(() => this.recover());
    } catch (error) {
      if (error.code !== 'ENOENT') this.publish({phase:'recovery_required',detail:'上次更新尚未恢复，请检查原部署与更新记录后重试。'});
    }
    return this.state();
  }
  run(fn) {
    if (this._operation) return Promise.reject(new Error('Portal 正在更新，请等待当前操作完成。'));
    this._operation = (async () => {
      await directoryChain(this.directory, true);
      let owner;
      try {
        owner = await fs.open(this.lockFile, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const old = await json(this.lockFile);
        if (!Number.isSafeInteger(old.pid) || old.pid <= 0) throw new Error('Portal 更新锁需要检查。');
        let alive = true;
        try { process.kill(old.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
        if (alive) throw new Error('另一个进程正在管理 Portal 更新。');
        await fs.unlink(this.lockFile);
        owner = await fs.open(this.lockFile, 'wx', 0o600);
      }
      try {
        await owner.writeFile(JSON.stringify({pid:process.pid})); await owner.sync();
        this.publish({busy:true});
        return await fn();
      } finally { await owner.close(); await fs.unlink(this.lockFile); this.publish({busy:false}); }
    })().finally(() => { this._operation = null; });
    return this._operation;
  }
  stage(release) { return this.run(() => this._stage(release)); }
  cancelDownload() { if (this._state.phase === 'downloading') this._downloadController?.abort(); }
  async _stage(value) {
    const release = validateRelease(value, this.platform, this.arch);
    if (!compatibleRelease(release.version)) throw new Error('此 Portal 版本超出 Desktop 已验证的兼容范围，请先更新 Desktop。');
    const adapter = await this.resolveAdapter();
    if (!adapter) throw new Error('尚未识别原 Portal 的管理方式，不能应用更新。');
    const current = await adapter.state(), context = this.getContext();
    const before = await this.readVersion(current.executable);
    if (!before || compareVersions(release.version, before) <= 0) throw new Error('当前 Portal 无需应用此更新。');
    this.publish({phase:'downloading',version:release.version,detail:'正在下载并校验官方 Portal 更新包…'});
    const controller = new AbortController(); this._downloadController = controller;
    try {
      const installer = this.createInstaller(release);
      const result = await installer.install({signal:controller.signal,onProgress:event => this.publish({receivedBytes:event.receivedBytes,totalBytes:event.totalBytes})});
      if (controller.signal.aborted) throw new Error('Portal 下载已取消。');
      if (await this.readVersion(result.executable) !== release.version) throw new Error('下载程序的版本与官方元数据不符。');
      if (this.platform === 'darwin') {
        try { await this.execImpl('/usr/bin/codesign', ['--verify','--strict',result.executable], {shell:false,timeout:15000,maxBuffer:4096}); }
        catch { throw new Error('Portal 程序签名验证失败，未应用更新。'); }
      }
      if (this.getContext() !== context) throw new Error('Being 连接已变化，请重新检查更新。');
      const after = await adapter.state();
      if (after.executable !== current.executable || after.configPath !== current.configPath) throw new Error('Portal 部署已变化，请重新检查更新。');
      this._pending = {release, candidate:result.executable, target:current.executable, configPath:current.configPath,
        kind:adapter.kind, targetHash:await fileHash(current.executable), configHash:await fileHash(current.configPath)};
      await durableJson(this.pendingFile, this._pending);
      this.publish({phase:'ready',detail:'更新已就绪。后台不会中断工具任务；空闲后可停止并更新。'});
      return this.state();
    } catch (error) { this.publish({phase:'error',detail:error.message}); throw error; }
    finally { if(this._downloadController===controller)this._downloadController=null; }
  }
  apply({restart = false} = {}) { return this.run(() => this._apply(restart)); }
  async _apply(restart) {
    // Recover before accepting any new transaction, even within the same app run.
    try { await regular(this.journalFile); await this.recover(); return this.state(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const pending = this._pending || await json(this.pendingFile);
    const release = validateRelease(pending.release, this.platform, this.arch);
    const installer = this.createInstaller(release);
    if (!compatibleRelease(release.version) || pending.candidate !== installer.executable || !(await installer.inspect()).verified) {
      throw new Error('更新包已变化，请重新下载。');
    }
    const adapter = await this.resolveAdapter();
    const current = adapter && await adapter.state();
    if (!current || adapter.kind !== pending.kind || current.executable !== pending.target || current.configPath !== pending.configPath
        || await fileHash(current.executable) !== pending.targetHash || await fileHash(current.configPath) !== pending.configHash) {
      throw new Error('Portal 程序或配置已变化，请重新下载并检查更新。');
    }
    // No Portal-wide drain API exists in 0.8.3. Automatic callers must never
    // infer idleness from the current Desktop chat, a quiet log, or a timer.
    if (current.running && !restart) {
      this.publish({phase:'waiting',detail:'更新已就绪，等待 Portal 停止；后台不会中断正在执行的任务。'});
      return this.state();
    }
    const context = this.getContext();
    const id = crypto.randomUUID(), directory = path.join(this.directory, id);
    await fs.mkdir(directory, {mode:0o700});
    const transaction = {id, phase:'prepared', pending, previous:current, directory,
      backup:path.join(directory,'heart-portal'), plistBackup:current.plist ? path.join(directory,'launchagent.plist') : '',
      shouldRun:current.running || restart, context};
    await fs.copyFile(current.executable, transaction.backup); await fs.chmod(transaction.backup, 0o700);
    if (await fileHash(transaction.backup) !== pending.targetHash) throw new Error('备份期间 Portal 程序发生变化，请重新检查更新。');
    if (transaction.plistBackup) { await fs.copyFile(current.plist, transaction.plistBackup); await fs.chmod(transaction.plistBackup, 0o600); }
    if(adapter.prepareUpdate)transaction.supportFiles=await adapter.prepareUpdate(directory,pending.candidate);
    await durableJson(this.journalFile, transaction);
    try {
      this.publish({phase:'stopping',detail:'正在通过原管理方式停止 Portal…'});
      await adapter.stop();
      if (this.getContext() !== context) throw new Error('Being 连接已变化，正在恢复原 Portal。');
      if (await fileHash(current.configPath) !== pending.configHash) throw new Error('Portal 配置已变化，停止本次更新。');
      transaction.phase = 'replacing'; await durableJson(this.journalFile, transaction);
      this.publish({phase:'replacing',detail:'正在应用 Portal 更新，保留旧版本供回滚。'});
      if (adapter.kind === 'launchagent' || adapter.inPlace) {
        if(adapter.prepareSupervision)await adapter.prepareSupervision();
        transaction.updatedDescriptor = {...adapter.descriptor};
        await durableJson(this.journalFile, transaction);
        if(adapter.replaceSupport)await adapter.replaceSupport(directory,transaction.supportFiles);
        if ((await adapter.state()).running) throw new Error('Portal 在更新期间重新启动，已暂停替换。');
        await replaceBinary(pending.candidate, current.executable, {sourceHash:release.sha256,targetHashes:[pending.targetHash]});
      } else {
        await adapter.activate(pending.candidate, release.version, release);
      }
      transaction.phase = 'verifying'; await durableJson(this.journalFile, transaction);
      this.publish({phase:'verifying',detail:'正在验证新版本进程、连接和工具注册…'});
      if (transaction.shouldRun) {
        const marker = await adapter.mark?.();
        await adapter.start();
        const verification = await this.verify(adapter, release, marker);
        if (!verification?.passed) throw new Error('新 Portal 验证未通过，正在恢复旧版本。');
        transaction.verification = verification;
      } else {
        if (await this.readVersion((await adapter.state()).executable) !== release.version) throw new Error('新 Portal 程序版本未通过验证。');
        transaction.verification = {passed:true,connection:'not_started',tools:'not_started'};
      }
      if (this.getContext() !== context) throw new Error('Being 连接已变化，正在恢复原 Portal。');
      await durableJson(this.journalFile, {...transaction,phase:'committed'}); transaction.phase = 'committed';
      await this.finish(transaction, 'complete');
      this.publish({phase:'complete',verification:transaction.verification,detail:transaction.shouldRun
        ? `Portal ${release.version} 已更新，启动与连接验证通过。` : `Portal ${release.version} 已安装；启动后仍需验证连接与工具。`});
      return this.state();
    } catch (error) {
      if (transaction.phase === 'committed') {
        this.publish({phase:'recovery_required',detail:'新版已验证并提交，更新记录尚未清理；恢复操作将完成记录清理，不会重复应用更新。'});
        throw new Error('Portal 已更新，更新记录尚待清理。');
      }
      await this.rollback(transaction, adapter);
      this.publish({phase:'rolled_back',detail:'更新未完成，已恢复旧版本；不会重放工具调用或消息。'});
      throw new Error('Portal 更新未完成，已恢复旧版本。');
    }
  }
  async finish(transaction, outcome) {
    await durableJson(path.join(transaction.directory,'result.json'), {...transaction,outcome});
    await fs.unlink(this.pendingFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.unlink(this.journalFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
    this._pending = null;
  }
  async rollback(transaction, adapter) {
    this.publish({phase:'rolling_back',detail:'正在恢复更新前的程序和启动方式…'});
    try {
      if (await fileHash(transaction.backup) !== transaction.pending.targetHash) throw new Error('Backup changed');
      await adapter.stop();
      if (adapter.kind === 'launchagent' || adapter.inPlace) {
        const currentHash = await fileHash(transaction.previous.executable);
        if (![transaction.pending.targetHash, transaction.pending.release.sha256].includes(currentHash)) throw new Error('Target changed');
        await replaceBinary(transaction.backup, transaction.previous.executable, {sourceHash:transaction.pending.targetHash,targetHashes:[transaction.pending.targetHash,transaction.pending.release.sha256]});
        if(adapter.restorePlist) {
          if (await fileHash(transaction.plistBackup) !== transaction.previous.plistHash) throw new Error('LaunchAgent backup changed');
          await adapter.restorePlist(transaction.plistBackup);
        }
        if(adapter.replaceSupport)await adapter.replaceSupport(transaction.directory,transaction.supportFiles,true);
      } else {
        await adapter.activate(transaction.previous.executable, transaction.previous.version, transaction.previous.release);
      }
      if (transaction.previous.running && (adapter.kind !== 'desktop' || this.getContext() === transaction.context)) await adapter.start();
      await this.finish(transaction,'rolled_back');
    } catch {
      this.publish({phase:'recovery_required',detail:'旧版本备份已保留，恢复尚未确认。请检查原 Portal 部署后重试恢复。'});
      throw new Error('Portal 更新中断，恢复尚未确认；备份和事务记录已保留。');
    }
  }
  async recover() {
    const transaction = await json(this.journalFile);
    if (!/^[a-f0-9-]{36}$/.test(transaction.id) || transaction.directory !== path.join(this.directory,transaction.id)
        || transaction.backup !== path.join(transaction.directory,'heart-portal')
        || transaction.plistBackup && transaction.plistBackup !== path.join(transaction.directory,'launchagent.plist')) throw new Error('更新恢复记录无效。');
    if (transaction.phase === 'committed') { await this.finish(transaction,'complete'); this.publish({phase:'complete',detail:'已恢复上次成功的更新记录。'}); return; }
    try {
      const result = await json(path.join(transaction.directory,'result.json'));
      if (result.id === transaction.id && result.outcome === 'rolled_back') {
        await this.finish(transaction,'rolled_back'); this.publish({phase:'rolled_back',detail:'旧版本已恢复，事务记录已清理。'}); return;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const adapter = await this.resolveAdapter(transaction);
    if (!adapter || adapter.kind !== transaction.pending.kind) throw new Error('无法匹配需要恢复的 Portal。');
    const current = await adapter.state();
    if (current.configPath !== transaction.previous.configPath || ![transaction.previous.executable,transaction.pending.candidate].includes(current.executable)) throw new Error('Portal 部署已变化。');
    await this.rollback(transaction, adapter);
    this.publish({phase:'rolled_back',detail:'已恢复中断的更新，旧版本可继续使用。'});
  }
}

module.exports = {PortalMaintenance, compatibleRelease, replaceBinary, durableJson, fileHash};
