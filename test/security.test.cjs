'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {parseConnection,endpoint,publicModelUrl,protocolFile,sessionPartition,allowedNavigation}=require('../src/security.cjs');

test('connection separates public metadata from credentials',()=>{
  const c=parseConnection('https://example.test/being/?token=private&api=https://example.test/being');
  assert.equal(c.displayUrl,'https://example.test/being/');
  assert.equal(c.token,'private');
  assert.equal(new URL(endpoint(c,'/api/status')).searchParams.get('token'),'private');
  assert.equal(c.beingName,'being');
});
test('rejects credential forwarding and unsafe schemes',()=>{
  for(const url of ['https://example.test/?token=x&api=https://other.test','http://example.test/a','file:///C:/a','https://a:b@example.test/a','https://example.test/?api=https://example.test/x?token=x'])assert.throws(()=>parseConnection(url));
  assert.equal(parseConnection('http://127.0.0.1:9000/').displayUrl,'http://127.0.0.1:9000/');
});
test('native API helper only reads verified endpoints',()=>{
  assert.throws(()=>endpoint(parseConnection('https://example.test/a'),'/api/chat/stream'));
  assert.equal(publicModelUrl('https://name:pass@example.test/v1?key=secret'),'https://example.test/v1');
});
test('app resource handler rejects encoded path traversal',()=>{
  const root=require('node:path').resolve('renderer');
  assert.throws(()=>protocolFile(root,'being://app/..%2fsecret'));
  assert.throws(()=>protocolFile(root,'being://other/app.js'));
  assert.match(protocolFile(root,'being://app/app.js'),/app\.js$/);
});
test('persistent sessions isolate backends and credentials while retaining the same identity',()=>{
  const a=parseConnection('https://example.test/loom/?api=https://example.test/a&token=first');
  const b=parseConnection('https://example.test/loom/?api=https://example.test/b&token=first');
  const c=parseConnection('https://example.test/loom/?api=https://example.test/a&token=second');
  assert.notEqual(sessionPartition(a),sessionPartition(b));
  assert.notEqual(sessionPartition(a),sessionPartition(c));
  assert.equal(sessionPartition(a),sessionPartition({...a}));
  assert.match(sessionPartition(a),/^persist:loom-v1-[a-f0-9]{32}$/);
  assert.doesNotMatch(sessionPartition(a),/first|example/);
});
test('persistent sessions isolate secret-only changes and normalize secret parameter aliases',()=>{
  const a=parseConnection('https://example.test/loom/?api=https://example.test/a&token=same-token&relay_secret=first-relay');
  const b=parseConnection('https://example.test/loom/?api=https://example.test/a&token=same-token&relay_secret=second-relay');
  const alias=parseConnection('https://example.test/loom/?api=https://example.test/a&token=same-token&secret=first-relay');
  assert.equal(a.displayUrl,b.displayUrl);
  assert.equal(a.apiBase,b.apiBase);
  assert.equal(a.token,b.token);
  assert.notEqual(a.secret,b.secret);
  assert.notEqual(sessionPartition(a),sessionPartition(b));
  assert.equal(sessionPartition(a),sessionPartition(alias));
  assert.doesNotMatch(sessionPartition(a),/same-token|first-relay/);
});

test('navigation allows slash normalization in both directions but rejects other routes',()=>{
  for(const input of ['https://example.test/being','https://example.test/being/']) {
    const c=parseConnection(input);
    assert.equal(allowedNavigation(c,'https://example.test/being/'),true);
    assert.equal(allowedNavigation(c,'https://example.test/being'),true);
    for(const target of ['https://other.test/being/','http://example.test/being/','https://example.test/another','file:///being'])assert.equal(allowedNavigation(c,target),false);
  }
});
