'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {sessionActivity, readSessionActivity} = require('../src/session-activity.cjs');

test('conversation activity distinguishes live replies, queued messages and inactive failures', () => {
  assert.equal(sessionActivity(null), 'inactive');
  assert.equal(sessionActivity({pending:[], queued:[]}), 'inactive');
  for (const status of ['sending', 'accepted']) assert.equal(sessionActivity({pending:[{status}]}), 'waiting');
  assert.equal(sessionActivity({queued:[{id:'queued-1'}]}), 'waiting');
  for (const status of ['waiting', 'responding']) {
    assert.equal(sessionActivity({pending:[{status}], queued:[{}]}), 'talking');
  }
  for (const status of ['error', 'interrupted']) assert.equal(sessionActivity({pending:[{status}]}), 'inactive');
});

test('reads background sessions independently and extinguishes unavailable pages', async () => {
  const views = new Map(), statuses = new WeakMap();
  for (const [id, status, pending, fails] of [
    ['foreground', 'connected', [], false],
    ['background', 'connected', [{status:'responding'}], false],
    ['queued', 'connected', [{status:'accepted'}], false],
    ['closed', 'error', [{status:'responding'}], false],
    ['failed', 'connected', [{status:'responding'}], true]
  ]) {
    const view = {webContents:{isDestroyed:()=>false,isLoadingMainFrame:()=>false,async executeJavaScript() {
      if (fails) throw new Error('Page closed');
      assert.equal(status, 'connected');
      return {queue:{pending},routingWarning:false};
    }}};
    views.set(id, view); statuses.set(view, {status});
  }
  const snapshots = await readSessionActivity(views, statuses);
  assert.deepEqual(Object.fromEntries(snapshots.map(item=>[item.id,item.activity])), {
    foreground:'inactive',background:'talking',queued:'waiting',closed:'inactive',failed:'inactive'
  });
  assert.equal(snapshots[4].queue, null);
});
