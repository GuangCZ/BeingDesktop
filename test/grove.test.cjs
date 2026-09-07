'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {getGroveCatalog,getGroveDetail,assessKit} = require('../src/grove.cjs');

function kit(patch = {}) {
  return {id:'kit-123',name:'example-kit',version:'1.0.0',description:'An example tool',being_id:'alice',display_name:'Alice',status:'sprouting',has_bundle:true,schema_complete:true,install_count:2,self_calls:4,total_calls:4,...patch};
}

function detail(patch = {}) {
  return {...kit(),manifest:{name:'example-kit',version:'1.0.0',description:'An example tool',command:['node','server.mjs'],platform:['windows','linux'],tools:[{name:'health',description:'Check health',params:{type:'object',properties:{}}}],provision:{runtime:{name:'node',version:'>=18'}}},bundle_hash:'a'.repeat(64),bundle_size:1234,download_url:'https://beings.town/api/grove/kit-123/download',source_url:'',setup_guide:{steps:['Inspect manifest before installing.'],deps:[],env_template:{}},...patch};
}

function response(value, options = {}) {
  return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'},...options});
}

test('catalog only fetches its fixed public endpoint and limits sanitized results',async()=>{
  let calls = 0;
  const fetchImpl = async(url,options)=>{
    calls++;
    assert.equal(url,'https://beings.town/api/grove?limit=2&offset=3');
    assert.deepEqual(options,{method:'GET',redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{Accept:'application/json'}});
    return response({kits:[kit({token:'private-credential',unexpected:{secret:'secret'}}),kit({id:'kit-124'}),kit({id:'kit-125'})],count:21,returned:999,token:'private-credential'});
  };
  const result = await getGroveCatalog({limit:2,offset:3},{fetchImpl});
  assert.equal(calls,1);
  assert.deepEqual(Object.keys(result).sort(),['count','kits','returned']);
  assert.equal(result.count,21); assert.equal(result.returned,2); assert.equal(result.kits.length,2);
  assert.doesNotMatch(JSON.stringify(result),/private-credential|unexpected|secret/);
});

test('invalid pagination and identifiers never issue a network request',async()=>{
  const fetchImpl = async()=>assert.fail('Invalid input must be rejected before networking');
  for (const pagination of [null,[],4,{limit:0},{limit:101},{limit:'2'},{offset:-1},{offset:Infinity},{offset:100001},{offset:0.5}]) await assert.rejects(getGroveCatalog(pagination,{fetchImpl}),/参数无效/);
  for (const id of [null,{},[],1,'','..','../token','a/b','a\\b','a?token=secret','a#b','a%2fb','https://example.com/','help','token','my','publish','install','a'.repeat(97),'__proto__']) await assert.rejects(getGroveDetail(id,{fetchImpl}),/标识无效/);
  await assert.rejects(getGroveDetail('kit-123',null),/参数无效/);
  assert.throws(()=>assessKit(detail(),null),/参数无效/);
});

test('detail preserves the documented public shape but strips credentials and nonpublic fields',async()=>{
  const raw = detail({source_url:'https://github.com/example/kit/releases/tag/v1?token=private-link#secret',download_url:'https://beings.town/api/grove/kit-123/download?sig=private-signature',token:'hidden-field',description:'<img src=x onerror=alert(1)>\u0000 Authorization: Bearer PRIVATE\nDocs https://name:pass@example.com/doc?token=secret#fragment',setup_guide:{steps:['TOKEN=real-secret','node server.mjs --api-key secret-value'],deps:[],env_template:{OPENAI_API_KEY:'real-key'}}});
  raw.manifest.env = {API_KEY:'real-key'};
  raw.manifest.tools[0].params.properties.password = {type:'string',description:'A required password',default:'never-return-this-secret',examples:['also-secret']};
  const result = await getGroveDetail('example-kit',{fetchImpl:async(url)=>{assert.equal(url,'https://beings.town/api/grove/example-kit');return response(raw);}});
  assert.equal(result.manifest.command[0],'node');
  assert.equal(result.source_url,'https://github.com/example/kit/releases/tag/v1');
  assert.equal(result.download_url,'https://beings.town/api/grove/kit-123/download');
  assert.equal(result.bundle_hash,'a'.repeat(64)); assert.equal(result.bundle_size,1234);
  assert.equal(result.manifest.env.API_KEY,'[需配置]');
  assert.equal(result.setup_guide.env_template.OPENAI_API_KEY,'[需配置]');
  assert.deepEqual(result.manifest.tools[0].params.properties.password,{type:'string',description:'A required password'});
  assert.match(result.description,/<img/); // Plain text content is preserved, never treated as HTML.
  assert.doesNotMatch(JSON.stringify(result),/hidden-field|real-key|real-secret|secret-value|never-return|also-secret|private-link|private-signature|name:pass|PRIVATE|\\u0000/);
});

test('detail rejects mismatched records and limits renderer-facing text and lists',async()=>{
  await assert.rejects(getGroveDetail('different',{fetchImpl:async()=>response(detail())}),/不匹配/);
  const raw = detail({description:'x'.repeat(20000),setup_guide:{steps:Array(90).fill('y'.repeat(8000)),env_template:{}}});
  const result = await getGroveDetail('kit-123',{fetchImpl:async()=>response(raw)});
  assert.equal(result.description.length,4000);
  assert.equal(result.setup_guide.steps.length,40);
  assert.equal(result.setup_guide.steps[0].length,4000);
});

test('response size is bounded both from content length and streaming bytes',async()=>{
  const large = new Uint8Array(1024 * 1024 + 1);
  let canceled = 0;
  const stream = ()=>new ReadableStream({start(controller){controller.enqueue(large);},cancel(){canceled++;}});
  await assert.rejects(getGroveCatalog({}, {fetchImpl:async()=>new Response(stream(),{headers:{'Content-Type':'application/json','Content-Length':String(large.length)}})}),/大小不受支持/);
  assert.equal(canceled,1);
  await assert.rejects(getGroveCatalog({}, {fetchImpl:async()=>new Response(stream(),{headers:{'Content-Type':'application/json'}})}),/大小限制/);
  assert.equal(canceled,2);
});

test('network, redirects and response failures become fixed Chinese messages without raw errors',async()=>{
  const failures = [
    async()=>{throw new Error('Authorization: Bearer private-upstream-secret');},
    async()=>response({error:'private-upstream-secret'},{status:500}),
    async()=>response({error:'private-upstream-secret'},{status:404}),
    async()=>new Response('<script>private-upstream-secret</script>',{headers:{'Content-Type':'text/html'}}),
    async()=>new Response('private-upstream-secret',{headers:{'Content-Type':'application/json'}}),
    async()=>({...response({}),ok:true,redirected:true}),
    async()=>({...response({}),ok:true,url:'https://evil.example/api/grove'})
  ];
  for (const fetchImpl of failures) await assert.rejects(getGroveCatalog({}, {fetchImpl}),error=>{
    assert.match(error.message,/Grove/);
    assert.doesNotMatch(error.message,/private-upstream-secret|evil\.example|Authorization/);
    return true;
  });
});

test('unsafe public links never become download or source links',async()=>{
  for (const source_url of ['javascript:alert(1)','file:///C:/secret','http://example.com/archive','https://user:secret@example.com/archive','https://localhost/file','https://example.com:444/file']) {
    const result = await getGroveDetail('kit-123',{fetchImpl:async()=>response(detail({source_url,download_url:source_url}))});
    assert.equal(result.source_url,''); assert.equal(result.download_url,'');
  }
  const result = await getGroveDetail('kit-123',{fetchImpl:async()=>response(detail({download_url:'https://github.com/example/archive.tar.gz'}))});
  assert.equal(result.download_url,'');
});

test('prototype keys in public manifest schemas cannot alter objects',async()=>{
  const raw = detail();
  raw.manifest.tools[0].params = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string","polluted":true},"constructor":{"type":"string"},"safe":{"type":"string"}}}');
  raw.manifest.platforms = JSON.parse('{"supported":["windows"],"backend_matrix":{"__proto__":["windows"],"cdp":["windows"]}}');
  const result = await getGroveDetail('kit-123',{fetchImpl:async()=>response(raw)});
  assert.equal({}.polluted,undefined);
  assert.deepEqual(Object.keys(result.manifest.tools[0].params.properties),['safe']);
  assert.deepEqual(Object.keys(result.manifest.platforms.backend_matrix),['cdp']);
});

test('known Hand backend Windows support does not override the full kit platform declaration',()=>{
  const input = detail();
  delete input.manifest.platform;
  input.manifest.command = ['bash','start.sh'];
  delete input.manifest.provision;
  input.manifest.platforms = {supported:['darwin','linux'],backend_matrix:{cdp:['windows','darwin','linux'],ax:['darwin']}};
  const result = assessKit(input,{platform:'win32',arch:'x64'});
  assert.deepEqual(result.platforms,['darwin','linux']);
  assert.equal(result.runtime.name,'bash');
  assert.equal(result.installable,false); assert.equal(result.blocked,true);
  assert.ok(result.reasons.some(reason=>reason.includes('不包含 Windows')));
  assert.ok(result.reasons.some(reason=>reason.includes('Bash')));
  assert.equal(input.manifest.platforms.backend_matrix.cdp[0],'windows');
});

test('missing platform evidence stays unverified and is distinct from explicit unsupported',()=>{
  const input = detail(); delete input.manifest.platform;
  input.manifest.platforms = {backend_matrix:{cdp:['windows']}};
  const result = assessKit(input);
  assert.deepEqual(result.platforms,[]);
  assert.ok(result.reasons.some(reason=>reason.includes('未声明支持的操作系统')));
  assert.ok(result.reasons.every(reason=>!reason.includes('不包含 Windows')));
});

test('Portal singular platform and Grove provisions are intersected conservatively',()=>{
  const input = detail();
  input.manifest.platforms = {supported:['darwin','windows']};
  input.manifest.provision.platforms = ['windows'];
  input.manifest.architectures = ['arm64'];
  const result = assessKit(input);
  assert.deepEqual(result.platforms,['win32']);
  assert.ok(result.reasons.some(reason=>reason.includes('处理器架构不包含 x64')));
  assert.ok(result.reasons.every(reason=>!reason.includes('不包含 Windows')));
});

test('Grove string commands and inputSchema-only tools are not silently adapted to Portal',()=>{
  const input = detail();
  input.manifest.command = 'node server.mjs';
  input.manifest.tools = [{name:'health',description:'Health',inputSchema:{type:'object'}}];
  const result = assessKit(input);
  assert.equal(result.manifestCompatible,false);
  assert.ok(result.reasons.some(reason=>reason.includes('command 是字符串')));
  assert.ok(result.reasons.some(reason=>reason.includes('params')));
  assert.equal(result.tools[0].params,undefined);
  assert.deepEqual(result.tools[0].inputSchema,{type:'object'});
});

test('an otherwise compatible manifest still requires runtime and archive verification',()=>{
  const result = assessKit(detail());
  assert.equal(result.manifestCompatible,true);
  assert.equal(result.archiveReady,true);
  assert.equal(result.runtime.verified,false);
  assert.equal(result.installable,false);
  assert.ok(result.reasons.some(reason=>reason.includes('本机 node >=18')));
  assert.ok(result.reasons.some(reason=>reason.includes('下载后校验摘要')));
});

test('required dependencies, local configuration and lifecycle are visible blockers',()=>{
  const input = detail();
  input.manifest.provision.deps = [{name:'sdk',required:true}];
  input.manifest.provision.post_install = 'npm install';
  input.manifest.provision.config_files = {auth:'~/.pi/agent/auth.json'};
  input.manifest.command.push('{{KIT_HOME}}/config.json');
  const result = assessKit(input);
  for (const expected of ['必需依赖','生命周期脚本','配置文件','发布者路径']) assert.ok(result.reasons.some(reason=>reason.includes(expected)));
});

test('missing hashes and external redirects never count as a verifiable bundle',()=>{
  for (const patch of [{bundle_hash:''},{bundle_size:0},{bundle_size:101*1024*1024},{has_bundle:false},{download_url:'https://example.com/file.tar.gz'}]) {
    const result = assessKit(detail(patch));
    assert.equal(result.archiveReady,false);
    assert.equal(result.installable,false);
  }
  const result = assessKit(detail({has_bundle:false,source_url:'https://github.com/example/kit/releases/tag/v1'}));
  assert.ok(result.reasons.some(reason=>reason.includes('外部来源尚未验证')));
});

test('grown and sprouting remain usage statuses and never affect compatibility',()=>{
  assert.deepEqual(assessKit(detail({status:'grown',self_calls:500})),assessKit(detail({status:'sprouting',self_calls:1})));
});

test('display truncation cannot make an oversized command or tools list appear manifest-compatible',async()=>{
  const raw = detail(); raw.manifest.command = Array(65).fill('arg');
  raw.manifest.tools = Array(101).fill(raw.manifest.tools[0]);
  const safe = await getGroveDetail('kit-123',{fetchImpl:async()=>response(raw)});
  assert.equal(safe.manifest.command.length,64); assert.equal(safe.manifest.tools.length,100);
  const result = assessKit(safe);
  assert.equal(result.manifestCompatible,false);
  assert.ok(result.reasons.some(reason=>reason.includes('超过可审阅范围')));
});
