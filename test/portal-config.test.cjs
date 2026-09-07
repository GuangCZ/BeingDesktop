'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPortalConfig, validatePortalWorkspace, preparePortalWorkspace } = require('../src/portal-config.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'being-portal-config-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('being-portal-config-test-'));
    return fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test('generated v0.8 configuration binds only loopback and leaves commands, screenshots, and kits off', async t => {
  const root = await fixture(t);
  const result = await createPortalConfig({ workspace: root });
  assert.match(result.toml, /^name = "being-desktop"$/m);
  assert.match(result.toml, /^bind = "127\.0\.0\.1:0"$/m);
  assert.match(result.toml, /^workspace = /m);
  assert.match(result.toml, /\[tools\]\nexec = false\nfile = true\nscreenshot = false\nweb_fetch = false\nsearch = true\ncustom_tools_enabled = false/);
  assert.match(result.toml, /^kits_enabled = false$/m);
  assert.match(result.toml, /\[cowork\]\nenabled = true\nhttp_port = 0/);
  assert.doesNotMatch(result.toml, /token|secret|https?:|wss?:|hearth_url|being_name|\[workspace\]/i);
  assert.deepEqual(await fs.readdir(root), []);
});

test('capability summary distinguishes advertised tools from actual enforcement gaps', async t => {
  const { capabilities } = await createPortalConfig({ workspace: await fixture(t) });
  assert.equal(capabilities.strictSandbox, false);
  assert.equal(capabilities.fileAccess, 'read_write');
  assert.equal(capabilities.coworkRequiresPortalToken, true);
  assert.equal(capabilities.customToolsEnabled, false);
  assert.equal(capabilities.kitsEnabled, false);
  assert.deepEqual(capabilities.disabledAtDispatch, ['portal_exec', 'portal_process', 'portal_screenshot']);
  assert.deepEqual(capabilities.hiddenButCallable, ['portal_web_fetch', 'portal_web_search']);
  assert.ok(capabilities.advertisedTools.includes('portal_file_write'));
  assert.ok(capabilities.advertisedTools.includes('portal_oauth_authorize'));
  assert.ok(capabilities.advertisedTools.includes('portal_tools_reload'));
});

test('absolute paths with spaces and Unicode are escaped as TOML basic strings', async t => {
  const root = await fixture(t);
  const workspace = path.join(root, '测试 workspace');
  await fs.mkdir(workspace);
  const kitsDir = path.join(root, 'disabled kits');
  const { toml } = await createPortalConfig({ workspace, name: 'desktop-01', kitsDir });
  const storedWorkspace = /^workspace = (.+)$/m.exec(toml)[1];
  const storedKits = /^kits_dir = (.+)$/m.exec(toml)[1];
  assert.equal(JSON.parse(storedWorkspace), await fs.realpath(workspace));
  assert.equal(JSON.parse(storedKits), kitsDir);
  assert.equal(await fs.stat(kitsDir).then(() => true, () => false), false);
});

test('invalid, missing, and file workspace paths are rejected without creating them', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'file.txt');
  await fs.writeFile(file, 'fixture');
  for (const workspace of [undefined, null, '.', 'relative', 'bad\0path', `${root}\nextra`, file, path.join(root, 'missing')]) {
    await assert.rejects(createPortalConfig({ workspace }));
  }
  assert.deepEqual(await fs.readdir(root), ['file.txt']);
});

test('workspace junctions and nested paths beneath them are rejected', async t => {
  const root = await fixture(t);
  const target = path.join(root, 'target');
  const link = path.join(root, 'link');
  await fs.mkdir(path.join(target, 'child'), { recursive: true });
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validatePortalWorkspace(link), /符号链接/);
  await assert.rejects(validatePortalWorkspace(path.join(link, 'child')), /符号链接/);
});

test('default workspace preparation creates only the dedicated leaf and preserves existing files', async t => {
  const root = await fixture(t);
  const defaultWorkspace = path.join(root, 'portal-workspace');
  assert.equal(await preparePortalWorkspace({ workspace: '', defaultWorkspace }), await fs.realpath(defaultWorkspace));
  await fs.writeFile(path.join(defaultWorkspace, 'keep.txt'), 'keep');
  await preparePortalWorkspace({ defaultWorkspace });
  assert.equal(await fs.readFile(path.join(defaultWorkspace, 'keep.txt'), 'utf8'), 'keep');
  const unused = path.join(root, 'unused');
  assert.equal(await preparePortalWorkspace({ workspace: root, defaultWorkspace: unused }), await fs.realpath(root));
  await assert.rejects(fs.stat(unused), { code: 'ENOENT' });
});

test('default workspace preparation refuses files, junctions, linked parents, and missing parent directories', async t => {
  const root = await fixture(t);
  const target = path.join(root, 'target');
  const linked = path.join(root, 'linked');
  const file = path.join(root, 'file');
  await fs.mkdir(target);
  await fs.writeFile(file, 'keep');
  await fs.symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  for (const defaultWorkspace of [file, linked, path.join(linked, 'child'), path.join(root, 'missing', 'child')]) {
    await assert.rejects(preparePortalWorkspace({ defaultWorkspace }));
  }
  assert.deepEqual(await fs.readdir(target), []);
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
  await assert.rejects(fs.stat(path.join(root, 'missing')), { code: 'ENOENT' });
});

test('names and optional kit paths cannot inject configuration fields', async t => {
  const workspace = await fixture(t);
  for (const name of ['', 'a'.repeat(65), 'x"\nexec = true', 'name space', null]) {
    await assert.rejects(createPortalConfig({ workspace, name }), /名称无效/);
  }
  await assert.rejects(createPortalConfig({ workspace, kitsDir: 'relative' }));
  await assert.rejects(createPortalConfig({ workspace, kitsDir: `${workspace}\n[tools]` }));
});
