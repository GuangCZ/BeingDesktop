'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const {createPortalConfig, normalizePortalPermissions} = require('./portal-config.cjs');
const {readConfig, grovePortalConfigText} = require('./grove-portal.cjs');

async function inspectPortalPermissions(settings) {
  const managed = settings.managedPortal;
  if (!managed || managed.configPath!==settings.portalConfig || managed.executable!==settings.portalExecutable) {
    throw new Error('请先一键配置 Portal。手动选择的配置请在原配置文件中管理权限。');
  }
  const permissions = normalizePortalPermissions(managed.permissions);
  const configuration = await createPortalConfig({workspace:managed.workspace,permissions});
  const expected = managed.groveKitsDir ? grovePortalConfigText(configuration.toml,managed.groveKitsDir) : configuration.toml;
  const source = await readConfig(managed.configPath);
  if (source.text!==expected) throw new Error('Portal 配置已在外部修改，请在原配置文件中管理权限；桌面端不会覆盖它。');
  return {permissions, revision:crypto.createHash('sha256').update(source.bytes).digest('hex'), source, managed};
}

async function savePortalPermissions({settings,request,persist}) {
  const permissions = normalizePortalPermissions(request?.permissions);
  const inspected = await inspectPortalPermissions(settings);
  if (request?.revision!==inspected.revision) throw new Error('Portal 权限已变化，请重新读取后保存。');
  const original = inspected.source.text;
  const updated = original.replace(/\[tools\]\n[\s\S]*?(?=\n\[)/,`[tools]\n${Object.entries(permissions).map(([key,value])=>`${key} = ${value}`).join('\n')}\n`);
  const configPath = inspected.managed.configPath;
  const temporary = `${configPath}.permissions-${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary,updated,{flag:'wx',mode:0o600});
  try {
    const current = await readConfig(configPath);
    if (current.text!==original || settings.managedPortal!==inspected.managed) throw new Error('Portal 配置已变化，请重新读取后保存。');
    await fs.rename(temporary,configPath);
    settings.managedPortal = {...inspected.managed,permissions};
    try { await persist(); }
    catch {
      settings.managedPortal = inspected.managed;
      if ((await readConfig(configPath)).text===updated) {
        await fs.writeFile(temporary,original,{flag:'wx',mode:0o600});
        await fs.rename(temporary,configPath);
      }
      throw new Error('权限未能保存，请检查磁盘权限后重试。');
    }
  } finally { await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;}); }
  return {permissions};
}

module.exports = {inspectPortalPermissions,savePortalPermissions};
