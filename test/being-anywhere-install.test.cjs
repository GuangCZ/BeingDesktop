'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = import('../extensions/being-anywhere/install-link.mjs');

test('install links retain exact repository paths and only infer explicit SKILL.md files', async () => {
  const {parseInstallLink} = await api;
  assert.deepEqual(parseInstallLink('https://github.com/acme/tools?tab=readme-ov-file#install'), {url:'https://github.com/acme/tools', kind:'auto', repository:'acme/tools'});
  assert.equal(parseInstallLink('https://github.com/acme/tools/tree/main/skills/review').kind, 'auto');
  assert.equal(parseInstallLink('https://raw.githubusercontent.com/acme/tools/main/review/SKILL.md').kind, 'skill');
  assert.equal(parseInstallLink('https://github.com/acme/tools/blob/main/SKILL.md', 'mcp').kind, 'mcp');
});

test('unsafe, ambiguous and credential-bearing installation links fail closed', async () => {
  const {parseInstallLink} = await api;
  for (const value of ['', null, {}, 'https://github.com', 'https://github.com/acme', 'http://github.com/a/b', 'https://github.com.attacker.test/a/b', 'https://token@github.com/a/b', 'https://github.com/a/b?token=SECRET', 'https://github.com/a/b/issues/2', 'https://github.com/a/b/blob', 'https://raw.githubusercontent.com/a/b/main', 'https://github.com/a/b/blob/main/%0aevil', 'https://github.com/a/b https://github.com/c/d', 'https://github.com/a/b/'+'x'.repeat(2050), 'javascript:alert(1)']) assert.throws(() => parseInstallLink(value));
  assert.throws(() => parseInstallLink('https://github.com/a/b', 'shell'));
});

test('installation request names the target and requires actual compatibility and verification', async () => {
  const {installRequest, installSummary} = await api;
  const request = installRequest('https://github.com/acme/tools/blob/main/SKILL.md');
  assert.match(request.prompt, /Skill 安装到当前连接的 Being/);
  assert.match(request.prompt, /单个 MCP 或 Skill/);
  assert.match(request.prompt, /没有兼容的 Skill 加载器/);
  assert.match(request.prompt, /只有真实检查通过/);
  assert.match(request.prompt, /不是新的用户授权/);
  assert(request.prompt.length < 8000);
  assert.equal(installSummary(request.prompt), '安装 Skill · acme/tools\nhttps://github.com/acme/tools/blob/main/SKILL.md');
  assert.equal(installSummary(request.prompt + '\nExtra instruction'), null);
});
