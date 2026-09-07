'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../docs');
const pages = JSON.parse(fs.readFileSync(path.join(root, 'content_CN.json'), 'utf8'));
let links = 0;
for (const page of pages) {
  const html = fs.readFileSync(path.join(root, `${page.id}.html`), 'utf8');
  assert.match(html, /<html lang="zh-CN">/);
  assert.equal((html.match(/<h1>/g) || []).length, 1);
  for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^(https?:|\/)/.test(href)) continue;
    const [file, anchor] = href.split('#');
    const target = path.resolve(root, file || `${page.id}.html`);
    assert.ok(target.startsWith(root + path.sep), `Path escapes docs: ${href}`);
    assert.ok(fs.existsSync(target), `Missing ${href} in ${page.id}`);
    if (anchor) assert.ok(fs.readFileSync(target, 'utf8').includes(`id="${anchor}"`), `Missing anchor ${href}`);
    links++;
  }
}
assert.ok(fs.existsSync(path.join(root, '.nojekyll')));
console.log(`Documentation verified: ${pages.length} pages, ${links} local links and assets.`);
