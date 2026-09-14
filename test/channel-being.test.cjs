'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {ChannelBeing, parseChannelOutcome} = require('../src/channel-being.cjs');
const {parseConnection} = require('../src/security.cjs');

const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
function contract(options) {
  const message=JSON.parse(options.body).message;
  return {protocol:'being-desktop-channel-result/1',requestId:message.match(/^\[Being Desktop Town sync:([^\]]+)\]/)[1],route:message.match(/任务路线：([^。]+)。/)[1],beingId:message.match(/当前 Being：([^；]+)；/)[1]};
}
const turn = (reply, sessionId = 'server-wechat', options) => (options ? event('meta', {scene_id:JSON.parse(options.body).scene_id}) : '') + event('content_block_delta', {delta: {text: typeof reply === 'string' ? reply : JSON.stringify({...options ? contract(options) : {}, ...reply})}}) + event('message_stop', {session_id: sessionId});
const stream = text => new Response(text, {headers: {'Content-Type': 'text/event-stream'}});
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return {promise, resolve}; };
function harness(respond = async (_, options) => stream(turn({channel: 'wechat', status: 'pending', detail: '请按返回的说明继续。'}, undefined, options)), overrides = {}) {
  const context = {configured: true, connected: true, exiting: false, connectionId: 4, identityRevision: 1, beingName: 'alice', connection: parseConnection('https://being.test/alice?token=loom-test-private')};
  const calls = [];
  const changes = [];
  const requests = [];
  const channel = new ChannelBeing({getContext: () => ({...context}), onChange: value => changes.push(value), onRequest:value=>requests.push(value), fetchImpl: async (url, options) => {
    calls.push({url, options, body: options.body ? JSON.parse(options.body) : undefined});
    return respond(url, options, calls);
  }, ...overrides});
  return {channel, context, calls, changes, requests};
}
const wechat = {channel: 'wechat', connectionRevision: 4};
const feishu = {channel: 'feishu', connectionRevision: 4};

test('channel clicks send fixed background requests only to authenticated Loom', async () => {
  const {channel, calls, requests} = harness();
  const result = await channel.beginChannelConnection(wechat);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, 'https://being.test/alice/api/chat/stream?token=loom-test-private');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.credentials, 'omit');
  assert.equal(call.options.referrerPolicy, 'no-referrer');
  assert.deepEqual(Object.keys(call.body), ['message', 'scene_id', 'scene_meta', 'client_ref']);
  assert.match(call.body.scene_id, /^desktop-channel-[0-9a-f-]+-wechat$/);
  assert.equal(call.body.scene_meta.scene_label, '微信 · Channel');
  assert.match(call.body.message, /"channel":"wechat"/);
  assert.match(call.body.message, /仅适用于本次请求/);
  assert.doesNotMatch(call.body.message, /不要部署 Portal|不要要求用户向 Heart 申请 IP Trust/);
  assert.match(call.body.message, /专用安全配置入口/);
  assert.equal(result.status, 'pending');
  assert.equal(channel.state().channel, 'wechat');
  assert.equal(requests.length,1);
  assert.deepEqual(Object.keys(requests[0]).sort(),['beingId','prompt','requestId','route']);
  assert.equal(requests[0].route,'/desktop/channel/wechat/begin');
  assert.equal(requests[0].beingId,'alice');
  assert.equal(requests[0].prompt,call.body.message);
  assert.equal(requests[0].requestId,contract(call.options).requestId);
  assert.ok(!JSON.stringify(requests).includes('loom-test-private'));
});

test('every channel uses its own scene from the first request and ignores legacy server session IDs', async () => {
  const {channel, calls} = harness(async (_, options) => {
    const target = JSON.parse(options.body).message.includes('"channel":"feishu"') ? 'feishu' : 'wechat';
    return stream(turn({channel: target, status: 'connected', detail: '实际服务已连接。'}, `actual-${target}`, options));
  });
  await channel.beginChannelConnection(wechat);
  await channel.beginChannelConnection(feishu);
  const result = await channel.getChannelStatus(wechat);
  assert.equal(calls[0].body.session_id, undefined);
  assert.equal(calls[1].body.session_id, undefined);
  assert.equal(calls[2].body.session_id, undefined);
  assert.notEqual(calls[0].body.scene_id, calls[1].body.scene_id);
  assert.equal(calls[2].body.scene_id, calls[0].body.scene_id);
  assert.equal(result.channels[0].status, 'connected');
  assert.match(calls[2].body.message, /只读检查/);
  assert.match(calls[2].body.message, /不要登记渠道/);
});

test('202 only means pending and does not replay automatically', async () => {
  const {channel, calls} = harness(async () => new Response('{}', {status: 202}));
  assert.equal((await channel.beginChannelConnection(wechat)).status, 'pending');
  assert.equal(calls.length, 1);
  assert.match(channel.state().detail, /尚未确认/);
});

test('every reply is consumed until EOF and only the final completed reply supplies the outcome', async () => {
  const {channel} = harness(async (_, options) => stream(turn('正在检查。') + turn({channel: 'wechat', status: 'unsupported', detail: '实际服务尚不支持。'}, undefined, options)));
  assert.equal((await channel.beginChannelConnection(wechat)).status, 'unsupported');
});

test('prose, malformed schema, and mismatched channel never imply connection success', async () => {
  for (const reply of ['已连接 connected', '{bad json}', {channel: 'feishu', status: 'connected', detail: 'wrong target'}, {channel: 'wechat', status: 'connected', detail: null}]) {
    const {channel} = harness(async () => stream(turn(reply)));
    assert.equal((await channel.beginChannelConnection(wechat)).status, 'unknown');
  }
});

test('new channel flows reject stale UUID, wrong route or Being, legacy untagged and extra-field replies', async () => {
  for (const patch of [{requestId:randomUUID()}, {requestId:null}, {route:'/desktop/channel/wechat/status'}, {beingId:'another'}, {protocol:'legacy'}, {channel:'feishu'}, {unexpected:'private detail'}]) {
    const {channel, changes, calls} = harness(async (_, options) => stream(turn({channel:'wechat',status:'connected',detail:'Never trust this stale result',qrCodeUrl:'https://beings.town/should-not-fetch.png',...patch},undefined,options)));
    const result = await channel.beginChannelConnection(wechat);
    assert.equal(result.status,'unknown');
    assert.equal(calls.length,1);
    assert.ok(!JSON.stringify([result,changes]).includes('Never trust this stale result'));
  }
  const untagged = harness(async () => stream(turn({channel:'wechat',status:'connected',detail:'legacy reply'})));
  assert.equal((await untagged.channel.beginChannelConnection(wechat)).status,'unknown');
  let previous;
  const reused = harness(async (_, options) => {
    const metadata = previous ?? contract(options);
    previous = metadata;
    return stream(turn({...metadata,channel:'wechat',status:'connected',detail:'First request response'}, undefined, options));
  });
  assert.equal((await reused.channel.beginChannelConnection(wechat)).status,'connected');
  assert.equal((await reused.channel.beginChannelConnection(wechat)).status,'unknown');
});

test('channel enrollment runs exactly before sending, stays four-field and cannot permit a stale POST', async () => {
  const ordered=[];
  const instance=harness(async (_, options)=>{
    ordered.push('post');
    return stream(turn({channel:'wechat',status:'connected',detail:'Confirmed'},undefined,options));
  }, {onRequest:record=>{ordered.push('enroll');assert.equal(record.route,'/desktop/channel/wechat/begin');}});
  await instance.channel.beginChannelConnection(wechat);
  assert.deepEqual(ordered,['enroll','post']);
  const stale=harness(undefined,{onRequest:()=>stale.channel.reset()});
  await assert.rejects(stale.channel.beginChannelConnection(wechat),{code:'SESSION_CHANGED'});
  assert.equal(stale.calls.length,0);
});

test('correlated JSON fences are parsed and legacy outcome parsing still omits private unknown fields', async () => {
  const {channel, changes} = harness(async (_, options) => stream(turn('```json\n' + JSON.stringify({...contract(options),channel:'wechat',status:'connected',detail:'实际服务已连接。'}) + '\n```', undefined, options)));
  const result = await channel.beginChannelConnection(wechat);
  assert.equal(result.status, 'connected');
  assert.ok(!JSON.stringify([result, changes]).includes('DO_NOT_EXPOSE'));
  const legacy=parseChannelOutcome(JSON.stringify({channel:'wechat',status:'connected',detail:'Legacy result',secret:'DO_NOT_EXPOSE'}),'wechat',[]);
  assert.equal(legacy.status,'connected');
  assert.ok(!JSON.stringify(legacy).includes('DO_NOT_EXPOSE'));
});

test('connection credential echoes and credential fields are redacted in structured and prose replies', async () => {
  for (const reply of ['token=unexpected-private app_secret=other-private loom-test-private', {channel: 'wechat', status: 'unknown', detail: 'loom-test-private app_secret=other-private'}]) {
    const {channel, changes} = harness(async (_, options) => stream(turn(reply, undefined, options)));
    const result = await channel.beginChannelConnection(wechat);
    assert.ok(!JSON.stringify([result, changes]).includes('loom-test-private'));
    assert.ok(!JSON.stringify([result, changes]).includes('other-private'));
  }
});

test('credential entry rejects locally without reading getters or contacting a server', () => {
  const {channel, calls} = harness();
  assert.throws(() => channel.updateFeishuCredentials({get appSecret() { throw new Error('must not read'); }}), {code: 'INVALID_REQUEST'});
  assert.equal(calls.length, 0);
});

test('strict channel requests reject extra fields, getters, unsupported channels, and stale identity before sending', async () => {
  const {channel, calls} = harness();
  for (const value of [{...wechat, prompt: 'custom instruction'}, {...wechat, channel: 'wecom'}, {...wechat, connectionRevision: -1}, {get channel() { throw new Error('must not read'); }, connectionRevision: 4}]) {
    assert.throws(() => channel.beginChannelConnection(value), {code: 'INVALID_REQUEST'});
  }
  await assert.rejects(channel.beginChannelConnection({...wechat, connectionRevision: 3}), {code: 'SESSION_CHANGED'});
  assert.equal(calls.length, 0);
});

test('duplicate requests are rejected while an HTTP stream is running', async () => {
  const gate = deferred();
  const arrived = deferred();
  const {channel, calls} = harness(async () => { arrived.resolve(); await gate.promise; return stream(turn({channel: 'wechat', status: 'pending', detail: '待扫码'})); });
  const first = channel.beginChannelConnection(wechat);
  await arrived.promise;
  await assert.rejects(channel.getChannelStatus(feishu), {code: 'BUSY'});
  assert.equal(calls.length, 1);
  gate.resolve();
  await first;
});

test('reset aborts pending streams and stale outcomes cannot replace the cleared state', async () => {
  const gate = deferred();
  const arrived = deferred();
  const {channel, calls} = harness(async () => { arrived.resolve(); await gate.promise; return stream(turn({channel: 'wechat', status: 'connected', detail: 'old reply'})); });
  const pending = channel.beginChannelConnection(wechat);
  await arrived.promise;
  channel.reset();
  assert.equal(calls[0].options.signal.aborted, true);
  gate.resolve();
  await assert.rejects(pending, {code: 'SESSION_CHANGED'});
  assert.deepEqual(channel.state(), {channel: '', status: 'unknown', detail: ''});
});

test('identity changes without reset are fenced before final results', async () => {
  const gate = deferred();
  const arrived = deferred();
  const {channel, context} = harness(async () => { arrived.resolve(); await gate.promise; return stream(turn({channel: 'wechat', status: 'connected', detail: 'old reply'})); });
  const pending = channel.beginChannelConnection(wechat);
  await arrived.promise;
  context.identityRevision++;
  gate.resolve();
  await assert.rejects(pending, {code: 'SESSION_CHANGED'});
  assert.notEqual(channel.state().status, 'connected');
});

test('truncated or errored operations report result unknown, retain no sensitive error, and never retry', async () => {
  for (const response of [() => stream(event('content_block_delta', {delta: {text: 'connected'}})), () => { throw new Error('secret=do-not-print'); }, () => new Response('secret=do-not-print', {status: 503})]) {
    const {channel, calls} = harness(async () => response());
    await assert.rejects(channel.beginChannelConnection(wechat), {code: 'RESULT_UNKNOWN'});
    assert.equal(calls.length, 1);
    assert.ok(!JSON.stringify(channel.state()).includes('do-not-print'));
  }
});

test('failed status checks and invalid Loom credentials use distinct fixed errors', async () => {
  const failed = harness(async () => new Response('', {status: 500}));
  await assert.rejects(failed.channel.getChannelStatus(wechat), {code: 'SERVICE_ERROR'});
  const expired = harness(async () => new Response('', {status: 401}));
  await assert.rejects(expired.channel.beginChannelConnection(wechat), {code: 'AUTH_REQUIRED', message: '连接凭据无效或已过期，请更新 Loom 连接地址。'});
});

test('only bounded raster data URLs are displayed and URL-only QR replies trigger no download', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  for (const [qr, expected] of [[png, png], ['data:image/svg+xml;base64,PHN2Zz4=', undefined], ['data:image/png;base64,PHN2Zz4=', undefined], ['https://weixin.qq.com/q/example', undefined]]) {
    const {channel, calls} = harness(async (_, options) => stream(turn({channel: 'wechat', status: 'pending', detail: '待扫码', qrCodeDataUrl: qr}, undefined, options)));
    const result = await channel.beginChannelConnection(wechat);
    assert.equal(result.qrCodeDataUrl, expected);
    assert.equal(channel.state().qrCodeDataUrl, expected, 'Returning to the channel must retain its validated QR image');
    channel.reset();
    assert.equal(channel.state().qrCodeDataUrl, undefined, 'A new Being must not see the previous QR image');
    assert.equal(calls.length, 1);
  }
});

test('documented QR image URLs load without Loom credentials, redirects or cookies', async () => {
  const png = Buffer.from('iVBORw0KGgo=', 'base64');
  const {channel, calls} = harness(async (url, options) => options.method === 'GET'
    ? new Response(png, {headers: {'Content-Type': 'image/png'}})
    : stream(turn({channel: 'wechat', status: 'pending', detail: '待扫码', qrCodeUrl: 'https://weixin.qq.com/q/actual-service-image'}, undefined, options)));
  const result = await channel.beginChannelConnection(wechat);
  assert.equal(result.qrCodeDataUrl, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(result.qrCodeUrl, undefined);
  assert.equal(calls.length, 2);
  const image = calls[1];
  assert.equal(image.options.credentials, 'omit');
  assert.equal(image.options.redirect, 'error');
  assert.equal(image.options.referrerPolicy, 'no-referrer');
  assert.ok(!JSON.stringify(image).includes('loom-test-private'));
});

test('private, credential-echo, wrong-domain, and non-HTTPS QR addresses never trigger a fetch', async () => {
  for (const url of ['http://weixin.qq.com/q/test', 'https://127.0.0.1/q/test', 'https://weixin.qq.com.evil.test/q/test', 'https://user@weixin.qq.com/q/test', 'https://weixin.qq.com/q/loom-test-private']) {
    const {channel, calls} = harness(async (_, options) => stream(turn({channel: 'wechat', status: 'pending', detail: '待扫码', qrCodeUrl: url}, undefined, options)));
    const result = await channel.beginChannelConnection(wechat);
    assert.equal(calls.length, 1);
    assert.equal(result.qrCodeUrl, undefined);
    assert.equal(result.qrCodeDataUrl, undefined);
  }
});

test('unsafe or oversized QR content does not invalidate an accepted channel operation', async () => {
  for (const image of [() => new Response('<html>', {headers: {'Content-Type': 'text/html'}}), () => new Response('bad', {headers: {'Content-Type': 'image/png'}}), () => new Response('too big', {headers: {'Content-Type': 'image/png', 'Content-Length': '9999999'}})]) {
    const {channel} = harness(async (_, options) => options.method === 'GET' ? image() : stream(turn({channel: 'wechat', status: 'pending', detail: '已登记', qrCodeUrl: 'https://beings.town/actual.png'}, undefined, options)));
    const result = await channel.beginChannelConnection(wechat);
    assert.equal(result.status, 'pending');
    assert.equal(result.qrCodeDataUrl, undefined);
    assert.match(result.detail, /扫码图像暂时无法读取/);
  }
});

test('an accepted or broken first request keeps its allocated channel scene without replay', async () => {
  for (const first of [() => new Response('{}', {status:202}), () => { throw new Error('offline'); }]) {
    const f = harness(async (_, options, calls) => calls.length === 1 ? first() : stream(turn({channel:'wechat', status:'connected', detail:'已核对'}, undefined, options)));
    try { await f.channel.beginChannelConnection(wechat); } catch (error) { assert.equal(error.code, 'RESULT_UNKNOWN'); }
    assert.equal(f.calls.length, 1);
    await f.channel.getChannelStatus(wechat);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].body.scene_id, f.calls[1].body.scene_id);
    assert.match(f.calls[1].body.message, /只读检查/);
  }
});

test('foreign and unscoped replies cannot supply channel results even with matching JSON', async () => {
  for (const scene of ['loom-current', 'desktop-another-conversation', '']) {
    const f = harness(async (_, options) => stream(event('meta', {scene_id:scene}) + turn({channel:'wechat', status:'connected', detail:'Wrong conversation', ...contract(options)})));
    assert.equal((await f.channel.beginChannelConnection(wechat)).status, 'unknown');
  }
  const f = harness(async (_, options) => stream(
    turn({channel:'wechat', status:'connected', detail:'Channel result'}, undefined, options) +
    event('meta', {scene_id:'loom-current', continuation:true}) +
    turn({channel:'wechat', status:'error', detail:'Foreign result', ...contract(options)})
  ));
  const result = await f.channel.beginChannelConnection(wechat);
  assert.equal(result.status, 'connected'); assert.equal(result.detail, 'Channel result');
});

test('allocated Desktop channel scenes are used directly and a missing session fails before POST', async () => {
  const target = 'desktop-11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222';
  const f = harness(undefined, {getSession:channel => { assert.equal(channel,'wechat'); return {sceneId:target}; }});
  await f.channel.beginChannelConnection(wechat);
  assert.equal(f.calls[0].body.scene_id, target);
  for (const value of [null, {}, {sceneId:'invalid scene'}]) {
    const missing = harness(undefined, {getSession:() => value});
    await assert.rejects(missing.channel.beginChannelConnection(wechat), {code:'NOT_CONNECTED'});
    assert.equal(missing.calls.length,0);
  }
});

test('an identity change without reset does not reuse the previous channel scene', async () => {
  const f = harness();
  await f.channel.beginChannelConnection(wechat);
  f.context.identityRevision++; f.context.beingName='bob';
  await f.channel.beginChannelConnection(wechat);
  assert.notEqual(f.calls[0].body.scene_id, f.calls[1].body.scene_id);
});

test('automatic channel inspection reads existing binding without allocating a session or sending a message', async () => {
  let reads=0;
  const f=harness(undefined,{getSession:()=>assert.fail('Read-only inspection must not allocate a session'),readStatus:async({signal})=>{
    assert.equal(signal.aborted,false);reads++;return {channels:[{channel:'feishu',status:'connected'}]};
  }});
  assert.deepEqual(await f.channel.inspectChannelStatus(feishu),{channels:[{channel:'feishu',status:'connected'}]});
  assert.equal(reads,1);assert.equal(f.calls.length,0);assert.equal(f.requests.length,0);
  await assert.rejects(f.channel.inspectChannelStatus({...feishu,extra:true}),{code:'INVALID_REQUEST'});
});

test('inspection permission errors do not trigger a Being request and reset cancels stale inspection', async () => {
  const denied=harness(undefined,{readStatus:async()=>{throw Object.assign(new Error('No status access'),{code:'AUTH_REQUIRED'});}});
  await assert.rejects(denied.channel.inspectChannelStatus(feishu),{code:'AUTH_REQUIRED'});
  assert.equal(denied.calls.length,0);
  const gate=deferred();let signal;
  const f=harness(undefined,{readStatus:async options=>{signal=options.signal;await gate.promise;return {channels:[{channel:'feishu',status:'connected'}]};}});
  const pending=f.channel.inspectChannelStatus(feishu);f.channel.reset();assert.equal(signal.aborted,true);gate.resolve();
  await assert.rejects(pending,{code:'SESSION_CHANGED'});
  assert.equal(f.calls.length,0);
});
