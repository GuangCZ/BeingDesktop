'use strict';

// Share the application file list and metadata with the Windows build.
const { build } = require('./package.json');

module.exports = {
  ...build,
  npmRebuild: true,
  directories: { ...build.directories, output: 'dist/macos' },
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.productivity',
    icon: 'renderer/assets/being/being-icon-512.png',
    artifactName: 'Being-Desktop-${version}-mac-${arch}.${ext}',
    // Local ad-hoc signing requires no Developer ID certificate.
    identity: '-',
    hardenedRuntime: false,
    notarize: false,
  },
};
