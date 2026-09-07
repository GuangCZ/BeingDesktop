'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'extensions', 'being-anywhere');
const output = path.join(root, '.local', 'being-anywhere-release');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.name, 'BeingAnywhere');
const icons = ['icons/being.png', 'icons/being-small.svg', ...[16, 20, 24, 32, 40, 48, 64, 80, 96, 112, 128, 160, 192, 256, 512].map(size => `icons/being-${size}.png`)];
const files = ['manifest.json', 'background.mjs', 'install-link.mjs', 'floating-controller.mjs', 'floating.html', 'being-client.mjs', 'reply-followup.mjs', 'activity-view.mjs', 'content.js', 'sidepanel.html', 'sidepanel.mjs', 'popup.html', 'popup.mjs', 'options.html', 'options.mjs', 'ui.css', ...icons, 'README_CN.md'];
for (const file of files) {
  assert(fs.statSync(path.join(source, file)).isFile(), `Missing ${file}`);
  if (/\.(?:mjs|js)$/.test(file)) {
    const checked = spawnSync(process.execPath, ['--check', path.join(source, file)], { encoding: 'utf8', windowsHide: true });
    assert.equal(checked.status, 0, checked.stderr);
  }
}
for (const file of [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.action.default_icon), manifest.side_panel.default_path, manifest.options_ui.page, ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(item => item.js)]) assert(files.includes(file), `Unbundled resource ${file}`);
for (const resource of manifest.web_accessible_resources.flatMap(item => item.resources)) {
  const pattern = new RegExp('^' + resource.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  assert(files.some(file => pattern.test(file)), `Unbundled public resource ${resource}`);
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Store-only ZIP keeps this build independent of downloaded tooling.
function zip(entries) {
  const chunks = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const filename = Buffer.from(name, 'utf8'), crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    chunks.push(header, filename, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(0x21, 14); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, filename); offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

const entries = files.map(name => ({ name, data: fs.readFileSync(path.join(source, name)) }));
entries.push({ name: 'LICENSE', data: fs.readFileSync(path.join(root, 'LICENSE')) });
fs.mkdirSync(output, { recursive: true });
const archive = path.join(output, `BeingAnywhere-${manifest.version}.zip`);
const bytes = zip(entries);
fs.writeFileSync(archive, bytes);
const sha256 = createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${sha256}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({ archive, files: entries.length, bytes: bytes.length, sha256 }, null, 2));
