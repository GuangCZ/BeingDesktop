'use strict';
const {sanitizeText} = require('./services.cjs');
const clean = value => {
  const text=typeof value==='string'?value:JSON.stringify(value ?? '');
  return sanitizeText(text)+(text.length>2000?'\n[内容已截断]':'');
};
// Text of a tool_result: the CLI sends a string or a list of content blocks.
const resultText = content => Array.isArray(content) ? content.map(part=>typeof part?.text==='string'?part.text:part?.type==='image'?'[图片]':'').filter(Boolean).join('\n') : content;
// One line can carry several events (an assistant message with text and tool calls); callers
// accept an event or an array of them.
function normalizeEvent(agent, value) {
  if (!value || typeof value!=='object') return null;
  const type=value.type;
  if(agent==='claude') {
    // Measured 2026-09-11 (Claude Code 2.1.245, `-p --output-format stream-json --verbose`):
    // system/init opens the session; assistant messages carry text and tool_use blocks; user
    // messages carry tool_result blocks keyed by tool_use_id; system/permission_denied precedes a
    // refused tool's failed result; the final result reports is_error even with subtype success.
    if(type==='system') {
      if(value.subtype==='init')return {kind:'session',sessionId:clean(value.session_id)};
      if(value.subtype==='permission_denied')return {kind:'status',text:clean(`${value.tool_name||'工具'} 需要审批，无人值守执行已拒绝`)};
      if(value.subtype==='api_retry')return {kind:'status',text:`模型请求重试 ${Number(value.attempt)||0}/${Number(value.max_retries)||0}`};
      return null;
    }
    const content=Array.isArray(value.message?.content)?value.message.content:[];
    if(type==='assistant') {
      const events=[];
      const text=content.filter(part=>part?.type==='text'&&typeof part.text==='string').map(part=>part.text).join('\n');
      if(text)events.push({kind:'message',text:clean(text)});
      for(const part of content)if(part?.type==='tool_use')events.push({kind:'tool',callId:clean(part.id),name:clean(part.name||'tool'),status:'running',text:clean(part.input??''),output:''});
      return events.length?events:null;
    }
    if(type==='user') {
      const events=content.filter(part=>part?.type==='tool_result').map(part=>({kind:'tool',callId:clean(part.tool_use_id),name:'',status:part.is_error===true?'failed':'completed',text:'',output:clean(resultText(part.content)??'')}));
      return events.length?events:null;
    }
    if(type==='result')return {kind:'result',success:value.is_error!==true&&value.subtype==='success',text:clean(value.result??''),sessionId:clean(value.session_id)};
    if(type==='error')return {kind:'error',text:clean(value.message||value.error?.message||'Worker 执行失败。')};
    return null;
  }
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
