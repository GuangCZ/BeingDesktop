'use strict';
const {createHash}=require('node:crypto');

// Bind consent to the original deployment and launcher. A binary update or the
// supervision marker may change bytes without changing that deployment.
function adoptionRecord(adapter) {
  const descriptor=adapter?.descriptor;
  if(!descriptor || !['launchagent','windows-supervisor'].includes(adapter.kind))throw new Error('尚未识别可接管的原服务。');
  const fields=adapter.kind==='launchagent'
    ? ['executable','configPath','label','plist','wrapper','wrapperHash','pointerHash']
    : ['executable','configPath','root','launchPath','launchHash'];
  const binding=fields.map(key=>[key,descriptor[key] || '']);
  return {schema:1,kind:adapter.kind,executable:descriptor.executable,configPath:descriptor.configPath,
    bindingHash:createHash('sha256').update(JSON.stringify(binding)).digest('hex')};
}
function matchesAdoption(saved,candidate) {
  return Boolean(saved && candidate && saved.schema===1 && saved.kind===candidate.kind
    && saved.executable===candidate.executable && saved.configPath===candidate.configPath && saved.bindingHash===candidate.bindingHash);
}
module.exports={adoptionRecord,matchesAdoption};
