'use strict';

// Copy the approved desktop artwork without redrawing or resizing it.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sourceRecord = require('../design/being-pixel/logo-source.json');
const source = path.join(root, 'renderer/assets/being');
const destination = path.join(root, 'extensions/being-anywhere/icons');
const sizes = [16, 20, 24, 32, 40, 48, 64, 80, 96, 112, 128, 160, 192, 256, 512];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(fs.readFileSync(path.join(root, sourceRecord.source))), sourceRecord.sourceSha256, 'Original artwork changed.');
assert.equal(sha256(fs.readFileSync(path.join(source, 'being-icon.png'))), sourceRecord.pngSha256, 'Approved large artwork changed.');
const names = ['being-icon.png', 'being-icon-small.svg', ...sizes.map(size => `being-icon-${size}.png`)];
const entries = names.map(name => {
  const bytes = fs.readFileSync(path.join(source, name));
  if (name.endsWith('.png')) {
    const size = name === 'being-icon.png' ? 1024 : Number(name.match(/-(\d+)\.png$/)[1]);
    assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `Invalid PNG: ${name}`);
    assert.equal(bytes.readUInt32BE(16), size, `Unexpected width: ${name}`);
    assert.equal(bytes.readUInt32BE(20), size, `Unexpected height: ${name}`);
  }
  return {source: name, file: name.replace('being-icon', 'being'), bytes, sha256: sha256(bytes)};
});
fs.mkdirSync(destination, {recursive: true});
for (const entry of entries) {
  const file = path.join(destination, entry.file);
  fs.writeFileSync(file, entry.bytes);
  assert(fs.readFileSync(file).equals(entry.bytes), `Logo copy mismatch: ${entry.file}`);
}
const report = {passed: true, source, destination, sourceSha256: sourceRecord.sourceSha256,
  files: entries.map(({source, file, bytes, sha256}) => ({source, file, bytes: bytes.length, sha256}))};
const reportPath = path.join(root, '.local/being-anywhere-logo-sync.json');
fs.mkdirSync(path.dirname(reportPath), {recursive: true});
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify({passed: true, files: entries.length, report: reportPath}) + '\n');
