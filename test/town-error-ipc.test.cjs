'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {FeatureTasks} = require('../src/feature-tasks.cjs');

test('Town transport failures survive the production preload and task ledger without becoming format errors', async () => {
  let api, response;
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/preload.cjs'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return {contextBridge: {exposeInMainWorld(_name, value) { api = value; }}, ipcRenderer: {
        async invoke(channel) { assert.equal(channel, 'being:requestTownRead'); return response; },
      }};
    },
  });
  const tasks = new FeatureTasks();
  for (const code of ['TOWN_TOOL_NOT_CALLED', 'RESULT_SOURCE_NOT_CONFIGURED', 'READINESS_UNKNOWN', 'RESULT_UNCONFIRMED']) {
    const task = tasks.begin({feature: 'bonfire', operation: 'read', title: '读取篝火消息', execution: 'being'});
    response = {__townError: true, code, message: '固定诊断信息'};
    await assert.rejects(api.requestTownRead({kind: 'bonfire'}), error => {
      assert.equal(error.code, code);
      assert.equal(error.message, response.message);
      const failed = tasks.fail(task.id, error);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.errorCode, code);
      return true;
    });
  }
  response = {__townError: true, code: 'UNTRUSTED', message: 'PRIVATE_REMOTE_DETAIL'};
  await assert.rejects(api.requestTownRead({kind: 'bonfire'}), error =>
    error.code === 'TOWN_ERROR' && !error.message.includes('PRIVATE_REMOTE_DETAIL'));
});
