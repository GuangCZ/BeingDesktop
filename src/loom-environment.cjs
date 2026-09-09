'use strict';

// Request a fresh, whitelisted host snapshot immediately before sending a chat.
function installEnvironmentReader() {
  const pending=new Map();
  globalThis.__beingDesktopReceiveEnvironment=({id,value,error})=>{
    const request=pending.get(id);if(!request)return;
    pending.delete(id);clearTimeout(request.timer);
    if(error)request.reject(new Error(error==='ORCHESTRATION_NOT_ENFORCED'?'严格编排检查未通过，消息未发送。请在设置中确认编排入口与 Worker 连接；不会改为 Being 自行执行。':'桌面环境尚未就绪，请稍后重新发送。'));
    else request.resolve(value);
  };
  globalThis.__beingDesktopEnvironment=(sessionId,titleInput='')=>new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('无法读取当前桌面环境，消息尚未发送。'));},10000);
    pending.set(id,{resolve,reject,timer});
    globalThis.__beingDesktopRequestEnvironment(JSON.stringify({id,sessionId,titleInput}));
  });
}

async function prepareLoomEnvironment(contents,provider) {
  const debuggerClient=contents.debugger;
  const contexts=new Map();let pending=0;
  const {frameTree}=await contents.debugger.sendCommand('Page.getFrameTree');
  const frameId=frameTree.frame.id;
  const handler=async(_event,method,params)=>{
    if(method==='Runtime.executionContextCreated') {
      const context=params.context;
      contexts.set(context.id,Boolean(context.auxData?.isDefault && context.auxData?.frameId===frameId));
    } else if(method==='Runtime.executionContextDestroyed')contexts.delete(params.executionContextId);
    else if(method==='Runtime.executionContextsCleared')contexts.clear();
    else if(method==='Runtime.bindingCalled' && params.name==='__beingDesktopRequestEnvironment' && contexts.get(params.executionContextId)) {
      let request;
      try {request=JSON.parse(params.payload);} catch {return;}
      const uuid=/^[0-9a-f-]{36}$/i;
      if(!uuid.test(request?.id || '') || !uuid.test(request?.sessionId || ''))return;
      const answer={id:request.id};
      pending++;
      try {
        if(pending>8)throw new Error('Too many environment requests');
        answer.value=await provider(request.sessionId,typeof request.titleInput==='string'?request.titleInput.slice(0,4000):'');
      } catch(error) {answer.error=error?.code==='ORCHESTRATION_NOT_ENFORCED'?'ORCHESTRATION_NOT_ENFORCED':true;}
      finally {pending--;}
      if(contents.isDestroyed() || !contexts.get(params.executionContextId))return;
      await contents.debugger.sendCommand('Runtime.evaluate',{contextId:params.executionContextId,
        expression:`globalThis.__beingDesktopReceiveEnvironment?.(${JSON.stringify(answer)})`}).catch(()=>{});
    }
  };
  contents.debugger.on('message',handler);
  contents.once('destroyed',()=>debuggerClient.removeListener('message',handler));
  await contents.debugger.sendCommand('Runtime.enable');
  await contents.debugger.sendCommand('Runtime.addBinding',{name:'__beingDesktopRequestEnvironment'});
  await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`(${installEnvironmentReader.toString()})()`});
}
module.exports={prepareLoomEnvironment};
