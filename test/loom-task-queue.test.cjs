'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {installTaskQueue} = require('../src/loom-task-queue.cjs');

function fixture(fetch, extra = {}) {
  const context = vm.createContext({fetch, URL, Response, ReadableStream, TextDecoder,
    location:{href:'https://example.test/loom',origin:'https://example.test',pathname:'/loom'}, sendQueue:[], ...extra});
  vm.runInContext(`(${installTaskQueue.toString()})()`, context);
  return context;
}
const send = (context, message) => context.fetch('/api/chat/stream', {body:JSON.stringify({message, session_id:'one'})});

test('pending messages retain order and leave independently when streams finish', async () => {
  const controllers = [];
  const context = fixture(async () => new Response(new ReadableStream({start(controller) {controllers.push(controller);}}), {headers:{'content-type':'text/event-stream'}}));
  const first = await send(context, 'first');
  const second = await send(context, 'second');
  assert.deepEqual(Array.from(context.__beingDesktopTaskQueue.snapshot().pending, item => item.text), ['first','second']);
  controllers[0].enqueue(new TextEncoder().encode('data: hello\n\n'));
  controllers[0].close();
  assert.equal(await first.text(), 'data: hello\n\n');
  assert.equal(context.__beingDesktopTaskQueue.snapshot().pending[0].text, 'second');
  await second.body.cancel();
  assert.equal(context.__beingDesktopTaskQueue.snapshot().pending.length, 0);
});

test('failure clears pending and local queue contains previews without attachment data', async () => {
  const context = fixture(async () => {throw new Error('offline');});
  await assert.rejects(send(context, 'failed'), /offline/);
  context.sendQueue.push({message:'next',files:[{base64:'secret'}]}, {message:'last'});
  const state = context.__beingDesktopTaskQueue.snapshot();
  assert.equal(state.pending.length, 0);
  assert.equal(state.queued[0].text, 'next');
  assert.equal(state.queued[0].attachments, 1);
  assert.doesNotMatch(JSON.stringify(state), /secret/);
  context.sendQueue.shift();
  assert.equal(context.__beingDesktopTaskQueue.snapshot().queued[0].text, 'last');
});

test('unknown queue and rejected HTTP responses do not appear as active work', async () => {
  const context = fixture(async () => new Response('no', {status:503}));
  delete context.sendQueue;
  const response = await send(context, '<script>hello</script>');
  assert.equal(response.status, 503);
  assert.equal(context.__beingDesktopTaskQueue.snapshot().pending.length, 0);
  assert.equal(context.__beingDesktopTaskQueue.snapshot().queueKnown, false);
});

test('202 acceptance survives reload and stays separate from actual response events', async () => {
  const storage = new Map();
  const sessionStorage = {getItem:key => storage.get(key), setItem:(key, value) => storage.set(key, value)};
  const context = fixture(async () => new Response('{"accepted":true,"spliced":true}', {status:202,headers:{'x-being-desktop-request-id':'request-202'}}), {sessionStorage});
  const response = await send(context, 'follow up');
  assert.equal(await response.text(), '{"accepted":true,"spliced":true}');
  assert.equal(context.__beingDesktopTaskQueue.snapshot().pending[0].status, 'accepted');
  const restored = fixture(async () => new Response(), {sessionStorage});
  assert.equal(restored.__beingDesktopTaskQueue.snapshot().pending[0].text, 'follow up');
  assert.equal(restored.__beingDesktopTaskQueue.snapshot().pending[0].spliced, true);
  restored.__beingDesktopTaskQueue.reconcileReply('request-202','active-202');
  restored.__beingDesktopTaskQueue.reconcileHistory(['request-202'],{id:'active-202',finished:false});
  assert.equal(restored.__beingDesktopTaskQueue.snapshot().pending.length,1);
  restored.__beingDesktopTaskQueue.reconcileHistory(['request-202'],{id:null,finished:true});
  assert.equal(restored.__beingDesktopTaskQueue.snapshot().pending.length,0);
  restored.__beingDesktopSessions = {list:() => ({activeId:'other'})};
  assert.equal(restored.__beingDesktopTaskQueue.snapshot().pending.length, 0);
});

test('split SSE frames correlate the stream and expose phase without private event contents', async () => {
  const chunks = ['event: meta\r\ndata: {"stream_', 'id":"stream-1"}\r\n\r\nevent: reasoning\ndata: {"text":"private reasoning"}\n\nevent: tool_use\ndata: {"name":"browse_web","input":{"token":"private"}}\n\n'];
  let controller;
  const context = fixture(async () => new Response(new ReadableStream({start(value) {controller = value;}}), {headers:{'content-type':'text/event-stream'}}));
  const response = await send(context, 'research');
  const reader = response.body.getReader();
  for (const chunk of chunks) {
    controller.enqueue(new TextEncoder().encode(chunk));
    assert.equal(new TextDecoder().decode((await reader.read()).value), chunk);
  }
  const item = context.__beingDesktopTaskQueue.snapshot().pending[0];
  assert.equal(item.streamId, 'stream-1');
  assert.equal(item.status, 'responding');
  assert.equal(item.phase, 'tool');
  assert.equal(item.tool, 'browse_web');
  assert.doesNotMatch(JSON.stringify(item), /private|token/);
  controller.enqueue(new TextEncoder().encode('event: message_stop\ndata: {}\n\n'));
  await reader.read();
  assert.equal(context.__beingDesktopTaskQueue.snapshot().pending[0].phase, 'continuing');
  controller.error(new Error('lost connection'));
  await assert.rejects(reader.read(), /lost connection/);
  assert.equal(context.__beingDesktopTaskQueue.snapshot().pending[0].status, 'interrupted');
  context.__beingDesktopTaskQueue.reconcileStream('another-stream',{finished:true});
  assert.equal(context.__beingDesktopTaskQueue.snapshot().pending.length,1);
  context.__beingDesktopTaskQueue.reconcileStream('stream-1',{event:'content_block_delta',data:{delta:{text:'recovered private text'}}});
  assert.equal(context.__beingDesktopTaskQueue.snapshot().pending[0].status,'responding');
  assert.doesNotMatch(JSON.stringify(context.__beingDesktopTaskQueue.snapshot()),/recovered private/);
  context.__beingDesktopTaskQueue.reconcileStream('stream-1',{finished:true});
  assert.equal(context.__beingDesktopTaskQueue.snapshot().pending.length,0);
});

