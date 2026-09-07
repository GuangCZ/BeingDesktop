'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createBrowserLinks} = require('../src/browser-links.cjs');

function fixture() {
  const opened = [], errors = [];
  let current = true, shown = 0, failure;
  const links = createBrowserLinks({
    getBrowser:()=>({newTab(options) {
      if (failure) throw failure;
      opened.push(options);
      return {activeTabId:`tab-${opened.length}`};
    }}),
    showBrowser:()=>{ shown++; },
    isCurrent:()=>current,
    onError:error=>errors.push(error),
  });
  return {links,opened,errors,shown:()=>shown,close:()=>{current=false;},fail:error=>{failure=error;}};
}

test('web entries create an internal tab and bring the browser into view', () => {
  const item = fixture();
  assert.deepEqual(item.links.open('https://example.com/docs'), {opened:true,tabId:'tab-1'});
  assert.deepEqual(item.opened, [{url:'https://example.com/docs'}]);
  assert.equal(item.shown(), 1);
  assert.equal(item.links.tryOpen('http://127.0.0.1:3000/preview'), true);
  assert.equal(item.opened[1].url, 'http://127.0.0.1:3000/preview');
});

test('links cannot execute non-web protocols or inject URL credentials', () => {
  const item = fixture();
  for (const url of ['javascript:alert(1)','file:///C:/private','being://app/index.html','mailto:person@example.com','about:blank','example.com','https://user:secret@example.com','https://example.com/\n',null]) {
    assert.throws(() => item.links.open(url));
  }
  assert.equal(item.opened.length, 0);
  assert.equal(item.shown(), 0);
});

test('popups are denied as native windows and opened without a referrer in a browser tab', async () => {
  const item = fixture();
  assert.deepEqual(item.links.popup({url:'https://example.com/story',referrer:{url:'https://loom.example/being?token=secret'}}), {action:'deny'});
  assert.equal(item.opened.length, 0);
  await Promise.resolve();
  assert.deepEqual(item.opened, [{url:'https://example.com/story'}]);
});

test('a connection change cancels a queued popup before it creates a tab', async () => {
  const item = fixture();
  item.links.popup({url:'https://example.com'});
  item.close();
  await Promise.resolve();
  assert.equal(item.opened.length, 0);
  assert.equal(item.links.tryOpen('https://example.com'), false);
  assert.equal(item.errors.length, 0);
});

test('tab creation failures are reported without switching to an empty browser', () => {
  const item = fixture();
  item.fail(new Error('Tab limit reached'));
  assert.equal(item.links.tryOpen('https://example.com'), false);
  assert.equal(item.errors[0].message, 'Tab limit reached');
  assert.equal(item.shown(), 0);
});
