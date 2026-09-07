'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {GroveActions} = require('../src/grove-actions.cjs');

test('batch walks server-capped pages, skips unsupported kits, continues failures and activates once',async()=>{
  const prepared=[],installed=[],activations=[],offsets=[];
  const kits=['one','manual','broken','two'].map(id=>({id,name:id}));
  const actions=new GroveActions({
    installer:{async prepare(id){prepared.push(id);return {status:id==='manual'?'needs_being':'ready',kit:{id,name:id},assessment:{}};},async install(id){installed.push(id);if(id==='broken')throw new Error('failure');return {status:'installed',kit:{id,name:id},detail:'Installed'};}},
    getCatalog:async({offset})=>{offsets.push(offset);return {kits:kits.slice(offset,offset+2),count:4};},
    activate:async results=>{activations.push(results.map(result=>result.id));return {loaded:true,detail:'Verified'};},
  });
  const result=await actions.installEligible({});
  assert.deepEqual(offsets,[0,2]);
  assert.deepEqual(prepared,['one','manual','broken','two']);
  assert.deepEqual(installed,['one','broken','two']);
  assert.deepEqual(activations,[['one','two']]);
  assert.deepEqual(result.results.map(item=>item.status),['installed','needs_being','failed','installed']);
  assert.equal(result.results[3].loaded,true);
});

test('unsupported single kit cannot call installer or activate',async()=>{
  const actions=new GroveActions({installer:{prepare:async()=>({status:'needs_being',assessment:{}}),install:()=>assert.fail('Unsupported install')},activate:()=>assert.fail('Unsupported activation')});
  assert.equal((await actions.install({id:'unsupported'})).status,'needs_being');
  assert.throws(()=>actions.install({id:'x',command:'bad'}));
  assert.throws(()=>actions.installEligible({ids:['x']}));
});

test('activation failure retains completed installation and never claims Portal loading',async()=>{
  const actions=new GroveActions({installer:{prepare:async()=>({status:'ready',assessment:{}}),install:async()=>({status:'installed',kit:{name:'one'},detail:'Verified'})},activate:async()=>{throw new Error('Start failed');}});
  const result=await actions.install({id:'one'});
  assert.equal(result.status,'installed');
  assert.equal(result.loaded,false);
  assert.match(result.detail,/Portal/);
});

test('Being assistance carries exact kit identity and unmet requirements',async()=>{
  const actions=new GroveActions({installer:{prepare:async id=>({status:'needs_being',detail:'缺少入口文件',kit:{id,name:'claude-sdk',version:'1.0.0',being_id:'publisher'},assessment:{reasons:['包内没有 server.mjs']}})}});
  const draft=await actions.assistance({id:'sample'});
  assert.match(draft,/Kit ID：sample/);
  assert.match(draft,/包内没有 server.mjs/);
  assert.match(draft,/不要索要或复述 Loom/);
});
