'use strict';
const {publicModelUrl} = require('./security.cjs');

function emptyRuntime() {
  return {status:'unknown',error:'',checkedAt:null,configStatus:'unknown',configError:'',configCheckedAt:null,
    model:'',provider:'',baseUrl:'',sideBySide:{configured:null,active:null},activeStream:{active:null}};
}

function readRuntime(results, checkedAt) {
  const next=emptyRuntime();
  const [health,config,active]=results;
  next.checkedAt=checkedAt;
  next.configCheckedAt=checkedAt;
  next.status=health.status==='fulfilled'?'connected':'error';
  next.error=next.status==='error'?'运行时状态读取失败，请检查网络与连接凭据。':'';
  const c=config.status==='fulfilled' && config.value;
  if(c && typeof c==='object' && !Array.isArray(c) && typeof c.model==='string' && typeof c.provider==='string') {
    next.configStatus='connected';
    next.model=c.model;
    next.provider=c.provider;
    next.baseUrl=publicModelUrl(c.base_url);
    next.sideBySide.configured=typeof c.sbs_enabled==='boolean'?c.sbs_enabled:null;
  } else {
    next.configStatus='error';
    next.configError='模型与并肩配置读取失败，当前值未知；重新读取成功后更新。';
  }
  if(active.status==='fulfilled') {
    if(active.value===null)next.activeStream.active=false;
    else if(typeof active.value?.finished==='boolean')next.activeStream.active=!active.value.finished;
    if(next.activeStream.active === true) {
      const stream = active.value;
      const safe = value => typeof value === 'string' ? value.slice(0, 160) : '';
      next.activeStream.id = safe(stream.stream_id);
      next.activeStream.sessionId = safe(stream.session_id);
      next.activeStream.phase = 'awaiting_first';
      next.activeStream.tool = '';
      const phases = {thinking:'reasoning', reasoning:'reasoning', tool_use:'tool', tool_result:'working', content_block_delta:'text', message_stop:'continuing', error:'error'};
      for(const item of Array.isArray(stream.events) ? stream.events : []) {
        if (!item || !Object.hasOwn(phases, item.event)) continue;
        next.activeStream.phase = phases[item.event];
        next.activeStream.tool = item.event === 'tool_use' ? safe(item.data?.name) : '';
      }
    }
  }
  return next;
}

function updateRuntimeConfig(runtime, snapshot) {
  const {config, checkedAt} = snapshot;
  return {...runtime, configStatus:'connected', configError:'', configCheckedAt:checkedAt,
    model:config.model, provider:config.provider, baseUrl:config.baseUrl,
    sideBySide:{...runtime.sideBySide, configured:config.sbsEnabled}};
}

module.exports={emptyRuntime,readRuntime,updateRuntimeConfig};
