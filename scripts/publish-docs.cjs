'use strict';
const {execFileSync} = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const git = (...args) => execFileSync('git', args, {cwd:root, encoding:'utf8'}).trim();
if (path.resolve(git('rev-parse', '--show-toplevel')).toLowerCase() !== root.toLowerCase()) {
  throw new Error('Run this command in the independent BeingDesktop repository, not its parent checkout.');
}
if (git('branch', '--show-current') !== 'main') throw new Error('Publish documentation from main.');
for (const script of ['build-docs.cjs', 'check-docs.cjs']) execFileSync(process.execPath, [path.join(__dirname, script)], {cwd:root, stdio:'inherit'});
if (git('status', '--porcelain', '--', 'docs')) throw new Error('Commit the generated documentation before publishing.');
git('fetch', 'origin', 'gh-pages');
const tree = git('rev-parse', 'HEAD:docs');
const parent = git('rev-parse', 'FETCH_HEAD');
if (tree === git('rev-parse', `${parent}^{tree}`)) {console.log('Documentation is already current.'); process.exit(0);}
const commit = git('commit-tree', tree, '-p', parent, '-m', 'Publish updated Being Desktop documentation');
git('push', 'origin', `${commit}:refs/heads/gh-pages`);
console.log('Documentation pushed. Check the GitHub Pages deployment before sharing the updated site.');
