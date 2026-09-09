'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {discoverPortalDeployment} = require('../src/portal-discovery.cjs');
const {PortalService} = require('../src/services.cjs');

async function fixture(t, text) {
  const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'portal-discovery-'));
  t.after(() => fs.rm(home, {recursive:true, force:true}));
  const directory = path.join(home, '.heart-portal');
  await fs.mkdir(directory);
  const configPath = path.join(directory, 'portal.toml');
  await fs.writeFile(configPath, text);
  return {home, configPath};
}

test('existing stopped deployment retains its config workspace and creates no child', async t => {
  const text = 'name = "cz-being-mac"\nworkspace = "/"\ntoken = "private-fixture"\n[cowork]\nworkspace = "/wrong"\n';
  const f = await fixture(t, text);
  let starts = 0;
  const portal = new PortalService({inspectProcesses:async()=>[], discoverDeployment:()=>discoverPortalDeployment(f), spawnImpl:()=>{starts++;throw new Error('unexpected spawn');}});
  const state = await portal.inspect();
  assert.equal(state.status, 'external');
  assert.equal(state.pid, null);
  assert.equal(state.deployment.workspace, '/');
  assert.equal(state.deployment.name, 'cz-being-mac');
  assert.equal(JSON.stringify(state).includes('private-fixture'), false);
  assert.equal((await portal.start({connectUrl:'https://fixture.invalid/loom'})).status, 'external');
  assert.equal(starts, 0);
  assert.throws(()=>portal.configure({configPath:'/new.toml'}), /已有 Portal/);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), text);
});

test('external process disappearance and configuration removal cannot trigger takeover', async t => {
  const f = await fixture(t, 'workspace = "/"');
  let processes = [{pid:71,name:'heart-portal',executable:path.join(f.home,'.heart-portal','heart-portal')}];
  const portal = new PortalService({inspectProcesses:async()=>processes,discoverDeployment:observation=>discoverPortalDeployment({...f,...observation})});
  assert.equal((await portal.inspect()).pid, 71);
  processes = [];
  await fs.unlink(f.configPath);
  const state = await portal.inspect();
  assert.equal(state.status, 'external');
  assert.equal(state.owned, false);
  assert.equal(state.pid, null);
});

test('metadata ignores table fields, comments and embedded multiline text', async t => {
  const f = await fixture(t, '# workspace = "/comment"\nnotes = """\nworkspace = "/embedded"\n"""\nname = "existing"\n[cowork]\nworkspace = "/table"');
  const state = await discoverPortalDeployment(f);
  assert.equal(state.workspace, '');
  assert.equal(state.name, 'existing');
});

test('unreadable or ambiguous metadata retains existing deployment priority without guessing a root', async t => {
  for (const text of ['workspace = "relative"', 'workspace = "/a"\nworkspace = "/b"', 'workspace = "unterminated']) {
    const f = await fixture(t, text);
    assert.equal((await discoverPortalDeployment(f)).workspace, '');
  }
  const f = await fixture(t, 'workspace = "/"');
  const directory = path.dirname(f.configPath);
  await fs.rename(directory, directory+'.real');
  await fs.symlink(directory+'.real', directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await discoverPortalDeployment(f)).metadataStatus, 'unavailable');
});

test('managed configuration is excluded and unrelated running Portal gets no assumed root', async t => {
  const f = await fixture(t, 'workspace = "/"');
  const executable = path.join(f.home, '.heart-portal', process.platform === 'win32' ? 'heart-portal.exe' : 'heart-portal');
  const settings = {portalExecutable:executable,portalConfig:f.configPath,managedPortal:{executable,configPath:f.configPath}};
  assert.equal(await discoverPortalDeployment({...f,settings}), null);
  const external = await discoverPortalDeployment({...f,observedExecutable:'/another/heart-portal'});
  assert.equal(external.workspace, '');
  assert.equal(external.configPath, '');
});
