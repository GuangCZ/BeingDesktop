'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {sidebarState,updateSidebar}=require('../src/sidebar-state.cjs');
const one='11111111-1111-4111-8111-111111111111',two='22222222-2222-4222-8222-222222222222';
test('sidebar changes are isolated by Being connection and reject stale requests',()=>{
  const saved=updateSidebar({},'owner-a','/work',{scope:'owner-a',type:'pin',id:one},[one]);
  assert.equal(sidebarState(saved,'owner-a').tasks[one].pinned,true);
  assert.deepEqual(sidebarState(saved,'owner-b').tasks,{});
  assert.throws(()=>updateSidebar(saved,'owner-b','',{scope:'owner-a',type:'archive',id:one},[one]),/连接已变化/);
  assert.throws(()=>updateSidebar(saved,'owner-a','',{scope:'owner-a',type:'pin',id:two},[one]),/会话不存在/);
});
test('archiving preserves the session and project assignment and can be reversed',()=>{
  let saved=updateSidebar({},'a','/work',{scope:'a',type:'move',id:one,project:'/work'},[one]);
  saved=updateSidebar(saved,'a','/work',{scope:'a',type:'pin',id:one},[one]);
  saved=updateSidebar(saved,'a','/work',{scope:'a',type:'archive',id:one},[one]);
  assert.deepEqual(sidebarState(saved,'a').tasks[one],{pinned:false,archived:true,project:'/work',touchedAt:0});
  saved=updateSidebar(saved,'a','/work',{scope:'a',type:'archive',id:one},[one]);
  assert.equal(sidebarState(saved,'a').tasks[one].archived,false);
});
test('invalid project assignments are rejected and removing a project retains its tasks',()=>{
  let saved=updateSidebar({projects:['/a','/b']},'a','/b',{scope:'a',type:'move',id:one,project:'/a'},[one]);
  assert.throws(()=>updateSidebar(saved,'a','/b',{scope:'a',type:'move',id:one,project:'/unknown'},[one]),/项目不存在/);
  saved=updateSidebar(saved,'a','/b',{scope:'a',type:'remove-project',project:'/a'},[one]);
  assert.deepEqual(sidebarState(saved,'a').projects,['/b']);
  assert.equal(sidebarState(saved,'a').tasks[one].project,'');
});
test('reading metadata normalizes malformed values without changing the saved object',()=>{
  const saved={projects:['/a','/a','relative','/bad\0path','C:\\work'],owners:{a:{tasks:{[one]:{pinned:'true',archived:false,project:'/missing',touchedAt:'secret',credential:'never exposed'},bad:{pinned:true}}}}};
  const original=structuredClone(saved), result=sidebarState(saved,'a');
  assert.deepEqual(result.projects,['/a','C:\\work']);
  assert.deepEqual(result.tasks,{[one]:{pinned:false,archived:false,project:'',touchedAt:0}});
  assert.deepEqual(saved,original);
});
test('removing the current project does not re-add it and works while disconnected',()=>{
  const saved=updateSidebar({},'','/work',{scope:'',type:'remove-project',project:'/work'});
  assert.deepEqual(sidebarState(saved,'','/work').projects,[]);
  assert.deepEqual(saved.owners,{});
});
