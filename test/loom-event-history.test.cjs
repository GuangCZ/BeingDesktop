'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {createEventHistory}=require('../src/loom-event-history.cjs');

test('quarantined first errors measure from request start rather than arrival',()=>{
  const now=Date.parse('2026-09-09T05:02:39Z'),storage=new Map();
  class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const context=vm.createContext({Date:Clock,localStorage:{get length(){return storage.size;},key:i=>[...storage.keys()][i],getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},document:{addEventListener(){}},setTimeout(){},clearTimeout(){},requestAnimationFrame(){}});
  const api=vm.runInContext(`(${createEventHistory.toString()})({key:'fixture',ownId:'session',messages:()=>[]})`,context);
  api.record({deliveryId:'error',requestId:'request',startedAt:'2026-09-09T05:01:39Z',event:'error',data:{message:'failure'},seq:1});
  const group=JSON.parse(storage.get('fixture:events:session:error'));
  assert.equal(group.at,'2026-09-09T05:01:39Z');assert.equal(group.endedAt-Date.parse(group.at),60000);
  api.record({deliveryId:'error',event:'error',data:{message:'failure'},seq:1});
  assert.equal(JSON.parse(storage.get('fixture:events:session:error')).entries.length,1);
});
