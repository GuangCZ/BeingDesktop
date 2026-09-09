'use strict';
const path = require('node:path');

function desktopPlatform(platform = process.platform, arch = process.arch) {
  return {
    platform, arch,
    name: {win32: 'Windows', darwin: 'macOS', linux: 'Linux'}[platform] || platform,
    shell: platform === 'darwin' ? 'zsh' : 'PowerShell',
    terminalSupported: ['win32', 'darwin'].includes(platform),
    portalSupported: (platform === 'win32' && arch === 'x64') || (platform === 'darwin' && ['arm64', 'x64'].includes(arch)),
  };
}

// Finder-launched applications do not inherit a terminal's Homebrew PATH.
// Add known locations without evaluating a login shell or loading shell secrets.
function desktopEnvironment(source = process.env, platform = process.platform) {
  const env = {...source};
  if (platform !== 'darwin') return env;
  const dirs = (env.PATH || '').split(':').filter(value => path.posix.isAbsolute(value) && !/[\0\r\n]/.test(value));
  dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  if (env.HOME && path.posix.isAbsolute(env.HOME) && !/[\0\r\n]/.test(env.HOME)) {
    dirs.push(path.posix.join(env.HOME, '.local/bin'), path.posix.join(env.HOME, '.cargo/bin'));
  }
  env.PATH = [...new Set(dirs)].join(':');
  return env;
}

function shellPath(platform = process.platform, environment = process.env) {
  return platform === 'darwin' ? '/bin/zsh'
    : path.win32.join(environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

module.exports = {desktopPlatform, desktopEnvironment, shellPath};
