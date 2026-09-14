'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const assert = require('node:assert/strict');

function verifyUpdateArtifacts(directory, platform, version = require('../package.json').version) {
  assert(['mac', 'windows'].includes(platform), 'Expected mac or windows');
  const manifest = platform === 'mac' ? 'latest-mac.yml' : 'latest.yml';
  const metadata = yaml.load(fs.readFileSync(path.join(directory, manifest), 'utf8'));
  assert.equal(metadata.version, version, 'Update metadata version mismatch');
  assert(Array.isArray(metadata.files) && metadata.files.length, 'Update files missing');
  assert(metadata.files.some(file => platform === 'mac' ? /-macos-(arm64|x64)\.zip$/.test(file.url) : /-windows-x64-setup\.exe$/.test(file.url)), 'Auto-update artifact missing');
  for (const file of metadata.files) {
    assert(typeof file.url === 'string' && /^[A-Za-z0-9._-]+$/.test(file.url), 'Update asset must be a local release filename');
    const bytes = fs.readFileSync(path.join(directory, file.url));
    assert.equal(crypto.createHash('sha512').update(bytes).digest('base64'), file.sha512, `Update checksum mismatch: ${file.url}`);
    if (file.size !== undefined) assert.equal(bytes.length, file.size, `Update size mismatch: ${file.url}`);
  }
  return {version, manifest, files: metadata.files.map(file => file.url)};
}
module.exports = {verifyUpdateArtifacts};
if (require.main === module) console.log(JSON.stringify(verifyUpdateArtifacts(path.resolve(process.argv[2]), process.argv[3])));
