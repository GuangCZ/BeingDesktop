'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');

const DEPENDENCIES = Object.freeze({
  '@xterm/addon-fit': '0.11.0',
  '@xterm/xterm': '6.0.0',
  'argparse': '2.0.1',
  'builder-util-runtime': '9.7.0',
  'debug': '4.4.3',
  'electron-updater': '6.8.9',
  'fs-extra': '10.1.0',
  'graceful-fs': '4.2.11',
  'js-yaml': '4.3.2',
  'jsonfile': '6.2.1',
  'lazy-val': '1.0.5',
  'lodash.escaperegexp': '4.1.2',
  'lodash.isequal': '4.5.0',
  'ms': '2.1.3',
  'node-addon-api': '7.1.1',
  'node-pty': '1.1.0',
  'sax': '1.6.1',
  'semver': '7.7.4',
  'tiny-typed-emitter': '2.1.0',
  'universalify': '2.0.1',
  'ws': '8.21.3',
});
// electron-builder removes only these observed metadata fields from dependencies.
const STRIPPED_MANIFEST_FIELDS = Object.freeze({
  '@xterm/addon-fit': ['keywords', 'scripts'],
  '@xterm/xterm': ['keywords', 'scripts'],
  'argparse': ['keywords', 'scripts'],
  'builder-util-runtime': ['bugs'],
  'debug': ['keywords', 'contributors', 'scripts', 'xo'],
  'electron-updater': ['bugs'],
  'fs-extra': ['keywords', 'scripts'],
  'graceful-fs': ['scripts', 'keywords'],
  'js-yaml': ['keywords', 'contributors', 'scripts'],
  'jsonfile': ['keywords', 'scripts'],
  'lazy-val': ['bugs', 'scripts'],
  'lodash.escaperegexp': ['keywords', 'contributors', 'scripts'],
  'lodash.isequal': ['keywords', 'contributors', 'scripts'],
  'ms': ['scripts', 'eslintConfig'],
  'node-addon-api': ['bugs', 'contributors', 'keywords', 'scripts'],
  'node-pty': ['bugs', 'keywords', 'scripts'],
  'sax': ['scripts'],
  'semver': ['scripts'],
  'tiny-typed-emitter': ['keywords', 'scripts'],
  'universalify': ['keywords', 'bugs', 'scripts'],
  'ws': ['keywords', 'bugs', 'scripts'],
});
const NATIVE_FILES = Object.freeze([
  'prebuilds/win32-x64/conpty.node',
  'prebuilds/win32-x64/conpty_console_list.node',
  'prebuilds/win32-x64/pty.node',
  'prebuilds/win32-x64/conpty/conpty.dll',
  'prebuilds/win32-x64/conpty/OpenConsole.exe',
].map(file => `node_modules/node-pty/${file}`));
const VENDOR_FILES = Object.freeze({
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'LICENSE-xterm': '@xterm/xterm/LICENSE',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  'LICENSE-addon-fit': '@xterm/addon-fit/LICENSE',
});

function normalizedEntry(item) {
  const file = item.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  assert.ok(file && !file.split('/').some(part => !part || part === '.' || part === '..'), `Invalid archive path: ${item}`);
  assert.ok(!file.includes(':') && !file.includes('\0'), `Invalid archive path: ${item}`);
  return file;
}

function validatePackageFile(file) {
  assert.ok(/^(src\/|renderer\/|package\.json$|LICENSE$)/.test(file)
    || file === 'extensions/being-anywhere/being-client.mjs'
    || Object.keys(DEPENDENCIES).some(name => file.startsWith(`node_modules/${name}/`)), `Unexpected packaged file: ${file}`);
  assert.ok(!file.startsWith('node_modules/') || file.indexOf('/node_modules/', 'node_modules/'.length) === -1,
    `Unexpected nested dependency: ${file}`);
  assert.ok(!file.startsWith('renderer/assets/kits/'), `Legacy generated icon shipped: ${file}`);
  assert.ok(!file.split('/').some(part => /^\.(?:local|git|codex|agents)$/.test(part)
    || /^\.env(?:\.|$)/.test(part) || /^(?:auths|credentials)$/i.test(part)), `Private file included: ${file}`);
}

function verifyPackage({ root = path.resolve(__dirname, '..'), archive } = {}) {
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = sourceManifest.version;
  archive ||= path.join(root, `dist-${version}`, 'win-unpacked', 'resources', 'app.asar');
  const unpacked = `${archive}.unpacked`;
  const entries = asar.listPackage(archive).map(normalizedEntry);
  const files = new Map();
  for (const entry of entries) {
    const stat = asar.statFile(archive, path.normalize(entry));
    assert.ok(!stat.link, `Archive links are not allowed: ${entry}`);
    if (!stat.files) files.set(entry, stat);
  }
  // electron-builder hoists updater's pinned semver into the app archive.
  const sourceFile = file => {
    if(file.startsWith('node_modules/semver/') && fs.existsSync(path.join(root,'node_modules/electron-updater/node_modules/semver/package.json')))
      return path.join(root,file.replace('node_modules/semver/','node_modules/electron-updater/node_modules/semver/'));
    return path.join(root,file);
  };
  const packedFile = file => {
    assert.ok(files.has(file), `Missing packaged file: ${file}`);
    return asar.extractFile(archive, path.normalize(file));
  };
  packedFile('package.json');
  packedFile('LICENSE');
  if (sourceManifest.build?.files?.includes('extensions/being-anywhere/being-client.mjs')) packedFile('extensions/being-anywhere/being-client.mjs');
  for (const [file, stat] of files) {
    validatePackageFile(file);
    const packed = packedFile(file);
    if (file === 'package.json') {
      const manifest = JSON.parse(packed);
      assert.equal(manifest.version, version);
      assert.equal(manifest.main, sourceManifest.main);
      assert.deepEqual(manifest.dependencies, sourceManifest.dependencies);
    } else if (Object.keys(DEPENDENCIES).some(name => file === `node_modules/${name}/package.json`)) {
      const name = file.slice('node_modules/'.length, -'/package.json'.length);
      const expected = JSON.parse(fs.readFileSync(sourceFile(file), 'utf8'));
      for (const field of STRIPPED_MANIFEST_FIELDS[name]) delete expected[field];
      assert.deepEqual(JSON.parse(packed), expected, `Packaged dependency manifest mismatch: ${file}`);
    } else {
      assert.ok(packed.equals(fs.readFileSync(sourceFile(file))), `Packaged source mismatch: ${file}`);
    }
    if (file.startsWith('node_modules/node-pty/')) {
      assert.equal(stat.unpacked, true, `node-pty file must be unpacked: ${file}`);
    }
    if (stat.unpacked) {
      const diskFile = path.join(unpacked, file);
      assert.ok(fs.lstatSync(diskFile).isFile(), `Unpacked file is not a regular file: ${file}`);
      assert.ok(fs.readFileSync(diskFile).equals(packed), `Unpacked bytes mismatch: ${file}`);
    }
  }
  for (const directory of ['src', 'renderer']) {
    for (const entry of fs.readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const relative = path.relative(root, path.join(entry.parentPath, entry.name)).replace(/\\/g, '/');
      // Historical 0.6.0 artwork is kept in source only, outside the current package.
      if (relative.startsWith('renderer/assets/kits/')) continue;
      assert.ok(files.has(relative), `Missing packaged source: ${relative}`);
    }
  }
  for (const [name, expectedVersion] of Object.entries(DEPENDENCIES)) {
    const manifest = JSON.parse(packedFile(`node_modules/${name}/package.json`));
    assert.equal(manifest.name, name, `Unexpected dependency identity: ${name}`);
    assert.equal(manifest.version, expectedVersion, `Unexpected dependency version: ${name}`);
    const license = ['LICENSE','LICENSE.md','LICENSE-MIT.txt','LICENSE.txt','LICENSE-MIT','license','license.txt','license.md'].find(file=>files.has(`node_modules/${name}/${file}`));
    if (license) packedFile(`node_modules/${name}/${license}`);
    else {
      // lazy-val 1.0.5 publishes its MIT declaration only in package.json.
      assert.equal(name, 'lazy-val', `Missing dependency license: ${name}`);
      assert.equal(manifest.license, 'MIT');
    }
    if (manifest.main) {
      const main = `node_modules/${name}/${manifest.main.replace(/^\.\//, '')}`;
      const entry = [main, `${main}.js`, `${main}.json`, `${main}.node`, `${main}/index.js`].find(file => files.has(file));
      assert.ok(entry, `Missing dependency entry point: ${name}`);
      packedFile(entry);
    }
  }
  for (const file of NATIVE_FILES) {
    packedFile(file);
    assert.equal(files.get(file).unpacked, true, `Native dependency must be unpacked: ${file}`);
    assert.ok(fs.readFileSync(path.join(unpacked, file)).equals(fs.readFileSync(sourceFile(file))), `Native dependency bytes mismatch: ${file}`);
  }
  for (const [vendorFile, dependencyFile] of Object.entries(VENDOR_FILES)) {
    assert.ok(packedFile(`renderer/vendor/xterm/${vendorFile}`).equals(fs.readFileSync(path.join(root, 'node_modules', dependencyFile))), `Vendored xterm asset mismatch: ${vendorFile}`);
  }
  // Reject files silently added next to the archive, outside its file inventory.
  for (const entry of fs.readdirSync(unpacked, { recursive: true, withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), `Unpacked links are not allowed: ${entry.name}`);
    if (!entry.isFile()) continue;
    const relative = path.relative(unpacked, path.join(entry.parentPath, entry.name)).replace(/\\/g, '/');
    validatePackageFile(relative);
    assert.equal(files.get(relative)?.unpacked, true, `Unexpected unpacked file: ${relative}`);
  }
  return { passed: true, version, files: files.size, dependencies: DEPENDENCIES,
    nativeFiles: NATIVE_FILES.length, sourceBytesMatch: true, privateFilesIncluded: false };
}

if (require.main === module) process.stdout.write(`${JSON.stringify(verifyPackage())}\n`);
module.exports = { verifyPackage, DEPENDENCIES, NATIVE_FILES, VENDOR_FILES };
