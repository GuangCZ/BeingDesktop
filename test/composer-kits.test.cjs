'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {listInstalledComposerKits} = require('../src/composer-kits.cjs');
const {normalizeComposerData,composerSuggestions,tokenAtCaret} = require('../src/loom-composer.cjs');
const manifest = name => ({name,command:['node','server.mjs'],tools:[],description:'本机工具'});
async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'composer-kits-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const put = async (base,name,data=manifest(name)) => {const folder=path.join(base,name);await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'manifest.json'),JSON.stringify(data));return folder;};
  return {root,put};
}
test('composer inventories the configured Portal directory and Desktop installations without Grove', async t => {
  const {root,put}=await setup(t), portal=path.join(root,'local-kits'),desktop=path.join(root,'desktop-kits');
  const configPath=path.join(root,'portal.toml');await fs.writeFile(configPath,'kits_dir = "local-kits"\n');
  await put(portal,'grip');await put(portal,'duplicate',manifest('grip'));
  const folder=await put(desktop,'image');await fs.writeFile(path.join(folder,'.being-desktop-install.json'),JSON.stringify({id:'market-image',name:'image'}));
  await put(path.join(root,'.heart-portal','kits'),'unused-default');
  const result=await listInstalledComposerKits({configPath,desktopKitsDir:desktop,homeDir:root});
  assert.deepEqual(result.kits.map(k=>k.id),['grip','market-image']);assert.ok(result.kits.every(k=>k.installed));
});
test('missing roots, incomplete manifests and symlink entries do not become installed candidates', async t => {
  const {root,put}=await setup(t), kits=path.join(root,'.heart-portal','kits');
  assert.deepEqual(await listInstalledComposerKits({homeDir:root}),{kits:[]});
  await put(kits,'valid');await put(kits,'incomplete',{name:'incomplete'});
  await fs.mkdir(path.join(kits,'broken'));await fs.writeFile(path.join(kits,'broken','manifest.json'),'{');
  await fs.symlink(path.join(kits,'valid'),path.join(kits,'linked'));
  assert.deepEqual((await listInstalledComposerKits({homeDir:root})).kits.map(k=>k.name),['valid']);
});
test('slash excludes uninstalled market entries but retains installed kits and bundled abilities', () => {
  const data=normalizeComposerData({kits:[{id:'installed',name:'installed',installed:true},{id:'market',name:'market'},{id:'removed',name:'removed',installed:false}]});
  assert.deepEqual(composerSuggestions(data,tokenAtCaret('/',1)).map(k=>k.id),['being-search','being-browse','installed']);
  assert.deepEqual(composerSuggestions(data,tokenAtCaret('/market',7)),[]);
});
