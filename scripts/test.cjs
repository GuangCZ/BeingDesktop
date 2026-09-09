'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname,'..');
const env = {...process.env};
// macOS exposes /var through a symlink. These tests deliberately reject linked
// workspace ancestors, so give fixtures the canonical system temporary path.
if (process.platform === 'darwin') env.TMPDIR = fs.realpathSync(os.tmpdir());
const files = fs.readdirSync(path.join(root,'test')).filter(file=>file.endsWith('.test.cjs')).sort().map(file=>path.join('test',file));
const child = spawn(process.execPath,['--test',...files],{cwd:root,env,stdio:'inherit'});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});
child.once('exit',(code)=>{process.exitCode=code ?? 1;});
