'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../extensions/being-anywhere/activity-view.mjs');

// Keep deterministic protocol tests separate from the real Electron layout checks.
class Element {
  constructor(document, tagName) {
    this.ownerDocument = document;
    this.tagName = tagName;
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.text = '';
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
}

async function fixture() {
  const { createActivityView } = await modulePromise;
  const document = { createElement: tag => new Element(document, tag) };
  const container = document.createElement('div');
  const scroller = { scrollHeight: 1000, scrollTop: 20, clientHeight: 300 };
  const activity = createActivityView({ container, scrollContainer: scroller });
  function all(className, root = container) {
    return [root, ...root.children.flatMap(child => all(className, child))].filter(node => node.className === className);
  }
  activity.start();
  return { activity, container, scroller, all, event(type, data) { activity.handle({ type, data }); } };
}

test('tool results without IDs finish the last pending tool without an ID', async () => {
  const f = await fixture();
  f.event('tool_use', { name: 'search', input: { query: 'first' } });
  f.event('tool_use', { name: 'read_file', input: { path: '/tmp/second.txt' } });
  f.event('tool_result', { content: 'second result' });
  const tools = f.all('being-process-item');
  assert.equal(tools.length, 2);
  assert.equal(tools[0].dataset.status, 'running');
  assert.equal(tools[1].dataset.status, 'complete');
  assert.match(tools[1].textContent, /second result/);
  f.event('tool_result', { is_error: true, content: 'first failed' });
  assert.equal(tools[0].dataset.status, 'error');
  assert.match(tools[0].textContent, /first failed/);
});

test('an unknown explicit tool ID never completes another pending tool', async () => {
  const f = await fixture();
  f.event('tool_use', { id: 'known', name: 'search' });
  f.event('tool_use', { name: 'read_file' });
  f.event('tool_result', { tool_use_id: 'unknown', content: 'unknown result' });
  let tools = f.all('being-process-item');
  assert.deepEqual(tools.map(node => node.dataset.status), ['running', 'running', 'complete']);
  f.event('tool_result', { tool_use_id: 'known', content: 'known result' });
  tools = f.all('being-process-item');
  assert.equal(tools.length, 3);
  assert.deepEqual(tools.map(node => node.dataset.status), ['complete', 'running', 'complete']);
});

test('thinking streams real text and sanitizes credentials across chunk boundaries', async () => {
  const f = await fixture();
  f.event('thinking', { text: '先阅读资料。' });
  assert.equal(f.all('being-process-content')[0].textContent, '先阅读资料。');
  f.event('thinking', { delta: { text: '再核对来源。 api_' } });
  f.event('thinking', { delta: { text: 'key="not-for-display"\n链接 https://user:password@example.com/path?token=hidden' } });
  assert.match(f.all('being-process-content')[0].textContent, /^先阅读资料。再核对来源。/);
  assert.match(f.container.textContent, /api_key=\[已隐藏\]/);
  assert.doesNotMatch(f.container.textContent, /not-for-display|user:password|token=hidden/);
  assert.match(f.container.textContent, /https:\/\/example.com\/path/);
});

test('long thinking and tool content have a visible truncation marker', async () => {
  const f = await fixture();
  f.event('reasoning', { text: 'a'.repeat(25000) });
  assert.equal(f.all('being-process-content')[0].textContent, 'a'.repeat(24000) + '…');
  f.event('tool_use', { id: 'tool', name: 'search', input: { query: 'x'.repeat(400) } });
  f.event('tool_result', { id: 'tool', output: 'b'.repeat(5000) });
  assert.equal(f.all('being-process-content')[1].textContent, 'x'.repeat(300) + '…\n' + 'b'.repeat(4000) + '…');
});

test('a reply boundary stays active until the turn finishes and never scrolls a reader away', async () => {
  const f = await fixture();
  f.event('thinking', { text: '读取资料' });
  f.event('content_block_delta', { delta: { text: 'Partial reply' } });
  assert.equal(f.all('being-progress')[0].dataset.state, 'replying');
  f.event('message_stop', {});
  assert.equal(f.container.dataset.active, 'true');
  assert.equal(f.all('being-progress')[0].dataset.state, 'waiting');
  assert.equal(f.scroller.scrollTop, 20);
  const details = f.all('being-process')[0];
  details.open = true;
  f.activity.finish('stopped');
  assert.equal(f.container.dataset.active, 'false');
  assert.equal(f.all('being-progress')[0].dataset.state, 'stopped');
  assert.equal(details.open, false);
  f.event('thinking', { text: 'late data' });
  assert.doesNotMatch(f.container.textContent, /late data/);
  assert.equal(f.scroller.scrollTop, 20);
});
