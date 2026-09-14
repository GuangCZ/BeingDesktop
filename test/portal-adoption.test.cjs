'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {adoptionRecord,matchesAdoption}=require('../src/portal-adoption.cjs');
const fixture=()=>({kind:'launchagent',descriptor:{executable:'/home/portal',configPath:'/home/portal.toml',label:'town.beings.heart-portal',plist:'/home/agent.plist',wrapper:'/home/start.sh',wrapperHash:'original-wrapper',plistHash:'original-plist',EnvironmentVariables:{TOKEN:'never-return-this'}}});
test('adoption binds only a recognized original deployment and excludes credential-bearing launch data',()=>{
  const adapter=fixture(),record=adoptionRecord(adapter);
  assert.ok(matchesAdoption(JSON.parse(JSON.stringify(record)),adoptionRecord(adapter)));
  assert.doesNotMatch(JSON.stringify(record),/TOKEN|EnvironmentVariables|never-return-this/);
  assert.throws(()=>adoptionRecord({kind:'desktop'}),/识别/);
});
test('another executable, config, label or launcher cannot reuse saved adoption',()=>{
  const record=adoptionRecord(fixture());
  for(const key of ['executable','configPath','label','plist','wrapper','wrapperHash','pointerHash']) {
    const adapter=fixture();adapter.descriptor[key]='changed';assert.equal(matchesAdoption(record,adoptionRecord(adapter)),false,key);
  }
  assert.equal(matchesAdoption(null,record),false);assert.equal(matchesAdoption({...record,schema:2},record),false);
});
test('updating binary and supervision plist preserves the same original manager binding',()=>{
  const adapter=fixture(),record=adoptionRecord(adapter);adapter.descriptor.plistHash='with-supervision-marker';adapter.descriptor.version='0.8.4';
  assert.ok(matchesAdoption(record,adoptionRecord(adapter)));
});
test('Windows adoption is invalidated by a changed saved launch',()=>{
  const adapter={kind:'windows-supervisor',descriptor:{executable:'C:/portal/heart-portal.exe',configPath:'C:/portal/portal.toml',root:'C:/portal',launchPath:'C:/portal/.portal-launch.json',launchHash:'before'}};
  const record=adoptionRecord(adapter);adapter.descriptor.launchHash='after';assert.equal(matchesAdoption(record,adoptionRecord(adapter)),false);
});
