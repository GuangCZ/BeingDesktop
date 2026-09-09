'use strict';

// Share the application file list and metadata with the Windows build.
const { build } = require('./package.json');
const signing = require('./scripts/macos-signing.cjs');
// Local test distribution uses the same persistent certificate on every build.
// Developer ID is optional and must be selected explicitly; neither mode falls
// back to an unsigned/ad-hoc build when its configured identity is unavailable.
const mode = process.env.BEING_SIGNING_MODE || 'local';
if (!['local', 'local-test', 'developer-id'].includes(mode)) throw new Error('Unknown BEING_SIGNING_MODE');
const local = mode !== 'developer-id';
const selected = local ? signing.identity() : signing.developerIdentity();

module.exports = {
  ...build,
  npmRebuild: true,
  forceCodeSigning: !local,
  ...(local ? {afterPack: signing.afterPack, afterSign: signing.afterSign} : {afterSign: signing.verifyDeveloper}),
  directories: { ...build.directories, output: mode === 'local-test' ? 'dist/macos/experimental-local-signing' : 'dist/macos' },
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.productivity',
    icon: 'renderer/assets/being/being-icon-512.png',
    artifactName: 'Being-Desktop-${version}-mac-${arch}.${ext}',
    identity: local ? null : selected.sha1,
    hardenedRuntime: false,
    notarize: false,
  },
};
