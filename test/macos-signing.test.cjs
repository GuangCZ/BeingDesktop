'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/macos-signing.cjs'), 'utf8');
const team = 'ABCDEFGHIJ';
const fingerprint = 'A'.repeat(40);
const identityLine = (hash = fingerprint, id = team) => `  1) ${hash} "Developer ID Application: Example (${id})"`;
function fixture({identities = identityLine(), profile, selector, designated, verifyFails = false} = {}) {
  const writes = [];
  const calls = [];
  const exported = {};
  const fakeRequire = name => {
    if (name === 'node:fs') return {
      existsSync: () => profile !== undefined,
      readFileSync: () => JSON.stringify(profile),
      mkdirSync: () => {},
      writeFileSync: (...args) => writes.push(args),
    };
    if (name === 'node:child_process') return {
      execFileSync: (command, args) => {
        calls.push({command, args});
        if (command === '/usr/bin/security') return identities;
        if (verifyFails) throw new Error('signature rejected');
        return '';
      },
      spawnSync: () => ({status: 0, stdout: designated ?? `designated => identifier "town.beings.desktop" and anchor apple generic and certificate leaf[subject.OU] = "${team}"`, stderr: ''}),
    };
    return require(name);
  };
  vm.runInNewContext(source, {require: fakeRequire, module: exported, process: {env: {CSC_NAME: selector}}, console});
  return {api: exported.exports, writes, calls};
}
const pinned = {teamId: team, appId: 'town.beings.desktop'};
test('release signing rejects missing or non-Developer-ID identities', () => {
  for (const identities of ['', '0 valid identities found', `1) ${fingerprint} "Being Desktop Local Code Signing"`]) {
    assert.throws(() => fixture({identities}).api.developerIdentity({initialize: true}), /Developer ID Application/);
  }
});
test('release signing requires explicit initial team pinning', () => {
  const {api, writes} = fixture();
  assert.throws(() => api.developerIdentity(), /Pin the Developer ID team/);
  api.developerIdentity({initialize: true});
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0][1]), pinned);
  assert.equal(writes[0][2].mode, 0o600);
  assert.equal(writes[0][2].flag, 'wx');
});
test('team pin survives certificate renewal but rejects a different team', () => {
  const renewed = 'B'.repeat(40);
  assert.equal(fixture({profile: pinned, identities: identityLine(renewed)}).api.developerIdentity().sha1, renewed);
  assert.throws(() => fixture({profile: pinned, identities: identityLine(renewed, 'KLMNOPQRST')}).api.developerIdentity(), /Developer ID Application/);
});
test('ambiguous certificates need a selector, which cannot override the pinned team', () => {
  const other = 'B'.repeat(40);
  const identities = [identityLine(), identityLine(other)].join('\n');
  assert.throws(() => fixture({profile: pinned, identities}).api.developerIdentity(), /unique/);
  assert.equal(fixture({profile: pinned, identities, selector: other}).api.developerIdentity().sha1, other);
  assert.throws(() => fixture({profile: pinned, identities: [identityLine(), identityLine(other, 'KLMNOPQRST')].join('\n'), selector: other}).api.developerIdentity(), /unique/);
});
test('malformed profiles cannot inject a signing requirement', () => {
  for (const profile of [{...pinned, teamId: 'ABC" or true'}, {...pinned, appId: 'another.app'}]) {
    assert.throws(() => fixture({profile}).api.developerIdentity(), /Invalid pinned/);
  }
});
test('post-sign validation requires the Apple anchor, application ID and team', () => {
  const {api, calls} = fixture({profile: pinned});
  const context = {appOutDir: '/tmp/output', packager: {appInfo: {productFilename: 'Being Desktop'}}};
  api.verifyDeveloper(context);
  const args = calls.find(call => call.command === '/usr/bin/codesign').args;
  assert.ok(args.includes('--deep'));
  assert.ok(args.includes('--strict'));
  assert.match(args[args.indexOf('-R') + 1], /identifier "town.beings.desktop" and anchor apple generic and certificate leaf\[subject.OU\] = "ABCDEFGHIJ"/);
  assert.throws(() => fixture({profile: pinned, verifyFails: true}).api.verifyDeveloper(context), /signature rejected/);
  for (const designated of ['designated => cdhash H"1234"', `designated => certificate leaf = H"${fingerprint}"`, '']) {
    assert.throws(() => fixture({profile: pinned, designated}).api.verifyDeveloper(context), /build-specific/);
  }
});
