'use strict';
const {sanitizeText} = require('./services.cjs');
const clean = value => {
  const text=typeof value==='string'?value:JSON.stringify(value ?? '');
  return sanitizeText(text)+(text.length>2000?'\n[内容已截断]':'');
};
function normalizeEvent(agent, value) {
  if (!value || typeof value!=='object') return null;
  const type=value.type;
  if(agent==='codex' && type==='error' && /^Reconnecting\.\.\.\s+\d+\/\d+\b/.test(value.message||''))return {kind:'status',text:clean(value.message)};
  if(type==='error'||type==='turn.failed')return {kind:'error',text:clean(value.message||value.error?.message||'Worker 执行失败。')};
  if(agent==='codex') {
    if(type==='thread.started')return {kind:'session',sessionId:clean(value.thread_id)};
    if(type==='turn.completed')return {kind:'result',success:true};
    const item=value.item;
    if(item && ['item.started','item.updated','item.completed'].includes(type)) {
      if(item.type==='agent_message')return {kind:'message',text:clean(item.text)};
      if(item.type==='reasoning')return {kind:'status',text:'正在分析任务'};
      return {kind:'tool',callId:clean(item.id),name:clean(item.tool||item.type),status:item.status || (type==='item.completed'?'completed':'running'),
        text:clean(item.command||item.changes||item.arguments||''),output:clean(item.aggregated_output||item.result||item.error||'')};
    }
  }
  if(agent==='cursor') {
    if(type==='system')return {kind:'session',sessionId:clean(value.session_id)};
    if(type==='assistant')return {kind:'message',text:clean(value.message?.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n'))};
    if(type==='tool_call') {
      const [name,call]=Object.entries(value.tool_call||{})[0]||['tool',{}];
      return {kind:'tool',callId:clean(value.call_id),name:clean(call.name||name),status:value.subtype==='completed'?(call.result?.error?'failed':'completed'):'running',text:clean(call.args||call.arguments),output:clean(call.result)};
    }
    if(type==='result')return {kind:'result',success:value.is_error!==true&&value.subtype==='success',text:clean(value.result),sessionId:clean(value.session_id)};
  }
  if(agent==='grok') {
    if(type==='thought')return {kind:'status',text:'正在分析任务'};
    if(type==='text')return {kind:'message',text:clean(value.data),append:true};
    if(type==='tool_call'||type==='tool_call_update')return {kind:'tool',callId:clean(value.toolCallId),name:clean(value.toolName||value.title||''),status:value.status||'running',text:clean(value.rawInput),output:clean(value.rawOutput||value.content)};
    if(type==='end')return {kind:'result',success:value.stopReason==='end_turn',text:'',sessionId:clean(value.sessionId)};
  }
  return null;
}
module.exports={normalizeEvent,clean};
