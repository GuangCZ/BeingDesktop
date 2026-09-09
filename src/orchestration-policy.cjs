'use strict';
const PROTOCOL='being-orchestrator/1';
const error=message=>Object.assign(new Error(message),{code:'ORCHESTRATION_NOT_ENFORCED'});
function endpoints(baseUrl) {
  const url=new URL(baseUrl);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw error('模型地址不支持安全切换，请使用无凭据参数的 CLIProxyAPI 地址。');
  const current=url.pathname.replace(/\/+$/,'');
  if(!current.endsWith('/v1'))throw error('严格编排模式需要 CLIProxyAPI 的 /v1 模型入口。');
  const prefix=current.endsWith('/orchestrator/v1')?current.slice(0,-'/orchestrator/v1'.length):current.slice(0,-3);
  return {strict:url.origin+prefix+'/orchestrator/v1',capabilities:url.origin+prefix+'/orchestrator/capabilities'};
}
class OrchestrationPolicy {
  constructor({readConfig,saveConfig,getIdentity,getRecord,saveRecord,fetchImpl,fallbackFetchImpl,onChange=()=>{}}) {
    Object.assign(this,{readConfig,saveConfig,getIdentity,getRecord,saveRecord,fetchImpl,fallbackFetchImpl,onChange});
    this.state={status:'unchecked',detail:'严格编排入口尚未核验。'};
  }
  publish(status,detail){this.state={status,detail};this.onChange({...this.state});}
  async capabilities(baseUrl) {
    const target=endpoints(baseUrl);
    let response,data;
    try {
      const options={method:'GET',redirect:'error',credentials:'omit',cache:'no-store'};
      try{response=await this.fetchImpl(target.capabilities,options);}
      catch(failure){
        if(!this.fallbackFetchImpl)throw failure;
        // Retry the same public endpoint with Node's transport when Chromium cannot connect.
        response=await this.fallbackFetchImpl(target.capabilities,options);
      }
      if(!response.ok || !response.headers.get('content-type')?.includes('application/json'))throw new Error('Unsupported gateway');
      const reader=response.body?.getReader();if(!reader)throw new Error('Missing gateway response');
      const chunks=[];let size=0;
      try {
        while(true) {
          const part=await reader.read();if(part.done)break;
          size+=part.value.byteLength;if(size>8192)throw new Error('Invalid gateway response');
          chunks.push(Buffer.from(part.value));
        }
      }finally{try{await reader.cancel();}catch{/* The response may already be closed. */}}
      data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch{throw error('CLIProxyAPI 尚未提供严格编排入口，请先更新并启动支持该入口的代理。不会使用普通执行模式代替。');}
    if(data.protocol!==PROTOCOL||data.provider!=='openai-responses'||data.enforcement!=='worker-tools-only')throw error('模型入口没有确认 worker 专用执行限制，编排模式未生效。');
    return target;
  }
  async configure(enabled) {
    const identity=this.getIdentity();if(!identity)throw error('请先连接 Being。');
    const current=await this.readConfig();
    const checkIdentity=()=>{if(identity!==this.getIdentity())throw error('Being 连接已变化，编排配置未完成。');};
    checkIdentity();
    const config=current.config,record=this.getRecord();
    if(enabled) {
      if(config.provider!=='openai-responses')throw error('当前严格编排入口支持 OpenAI Responses，请先选择对应模型服务。');
      const target=await this.capabilities(config.baseUrl);checkIdentity();
      if(config.baseUrl.replace(/\/+$/,'')===target.strict && (!record||record.identity!==identity))throw error('当前模型已使用编排入口，但缺少原地址恢复记录，请先在模型设置中确认地址。');
      const next=record?.identity===identity&&record.strictBaseUrl===target.strict?record:{identity,originalBaseUrl:config.baseUrl,strictBaseUrl:target.strict};
      // Persist recovery information before modifying the remote model endpoint.
      await this.saveRecord(next);checkIdentity();
      await this.saveConfig({connectionId:current.connectionId,model:config.model,provider:config.provider,baseUrl:target.strict});checkIdentity();
      await this.assertEnforced();
    } else {
      if(record?.identity===identity) {
        if(config.provider==='openai-responses'&&config.baseUrl.replace(/\/+$/,'')===record.strictBaseUrl) {
          await this.saveConfig({connectionId:current.connectionId,model:config.model,provider:config.provider,baseUrl:record.originalBaseUrl});checkIdentity();
        }
        // A separately changed model endpoint must not be overwritten on disable.
        await this.saveRecord(null);
      }
      this.publish('disabled','编排模式已关闭。');
    }
  }
  async assertEnforced() {
    try {
      const identity=this.getIdentity(),record=this.getRecord();
      if(!identity||record?.identity!==identity)throw error('此 Being 尚未建立严格编排绑定，请重新开启模式。');
      const current=await this.readConfig();
      if(identity!==this.getIdentity()||current.config.provider!=='openai-responses'||current.config.baseUrl.replace(/\/+$/,'')!==record.strictBaseUrl)throw error('Being 的模型入口已变化，消息已阻止发送；请重新开启严格编排模式。');
      await this.capabilities(record.strictBaseUrl);
      if(identity!==this.getIdentity())throw error('Being 连接已变化。');
      this.publish('enforced','已核验：模型入口只允许 worker 调度，直接执行调用会被拦截。');
    }catch(failure){this.publish('blocked',failure.code==='ORCHESTRATION_NOT_ENFORCED'?failure.message:'编排权限检查失败，消息已阻止发送。');throw error(this.state.detail);}
  }
}
module.exports={OrchestrationPolicy,endpoints,PROTOCOL};
