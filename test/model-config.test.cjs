'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {ModelConfig, modelConfigDto, validateModelPatch} = require('../src/model-config.cjs');
const {parseConnection} = require('../src/security.cjs');
const {emptyRuntime, updateRuntimeConfig} = require('../src/runtime.cjs');

const config = {
  model: 'model-current', provider: 'openai-responses', base_url: 'https://api.example.test/v1', has_api_key: true,
  api_key: 'private-upstream-key', thinking: 'high', temperature: 0.7, sbs_enabled: true,
  presets: [{id: 'preset-a', label: 'Model A', model: 'model-a', provider: 'openai-responses', has_key: true},
    {id: 'preset-b', label: 'Model B', model: 'model-b', provider: 'anthropic', has_key: false}],
};
const input = {connectionId: 7, model: 'model-a', provider: 'openai-responses', baseUrl: 'https://api.example.test/v1'};
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
function fixture(fetchImpl) {
  let context = {connection: parseConnection('https://being.example.test/loom/?api=https://being.example.test/heart&token=private-loom-token&relay_secret=private-relay'), connectionId: 7};
  const requests = [];
  const service = new ModelConfig({getContext: () => context, fetchImpl: async (url, options) => {
    requests.push({url, ...options});
    return fetchImpl ? fetchImpl(url, options) : json(config);
  }});
  return {service, requests, changeContext: value => {context = {...context, ...value};}};
}

test('configuration exposes only display fields and the runtime preset catalog', () => {
  const result = modelConfigDto({...config, base_url: 'https://user:private@example.test/v1?token=private#private', presets: [...config.presets, config.presets[0], null, {model: ''}]}, 7, 'now');
  assert.equal(result.connectionId, 7);
  assert.equal(result.config.baseUrl, 'https://example.test/v1');
  assert.equal(result.config.hasApiKey, true);
  assert.equal(result.models.length, 2);
  assert.deepEqual(result.models[0], {id: 'model-a', presetId: 'preset-a', name: 'Model A', provider: 'openai-responses', hasApiKey: true, baseUrl: ''});
  assert.equal(result.models[1].hasApiKey, false);
  assert.equal(result.providers.find(provider => provider.id === 'anthropic').baseUrl, 'https://api.anthropic.com');
  assert.doesNotMatch(JSON.stringify(result), /private|api_key|token=/);
  assert.deepEqual(modelConfigDto({...config, presets: undefined}, 7).models, []);
  assert.match(modelConfigDto({...config, presets: undefined}, 7).modelsError, /自定义模型/);
  assert.equal(modelConfigDto({...config, provider: 'custom-provider'}, 7).providers[0].id, 'custom-provider');
  assert.deepEqual(result.providers.filter(provider => provider.keyless !== false).map(provider => provider.id), ['self-hosted']);
});

test('self-hosted presets mirror Loom: a keyless provider with a default address that a preset address overrides', () => {
  const selfHosted = {id: 'self-hosted-glm', label: 'GLM 5.3 Flash', model: 'glm-5.3-flash', provider: 'self-hosted'};
  const result = modelConfigDto({...config, presets: [...config.presets, selfHosted]}, 7, 'now');
  assert.deepEqual(result.models[2], {id: 'glm-5.3-flash', presetId: 'self-hosted-glm', name: 'GLM 5.3 Flash', provider: 'self-hosted', hasApiKey: null, baseUrl: ''});
  assert.deepEqual(result.providers.find(provider => provider.id === 'self-hosted'), {id: 'self-hosted', name: '自部署', baseUrl: 'http://115.190.110.33:7860/v1', keyless: true});
  assert.deepEqual(result.providers.find(provider => provider.id === 'glm'), {id: 'glm', name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyless: false});
  assert.equal(result.providers.find(provider => provider.id === 'openai').baseUrl, 'https://api.openai.com/v1');
  const explicit = modelConfigDto({...config, presets: [{...selfHosted, base_url: 'http://10.0.0.2:7860/v1?key=private'}]}, 7, 'now');
  assert.equal(explicit.models[0].baseUrl, 'http://10.0.0.2:7860/v1');
  assert.doesNotMatch(JSON.stringify(explicit), /private/);
  assert.deepEqual(validateModelPatch({connectionId: 7, model: 'glm-5.3-flash', provider: 'self-hosted', baseUrl: 'http://115.190.110.33:7860/v1'}),
    {model: 'glm-5.3-flash', provider: 'self-hosted', base_url: 'http://115.190.110.33:7860/v1'});
});

test('patch accepts custom models, preserves a blank key and rejects hidden write fields', () => {
  assert.deepEqual(validateModelPatch({...input, model: ' vendor/custom-v2 ', provider: 'custom-provider', apiKey: '  '}),
    {model: 'vendor/custom-v2', provider: 'custom-provider', base_url: input.baseUrl});
  assert.deepEqual(validateModelPatch({...input, baseUrl: '', apiKey: ' new-private-key '}),
    {model: input.model, provider: input.provider, api_key: 'new-private-key'});
  for (const value of [null, [], {...input, connectionId: undefined}, {...input, rollback: true}, {...input, model: ''}, {...input, model: 'line\nbreak'},
    {...input, provider: 'invalid/provider'}, {...input, apiKey: 'a\nb'}, {...input, baseUrl: 'file:///C:/secret'},
    {...input, baseUrl: 'https://user:key@example.test'}, {...input, baseUrl: 'https://example.test?api_key=private'}, {...input, baseUrl: 'https://example.test/#secret'}]) {
    assert.throws(() => validateModelPatch(value), {code: 'INVALID_REQUEST'});
  }
  let invoked = false;
  const getter = {...input};
  Object.defineProperty(getter, 'model', {get: () => {invoked = true; return 'unexpected';}});
  assert.throws(() => validateModelPatch(getter), {code: 'INVALID_REQUEST'});
  assert.equal(invoked, false);
});

test('read and save use the confirmed same-origin config route and sanitized verification', async () => {
  let saved = {...config};
  const {service, requests} = fixture((_url, options) => {
    if (options.method === 'PATCH') {
      saved = {...saved, ...JSON.parse(options.body)};
      return json({ok: true, config: saved});
    }
    return json(saved);
  });
  const read = await service.get();
  assert.equal(read.models.length, 2);
  const result = await service.save({...input, apiKey: 'replacement-private-key'});
  assert.equal(result.config.model, 'model-a');
  assert.equal(requests.length, 3);
  for (const request of requests) {
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://being.example.test');
    assert.equal(url.pathname, '/heart/api/llm/config');
    assert.equal(url.searchParams.get('token'), 'private-loom-token');
    assert.equal(request.headers['X-Relay-Secret'], 'private-relay');
    assert.equal(request.redirect, 'error');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.cache, 'no-store');
    assert.equal(request.signal, undefined);
  }
  assert.deepEqual(JSON.parse(requests[1].body), {model: 'model-a', provider: 'openai-responses', api_key: 'replacement-private-key'});
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('successful PATCH requires a matching reread and is never automatically retried', async () => {
  for (const observed of [config, {...config, model: input.model, provider: 'different'}, {...config, model: input.model, base_url: 'https://different.test'}, {...config, model: input.model, has_api_key: false}]) {
    const {service, requests} = fixture((_url, options) => options.method === 'PATCH' ? json({ok: true}) : json(observed));
    await assert.rejects(service.save({...input, apiKey: 'new-key'}), {code: 'RESULT_UNKNOWN'});
    assert.equal(requests.filter(request => request.method === 'PATCH').length, 1);
  }
});

test('missing keys, rollbacks and authorization errors remain safe and distinct', async () => {
  for (const [body, status, code] of [[{needs_key: true, error: 'private-key'}, 400, 'NEEDS_KEY'], [{ok: true, rolled_back: true, error: 'private-key'}, 200, 'ROLLED_BACK'],
    [{error: 'private-key'}, 403, 'AUTH_REQUIRED'], [{ok: false, error: 'private-key'}, 500, 'RESULT_UNKNOWN']]) {
    const {service, requests} = fixture(() => json(body, status));
    await assert.rejects(service.save(input), error => error.code === code && !error.message.includes('private'));
    assert.equal(requests.length, 1);
    assert.equal(service.busy, false);
  }
});

test('transport exceptions and invalid or oversized bodies never expose credentials', async () => {
  for (const fetchImpl of [() => {throw new Error('private-loom-token private-upstream-key');},
    () => {const error = new Error('private-key'); error.code = 'NETWORK_ERROR'; throw error;},
    () => new Response('private-key', {status: 200}),
    () => new Response('{}', {headers: {'Content-Length': String(1024 * 1024 + 1)}})]) {
    const {service} = fixture(fetchImpl);
    await assert.rejects(service.get(), error => !error.message.includes('private'));
    await assert.rejects(service.save(input), error => !error.message.includes('private'));
  }
});

test('stale forms are rejected before writes and disconnected reads are not sent', async () => {
  const {service, requests, changeContext} = fixture();
  changeContext({connectionId: 8});
  await assert.rejects(service.save(input), {code: 'SESSION_CHANGED'});
  assert.equal(requests.length, 0);
  changeContext({connection: null});
  await assert.rejects(service.get(), {code: 'NOT_CONNECTED'});
  assert.equal(requests.length, 0);
});

test('responses from a switched Being are discarded for reads and writes', async () => {
  for (const mutation of [false, true]) {
    let resolveResponse;
    const pending = new Promise(resolve => {resolveResponse = resolve;});
    const {service, changeContext, requests} = fixture(() => pending);
    const result = mutation ? service.save(input) : service.get();
    changeContext({connectionId: 8});
    resolveResponse(json(mutation ? {ok: true} : config));
    await assert.rejects(result, {code: 'SESSION_CHANGED'});
    assert.equal(requests.length, 1);
  }
});

test('saving rejects concurrent requests and discards older configuration reads', async () => {
  let resolveOld, resolvePatch;
  const old = new Promise(resolve => {resolveOld = resolve;});
  const patch = new Promise(resolve => {resolvePatch = resolve;});
  let reads = 0;
  const {service} = fixture((_url, options) => options.method === 'PATCH' ? patch : (++reads === 1 ? old : json({...config, model: input.model})));
  const prior = service.get();
  const saving = service.save(input);
  await assert.rejects(service.get(), {code: 'BUSY'});
  await assert.rejects(service.save(input), {code: 'BUSY'});
  resolvePatch(json({ok: true}));
  const result = await saving;
  assert.equal(result.config.model, input.model);
  resolveOld(json(config));
  await assert.rejects(prior, {code: 'BUSY'});
});

test('confirmed model snapshot updates configuration without claiming runtime or stream health', () => {
  const previous = emptyRuntime();
  const next = updateRuntimeConfig(previous, modelConfigDto(config, 7, 'now'));
  assert.equal(next.model, config.model);
  assert.equal(next.configStatus, 'connected');
  assert.equal(next.configCheckedAt, 'now');
  assert.equal(next.sideBySide.configured, true);
  assert.equal(next.status, 'unknown');
  assert.equal(next.activeStream.active, null);
  assert.equal(previous.model, '');
});

test('unchanged displayed addresses preserve private URL fields when the model is saved', async () => {
  let saved = {...config, base_url: 'https://user:private@example.test/v1?credential=private'};
  const {service, requests} = fixture((_url, options) => {
    if (options.method === 'PATCH') {saved = {...saved, ...JSON.parse(options.body)}; return json({ok: true});}
    return json(saved);
  });
  const original = await service.get();
  assert.equal(original.config.baseUrl, 'https://example.test/v1');
  await service.save({...input, baseUrl: original.config.baseUrl});
  assert.equal(JSON.parse(requests[1].body).base_url, undefined);
  assert.equal(saved.base_url, 'https://user:private@example.test/v1?credential=private');
});

test('a stalled save belongs to its original connection and cannot lock a new Being', async () => {
  let resolveOld, resolveNew;
  const old = new Promise(resolve => {resolveOld = resolve;});
  const next = new Promise(resolve => {resolveNew = resolve;});
  let mutations = 0;
  const {service, changeContext} = fixture((_url, options) => options.method === 'PATCH' ? (++mutations === 1 ? old : next) : json({...config, model: input.model}));
  const first = service.save(input);
  changeContext({connection: parseConnection('https://another.example.test/being'), connectionId: 8});
  assert.equal(service.busy, false);
  assert.equal((await service.get()).connectionId, 8);
  const second = service.save({...input, connectionId: 8});
  assert.equal(service.busy, true);
  resolveOld(json({ok: true}));
  await assert.rejects(first, {code: 'SESSION_CHANGED'});
  assert.equal(service.busy, true);
  resolveNew(json({ok: true}));
  assert.equal((await second).connectionId, 8);
  assert.equal(service.busy, false);
});
