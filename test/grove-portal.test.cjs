'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inspectGrovePortal, enableGrovePortal, verifyGrovePortalLogs, grovePortalConfigText, recoverGrovePortalMetadata } = require('../src/grove-portal.cjs');
const { createPortalConfig } = require('../src/portal-config.cjs');

async function fixture(t, contents) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'being-grove-portal-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('being-grove-portal-test-'));
    return fs.rm(root, { recursive: true, force: true });
  });
  const configPath = path.join(root, 'portal.toml');
  const kitsDir = path.join(root, 'grove-kits');
  await fs.writeFile(configPath, contents === undefined ? 'name = "desktop"\nkits_enabled = false\n[tools]\nexec = false\n' : contents);
  return { root, configPath, kitsDir };
}

test('inspection checks a disabled managed config without creating or changing files', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(f.configPath);
  const result = await inspectGrovePortal(f);
  assert.equal(result.ready, true);
  assert.equal(result.enabled, false);
  assert.equal(result.activationRequired, true);
  assert.equal(result.directoryExists, false);
  assert.deepEqual(await fs.readFile(f.configPath), before);
  assert.deepEqual(await fs.readdir(f.root), ['portal.toml']);
});

test('enable changes only root Kit values and keeps workspace, permissions, comments and CRLF bytes', async t => {
  const source = '\uFEFF# managed\r\nworkspace = "E:\\\\private workspace"\r\n  kits_enabled = false  # disabled until installation\r\nkits_dir = \'old kits\' # existing comment\r\n\r\n[tools]\r\nexec = false\r\nfile = true\r\nscreenshot = false\r\ncustom_tools_enabled = false\r\n[security]\r\nexec_allowlist = []\r\n';
  const f = await fixture(t, source);
  const result = await enableGrovePortal(f);
  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
  assert.equal(result.enabled, true);
  assert.equal(result.restartRequired, true);
  assert.deepEqual(await fs.readFile(result.backupPath), Buffer.from(source));
  assert.equal(await fs.readFile(f.configPath, 'utf8'), source
    .replace('kits_enabled = false', 'kits_enabled = true')
    .replace("kits_dir = 'old kits'", `kits_dir = ${JSON.stringify(f.kitsDir)}`));
  assert.equal((await fs.lstat(f.kitsDir)).isDirectory(), true);
  assert.equal((await fs.lstat(result.backupPath)).isSymbolicLink(), false);
  assert.equal((await fs.lstat(result.backupPath)).isFile(), true);
  assert.equal((await fs.readdir(f.root)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('missing Kit directory is inserted in the root before the first table', async t => {
  const source = '# managed\nname = "desktop"\nkits_enabled = false\n\n[tools]\nexec = false\n';
  const f = await fixture(t, source);
  await enableGrovePortal(f);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), source
    .replace('kits_enabled = false', 'kits_enabled = true')
    .replace('[tools]', `kits_dir = ${JSON.stringify(f.kitsDir)}\n[tools]`));
});

test('pure expected configuration matches activation bytes for managed deployment retries', async t => {
  const f = await fixture(t);
  const { toml } = await createPortalConfig({ workspace: f.root, name: 'being-desktop' });
  await fs.writeFile(f.configPath, toml);
  const expected = grovePortalConfigText(toml, f.kitsDir);
  assert.deepEqual(await fs.readdir(f.root), ['portal.toml']);
  await enableGrovePortal(f);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), expected);
  assert.equal(grovePortalConfigText(expected, f.kitsDir), expected);
  assert.throws(() => grovePortalConfigText(null, f.kitsDir));
  assert.throws(() => grovePortalConfigText(toml, 'relative'));
});

test('quoted keys are updated while identical text in multiline strings and tables is preserved', async t => {
  const source = 'description = """\n[tools]\nkits_enabled = true\n"""\n"kits_enabled" = false\n\'kits_dir\' = \'old\'\n[other]\nkits_enabled = false\nkits_dir = "retain"\n';
  const f = await fixture(t, source);
  await enableGrovePortal(f);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), source
    .replace('"kits_enabled" = false', '"kits_enabled" = true')
    .replace("'kits_dir' = 'old'", `'kits_dir' = ${JSON.stringify(f.kitsDir)}`));
});

test('missing newline at end of root config is handled without joining assignments', async t => {
  const f = await fixture(t, 'kits_enabled = false');
  await enableGrovePortal(f);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), `kits_enabled = true\nkits_dir = ${JSON.stringify(f.kitsDir)}\n`);
});

test('already enabled dedicated config stays byte-identical and creates no extra backups', async t => {
  const f = await fixture(t);
  const first = await enableGrovePortal(f);
  const source = await fs.readFile(f.configPath);
  const second = await enableGrovePortal(f);
  assert.equal(second.changed, false);
  assert.equal(second.backupPath, null);
  assert.equal(second.restartRequired, false);
  assert.deepEqual(await fs.readFile(f.configPath), source);
  assert.deepEqual((await fs.readdir(f.root)).filter(name => name.endsWith('.bak')), [path.basename(first.backupPath)]);
});

test('concurrent activation of the same configuration writes only one backup', async t => {
  const f = await fixture(t);
  const results = await Promise.all([enableGrovePortal(f), enableGrovePortal(f)]);
  assert.equal(results.filter(result => result.changed).length, 1);
  assert.equal((await fs.readdir(f.root)).filter(name => name.endsWith('.bak')).length, 1);
  assert.equal((await inspectGrovePortal(f)).enabled, true);
});

test('enabled configuration with a different explicit Kit directory is deferred to Being', async t => {
  const f = await fixture(t);
  const source = `kits_enabled = true\nkits_dir = ${JSON.stringify(path.join(f.root, 'other-kits'))}\n`;
  await fs.writeFile(f.configPath, source);
  for (const result of [await inspectGrovePortal(f), await enableGrovePortal(f)]) {
    assert.equal(result.ready, false);
    assert.equal(result.status, 'needs_being');
    assert.match(result.reason, /隐藏现有工具/);
  }
  assert.equal(await fs.readFile(f.configPath, 'utf8'), source);
  assert.deepEqual(await fs.readdir(f.root), ['portal.toml']);
});

test('implicit enabled default directory containing a Kit is not hidden', async t => {
  const f = await fixture(t, 'name = "desktop"\n[tools]\nexec = false\n');
  const defaultDir = path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.heart-portal', 'kits');
  const defaultParent = path.dirname(defaultDir);
  const lstat = fs.lstat.bind(fs), readdir = fs.readdir.bind(fs);
  const directoryStat = await lstat(f.root), fileStat = await lstat(f.configPath);
  t.mock.method(fs, 'lstat', async value => {
    if ([defaultDir, defaultParent].includes(String(value))) return directoryStat;
    if (String(value) === path.join(defaultDir, 'existing-kit', 'manifest.json')) return fileStat;
    return lstat(value);
  });
  t.mock.method(fs, 'readdir', async (value, options) => String(value) === defaultDir
    ? [{ name: 'existing-kit', isDirectory: () => true, isSymbolicLink: () => false }] : readdir(value, options));
  const result = await enableGrovePortal(f);
  assert.equal(result.ready, false);
  assert.equal(result.status, 'needs_being');
  assert.match(result.reason, /默认目录已有工具包/);
  assert.deepEqual(await readdir(f.root), ['portal.toml']);
});

test('implicit empty default allows inserting root fields before a BOM-prefixed table', async t => {
  const f = await fixture(t, '\uFEFF[tools]\nexec = false\n');
  const defaultDir = path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.heart-portal', 'kits');
  const lstat = fs.lstat.bind(fs);
  t.mock.method(fs, 'lstat', async value => {
    if (String(value) === defaultDir) throw Object.assign(new Error('missing fixture directory'), { code: 'ENOENT' });
    return lstat(value);
  });
  const result = await enableGrovePortal(f);
  assert.equal(result.changed, true);
  const contents = await fs.readFile(f.configPath, 'utf8');
  assert.equal(contents[0], '\uFEFF');
  assert.ok(contents.indexOf('kits_enabled = true') < contents.indexOf('[tools]'));
  assert.equal((await inspectGrovePortal(f)).enabled, true);
});

test('unsafe paths, linked ancestors, linked config and linked Kit directories cannot be activated', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'target');
  const linked = path.join(f.root, 'linked');
  await fs.mkdir(target);
  await fs.symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(target, 'portal.toml'), 'kits_enabled = false\n');
  for (const options of [
    { ...f, configPath: 'relative.toml' },
    { ...f, kitsDir: 'relative-kits' },
    { ...f, configPath: `${f.configPath}\nextra` },
    { ...f, configPath: path.join(linked, 'portal.toml') },
    { ...f, kitsDir: linked },
    { ...f, kitsDir: path.join(linked, 'kits') },
    { ...f, kitsDir: f.configPath },
    { ...f, kitsDir: path.join(f.root, 'missing-parent', 'kits') },
  ]) {
    const result = await enableGrovePortal(options);
    assert.equal(result.ready, false);
    assert.equal(result.changed, false);
    assert.equal(result.status, 'needs_being');
  }
  assert.equal(await fs.readFile(f.configPath, 'utf8'), 'name = "desktop"\nkits_enabled = false\n[tools]\nexec = false\n');
  assert.deepEqual(await fs.readdir(target), ['portal.toml']);
});

test('unrecognized, duplicate or invalid UTF-8 root values leave original bytes untouched', async t => {
  const f = await fixture(t);
  for (const contents of [
    'kits_enabled = false\nkits_enabled = true\n',
    'kits_enabled = "false"\n',
    'kits_enabled = false\nkits_dir = """multi\nline"""\n',
    '"kits_\\u0065nabled" = false\n',
    'kits_enabled = false\nkits_dir = "bad\\q"\n',
    Buffer.from([0xff, 0xfe, 0x61, 0x00]),
  ]) {
    await fs.writeFile(f.configPath, contents);
    assert.equal((await enableGrovePortal(f)).ready, false);
    assert.deepEqual(await fs.readFile(f.configPath), Buffer.from(contents));
    assert.deepEqual(await fs.readdir(f.root), ['portal.toml']);
  }
});

test('a concurrent config change before replacement is retained and the verified original backup remains', async t => {
  const f = await fixture(t);
  const original = await fs.readFile(f.configPath);
  const open = fs.open.bind(fs);
  const concurrent = 'name = "user change"\nkits_enabled = false\n';
  t.mock.method(fs, 'open', async (file, flags, mode) => {
    if (String(file).endsWith('.tmp')) await fs.writeFile(f.configPath, concurrent);
    return open(file, flags, mode);
  });
  await assert.rejects(enableGrovePortal(f), /配置已变化/);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), concurrent);
  const files = await fs.readdir(f.root);
  assert.equal(files.filter(name => name.endsWith('.tmp')).length, 0);
  const backups = files.filter(name => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.deepEqual(await fs.readFile(path.join(f.root, backups[0])), original);
});

test('an invalid backup prevents replacing the original configuration', async t => {
  const f = await fixture(t);
  const original = await fs.readFile(f.configPath);
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (file, flags, mode) => {
    if (String(file).endsWith('.bak') && flags === 'r') await fs.writeFile(file, 'corrupt backup');
    return open(file, flags, mode);
  });
  await assert.rejects(enableGrovePortal(f));
  assert.deepEqual(await fs.readFile(f.configPath), original);
});

test('log verification needs the actual Portal tool list, not process status or manifest discovery', () => {
  const names = ['web-search', 'echo-test'];
  const logs = [
    { title: 'Portal 已启动', detail: 'running' },
    { detail: "Loaded 2 kit manifest(s)" },
    { detail: "Kit 'web-search' discovered (v1.0.0)" },
    { detail: "Spawning kit 'echo-test' with command: node server.js" },
  ];
  assert.deepEqual(verifyGrovePortalLogs(logs, names).loaded, []);
  assert.equal(verifyGrovePortalLogs(logs, names).verified, false);
  logs.push({ detail: '2026-09-07T02:00:00Z INFO heart_portal: Portal tools: portal_file_read, web_search_search, echo_test_echo' });
  logs.push({ detail: "DEBUG heart_portal::mcp::connection: MCP server 'echo-test' spawned and initialized" });
  const result = verifyGrovePortalLogs(logs, names);
  assert.equal(result.verified, true);
  assert.deepEqual(result.loaded, names);
  assert.deepEqual(result.started, ['echo-test']);
  assert.deepEqual(result.missing, []);
});

test('missing tools, unhealthy Kits, latest list and process restart invalidate prior registration evidence', () => {
  const listed = { detail: 'Portal tools: one_echo, two_echo' };
  assert.deepEqual(verifyGrovePortalLogs([listed, { detail: "Kit 'two' marked unhealthy after 3 failures" }], ['one', 'two']).missing, ['two']);
  assert.deepEqual(verifyGrovePortalLogs([listed, { detail: 'Portal tools: portal_file_read, one_echo' }], ['one', 'two']).missing, ['two']);
  assert.equal(verifyGrovePortalLogs([listed, { title: 'Portal 已启动', detail: 'new process running' }], ['one']).verified, false);
  assert.equal(verifyGrovePortalLogs([listed, { title: 'Portal 已退出', detail: 'stopped' }], ['one']).verified, false);
  assert.equal(verifyGrovePortalLogs([{ status: 'running' }], ['one']).verified, false);
  assert.equal(verifyGrovePortalLogs([], []).verified, false);
});

test('log matching requires complete safe names and attributes longer prefixes to the correct Kit', () => {
  const logs = [{ detail: 'Portal tools: web_search_search, one_more_echo' }];
  const result = verifyGrovePortalLogs(logs, ['web', 'web-search', 'one', 'one-more']);
  assert.deepEqual(result.loaded, ['web-search', 'one-more']);
  assert.deepEqual(result.missing, ['web', 'one']);
  assert.equal(verifyGrovePortalLogs([{ detail: 'untrusted echo Portal tools: one_echo' }], ['one']).verified, false);
  assert.equal(verifyGrovePortalLogs([{ detail: 'Portal tools: one_echo\nignored' }], ['one']).verified, false);
  assert.throws(() => verifyGrovePortalLogs([], ['../unsafe']));
});

async function recoveryFixture(t) {
  const f = await fixture(t);
  const executable = path.join(f.root, 'heart-portal.exe');
  const browserWorkspace = path.join(f.root, 'other-workspace');
  await fs.writeFile(executable, 'non-executed binary fixture');
  await fs.mkdir(f.kitsDir);
  await fs.mkdir(browserWorkspace);
  const baseline = await createPortalConfig({ workspace: f.root, name: 'being-desktop' });
  await fs.writeFile(f.configPath, grovePortalConfigText(baseline.toml, f.kitsDir));
  const settings = { workspace: browserWorkspace, portalExecutable: executable, portalConfig: f.configPath,
    closeToTray: true, credential: 'opaque-fixture',
    managedPortal: { executable, configPath: f.configPath, workspace: baseline.capabilities.workspace, version: '0.8.0' } };
  let checks = 0;
  const verifyInstalledRoot = async directory => {
    assert.equal(directory, f.kitsDir);
    checks++;
    return { verified: true, installed: [{ id: 'fixture-kit', name: 'verified-kit', version: '1.0.0' }] };
  };
  return { ...f, baseline, executable, settings, verifyInstalledRoot, checks: () => checks };
}

test('metadata recovery uses the managed workspace and returns only the missing marker without writes', async t => {
  const f = await recoveryFixture(t);
  const before = structuredClone(f.settings), configBefore = await fs.readFile(f.configPath), filesBefore = await fs.readdir(f.root);
  const result = await recoverGrovePortalMetadata(f);
  assert.equal(result.changed, true);
  assert.deepEqual(result.managedPortal, { ...before.managedPortal, groveKitsDir: f.kitsDir });
  assert.deepEqual(f.settings, before);
  assert.deepEqual(await fs.readFile(f.configPath), configBefore);
  assert.deepEqual(await fs.readdir(f.root), filesBefore);
  assert.equal(f.checks(), 1);
});

test('a saved marker is unchanged, and recovery repeats after an older app overwrites it', async t => {
  const f = await recoveryFixture(t);
  const originalManaged = structuredClone(f.settings.managedPortal);
  const first = await recoverGrovePortalMetadata(f);
  f.settings.managedPortal = first.managedPortal;
  assert.deepEqual(await recoverGrovePortalMetadata(f), { changed: false, reason: '' });
  assert.equal(f.checks(), 1);
  // An old process may persist its startup snapshot without the newer marker.
  f.settings.managedPortal = originalManaged;
  const repeated = await recoverGrovePortalMetadata(f);
  assert.equal(repeated.changed, true);
  assert.deepEqual(repeated.managedPortal, first.managedPortal);
  assert.equal(f.checks(), 2);
});

test('metadata recovery refuses mismatched selections and conflicting existing markers', async t => {
  const f = await recoveryFixture(t);
  for (const changes of [
    { portalExecutable: path.join(f.root, 'other.exe') },
    { portalConfig: path.join(f.root, 'other.toml') },
    { managedPortal: { ...f.settings.managedPortal, groveKitsDir: path.join(f.root, 'other-kits') } },
    { managedPortal: { ...f.settings.managedPortal, workspace: f.settings.workspace } },
  ]) {
    const settings = { ...f.settings, ...changes };
    const before = structuredClone(settings);
    const result = await recoverGrovePortalMetadata({ ...f, settings });
    assert.equal(result.changed, false);
    assert.equal(result.managedPortal, undefined);
    assert.deepEqual(settings, before);
  }
  assert.equal(f.checks(), 0);
});

test('metadata recovery requires exact expected config bytes and never normalizes user changes', async t => {
  const f = await recoveryFixture(t);
  const expected = await fs.readFile(f.configPath, 'utf8');
  for (const changed of [
    f.baseline.toml,
    expected.replace('exec = false', 'exec = true'),
    `${expected}# user change\n`,
    expected.replaceAll('\n', '\r\n'),
  ]) {
    await fs.writeFile(f.configPath, changed);
    assert.equal((await recoverGrovePortalMetadata(f)).changed, false);
    assert.equal(await fs.readFile(f.configPath, 'utf8'), changed);
  }
  assert.equal(f.checks(), 0);
});

test('metadata recovery requires a nonempty directory with every installed Kit verified', async t => {
  const f = await recoveryFixture(t);
  for (const checked of [{ verified: false, installed: [{ name: 'unknown' }] }, { verified: true, installed: [] }, { verified: true }, null]) {
    assert.equal((await recoverGrovePortalMetadata({ ...f, verifyInstalledRoot: async () => checked })).changed, false);
  }
  assert.equal((await recoverGrovePortalMetadata({ ...f, verifyInstalledRoot: undefined })).changed, false);
  assert.equal((await recoverGrovePortalMetadata({ ...f, verifyInstalledRoot: async () => { throw new Error('offline or invalid root'); } })).changed, false);
  assert.equal(f.settings.managedPortal.groveKitsDir, undefined);
});

test('metadata recovery rejects linked directory ancestors and non-file Portal executables', async t => {
  const f = await recoveryFixture(t);
  const linked = path.join(f.root, 'linked');
  await fs.symlink(f.kitsDir, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await recoverGrovePortalMetadata({ ...f, kitsDir: linked })).changed, false);
  const directoryExecutable = path.join(f.root, 'not-an-executable');
  await fs.mkdir(directoryExecutable);
  const settings = { ...f.settings, portalExecutable: directoryExecutable,
    managedPortal: { ...f.settings.managedPortal, executable: directoryExecutable } };
  assert.equal((await recoverGrovePortalMetadata({ ...f, settings })).changed, false);
  assert.equal(f.checks(), 0);
});

test('metadata recovery rechecks config and selection after directory verification', async t => {
  const f = await recoveryFixture(t);
  const original = await fs.readFile(f.configPath, 'utf8');
  const changedConfig = `${original}# changed during audit\n`;
  assert.equal((await recoverGrovePortalMetadata({ ...f, verifyInstalledRoot: async () => {
    await fs.writeFile(f.configPath, changedConfig);
    return { verified: true, installed: [{ name: 'verified-kit' }] };
  } })).changed, false);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), changedConfig);
  await fs.writeFile(f.configPath, original);
  assert.equal((await recoverGrovePortalMetadata({ ...f, verifyInstalledRoot: async () => {
    f.settings.portalConfig = path.join(f.root, 'new-selection.toml');
    return { verified: true, installed: [{ name: 'verified-kit' }] };
  } })).changed, false);
  assert.equal(f.settings.managedPortal.groveKitsDir, undefined);
  f.settings.portalConfig = f.configPath;
  assert.equal((await recoverGrovePortalMetadata({ ...f, verifyInstalledRoot: async () => {
    f.settings.managedPortal.workspace = f.settings.workspace;
    return { verified: true, installed: [{ name: 'verified-kit' }] };
  } })).changed, false);
});
