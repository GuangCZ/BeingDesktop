'use strict';

// Serialized into Loom. Result metadata is scoped to the owning conversation.
function createWorkerResults({key,ownId,messages,route}) {
  const prefix=key+':worker-result:',uuid=/^[0-9a-f-]{36}$/i;
  const labels={passed:'已完成',failed:'未完成',needs_verification:'待补充验证',ready:'结果已就绪'};
  const text=(tag,className,value)=>{const node=document.createElement(tag);node.className=className;node.textContent=value;return node;};
  let scheduled=false;
  function items(){
    const result=[];
    for(let i=0;i<localStorage.length;i++){
      const name=localStorage.key(i);if(!name?.startsWith(prefix))continue;
      try{const item=JSON.parse(localStorage.getItem(name));if(item.sessionId===ownId&&uuid.test(item.workerId)&&uuid.test(item.requestId))result.push(item);}catch{}
    }
    return result;
  }
  function render(){
    if(typeof document.querySelectorAll!=='function')return;
    const rows=[...document.querySelectorAll('#messages > .message:not(.thinking-indicator)')].filter(row=>row.classList.contains('being')||row.classList.contains('user'));
    for(const item of items()){
      const row=rows.find((row,index)=>!row.classList.contains('user')&&(row.dataset.requestId===item.requestId||messages()[index]?.request_id===item.requestId||row.querySelector('.content')?.innerText===item.body));
      const content=row?.querySelector('.content');if(!content)continue;
      const signature=JSON.stringify(item);
      if(row.dataset.workerResultSignature===signature&&content.querySelector('.desktop-worker-result'))continue;
      row.dataset.workerResultSignature=signature;row.dataset.workerResultText=item.body;row.dataset.requestId=item.requestId;
      const card=document.createElement('section');card.className='desktop-worker-result';card.dataset.workerId=item.workerId;
      card.append(text('div','desktop-worker-result-status',labels[item.status]),text('h3','desktop-worker-result-title',item.title),text('div','desktop-worker-result-summary',item.summary));
      if(item.preview){
        const open=text('a','desktop-worker-result-open','打开预览');open.href='https://being-desktop-result.invalid/open/'+item.workerId;open.target='_blank';open.rel='noopener';
        card.append(open,text('span','desktop-worker-result-hint','在 Desktop 内置浏览器中打开'));
      }
      if(item.evidence){const evidence=document.createElement('details');evidence.className='desktop-worker-result-evidence';evidence.append(text('summary','','查看验收依据'),text('pre','',item.evidence));card.append(evidence);}
      content.replaceChildren(card);
    }
  }
  function schedule(){if(!scheduled){scheduled=true;queueMicrotask(()=>{scheduled=false;render();});}}
  if(typeof window.addEventListener==='function')window.addEventListener('storage',event=>{if(event.key?.startsWith(prefix))schedule();});
  return {render,schedule,async deliver(item){
    if(!item||!uuid.test(item.workerId)||!uuid.test(item.requestId)||!uuid.test(item.sessionId)||!labels[item.status]||typeof item.summary!=='string'||item.summary.length>8000||typeof item.evidence!=='string'||item.evidence.length>16000)return false;
    const value={sessionId:item.sessionId,requestId:item.requestId,workerId:item.workerId,status:item.status,title:String(item.title||'任务结果').slice(0,160),summary:item.summary,evidence:item.evidence,preview:Boolean(item.preview)};
    value.body=labels[value.status]+'\n\n'+value.title+'\n\n'+value.summary+(value.evidence?'\n\n验收依据：'+value.evidence:'');
    const name=prefix+value.workerId,previous=localStorage.getItem(name);localStorage.setItem(name,JSON.stringify(value));
    const delivered=await route(`会话id：${value.sessionId}\n请求id：${value.requestId}\n${value.body}`,{deliveryId:'worker-review:'+value.requestId});
    if(!delivered){if(previous)localStorage.setItem(name,previous);else localStorage.removeItem(name);return false;}
    schedule();return true;
  }};
}
module.exports={createWorkerResults};
