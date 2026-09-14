'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../renderer/town-mentions.js');
const members = [{id:'t_first',name:'Twin Name'},{id:'t_second',name:'Twin Name'},{id:'t_yomi',name:'YomiyaHina'}];
test('display name selections resolve to exact IDs, including spaces and duplicate names', () => {
  const result=M.resolve('@Twin Name hello @YomiyaHina',members,[{start:0,end:10,label:'Twin Name',id:'t_second'}]);
  assert.equal(result.text,'@t_second hello @t_yomi');assert.deepEqual(result.members,['t_second','t_yomi']);assert.deepEqual(result.unresolved,[]);
});
test('two identical visible names can address different selected members', () => {
  const result=M.resolve('@Twin Name @Twin Name',members,[{start:0,end:10,label:'Twin Name',id:'t_first'},{start:11,end:21,label:'Twin Name',id:'t_second'}]);
  assert.equal(result.text,'@t_first @t_second');assert.deepEqual(result.members,['t_first','t_second']);
});
test('surrounding edits move selection ranges while editing a selected name removes its binding', () => {
  const selections=[{start:0,end:10,label:'Twin Name',id:'t_second'}];
  const prefixed=M.rebaseSelections('@Twin Name ','你好 @Twin Name ',selections);
  const shifted=M.rebaseSelections('你好 @Twin Name ','你好 @Twin Name 请看看',prefixed);
  assert.equal(M.resolve('你好 @Twin Name 请看看',members,shifted).text,'你好 @t_second 请看看');
  assert.deepEqual(M.rebaseSelections('@Twin Name ','@Twin Other ',selections),[]);
});
test('stale IDs and edited labels cannot use an old selected identity', () => {
  const selection={start:0,end:10,label:'Twin Name',id:'t_removed'};
  assert.ok(!M.resolve('@Twin Name',members,[selection]).members.includes('t_removed'));
  assert.ok(!M.resolve('@OtherName',members,[{...selection,id:'t_second'}]).members.includes('t_second'));
});
test('message display resolves known Town IDs while preserving unknown IDs, URLs and emails', () => {
  const original='@t_yomi 你好，@t_unknown user@t_yomi https://example.invalid/@t_yomi';
  assert.equal(M.displayText(original,members),'@YomiyaHina 你好，@t_unknown user@t_yomi https://example.invalid/@t_yomi');
  assert.equal(M.displayText('@t_yomi。',members),'@YomiyaHina。');
});
