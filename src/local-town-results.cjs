'use strict';

const MAX_BYTES=1024*1024;
const MAX_ERROR_BYTES=4096;
const BUSINESS_STATUS={AUTH_REQUIRED:403,IDENTITY_MISMATCH:403,RATE_LIMITED:429,SERVICE_ERROR:502,INCOMPLETE_RESULT:502};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function failure(code='INCOMPLETE_RESULT') {
  return Object.assign(new Error(code==='RESULT_SOURCE_UNAVAILABLE'?'本机工具结果通道尚未就绪。':'未取得完整工具结果，已保留上次同步内容。'),{code});
}

async function readJson(response,maxBytes=MAX_BYTES) {
  if((response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase()!=='application/json')throw failure();
  const reader=response.body?.getReader();if(!reader)throw failure();
  let length=0;const chunks=[];
  try { while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>maxBytes)throw failure();chunks.push(Buffer.from(value));} }
  finally { try { await reader.cancel();reader.releaseLock(); } catch { /* Preserve the read outcome. */ } }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function businessCode(value,status) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!Object.hasOwn(value,'error'))return;
  const error=value.error;
  if(!error||typeof error!=='object'||Array.isArray(error)||Object.keys(error).length!==1||!Object.hasOwn(error,'code'))return;
  if(typeof error.code==='string'&&Object.hasOwn(BUSINESS_STATUS,error.code)&&BUSINESS_STATUS[error.code]===status)return error.code;
}

class LocalTownResults {
  constructor({getConfig,fetchImpl=globalThis.fetch}) { Object.assign(this,{getConfig,fetchImpl}); }
  async _request(method,record,{pending=false,signal}={}) {
    const config=this.getConfig();
    if(!config||typeof config.key!=='string'||config.key.length<32||/[\r\n]/.test(config.key))throw failure('RESULT_SOURCE_UNAVAILABLE');
    let base;
    try { base=new URL(config.baseUrl); } catch { throw failure('RESULT_SOURCE_UNAVAILABLE'); }
    if(base.origin!=='http://127.0.0.1:8317'||base.username||base.password||base.search||base.hash||!UUID.test(record.requestId))throw failure('RESULT_SOURCE_UNAVAILABLE');
    const url=base.origin+'/desktop-town/v1/reads/'+record.requestId;
    let response;
    try {
      response=await this.fetchImpl(url,{method,headers:{Authorization:'Bearer '+config.key,Accept:'application/json',...(method==='PUT'?{'Content-Type':'application/json'}:{})},
        ...(method==='PUT'?{body:JSON.stringify({beingId:record.beingId,route:record.route,query:record.query,...(record.source==='sbs'?{source:'sbs'}:{})})}:{}),credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store',...(signal?{signal}:{})});
      if(response.redirected)throw failure('RESULT_SOURCE_UNAVAILABLE');
      if(method==='DELETE'&&[200,204,404].includes(response.status))return;
      if(method==='PUT'&&[200,201,204].includes(response.status))return;
      if(method==='GET'&&pending&&response.status===202){
        const value=await readJson(response,MAX_ERROR_BYTES);
        if(value?.pending!==true||value.requestId!==record.requestId||value.beingId!==record.beingId||value.route!==record.route)throw failure();
        return null;
      }
      if(response.status!==200){
        let payload;
        try { payload=await readJson(response,MAX_ERROR_BYTES); } catch { /* Never expose an error response body. */ }
        const code=method==='GET'?businessCode(payload,response.status):undefined;
        if(code)throw failure(code);
        throw failure([401,403,404,503].includes(response.status)?'RESULT_SOURCE_UNAVAILABLE':'INCOMPLETE_RESULT');
      }
      return await readJson(response);
    } catch(error) { if(signal?.aborted)throw Object.assign(new Error('读取已取消。'),{code:'ABORTED'}); throw error?.code==='RESULT_SOURCE_UNAVAILABLE'||Object.hasOwn(BUSINESS_STATUS,error?.code)?error:failure('RESULT_SOURCE_UNAVAILABLE'); }
    finally { try { await response?.body?.cancel(); } catch { /* Preserve the read outcome. */ } }
  }
  prepare(record) { return this.getConfig()?this._request('PUT',record):Promise.resolve(); }
  read(record) { return this._request('GET',record); }
  poll(record,options={}) { return this._request('GET',record,{...options,pending:true}); }
  release(record) { return this.getConfig()?this._request('DELETE',record):Promise.resolve(); }
}

module.exports={LocalTownResults};
