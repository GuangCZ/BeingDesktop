'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function absolutePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('请选择有效的绝对工作区路径。');
  }
  return path.resolve(value);
}

async function validatePortalWorkspace(value) {
  const workspace = absolutePath(value);
  const root = path.parse(workspace).root;
  let current = root;
  try {
    for (const part of path.relative(root, workspace).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Invalid workspace');
    }
    const stat = await fs.lstat(workspace);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid workspace');
    return await fs.realpath(workspace);
  } catch { throw new Error('工作区必须是现有实际目录，不能包含符号链接。'); }
}

async function preparePortalWorkspace({ workspace, defaultWorkspace } = {}) {
  if (workspace) return validatePortalWorkspace(workspace);
  const directory = absolutePath(defaultWorkspace);
  await validatePortalWorkspace(path.dirname(directory));
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw new Error('无法创建默认 Portal 工作区，请检查目录权限。');
  }
  return validatePortalWorkspace(directory);
}

const DEFAULT_PERMISSIONS = Object.freeze({exec:false,file:true,screenshot:false,web_fetch:false,search:true,custom_tools_enabled:false});

function normalizePortalPermissions(value = DEFAULT_PERMISSIONS) {
  if (!value || Object.getPrototypeOf(value)!==Object.prototype
    || Object.keys(value).length!==Object.keys(DEFAULT_PERMISSIONS).length
    || Object.keys(DEFAULT_PERMISSIONS).some(key=>!Object.hasOwn(value,key) || typeof value[key]!=='boolean')) {
    throw new Error('Portal 权限必须是完整的开关设置。');
  }
  return Object.fromEntries(Object.keys(DEFAULT_PERMISSIONS).map(key=>[key,value[key]]));
}

async function createPortalConfig({ workspace, name = 'being-desktop', kitsDir, permissions } = {}) {
  const flags = normalizePortalPermissions(permissions);
  const validatedWorkspace = await validatePortalWorkspace(workspace);
  if (typeof name !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(name)) throw new Error('Portal 名称无效。');
  const validatedKitsDir = kitsDir === undefined ? undefined : absolutePath(kitsDir);
  // JSON double-quoted path strings use escapes compatible with TOML basic strings.
  const lines = [
    `name = ${JSON.stringify(name)}`,
    'bind = "127.0.0.1:0"',
    `workspace = ${JSON.stringify(validatedWorkspace)}`,
    'kits_enabled = false',
    ...(validatedKitsDir ? [`kits_dir = ${JSON.stringify(validatedKitsDir)}`] : []),
    '', '[tools]',
    ...Object.entries(flags).map(([key,value])=>`${key} = ${value}`),
    '', '[security]', 'exec_allowlist = []', 'max_file_size = 10485760',
    '', '[cowork]', 'enabled = true', 'http_port = 0', '',
  ];
  return {
    toml: lines.join('\n'),
    capabilities: {
      workspace: validatedWorkspace,
      advertisedTools: [
        ...(flags.exec ? ['portal_exec','portal_process'] : []),
        ...(flags.file ? ['portal_file_read', 'portal_file_write', 'portal_file_edit', 'portal_file_list'] : []),
        ...(flags.screenshot ? ['portal_screenshot'] : []),
        ...(flags.web_fetch ? ['portal_web_fetch','portal_web_search'] : []),
        ...(flags.search ? ['portal_search'] : []), 'portal_oauth_authorize', 'portal_tools_reload',
      ],
      disabledAtDispatch: [...(!flags.exec ? ['portal_exec','portal_process'] : []), ...(!flags.file ? ['portal_file_read','portal_file_write','portal_file_edit','portal_file_list'] : []), ...(!flags.screenshot ? ['portal_screenshot'] : [])],
      hiddenButCallable: [...(!flags.web_fetch ? ['portal_web_fetch','portal_web_search'] : []), ...(!flags.search ? ['portal_search'] : [])],
      fileAccess: flags.file ? 'read_write' : 'disabled', customToolsEnabled: flags.custom_tools_enabled, kitsEnabled: false,
      strictSandbox: false, coworkRequiresPortalToken: true,
      description: `文件读写${flags.file?'已开启':'已关闭'}；命令执行${flags.exec?'已开启':'已关闭'}；截图${flags.screenshot?'已开启':'已关闭'}。上游仍保留网络和 OAuth 调用能力，这不是严格的工作区沙箱。`,
    },
  };
}

module.exports = { createPortalConfig, validatePortalWorkspace, preparePortalWorkspace, DEFAULT_PERMISSIONS, normalizePortalPermissions };
