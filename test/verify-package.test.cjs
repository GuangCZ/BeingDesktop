'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const { verifyPackage, DEPENDENCIES, NATIVE_FILES, VENDOR_FILES } = require('./verify-package.cjs');

function write(root, file, contents) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), contents);
}

async function fixture(t, mutate, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'being-package-verification-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('being-package-verification-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const root = path.join(directory, 'source');
  const archive = path.join(directory, 'app.asar');
  write(root, 'package.json', JSON.stringify({ name: 'fixture', version: '0.8.0', main: 'src/main.cjs', dependencies: DEPENDENCIES }));
  write(root, 'LICENSE', 'Fixture license');
  write(root, 'src/main.cjs', 'module.exports = true;');
  write(root, 'renderer/index.html', '<main>Fixture</main>');
  for (const [name, version] of Object.entries(DEPENDENCIES)) {
    write(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version, main: 'index.js' }));
    write(root, `node_modules/${name}/index.js`, 'module.exports = {};');
    write(root, `node_modules/${name}/${name === 'node-addon-api' ? 'LICENSE.md' : 'LICENSE'}`, `License for ${name}`);
  }
  for (const file of NATIVE_FILES) write(root, file, `Synthetic fixture bytes for ${file}`);
  for (const [vendorFile, dependencyFile] of Object.entries(VENDOR_FILES)) {
    const contents = `Synthetic vendor bytes for ${vendorFile}`;
    write(root, `renderer/vendor/xterm/${vendorFile}`, contents);
    write(root, `node_modules/${dependencyFile}`, contents);
  }
  mutate?.(root);
  let packagedRoot = root;
  if (options.packageTransform) {
    packagedRoot = path.join(directory, 'staging');
    fs.cpSync(root, packagedRoot, { recursive: true });
    options.packageTransform(packagedRoot);
  }
  await asar.createPackageWithOptions(packagedRoot, archive, options.packNative ? {} : { unpackDir: 'node_modules/node-pty' });
  return { root, archive };
}

test('packaging verifier accepts a synthetic archive with only exact dependencies and unpacked native bytes', async t => {
  const value = await fixture(t);
  const result = verifyPackage(value);
  assert.equal(result.passed, true);
  assert.equal(result.nativeFiles, 5);
});

test('packaging verifier rejects unrelated and lookalike dependency packages', async t => {
  for (const name of ['unrelated-package', 'node-pty-extra']) {
    const value = await fixture(t, root => write(root, `node_modules/${name}/index.js`, 'unexpected'));
    assert.throws(() => verifyPackage(value), /Unexpected packaged file/);
  }
});

test('packaging includes the shared Being transport without shipping the browser extension', async t => {
  const transport = 'extensions/being-anywhere/being-client.mjs';
  const configure = root => {
    const manifestFile = path.join(root, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.build = {files: [transport]};
    write(root, 'package.json', JSON.stringify(manifest));
    write(root, transport, 'export class BeingClient {}');
  };
  const valid = await fixture(t, configure);
  assert.equal(verifyPackage(valid).passed, true);
  const missing = await fixture(t, configure, {packageTransform: root => fs.unlinkSync(path.join(root, transport))});
  assert.throws(() => verifyPackage(missing), /Missing packaged file: extensions\/being-anywhere\/being-client/);
  const extra = await fixture(t, root => {
    configure(root);
    write(root, 'extensions/being-anywhere/background.js', 'Unexpected extension entry point');
  });
  assert.throws(() => verifyPackage(extra), /Unexpected packaged file/);
});

test('packaging verifier rejects private files inside an allowed dependency', async t => {
  const value = await fixture(t, root => write(root, 'node_modules/node-pty/.env', 'synthetic private fixture'));
  assert.throws(() => verifyPackage(value), /Private file included/);
});

test('packaging verifier rejects nested dependencies and changed dependency versions', async t => {
  const nested = await fixture(t, root => write(root, 'node_modules/node-pty/node_modules/unrelated/index.js', 'unexpected'));
  assert.throws(() => verifyPackage(nested), /Unexpected nested dependency/);
  const version = await fixture(t, root => write(root, 'node_modules/node-pty/package.json', JSON.stringify({ name: 'node-pty', version: '1.0.0', main: 'index.js' })));
  assert.throws(() => verifyPackage(version), /Unexpected dependency version/);
});

test('packaging verifier accepts exact builder metadata removal while retaining dependency runtime fields', async t => {
  const file = 'node_modules/node-pty/package.json';
  const source = { name: 'node-pty', version: '1.1.0', main: 'index.js', dependencies: { 'node-addon-api': '^7.1.0' },
    license: 'MIT', scripts: { install: 'synthetic fixture only' }, keywords: ['pty'], bugs: { url: 'https://example.invalid/fixture' } };
  const normalized = { name: source.name, version: source.version, main: source.main, dependencies: source.dependencies, license: source.license };
  const valid = await fixture(t, root => write(root, file, JSON.stringify(source)), {
    packageTransform: root => write(root, file, JSON.stringify(normalized)),
  });
  assert.equal(verifyPackage(valid).passed, true);
  for (const change of [{ dependencies: {} }, { main: 'changed.js' }, { license: undefined }]) {
    const invalid = await fixture(t, root => write(root, file, JSON.stringify(source)), {
      packageTransform: root => write(root, file, JSON.stringify({ ...normalized, ...change })),
    });
    assert.throws(() => verifyPackage(invalid), /Packaged dependency manifest mismatch/);
  }
});

test('packaging verifier requires native files outside the archive', async t => {
  const value = await fixture(t, undefined, { packNative: true });
  assert.throws(() => verifyPackage(value), /must be unpacked/);
});

test('packaging verifier detects changed native bytes and extra unpacked files', async t => {
  const native = await fixture(t);
  write(`${native.archive}.unpacked`, NATIVE_FILES[0], 'tampered synthetic native file');
  assert.throws(() => verifyPackage(native), /Packaged source mismatch/);
  const extra = await fixture(t);
  write(`${extra.archive}.unpacked`, 'node_modules/node-pty/extra.js', 'unexpected');
  assert.throws(() => verifyPackage(extra), /Unexpected unpacked file/);
});

test('packaging verifier detects missing source, missing native helpers, and altered vendored xterm assets', async t => {
  const missingSource = await fixture(t);
  write(missingSource.root, 'renderer/required.js', 'unpackaged source');
  assert.throws(() => verifyPackage(missingSource), /Missing packaged source/);
  const missingNative = await fixture(t, root => fs.unlinkSync(path.join(root, NATIVE_FILES.at(-1))));
  assert.throws(() => verifyPackage(missingNative), /Missing packaged file/);
  const vendor = await fixture(t, root => write(root, 'renderer/vendor/xterm/xterm.js', 'different renderer bytes'));
  assert.throws(() => verifyPackage(vendor), /Vendored xterm asset mismatch/);
});
