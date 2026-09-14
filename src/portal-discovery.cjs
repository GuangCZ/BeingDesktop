'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {readConfig, configFields} = require('./grove-portal.cjs');

function safePath(value) {
  return typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
}

// Configuration metadata is a read-only hint, never proof of a running relay's identity.
async function discoverPortalDeployment({home = os.homedir(), settings = {}, observedExecutable = ''} = {}) {
  const managed = settings.managedPortal;
  const candidates = [];
  const add = (configPath, executable, source) => {
    if (!safePath(configPath) || candidates.some(item => item.configPath === configPath)) return;
    if (managed?.configPath === configPath && managed.executable === executable) return;
    candidates.push({configPath, executable:safePath(executable) ? executable : '', source});
  };
  // Official 0.8.3 Windows supervision saves an absolute config in a private
  // launch record beside the executable. Extract paths only, never environment.
  if(safePath(observedExecutable)) {
    try {
      const {regular}=require('./portal-launchagent.cjs');
      const launch=JSON.parse(await regular(path.join(path.dirname(observedExecutable),'.portal-launch.json')));
      if(launch.protocol===1 && Array.isArray(launch.arguments) && launch.arguments[0]==='--config') {
        add(launch.arguments[1],observedExecutable,'saved_launch');
      }
    } catch { /* Fall back to conventional paths without exposing private data. */ }
  }
  // Prefer the process's conventional adjacent config over unrelated Desktop selections.
  if (safePath(observedExecutable)) add(path.join(path.dirname(observedExecutable), 'portal.toml'), observedExecutable, 'process_directory');
  add(settings.portalConfig, settings.portalExecutable, 'selected_configuration');
  add(path.join(home, '.heart-portal', 'portal.toml'), path.join(home, '.heart-portal', process.platform === 'win32' ? 'heart-portal.exe' : 'heart-portal'), 'existing_installation');
  for (const candidate of candidates) {
    let stat;
    try { stat = await fs.lstat(candidate.configPath); }
    catch (error) { if (error.code === 'ENOENT') continue; return {...candidate, workspace:'', name:'', metadataStatus:'unavailable'}; }
    // A known deployment still has priority when its metadata cannot safely be read.
    const result = {...candidate, workspace:'', name:'', metadataStatus:'unavailable'};
    if (observedExecutable && candidate.executable !== observedExecutable) return {...result, configPath:'', executable:observedExecutable, source:'external_process'};
    try {
      if (!stat.isFile() || stat.isSymbolicLink()) return result;
      const {text} = await readConfig(candidate.configPath);
      const {fields} = configFields(text, ['workspace', 'name']);
      if (safePath(fields.workspace?.value)) result.workspace = fields.workspace.value;
      if (typeof fields.name?.value === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(fields.name.value)) result.name = fields.name.value;
      result.metadataStatus = 'configuration';
    } catch { /* Do not return configuration contents or errors that could contain credentials. */ }
    return result;
  }
  return null;
}

module.exports = {discoverPortalDeployment};
