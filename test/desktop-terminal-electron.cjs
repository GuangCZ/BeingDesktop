'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const argumentsForFixture = process.argv.slice(2);
if (argumentsForFixture.some(value => value !== '--archive') || argumentsForFixture.length > 1) throw new Error('Supported fixture option: --archive');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(__dirname, 'desktop-terminal-integration.cjs'), ...argumentsForFixture], {
  cwd: path.resolve(__dirname, '..'), env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('error', error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal || code === null ? 1 : code; });
