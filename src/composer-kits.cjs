'use strict';
// Read installed manifests only. This inventory neither launches tools nor queries Grove.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {readConfig, configFields} = require('./grove-portal.cjs');
const {sanitizeText} = require('./services.cjs');
const valid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
async function listInstalledComposerKits({configPath = '', desktopKitsDir = '', homeDir = os.homedir()} = {}) {
  let portalDir = path.join(homeDir, '.heart-portal', 'kits');
  if (configPath) {
    let source;
    try { source = await readConfig(configPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (source) {
      const value = configFields(source.text).fields.kits_dir?.value;
      if (value?.trim()) {
        if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Kit 安装目录配置无效。');
        portalDir = value === '~' || value.startsWith('~/') ? path.resolve(homeDir, value.slice(2)) : path.resolve(path.dirname(configPath), value);
      }
    }
  }
  const kits = [], names = new Set();
  for (const directory of new Set([portalDir, desktopKitsDir].filter(Boolean))) {
    let entries;
    try { entries = await fs.readdir(directory, {withFileTypes:true}); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name)).slice(0,1000)) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try {
        const manifest = JSON.parse((await readConfig(path.join(directory, entry.name, 'manifest.json'))).text);
        if (!valid(manifest.name) || !Array.isArray(manifest.tools) || !Array.isArray(manifest.command) || !manifest.command.length || names.has(manifest.name)) continue;
        let id = valid(manifest.id) ? manifest.id : manifest.name;
        // Desktop receipts preserve the market ID for kits installed under a local name.
        try {
          const receipt = JSON.parse((await readConfig(path.join(directory, entry.name, '.being-desktop-install.json'))).text);
          if (receipt.name === manifest.name && valid(receipt.id)) id = receipt.id;
        } catch { /* External installations have no Desktop receipt. */ }
        names.add(manifest.name);
        kits.push({id, name:manifest.name, description:sanitizeText(typeof manifest.description === 'string' ? manifest.description : '').slice(0,220), installed:true});
      } catch { /* An incomplete or invalid manifest is not an installed Kit candidate. */ }
    }
  }
  return {kits};
}
module.exports = {listInstalledComposerKits};
