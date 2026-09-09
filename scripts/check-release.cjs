'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {version} = require('../package.json');
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error('Stable release versions must use X.Y.Z; platform names belong in artifact filenames.');
}
const notes = path.join(root, 'releases', `${version}.md`);
if (!fs.readFileSync(notes, 'utf8').trim()) throw new Error('Write release notes for the current version before publishing.');
console.log(`Release v${version}: version and release notes verified.`);
