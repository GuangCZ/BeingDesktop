'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {runPortalSelfTest} = require('../src/portal-self-test.cjs');

function fixture(overrides = {}) {
  const state = {executable: __filename, configPath: __filename, pid: 42, owned: true, health: 'connected'};
  return {portal: {state, inspectProcesses: async () => [{pid: 42, executable: __filename}]}, connectionCurrent: true, probeRuntime: async () => ({status:'ok'}), ...overrides};
}
test('all checks pass only with process, runtime and current handshake evidence', async () => {
  const result = await runPortalSelfTest(fixture());
  assert.equal(result.status, 'passed');
  assert.equal(result.checks.length, 4);
});
test('reachable runtime without handshake remains unconfirmed', async () => {
  const input = fixture(); input.portal.state.health = 'unknown';
  assert.equal((await runPortalSelfTest(input)).status, 'unknown');
});
test('previous Being handshake cannot pass', async () => {
  const result = await runPortalSelfTest(fixture({connectionCurrent:false}));
  assert.equal(result.status, 'failed');
  assert.match(result.checks.at(-1).detail, /之前/);
});
test('missing process does not pass with a stale handshake', async () => {
  const input = fixture(); input.portal.inspectProcesses = async () => [];
  const result = await runPortalSelfTest(input);
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.at(-1).status, 'unknown');
});
test('runtime errors do not expose credentials', async () => {
  const result = await runPortalSelfTest(fixture({probeRuntime:async()=>{throw new Error('secret-token');}}));
  assert.equal(result.status, 'failed');
  assert.ok(!JSON.stringify(result).includes('secret-token'));
});
test('connection changes discard results', async () => {
  const result = await runPortalSelfTest(fixture({isCurrent:()=>false}));
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.checks, []);
});
test('process inspection failure remains unconfirmed', async () => {
  const input = fixture(); input.portal.inspectProcesses = async () => {throw new Error('denied');};
  assert.equal((await runPortalSelfTest(input)).status, 'unknown');
});
test('missing config and malformed runtime are failures', async () => {
  const input = fixture({probeRuntime:async()=>null}); input.portal.state.configPath = '';
  const result = await runPortalSelfTest(input);
  assert.equal(result.checks[0].status, 'failed');
  assert.equal(result.checks[2].status, 'failed');
});
