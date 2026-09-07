'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {FeatureTasks}=require('../src/feature-tasks.cjs');
const {discussFeatureTask}=require('../src/feature-task-discussion.cjs');

function fixture() {
  let ledger=new FeatureTasks();
  const task=ledger.begin({feature:'bonfire',operation:'read',title:'读取篝火',execution:'being'});
  ledger.complete(task.id,{summary:'已读取 10 条消息。token=private-value'});
  let context={connection:{},generation:1};
  const drafts=[];
  return {task,drafts,options:{getLedger:()=>ledger,getContext:()=>context,prepareDraft:async(text,getContext)=>{getContext();drafts.push(text);}},changeLedger:()=>{ledger=new FeatureTasks();},changeContext:()=>{context={...context,generation:2};}};
}

test('discussion explicitly prepares only a safe summary, without sending or changing task status',async()=>{
  const f=fixture();
  assert.deepEqual(await discussFeatureTask(f.task.id,f.options),{prepared:true,taskId:f.task.id});
  assert.equal(f.drafts.length,1);
  assert.match(f.drafts[0],/读取篝火/);
  assert.match(f.drafts[0],/已读取 10 条/);
  assert.match(f.drafts[0],/尚未确认与聊天执行队列隔离/);
  assert.doesNotMatch(f.drafts[0],/private-value/);
  assert.equal(f.options.getLedger().get(f.task.id).status,'succeeded');
});

test('unknown and previous identity tasks cannot prepare a draft',async()=>{
  const f=fixture();
  await assert.rejects(discussFeatureTask({},f.options),/有效/);
  await assert.rejects(discussFeatureTask('missing',f.options),/不存在/);
  f.changeLedger();
  await assert.rejects(discussFeatureTask(f.task.id,f.options),/不存在/);
  assert.equal(f.drafts.length,0);
});

test('draft preparation propagates existing-draft errors and preserves the task',async()=>{
  const f=fixture();
  f.options.prepareDraft=async()=>{throw new Error('Loom 中已有草稿');};
  await assert.rejects(discussFeatureTask(f.task.id,f.options),/已有草稿/);
  assert.equal(f.options.getLedger().get(f.task.id).status,'succeeded');
});

test('identity and connection are checked again during asynchronous preparation',async()=>{
  for(const kind of ['changeLedger','changeContext']) {
    const f=fixture();
    f.options.prepareDraft=async(_prompt,current)=>{f[kind]();current();};
    await assert.rejects(discussFeatureTask(f.task.id,f.options),/变化/);
  }
});
