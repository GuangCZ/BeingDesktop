'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const {importSessionRecovery} = require('../src/session-recovery.cjs');

test('recovery preserves current sessions, retains conflicts separately, and imports only once',()=>{
  const key='being-desktop-sessions-v1:/loom/Being';
  const original={id:'one',title:'Existing',context:'',messages:[{role:'user',content:'new'}]};
  const storage=new Map([[key,JSON.stringify({active:'one',items:[{id:'one',title:'Existing'}]})],[key+':one',JSON.stringify(original)]]);
  const context=vm.createContext({crypto:webcrypto,location:{origin:'https://fixture.invalid',pathname:'/loom/Being'},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}});
  vm.runInContext('window=globalThis; window.top=window',context);
  const recovery={origin:'https://fixture.invalid',id:'backup-1',entries:[[key,JSON.stringify({active:'one',items:[{id:'one',title:'Old'},{id:'two',title:'Second'}]})],[key+':one',JSON.stringify({...original,messages:[{role:'user',content:'old'}]})],[key+':two',JSON.stringify({id:'two',title:'Second',messages:[]})]]};
  const run=()=>vm.runInContext(`(${importSessionRecovery.toString()})(${JSON.stringify(recovery)})`,context);
  run();run();
  const index=JSON.parse(storage.get(key));
  assert.equal(index.active,'one');
  assert.equal(index.items.length,3);
  assert.deepEqual(JSON.parse(storage.get(key+':one')),original);
  const restored=index.items.find(item=>!['one','two'].includes(item.id));
  assert.equal(JSON.parse(storage.get(key+':'+restored.id)).messages[0].content,'old');
  recovery.origin='https://foreign.invalid';recovery.id='backup-2';run();
  assert.equal(JSON.parse(storage.get(key)).items.length,3);
});

test('post-migration recovery reaches only its owning Desktop namespace',()=>{
  const id=webcrypto.randomUUID(),other=webcrypto.randomUUID();
  const legacy='being-desktop-sessions-v1:/loom/Being',key='being-desktop-sessions-v2:'+id+':/loom/Being';
  const storage=new Map([[key,JSON.stringify({active:'current',items:[{id:'current'}]})],[legacy+':desktop-owner',id]]);
  const context=vm.createContext({crypto:webcrypto,location:{origin:'https://fixture.invalid',pathname:'/loom/Being'},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}});
  vm.runInContext('window=globalThis;window.top=window',context);
  const recovery={origin:'https://fixture.invalid',id:'new-backup',entries:[[legacy,JSON.stringify({active:'recovered',items:[{id:'recovered',title:'Recovered',messages:[]}]})]]};
  const run=desktop=>vm.runInContext(`(${importSessionRecovery.toString()})(${JSON.stringify(recovery)},'${desktop}')`,context);
  run(other);assert.equal(storage.size,2);
  run(id);run(id);assert.equal(JSON.parse(storage.get(key)).items.length,2);
  assert.equal(JSON.parse(storage.get(key+':recovered')).title,'Recovered');assert.equal(storage.has(legacy),false);
});
