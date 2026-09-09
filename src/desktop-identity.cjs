'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validDesktopId(value) {return typeof value==='string' && UUID.test(value);}
function desktopPortalName(id) {
  if(!validDesktopId(id))throw new Error('Desktop 身份无效。');
  return 'being-desktop-tools-'+id.toLowerCase();
}
async function loadDesktopId(directory) {
  await fs.mkdir(directory,{recursive:true});
  const file=path.join(directory,'desktop-id.json');
  try {
    const value=JSON.parse(await fs.readFile(file,'utf8'));
    if(!validDesktopId(value.desktopId))throw new Error('Invalid identity');
    return value.desktopId.toLowerCase();
  } catch(error) {
    if(error.code!=='ENOENT')throw new Error('Desktop 身份文件无法读取，原文件已保留。');
  }
  const desktopId=randomUUID();
  const temporary=file+'.'+desktopId+'.tmp';
  try {
    await fs.writeFile(temporary,JSON.stringify({desktopId})+'\n',{mode:0o600,flag:'wx'});
    // Publish a complete file without replacing a concurrently created identity.
    try {await fs.link(temporary,file);}
    catch(error) {if(error.code==='EEXIST')return await loadDesktopId(directory);throw error;}
  } finally {await fs.rm(temporary,{force:true});}
  return desktopId;
}
module.exports={loadDesktopId,validDesktopId,desktopPortalName};
