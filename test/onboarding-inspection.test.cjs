'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {OnboardingInspection, identityDto, modelDto, channelsDto, MAX_RESPONSE_BYTES} = require('../src/onboarding-inspection.cjs');
const {parseConnection} = require('../src/security.cjs');
const {TownSession} = require('../src/town-session.cjs');

const NOW = Date.parse('2026-09-08T12:00:00Z');
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
const knownChannels = {channels: [{channel: 'feishu', status: 'connected'}, {channel: 'wechat', status: 'registered'}]};
function fixture(options = {}) {
  let context = {connection: parseConnection('https://being.example.test/alice?api=https://being.example.test/heart&token=private-loom-token&relay_secret=private-relay-secret'),
    connectionId: 7, identityRevision: 4, beingName: 'alice', configured: true, connected: true};
  const requests = [], updates = [], channelReads = [];
  const service = new OnboardingInspection({
    getContext: () => context,
    fetchImpl: (url, request) => {
      requests.push({url, ...request});
      return options.fetchImpl ? options.fetchImpl(url, request) : Promise.resolve(json(url.includes('/api/status')
        ? {being_id: 'alice', being_name: 'Alice', created: '2020-01-01T00:00:00Z'} : {model: 'existing-model', provider: 'existing-provider'}));
    },
    getChannelStatus: value => { channelReads.push(value); return options.getChannelStatus ? options.getChannelStatus(value) : Promise.resolve(knownChannels); },
    onChange: state => { updates.push(state); options.onChange?.(state); },
    now: options.now || (() => NOW),
  });
  return {service, requests, updates, channelReads, changeContext: patch => { context = {...context, ...patch}; }, context: () => context};
}

test('first desktop use reads existing Being configuration concurrently without mutation', async () => {
  const status = deferred(), model = deferred(), channel = deferred();
  const {service, requests, channelReads, updates} = fixture({fetchImpl: url => url.includes('/api/status') ? status.promise : model.promise, getChannelStatus: () => channel.promise});
  assert.equal(service.state(), null);
  const pending = service.inspect();
  assert.equal(requests.length, 2);
  assert.equal(channelReads.length, 0, 'Town identity waits for the authenticated Loom status');
  assert.equal(service.inspect(), pending, 'duplicate clicks share an in-flight read');
  assert.equal(service.state().status, 'loading');
  for (const request of requests) {
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://being.example.test');
    assert.match(url.pathname, /^\/heart\/api\/(?:status|llm\/config)$/);
    assert.equal(url.searchParams.get('token'), 'private-loom-token');
    assert.equal(request.headers['X-Relay-Secret'], 'private-relay-secret');
    assert.equal(request.method, 'GET');
    assert.equal(request.redirect, 'error');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.referrerPolicy, 'no-referrer');
    assert.equal(request.body, undefined);
    assert.equal(request.signal.aborted, false);
  }
  status.resolve(json({being_id: 'alice', being_name: 'Alice', created: '2020-01-01T00:00:00Z'}));
  model.resolve(json({model: 'existing-model', provider: 'custom-provider', api_key: 'private-model-key'}));
  channel.resolve(knownChannels);
  const result = await pending;
  assert.equal(result.status, 'partial', 'remote Portal remains explicitly unknown');
  assert.equal(result.beingId, 'alice');
  assert.equal(result.identity.id, 'alice');
  assert.equal(channelReads.length, 1);
  assert.equal(channelReads[0].beingId, 'alice');
  assert.equal(result.connectionRevision, 7);
  assert.equal(result.identity.lifecycle, 'existing');
  assert.equal(result.model.status, 'configured');
  assert.equal(result.channels.items[0].configured, true);
  assert.deepEqual(result.portal.items, []);
  assert.equal(result.portal.status, 'unknown');
  assert.ok(updates.some(value => value.status === 'loading' && value.identity.status === 'ready'));
  assert.doesNotMatch(JSON.stringify(result), /private-|api_key|token|secret|https?:/);
  assert.ok(requests.every(request => request.signal.aborted), 'finished operations release their transport controllers');
  result.identity.name = 'changed renderer copy';
  assert.equal(service.state().identity.name, 'Alice');
});

test('creation classification requires an explicit valid timestamp and uses the 24-hour boundary', () => {
  const classify = value => identityDto({being_name: 'Alice', ...value}, NOW, []);
  assert.equal(classify({created: '2026-09-07T12:00:00Z'}).lifecycle, 'recent');
  assert.equal(classify({created: '2026-09-07T11:59:59.999Z'}).lifecycle, 'existing');
  assert.equal(classify({born: '2026-09-08T20:00:00+08:00'}).lifecycle, 'recent');
  assert.equal(classify({created: '2026-09-08T12:00:00.001Z'}).lifecycle, 'unknown');
  for (const created of [undefined, null, '', true, 1788868800, 'invalid', '2026-02-30T12:00:00Z', '2026-09-08T11:00:00']) {
    assert.equal(classify({created}).createdAt, null);
    assert.equal(classify({created}).lifecycle, 'unknown');
  }
  assert.equal(classify({created: '2026-09-08'}).lifecycle, 'unknown', 'a calendar date cannot prove the age within 24 hours');
  assert.equal(classify({created: '2026-09-07'}).lifecycle, 'unknown');
  assert.equal(classify({created: '2020-01-01'}).lifecycle, 'existing');
  assert.equal(classify({created: '2026-09-05'}).lifecycle, 'existing', 'old calendar dates allow for timezone and day uncertainty');
  assert.equal(classify({uptime_seconds: 0, status: 'ready'}).lifecycle, 'unknown', 'a restarted Being is not a newborn');
  assert.equal(identityDto({name: 'Legacy name', born: '2020-01-01T00:00:00Z'}, NOW, []).name, 'Legacy name');
});

test('model configuration distinguishes explicit empty configuration from malformed or failed values', async () => {
  assert.equal(modelDto({model: '', provider: ''}, []).status, 'unconfigured');
  assert.equal(modelDto({model: 'already-set', provider: ''}, []).status, 'configured');
  for (const value of [{}, {model: null, provider: ''}, {model: '', provider: 'provider'}, {model: '\n', provider: '\n'}, {model: [], provider: ''}, {model: 'x'.repeat(513), provider: ''}]) {
    assert.equal(modelDto(value, []).status, 'unknown');
  }
  for (const value of [null, [], {}, {ok: false, model: '', provider: ''}, {error: 'private-secret', model: '', provider: ''}]) {
    const {service} = fixture({fetchImpl: () => Promise.resolve(json(value)), getChannelStatus: () => Promise.reject(new Error('private failure'))});
    const result = await service.inspect();
    assert.equal(result.status, 'error');
    assert.equal(result.identity.lifecycle, 'unknown');
    assert.equal(result.model.status, 'unknown');
    assert.equal(result.channels.status, 'unknown');
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});

test('channel failures preserve confirmed model and identity without sending a Being message', async () => {
  const {service} = fixture({getChannelStatus: () => Promise.reject(Object.assign(new Error('Authorization private-town-key'), {code: 'AUTH_REQUIRED'}))});
  const result = await service.inspect();
  assert.equal(result.status, 'partial');
  assert.equal(result.identity.lifecycle, 'existing');
  assert.equal(result.model.status, 'configured');
  assert.equal(result.channels.status, 'unknown');
  assert.ok(result.channels.items.every(item => item.configured === null));
  assert.doesNotMatch(JSON.stringify(result), /private-town|Authorization/);
});

test('channel DTO retains existing registration and never equates a failed connection with absent credentials', () => {
  for (const status of ['connected', 'registered', 'pending', 'waiting']) {
    const value = channelsDto({channels: [{channel: 'feishu', status, appId: 'private-app', qrCodeUrl: 'https://secret.test'}]});
    assert.equal(value.items[0].configured, true);
    assert.equal(value.items[1].status, 'unknown');
    assert.doesNotMatch(JSON.stringify(value), /private|https:/);
  }
  for (const status of ['disconnected', 'error', 'expired', 'disabled', 'unknown']) {
    assert.equal(channelsDto({channels: [{channel: 'wechat', status}]}).items[1].configured, null);
  }
  assert.equal(channelsDto({channels: [{channel: 'feishu', status: 'connected'}, {channel: 'feishu', status: 'error'}]}).items[0].status, 'unknown');
});

test('display allowlist strips raw secrets, URLs, response prose and unrelated configuration', async () => {
  const {service} = fixture({fetchImpl: url => Promise.resolve(json(url.includes('/api/status')
    ? {being_id: 'alice', being_name: 'Alice private-loom-token', created: '2020-01-01T00:00:00Z', note: 'private-note', api_key: 'private-upstream-key'}
    : {model: 'private-upstream-key', provider: 'custom-provider', api_key: 'private-upstream-key', base_url: 'https://secret.test', presets: [{api_key: 'private-preset'}]})),
    getChannelStatus: () => Promise.resolve({channels: [{channel: 'feishu', status: 'connected', detail: 'private-token', qrCodeDataUrl: 'private-qr'}, {channel: 'wechat', status: 'registered', appSecret: 'private-secret'}]})});
  const result = await service.inspect();
  assert.doesNotMatch(JSON.stringify(result), /private-|https?:|presets|base_url|api_key|appSecret|qrCode/);
  assert.deepEqual(Object.keys(result.model), ['status', 'name', 'provider']);
  assert.deepEqual(Object.keys(result.channels.items[0]), ['channel', 'status', 'configured']);
});

test('malformed media, HTTP errors and oversized bodies remain unknown', async () => {
  const responses = [
    () => json({model: '', provider: ''}, 403),
    () => new Response('<html>private-secret</html>', {headers: {'Content-Type': 'text/html'}}),
    () => new Response('{broken private-secret', {headers: {'Content-Type': 'application/json'}}),
    () => new Response('{}', {headers: {'Content-Type': 'application/json', 'Content-Length': String(MAX_RESPONSE_BYTES + 1)}}),
    () => json({payload: 'x'.repeat(MAX_RESPONSE_BYTES + 1)}),
  ];
  for (const response of responses) {
    const {service} = fixture({fetchImpl: () => Promise.resolve(response())});
    const result = await service.inspect();
    assert.equal(result.identity.status, 'unknown');
    assert.equal(result.model.status, 'unknown');
    assert.equal(result.channels.status, 'unknown');
  }
});

test('user cancellation settles an ignored transport abort and leaves safe completed sections', async () => {
  const model = deferred(), identityReady = deferred(), channelStarted = deferred();
  const {service, requests, channelReads} = fixture({fetchImpl: url => url.includes('/api/status')
    ? Promise.resolve(json({being_id: 'alice', name: 'Alice'})) : model.promise,
  onChange: state => { if (state?.identity.status === 'ready') identityReady.resolve(); },
  getChannelStatus: () => { channelStarted.resolve(); return Promise.resolve(knownChannels); }});
  const pending = service.inspect();
  const rejected = assert.rejects(pending, {code: 'ABORTED'});
  await identityReady.promise;
  await channelStarted.promise;
  const result = service.cancel();
  assert.equal(result.status, 'partial');
  assert.equal(result.identity.name, 'Alice');
  assert.ok(requests.every(request => request.signal.aborted));
  assert.equal(channelReads[0].signal.aborted, true);
  await rejected;
  model.resolve(json({model: 'stale-model', provider: 'provider'}));
  await Promise.resolve();
  assert.equal(service.state().model.status, 'unknown');
});

test('reset and same-Being reconnect invalidate old responses and allow a fresh read', async () => {
  const old = deferred();
  let hang = true;
  const {service, changeContext, requests} = fixture({fetchImpl: () => hang ? old.promise : Promise.resolve(json({being_id: 'alice', being_name: 'Alice', model: 'new-model', provider: 'new-provider'}))});
  const pending = service.inspect();
  const rejected = assert.rejects(pending, {code: 'SESSION_CHANGED'});
  changeContext({connectionId: 8});
  service.reset();
  assert.equal(service.state(), null);
  assert.ok(requests.every(request => request.signal.aborted));
  await rejected;
  hang = false;
  const result = await service.inspect();
  assert.equal(result.connectionRevision, 8);
  assert.equal(result.model.name, 'new-model');
  old.resolve(json({model: 'stale-model', provider: 'stale-provider'}));
  await Promise.resolve();
  assert.equal(service.state().model.name, 'new-model');
});

test('identity revision changes cannot publish a late summary even if reset was omitted', async () => {
  const old = deferred();
  const {service, changeContext} = fixture({fetchImpl: () => old.promise});
  const pending = service.inspect();
  changeContext({identityRevision: 5});
  old.resolve(json({being_id: 'alice', being_name: 'Alice', model: 'stale-model', provider: 'provider'}));
  await assert.rejects(pending, {code: 'SESSION_CHANGED'});
  assert.equal(service.state(), null);
});

test('generic Loom page uses authenticated status ID for channel authorization and query', async () => {
  const calls = [];
  const {service, changeContext, channelReads} = fixture({getChannelStatus: ({beingId, signal}) => {
    const channelSession = new TownSession({getContext: () => ({configured: true, connected: true, beingName: beingId, connectionId: 7, identityRevision: 4}),
      fetchImpl: async (url, options) => {
        calls.push({url, ...options});
        return json(url.includes('/api/bonfire/mentions') ? {being: 'alice'} : knownChannels);
      },
    });
    return channelSession.getChannelStatus({signal});
  }});
  const connection = parseConnection('https://being.example.test/loom/?api=https://being.example.test/alice&token=private-loom-token');
  changeContext({connection, beingName: connection.beingName});
  const result = await service.inspect();
  assert.equal(result.beingId, 'loom', 'correlation retains the selected desktop connection label');
  assert.equal(result.identity.id, 'alice', 'the server ID is authoritative even when the URL label differs');
  assert.equal(result.channels.status, 'ready');
  assert.equal(channelReads[0].beingId, 'alice');
  assert.equal(calls.length, 2);
  const status = calls.find(call => new URL(call.url).pathname === '/api/channels/status');
  assert.equal(new URL(status.url).searchParams.get('being_id'), 'alice');
  assert.ok(calls.every(call => call.method === 'GET' && call.headers['X-Relay-Secret'] === undefined));
});

test('legacy status without server ID keeps the known desktop channel identity', async () => {
  const {service, channelReads} = fixture({fetchImpl: url => Promise.resolve(json(url.includes('/api/status')
    ? {being_name: 'Alice'} : {model: 'legacy-model', provider: 'provider'}))});
  const result = await service.inspect();
  assert.equal(result.identity.id, '');
  assert.equal(result.identity.name, 'Alice');
  assert.equal(channelReads[0].beingId, 'alice');
});

test('malformed authoritative status IDs reject without querying Town or publishing model configuration', async () => {
  for (const being_id of [null, '', [], 123, '../alice', 'alice?secret=private', 'a'.repeat(101)]) {
    const {service, updates, channelReads, requests} = fixture({fetchImpl: url => Promise.resolve(json(url.includes('/api/status')
      ? {being_id, being_name: 'Invalid Being'} : {model: 'unverified-model', provider: 'provider'}))});
    await assert.rejects(service.inspect(), {code: 'INVALID_IDENTITY'});
    const result = service.state();
    assert.equal(result.status, 'error');
    assert.equal(result.identity.status, 'unknown');
    assert.equal(result.model.status, 'unknown');
    assert.equal(result.channels.status, 'unknown');
    assert.equal(channelReads.length, 0);
    assert.ok(requests.every(request => request.signal.aborted));
    assert.doesNotMatch(JSON.stringify(updates), /Invalid Being|unverified-model/);
  }
});

test('rejected streaming HTTP, MIME and size responses are cancelled before inspection completes', async () => {
  for (const options of [
    {status: 403, headers: {'Content-Type': 'application/json'}},
    {status: 200, headers: {'Content-Type': 'text/html'}},
    {status: 200, headers: {'Content-Type': 'application/json', 'Content-Length': String(MAX_RESPONSE_BYTES + 1)}},
  ]) {
    let cancelled = 0;
    const {service, requests} = fixture({fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')); },
      cancel() { cancelled++; },
    }), options)});
    assert.equal((await service.inspect()).status, 'error');
    assert.equal(cancelled, 2);
    assert.ok(requests.every(request => request.signal.aborted));
  }
});

test('Town inspection uses only direct authorized GET routes and propagates inspection cancellation', async () => {
  const calls = [], pending = deferred(), started = deferred();
  const session = new TownSession({getContext: () => ({configured: true, connected: true, beingName: 'alice', connectionId: 7, identityRevision: 4}),
    fetchImpl: (url, options) => {
      calls.push({url, ...options});
      if (url.includes('/api/bonfire/mentions')) return Promise.resolve(json({being: 'alice'}));
      started.resolve();
      options.signal.addEventListener('abort', () => pending.reject(new Error('aborted')), {once: true});
      return pending.promise;
    },
    readImpl: () => { throw new Error('A Being message must never be used for onboarding inspection'); },
  });
  const controller = new AbortController();
  const read = session.getChannelStatus({signal: controller.signal});
  await started.promise;
  controller.abort();
  await assert.rejects(read, {code: 'ABORTED'});
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, 'https://beings.town');
    assert.equal(call.method, 'GET');
    assert.equal(call.headers['X-Relay-Secret'], undefined);
    assert.doesNotMatch(call.url, /token|secret|message/);
    assert.equal(call.signal.aborted, true);
  }
});
