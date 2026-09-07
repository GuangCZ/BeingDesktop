'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable, PassThrough } = require('node:stream');
const { portalRequestAdapter } = require('../src/desktop-network.cjs');

const ASSET = new URL('https://github.com/d5z/heart-portal/releases/download/v0.8.0/heart-portal-windows-x86_64.exe');
const REDIRECT = 'https://release-assets.githubusercontent.com/fixture?signature=private-fixture';
const HEADERS = { 'user-agent': 'Being-Desktop-Portal-Installer', accept: 'application/octet-stream' };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function nativeRequest({ abortError = 'none' } = {}) {
  const request = new EventEmitter();
  Object.assign(request, { headers: {}, endCount: 0, abortCount: 0, followCount: 0 });
  request.setHeader = (name, value) => { request.headers[name.toLowerCase()] = value; };
  request.end = () => { request.endCount++; };
  request.abort = () => {
    request.abortCount++;
    request.emit('abort');
    const error = new Error('Redirect was cancelled https://private.test/?token=private-fixture-token');
    if (abortError === 'sync') request.emit('error', error);
    if (abortError === 'async') queueMicrotask(() => request.emit('error', error));
  };
  request.followRedirect = () => { request.followCount++; };
  return request;
}
function transport(options = {}) {
  const requests = [];
  const constructed = deferred();
  const factory = init => {
    if (options.constructorFailure) throw new Error('private-fixture-token from constructor');
    const request = nativeRequest(options);
    requests.push({ init, request });
    constructed.resolve(request);
    return request;
  };
  return { requests, constructed: constructed.promise, adapter: portalRequestAdapter(factory) };
}
function begin(adapter, { url = ASSET, options = {} } = {}) {
  const ready = deferred();
  const errors = [], responses = [];
  const request = adapter(url, options, response => { responses.push(response); ready.resolve(response); });
  request.on('error', error => { errors.push(error); ready.reject(error); });
  return { request, errors, responses, response: ready.promise, start() { request.end(); } };
}
function incoming(value = 'fixture', statusCode = 200, headers = {}) {
  const response = Readable.from([Buffer.from(value)]);
  response.statusCode = statusCode;
  response.headers = headers;
  return response;
}
async function readBody(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('native request fixes GET, manual redirect, omitted credentials, no referrer and no session cookies', async () => {
  const t = transport(), h = begin(t.adapter);
  h.start();
  const native = await t.constructed;
  assert.equal(t.requests.length, 1);
  const { init } = t.requests[0];
  assert.equal(init.url, ASSET.href);
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.useSessionCookies, false);
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.deepEqual(native.headers, HEADERS);
  const source = incoming('fixture', 200, { 'content-length': '7' });
  native.emit('response', source);
  const body = await h.response;
  assert.equal(body, source);
  assert.equal(body.statusCode, 200);
  assert.equal(body.headers['content-length'], '7');
  assert.equal(await readBody(body), 'fixture');
});

test('caller methods and authentication headers cannot override fixed native download headers', async () => {
  const t = transport();
  const h = begin(t.adapter, { options: { method: 'POST', headers: {
    Authorization: 'Bearer private-fixture-token', Cookie: 'private-fixture-cookie',
    'Proxy-Authorization': 'private-fixture-proxy', Referer: 'https://private.test/',
    'User-Agent': 'caller-controlled', Accept: 'text/html',
  } } });
  h.start();
  const native = await t.constructed;
  assert.deepEqual(native.headers, HEADERS);
  assert.equal(t.requests[0].init.method, 'GET');
  assert.doesNotMatch(JSON.stringify(t.requests[0].init), /private-fixture|caller-controlled/);
  native.emit('response', incoming());
  await readBody(await h.response);
});

test('native redirect statuses become empty Node responses for installer URL validation', async () => {
  for (const statusCode of [301, 302, 303, 307, 308]) {
    const t = transport(), h = begin(t.adapter);
    h.start();
    const native = await t.constructed;
    native.emit('redirect', statusCode, 'GET', REDIRECT, { location: ['ignored-header-placeholder'] });
    const body = await h.response;
    assert.equal(body.statusCode, statusCode);
    assert.equal(body.headers.location, REDIRECT);
    assert.equal(await readBody(body), '');
    assert.equal(native.abortCount, 1);
    assert.equal(native.followCount, 0);
    assert.equal(t.requests.length, 1);
  }
});

test('synchronous abort errors after redirect cannot reject the synthetic response', async () => {
  const t = transport({ abortError: 'sync' }), h = begin(t.adapter);
  h.start();
  const native = await t.constructed;
  native.emit('redirect', 302, 'GET', REDIRECT, {});
  assert.equal(await readBody(await h.response), '');
  assert.deepEqual(h.errors, []);
  assert.equal(h.responses.length, 1);
});

test('asynchronous abort errors after redirect are suppressed without exposing their URLs', async () => {
  const t = transport({ abortError: 'async' }), h = begin(t.adapter);
  h.start();
  const native = await t.constructed;
  native.emit('redirect', 302, 'GET', REDIRECT, {});
  assert.equal(await readBody(await h.response), '');
  await Promise.resolve();
  assert.deepEqual(h.errors, []);
  assert.equal(h.responses.length, 1);
});

test('a late error from the redirected request cannot poison the next asset request', async () => {
  const t = transport(), first = begin(t.adapter);
  first.start();
  const oldNative = await t.constructed;
  oldNative.emit('redirect', 302, 'GET', REDIRECT, {});
  const redirect = await first.response;
  await readBody(redirect);
  const next = begin(t.adapter, { url: new URL(redirect.headers.location) });
  next.start();
  const newNative = t.requests[1].request;
  oldNative.emit('error', new Error('late cancellation private-fixture-token'));
  newNative.emit('response', incoming('verified-fixture-body'));
  assert.equal(await readBody(await next.response), 'verified-fixture-body');
  assert.deepEqual(first.errors, []);
  assert.deepEqual(next.errors, []);
  assert.equal(t.requests.length, 2);
  assert.equal(oldNative.abortCount, 1);
  assert.equal(newNative.abortCount, 0);
});

test('native errors before headers become a fixed request error', async () => {
  const t = transport(), h = begin(t.adapter);
  h.start();
  const native = await t.constructed;
  const failed = assert.rejects(h.response, { name: 'Error', message: 'Portal download failed' });
  native.emit('error', new Error('https://private.test/?token=private-fixture-token'));
  await failed;
  assert.equal(h.responses.length, 0);
  assert.doesNotMatch(h.errors[0].message, /private-fixture|https/);
});

test('synchronous native constructor failure uses the same fixed request error', async () => {
  const t = transport({ constructorFailure: true }), h = begin(t.adapter);
  const failed = assert.rejects(h.response, { name: 'Error', message: 'Portal download failed' });
  assert.doesNotThrow(() => h.start());
  await failed;
  assert.equal(h.responses.length, 0);
});

test('repeated end calls construct and send exactly one native request', async () => {
  const t = transport(), h = begin(t.adapter);
  h.start();
  h.start();
  const native = await t.constructed;
  assert.equal(t.requests.length, 1);
  assert.equal(native.endCount, 1);
  native.emit('response', incoming());
  await readBody(await h.response);
});

test('native HTTP errors preserve status, headers, and readable response for installer handling', async () => {
  const t = transport(), h = begin(t.adapter);
  h.start();
  const native = await t.constructed;
  const source = incoming('fixture-error', 403, { 'retry-after': '60' });
  native.emit('response', source);
  const body = await h.response;
  assert.equal(body, source);
  assert.equal(body.statusCode, 403);
  assert.equal(body.headers['retry-after'], '60');
  assert.equal(await readBody(body), 'fixture-error');
  assert.equal(h.responses.length, 1);
});

test('download stream errors remain observable after response headers were delivered', async () => {
  const t = transport(), h = begin(t.adapter);
  h.start();
  const native = await t.constructed;
  const source = new PassThrough();
  source.statusCode = 200;
  source.headers = {};
  native.emit('response', source);
  const body = await h.response;
  assert.equal(body, source);
  const failed = assert.rejects(readBody(body), /Fixture data interrupted/);
  source.write(Buffer.from('partial-body'));
  source.destroy(new Error('Fixture data interrupted'));
  await failed;
});

test('redirect followed by a late native response cannot deliver two callbacks', async () => {
  const t = transport(), h = begin(t.adapter);
  h.start();
  const native = await t.constructed;
  native.emit('redirect', 302, 'GET', REDIRECT, {});
  native.emit('response', incoming('late-body'));
  assert.equal(await readBody(await h.response), '');
  assert.equal(h.responses.length, 1);
  assert.equal(native.abortCount, 1);
});
