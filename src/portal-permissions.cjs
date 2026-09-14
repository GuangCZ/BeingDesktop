'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const {createPortalConfig, normalizePortalPermissions} = require('./portal-config.cjs');
const {readConfig, grovePortalConfigText} = require('./grove-portal.cjs');
const {adoptionRecord,matchesAdoption}=require('./portal-adoption.cjs');
const {parseToolPermissions,editToolPermissions}=require('./portal-tools-config.cjs');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

async function inspectPortalPermissions(settings, {adapter}={}) {
  if(adapter && adapter.kind!=='desktop') {
    if(!matchesAdoption(settings.adoptedPortal,adoptionRecord(adapter)))throw new Error('请先一键接管此 Portal，再管理工具权限。');
    const deployment=await adapter.state(),source=await readConfig(deployment.configPath);
    return {permissions:parseToolPermissions(source.text).permissions,revision:digest(source.bytes),source,
      configPath:deployment.configPath,adoption:settings.adoptedPortal,managed:null};
  }
  const managed = settings.managedPortal;
  if (!managed || managed.configPath!==settings.portalConfig || managed.executable!==settings.portalExecutable) {
    throw new Error('请先配置或接管 Portal。手动选择的配置请在原配置文件中管理权限。');
  }
  const permissions = normalizePortalPermissions(managed.permissions);
  const configuration = await createPortalConfig({workspace:managed.workspace,permissions});
  const expected = managed.groveKitsDir ? grovePortalConfigText(configuration.toml,managed.groveKitsDir) : configuration.toml;
  const source = await readConfig(managed.configPath);
  if (source.text!==expected) throw new Error('Portal 配置已在外部修改，请在原配置文件中管理权限；桌面端不会覆盖它。');
  return {permissions, revision:digest(source.bytes), source, managed,configPath:managed.configPath};
}

async function savePortalPermissions({settings,request,persist,adapter,backup=false}) {
  const permissions = normalizePortalPermissions(request?.permissions);
  const inspected = await inspectPortalPermissions(settings,{adapter});
  if (request?.revision!==inspected.revision || request.configPath!==undefined&&request.configPath!==inspected.configPath) throw new Error('Portal 权限已变化，请重新读取后保存。');
  const original = inspected.source.text,updated=editToolPermissions(original,permissions),configPath=inspected.configPath;
  if(updated===original)return {permissions,changed:false,revision:inspected.revision};
  const temporary = `${configPath}.permissions-${crypto.randomUUID()}.tmp`;
  const backupPath=backup?`${configPath}.permissions-${crypto.randomUUID()}.bak`:'';
  try {
    if(backupPath)await fs.writeFile(backupPath,inspected.source.bytes,{flag:'wx',mode:0o600});
    await fs.writeFile(temporary,updated,{flag:'wx',mode:0o600});
    const current = await readConfig(configPath);
    if(current.text!==original || inspected.managed&&settings.managedPortal!==inspected.managed
        || inspected.adoption&&settings.adoptedPortal!==inspected.adoption)throw new Error('Portal 配置已变化，请重新读取后保存。');
    if(adapter)await adapter.state();
    if((await readConfig(configPath)).text!==original)throw new Error('Portal 配置已变化，请重新读取后保存。');
    await fs.rename(temporary,configPath);
    if(inspected.managed) {
      settings.managedPortal = {...inspected.managed,permissions};
      try { await persist(); }
      catch {
        settings.managedPortal = inspected.managed;
        if ((await readConfig(configPath)).text===updated) {
          await fs.writeFile(temporary,inspected.source.bytes,{flag:'wx',mode:0o600});
          await fs.rename(temporary,configPath);
        }
        throw new Error('权限未能保存，请检查磁盘权限后重试。');
      }
    }
    return {permissions,changed:true,revision:digest(Buffer.from(updated)),backupPath,managed:settings.managedPortal};
  } finally { await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;}); }
}

async function restorePortalPermissions({settings,snapshot,receipt,persist,adapter}) {
  const current=await inspectPortalPermissions(settings,{adapter});
  if(current.configPath!==snapshot.configPath||current.revision!==receipt.revision)throw new Error('Portal 配置已再次变化，原备份已保留。');
  const temporary=`${snapshot.configPath}.permissions-${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary,snapshot.source.bytes,{flag:'wx',mode:0o600});
    if(digest((await readConfig(snapshot.configPath)).bytes)!==receipt.revision)throw new Error('Portal 配置已再次变化，原备份已保留。');
    await fs.rename(temporary,snapshot.configPath);
    if(snapshot.managed) {settings.managedPortal=snapshot.managed;await persist();}
  }finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

// Both Desktop-owned and adopted instances use their established lifecycle.
// No-op saves do not restart. A failed changed save restores the prior config
// and running state; an uncertain recovery retains the private file backup.
async function applyPortalPermissions({settings,request,persist,adapter,verify,isCurrent=()=>true}) {
  if(!adapter)throw new Error('请先配置或接管 Portal，再管理工具权限。');
  const permissions=normalizePortalPermissions(request?.permissions),snapshot=await inspectPortalPermissions(settings,{adapter});
  if(request?.configPath!==snapshot.configPath || request?.revision!==snapshot.revision)throw new Error('Portal 配置已变化，请重新读取后保存。');
  if(Object.keys(permissions).every(key=>permissions[key]===snapshot.permissions[key]))return {detail:'权限未改变，无需重启 Portal。',changed:false};
  const previous=await adapter.state();let receipt,stopped=false;
  if(!isCurrent())throw new Error('连接或配置已变化，请重新读取权限。');
  try {
    if(previous.running){stopped=true;await adapter.stop();}
    if(!isCurrent())throw new Error('连接或配置已变化，请重新读取权限。');
    receipt=await savePortalPermissions({settings,request,persist,adapter,backup:true});
    let health;
    if(previous.running) {
      if(!isCurrent())throw new Error('连接或配置已变化，请重新读取权限。');
      const marker=await adapter.mark?.();await adapter.start();health=await verify(adapter,marker);
      if(!health?.passed)throw new Error('Portal 重启验证未通过。');
    }
    if(!isCurrent())throw new Error('连接或配置已变化，请重新读取权限。');
    return {changed:receipt.changed,detail:previous.running
      ? health.connected?'权限已保存，Portal 已通过原管理方式重启并重新连接。':'权限已保存，Portal 已通过原管理方式重启；Being 连接尚待确认。'
      : '权限已保存，下次启动 Portal 时生效。'};
  }catch(error) {
    try {
      if(receipt?.changed){await adapter.stop();await restorePortalPermissions({settings,snapshot,receipt,persist,adapter});}
      if(stopped&&(adapter.kind!=='desktop'||isCurrent())) {
        const marker=await adapter.mark?.();await adapter.start();
        if(!(await verify(adapter,marker))?.passed)throw new Error('Recovery not verified');
      }
    }catch{throw new Error('权限更新未完成，恢复尚未确认；请检查原服务和配置后重试。');}
    if(stopped)throw new Error(adapter.kind==='desktop'&&!isCurrent()
      ? '权限更新未完成，原配置已恢复；连接已变化，请按当前连接手动启动 Portal。'
      : receipt?.changed ? '权限更新未完成，已恢复原配置和运行状态，请重新读取权限。' : '权限更新未完成，Portal 已恢复运行；请重新读取当前配置。');
    throw error;
  }
}

module.exports = {inspectPortalPermissions,savePortalPermissions,applyPortalPermissions};
