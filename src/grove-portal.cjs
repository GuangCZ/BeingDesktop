'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { createPortalConfig } = require('./portal-config.cjs');

const MAX_CONFIG_BYTES = 1024 * 1024;
const changes = new Map();

function absolutePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Portal 配置或工具包目录必须是有效绝对路径。');
  }
  return path.resolve(value);
}

async function directoryChain(directory, allowMissing = false) {
  const root = path.parse(directory).root;
  let current = root;
  for (const part of [null, ...path.relative(root, directory).split(path.sep).filter(Boolean)]) {
    if (part !== null) current = path.join(current, part);
    const stat = await fs.lstat(current).catch(error => {
      if (allowMissing && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Portal 配置和工具包目录不能包含符号链接或非目录路径。');
  }
  return true;
}

function sameFile(a, b) {
  return a.ino === b.ino && a.dev === b.dev && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function readConfig(configPath) {
  await directoryChain(path.dirname(configPath));
  const before = await fs.lstat(configPath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CONFIG_BYTES) {
    throw new Error('Portal 配置必须是大小有效的实际文件。');
  }
  const handle = await fs.open(configPath, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error('Portal 配置在检查期间发生了变化。');
    const bytes = await handle.readFile();
    const after = await fs.lstat(configPath);
    if (after.isSymbolicLink() || !sameFile(before, after) || bytes.length !== before.size) {
      throw new Error('Portal 配置在检查期间发生了变化。');
    }
    // Preserve a UTF-8 BOM if present; never silently replace invalid bytes.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { bytes, text, stat: before };
  } finally { await handle.close(); }
}

function parseString(value) {
  if (value.startsWith("'")) {
    const match = /^'([^'\r\n]*)'([ \t]*(?:#.*)?)$/.exec(value);
    if (!match) throw new Error('无法安全识别 Portal 工具包目录配置。');
    return { value: match[1], length: match[1].length + 2 };
  }
  const match = /^"((?:[^"\\\r\n]|\\.)*)"([ \t]*(?:#.*)?)$/.exec(value);
  if (!match) throw new Error('无法安全识别 Portal 工具包目录配置。');
  const decoded = match[1].replace(/\\(?:[btnfr"\\]|u[\da-fA-F]{4}|U[\da-fA-F]{8})|\\./g, escape => {
    const simple = { '\\b': '\b', '\\t': '\t', '\\n': '\n', '\\f': '\f', '\\r': '\r', '\\"': '"', '\\\\': '\\' };
    if (Object.hasOwn(simple, escape)) return simple[escape];
    if (/^\\[uU][\da-fA-F]+$/.test(escape)) {
      const codePoint = Number.parseInt(escape.slice(2), 16);
      if (codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) return String.fromCodePoint(codePoint);
    }
    throw new Error('无法安全识别 Portal 工具包目录配置。');
  });
  return { value: decoded, length: match[1].length + 2 };
}

function configFields(text, keys = ['kits_enabled', 'kits_dir']) {
  const fields = {};
  let offset = 0, rootEnd = text.length, quote = '', triple = false, depth = 0;
  for (const line of text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) || []) {
    if (!line) continue;
    const body = line.replace(/[\r\n]+$/, '');
    const content = offset === 0 ? body.replace(/^\uFEFF/, '') : body;
    const bom = body.length - content.length;
    if (!quote && depth === 0) {
      if (/^[ \t]*\[/.test(content)) { rootEnd = offset + bom; break; }
      if (/^[ \t]*"[^"\r\n]*\\/.test(content)) throw new Error('Portal 配置键包含转义，请通过 Being 核对配置。');
      const assignment = /^[ \t]*(?:([A-Za-z0-9_-]+)|"([^"\\]*)"|'([^']*)')[ \t]*=[ \t]*/.exec(content);
      if (assignment) {
        const key = assignment[1] || assignment[2] || assignment[3];
        if (keys.includes(key)) {
          if (Object.hasOwn(fields, key)) throw new Error('Portal 工具包配置包含重复字段，请先核对配置。');
          const value = content.slice(assignment[0].length);
          let parsed;
          if (key === 'kits_enabled') {
            const flag = /^(true|false)([ \t]*(?:#.*)?)$/.exec(value);
            if (!flag) throw new Error('无法安全识别 Portal 工具包启用配置。');
            parsed = { value: flag[1] === 'true', length: flag[1].length };
          } else parsed = parseString(value);
          fields[key] = { value: parsed.value, start: offset + bom + assignment[0].length, length: parsed.length };
        }
      }
    }
    // Track strings and arrays so table-like text inside a value is never edited.
    for (let index = 0; index < content.length; index++) {
      const char = content[index];
      if (quote) {
        if (quote === '"' && char === '\\') { index++; continue; }
        if (char === quote) {
          if (triple) {
            if (content.slice(index, index + 3) === quote.repeat(3)) { index += 2; quote = ''; triple = false; }
          } else quote = '';
        }
      } else if (char === '#') break;
      else if (char === '"' || char === "'") {
        quote = char;
        triple = content.slice(index, index + 3) === char.repeat(3);
        if (triple) index += 2;
      } else if (char === '[' || char === '{') depth++;
      else if (char === ']' || char === '}') depth--;
    }
    if ((quote && !triple) || depth < 0) throw new Error('Portal 配置格式无法安全识别。');
    offset += line.length;
  }
  if (quote || depth !== 0) throw new Error('Portal 配置格式无法安全识别。');
  return { fields, rootEnd };
}

function defaultKitsDirectory() {
  return path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.heart-portal', 'kits');
}

function configuredDirectory(value, configPath) {
  if (!value || !value.trim()) return absolutePath(defaultKitsDirectory());
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Portal 工具包目录配置无效。');
  if (value === '~' || value.startsWith('~/')) {
    return path.resolve(process.env.HOME || process.env.USERPROFILE || os.homedir(), value.slice(2));
  }
  return path.resolve(path.dirname(configPath), value);
}

function samePath(a, b) { return path.relative(a, b) === ''; }

async function containsKits(directory) {
  if (!await directoryChain(directory, true)) return false;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('原有工具包目录包含符号链接，请通过 Being 核对。');
    if (!entry.isDirectory()) continue;
    const manifest = await fs.lstat(path.join(directory, entry.name, 'manifest.json')).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (manifest) return true;
  }
  return false;
}

function blocked(reason, context = {}) {
  return { ...context, ready: false, status: 'needs_being', reason };
}

async function inspect(options) {
  const configPath = absolutePath(options?.configPath);
  const kitsDir = absolutePath(options?.kitsDir);
  const source = await readConfig(configPath);
  const parsed = configFields(source.text);
  const enabled = parsed.fields.kits_enabled?.value !== false;
  const previousKitsDir = configuredDirectory(parsed.fields.kits_dir?.value, configPath);
  const context = { configPath, kitsDir, enabled, previousKitsDir };
  await directoryChain(path.dirname(kitsDir));
  const directoryExists = await directoryChain(kitsDir, true);
  if (enabled && !samePath(previousKitsDir, kitsDir)) {
    if (parsed.fields.kits_dir?.value?.trim()) {
      return { result: blocked('Portal 已启用其他工具包目录，请通过 Being 合并配置，避免隐藏现有工具。', context) };
    }
    if (await containsKits(previousKitsDir)) {
      return { result: blocked('Portal 默认目录已有工具包，请通过 Being 合并配置，避免隐藏现有工具。', context) };
    }
  }
  return {
    source, parsed,
    result: { ...context, ready: true, status: 'ready', reason: '', directoryExists,
      activationRequired: !enabled || !samePath(previousKitsDir, kitsDir),
      restartRequired: !enabled || !samePath(previousKitsDir, kitsDir) },
  };
}

async function inspectGrovePortal(options) {
  try { return (await inspect(options)).result; }
  catch { return blocked('无法安全检查 Portal 配置或工具包目录，请通过 Being 核对路径和配置。'); }
}

function updatedConfig(text, parsed, kitsDir) {
  const replacements = [], additions = [];
  for (const [key, value] of [['kits_enabled', 'true'], ['kits_dir', JSON.stringify(kitsDir)]]) {
    const field = parsed.fields[key];
    if (field) replacements.push({ start: field.start, length: field.length, value });
    else additions.push(`${key} = ${value}`);
  }
  if (additions.length) {
    const newline = /\r\n|\n|\r/.exec(text)?.[0] || '\n';
    const prefix = parsed.rootEnd > 0 && !/[\r\n]$/.test(text.slice(0, parsed.rootEnd)) ? newline : '';
    replacements.push({ start: parsed.rootEnd, length: 0, value: prefix + additions.join(newline) + newline });
  }
  for (const edit of replacements.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.value + text.slice(edit.start + edit.length);
  }
  return Buffer.from(text, 'utf8');
}

function grovePortalConfigText(text, kitsDir) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) throw new Error('Portal 配置格式无法安全识别。');
  return updatedConfig(text, configFields(text), absolutePath(kitsDir)).toString('utf8');
}

async function recoverGrovePortalMetadata({ settings, kitsDir, verifyInstalledRoot, configFactory = createPortalConfig } = {}) {
  const unchanged = (reason = '') => ({ changed: false, reason });
  try {
    const managed = settings?.managedPortal;
    if (!managed || typeof managed !== 'object' || Array.isArray(managed)
      || typeof managed.executable !== 'string' || typeof managed.configPath !== 'string'
      || settings.portalExecutable !== managed.executable || settings.portalConfig !== managed.configPath) {
      return unchanged('当前选择与受管 Portal 记录不一致，未恢复 Grove 配置记录。');
    }
    const target = absolutePath(kitsDir);
    if (managed.groveKitsDir === target) return unchanged();
    if (managed.groveKitsDir !== undefined && managed.groveKitsDir !== null && managed.groveKitsDir !== '') {
      return unchanged('原有 Grove 目录记录不同，未覆盖该记录。');
    }
    const managedSnapshot = JSON.stringify(managed);
    if (typeof verifyInstalledRoot !== 'function') return unchanged('缺少已安装工具包验证，未恢复 Grove 配置记录。');
    const executable = absolutePath(managed.executable);
    const configPath = absolutePath(managed.configPath);
    const workspace = absolutePath(managed.workspace);
    await directoryChain(path.dirname(executable));
    const binaryBefore = await fs.lstat(executable);
    if (!binaryBefore.isFile() || binaryBefore.isSymbolicLink()) return unchanged('受管 Portal 程序不是实际文件，未恢复 Grove 配置记录。');
    await directoryChain(target);
    const source = await readConfig(configPath);
    // The file browser may now show a different workspace. The deployment's
    // recorded workspace is the only baseline for its existing Portal config.
    const configuration = await configFactory({ workspace, name: 'being-desktop', permissions: managed.permissions });
    if (configuration?.capabilities?.workspace !== managed.workspace
      || typeof configuration.toml !== 'string'
      || !source.bytes.equals(Buffer.from(grovePortalConfigText(configuration.toml, target), 'utf8'))) {
      return unchanged('Portal 配置与已验证的 Grove 受管配置不同，未恢复配置记录。');
    }
    const checked = await verifyInstalledRoot(target);
    if (checked?.verified !== true || !Array.isArray(checked.installed) || checked.installed.length === 0) {
      return unchanged('工具包目录未全部通过验证，未恢复 Grove 配置记录。');
    }
    const current = await readConfig(configPath);
    await directoryChain(path.dirname(executable));
    await directoryChain(target);
    const binaryAfter = await fs.lstat(executable);
    if (binaryAfter.isSymbolicLink() || !binaryAfter.isFile() || !sameFile(binaryBefore, binaryAfter)
      || !sameFile(source.stat, current.stat) || !source.bytes.equals(current.bytes)
      || settings.managedPortal !== managed || JSON.stringify(managed) !== managedSnapshot
      || settings.portalExecutable !== executable || settings.portalConfig !== configPath) {
      return unchanged('受管 Portal 在检查期间发生变化，未恢复 Grove 配置记录。');
    }
    return { changed: true, reason: '', managedPortal: { ...managed, groveKitsDir: target } };
  } catch { return unchanged('无法完整验证受管 Portal 和工具包目录，未恢复 Grove 配置记录。'); }
}

async function writeExclusive(file, bytes, mode = 0o600, onCreate = () => {}) {
  const handle = await fs.open(file, 'wx', mode);
  try { onCreate(); await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function enable(options) {
  let snapshot;
  try { snapshot = await inspect(options); }
  catch { return { ...blocked('无法安全检查 Portal 配置或工具包目录，请通过 Being 核对路径和配置。'), changed: false, backupPath: null }; }
  const { result, source, parsed } = snapshot;
  if (!result.ready) return { ...result, changed: false, backupPath: null };
  const { configPath, kitsDir } = result;
  if (!result.directoryExists) {
    await fs.mkdir(kitsDir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await directoryChain(kitsDir);
  }
  if (!result.activationRequired) return { ...result, changed: false, backupPath: null, enabled: true, directoryExists: true };
  const bytes = updatedConfig(source.text, parsed, kitsDir);
  const backupPath = `${configPath}.grove-${crypto.randomUUID()}.bak`;
  const temporary = `${configPath}.grove-${crypto.randomUUID()}.tmp`;
  let temporaryOwned = false;
  try {
    const before = await readConfig(configPath);
    if (!sameFile(source.stat, before.stat) || !source.bytes.equals(before.bytes)) throw new Error('Portal 配置已变化，请重新检查。');
    await writeExclusive(backupPath, source.bytes);
    const backup = await readConfig(backupPath);
    if (!backup.bytes.equals(source.bytes)) throw new Error('Portal 配置备份校验失败，未修改配置。');
    await writeExclusive(temporary, bytes, source.stat.mode & 0o777, () => { temporaryOwned = true; });
    if (!(await readConfig(temporary)).bytes.equals(bytes)) throw new Error('Portal 新配置校验失败，未修改原配置。');
    const current = await readConfig(configPath);
    if (!sameFile(source.stat, current.stat) || !source.bytes.equals(current.bytes)) throw new Error('Portal 配置已变化，请重新检查。');
    await directoryChain(kitsDir);
    await fs.rename(temporary, configPath);
    temporaryOwned = false;
    return { ...result, changed: true, backupPath, enabled: true, directoryExists: true, activationRequired: false, restartRequired: true };
  } finally {
    if (temporaryOwned) await fs.unlink(temporary).catch(() => {});
  }
}

function enableGrovePortal(options) {
  let key;
  try { key = absolutePath(options?.configPath); }
  catch { return enable(options); }
  const previous = changes.get(key) || Promise.resolve();
  const running = previous.catch(() => {}).then(() => enable(options));
  changes.set(key, running);
  return running.finally(() => { if (changes.get(key) === running) changes.delete(key); });
}

function verifyGrovePortalLogs(logs, kitNames) {
  const names = [...new Set(Array.isArray(kitNames) ? kitNames : [])];
  if (names.some(name => typeof name !== 'string' || !/^[A-Za-z0-9-]+$/.test(name))) throw new Error('工具包名称无效。');
  const registered = new Set(), started = new Set(), failed = new Set();
  let tools = [];
  const matching = [...names].sort((a, b) => b.length - a.length);
  for (const event of Array.isArray(logs) ? logs : []) {
    if (!event || typeof event.detail !== 'string') continue;
    if (['Portal 已启动', 'Portal 已退出', 'Portal 正在退出'].includes(event.title)) {
      registered.clear(); started.clear(); failed.clear(); tools = [];
      continue;
    }
    const message = event.detail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim()
      .replace(/^(?:\d{4}-\d{2}-\d{2}T\S+\s+)?(?:(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+)?(?:(?:heart_portal|portal)(?:::[a-zA-Z0-9_]+)*:\s*)?/, '');
    const list = /^Portal tools: ([A-Za-z0-9_-]+(?:, [A-Za-z0-9_-]+)*)$/.exec(message);
    if (list) {
      tools = list[1].split(', ');
      registered.clear();
      for (const tool of tools) {
        const name = matching.find(name => tool.startsWith(`${name.replaceAll('-', '_')}_`));
        if (name) { registered.add(name); failed.delete(name); }
      }
      continue;
    }
    const initialization = /^MCP server '([A-Za-z0-9-]+)' spawned and initialized$/.exec(message);
    if (initialization && names.includes(initialization[1])) started.add(initialization[1]);
    const unhealthy = /^Kit '([A-Za-z0-9-]+)' (?:removed|pre-marked unhealthy(?::.*)?|marked unhealthy after \d+ failures)$/.exec(message);
    if (unhealthy && names.includes(unhealthy[1])) {
      registered.delete(unhealthy[1]); started.delete(unhealthy[1]); failed.add(unhealthy[1]);
    }
  }
  const loaded = names.filter(name => registered.has(name));
  const missing = names.filter(name => !registered.has(name));
  return { verified: names.length > 0 && missing.length === 0, loaded, missing,
    started: names.filter(name => started.has(name)), failed: names.filter(name => failed.has(name)), tools };
}

module.exports = { inspectGrovePortal, enableGrovePortal, verifyGrovePortalLogs, grovePortalConfigText, recoverGrovePortalMetadata, readConfig, configFields };
