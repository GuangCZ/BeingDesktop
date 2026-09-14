'use strict';
module.exports = async ({execute,check,settle,capture,win}) => {
  await execute(`(()=>{
    fixture.openResults=[];beingDesktop.chatOpenWorkerResult=async value=>{fixture.openResults.push(value);};
    fixture.views[fixture.A]={sessionId:fixture.A,version:500,rows:[{seq:1,role:'user',content:'写一个像素风格的多米诺骨牌',at:'2026-09-14T09:00:00Z'}],sent:[],replied:[],live:null,
      workerResults:[{workerId:'fixture-worker',sessionId:fixture.A,title:'像素多米诺骨牌',status:'passed',summary:'页面已完成，支持放置、推倒和重新开始。',evidence:'隔离测试验证了操作流程。',preview:true,at:'2026-09-14T09:01:00Z'}]};
    fixture.views[fixture.B]={sessionId:fixture.B,version:500,rows:[],sent:[],replied:[],live:null,workerResults:[]};
    fixture.current=fixture.state(500);fixture.current.chat.active=fixture.A;beingChat.setState(fixture.current);
  })()`);await settle();await settle();
  await check('native Worker result shows review and preview in the original conversation', `document.querySelector('.chat-worker-result')?.textContent.includes('页面已完成')&&document.querySelector('.chat-worker-status').textContent==='已完成'&&document.querySelectorAll('.chat-worker-open').length===1`);
  await capture('native-worker-result');
  await execute(`document.querySelector('.chat-worker-open').click()`);await settle();
  await check('native preview opens with its original session and worker binding', `fixture.openResults.length===1&&fixture.openResults[0].sessionId===fixture.A&&fixture.openResults[0].workerId==='fixture-worker'`);
  await execute(`fixture.current.chat.active=fixture.B;beingChat.setState(fixture.current)`);await settle();await settle();
  await check('Worker result does not appear in another conversation', `document.querySelectorAll('.chat-worker-result').length===0`);
  await execute(`fixture.current.chat.active=fixture.A;beingChat.setState(fixture.current)`);await settle();await settle();
  await check('Worker result is projected again after switching back without duplication', `document.querySelectorAll('.chat-worker-result').length===1`);
  await execute(`fixture.views[fixture.A].workerResults[0].summary='<img src=x onerror=alert(1)>';fixture.current.chat.version++;beingChat.setState(fixture.current)`);await settle();await settle();
  await check('Worker summary stays text and cannot create active markup', `document.querySelector('.chat-worker-summary').textContent==='<img src=x onerror=alert(1)>'&&!document.querySelector('.chat-worker-result img')`);
};
