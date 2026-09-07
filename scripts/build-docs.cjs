'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'docs');
const pages = JSON.parse(fs.readFileSync(path.join(out, 'content_CN.json'), 'utf8'));
const version = require('../package.json').version;
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const groups = [...new Set(pages.map(page => page.group))];
const base = 'https://GuangCZ.github.io/BeingDesktop/';
fs.mkdirSync(path.join(out, 'assets'), {recursive:true});
fs.copyFileSync(path.join(root, 'renderer/assets/being/being-icon-64.png'), path.join(out, 'assets/being.png'));
for (const [index, page] of pages.entries()) {
  const nav = groups.map(group => `<div class="nav-group"><div class="nav-label">${group}</div>${pages.filter(item => item.group === group).map(item => `<a href="${item.id}.html"${item.id === page.id ? ' aria-current="page"' : ''}>${item.title}</a>`).join('')}</div>`).join('');
  const sections = page.sections.map((section, i) => `<section aria-labelledby="section-${i}"><h2 id="section-${i}">${section.title}</h2>${section.html}</section>`).join('\n');
  const toc = page.sections.map((section, i) => `<a href="#section-${i}">${section.title}</a>`).join('');
  const adjacent = [pages[index - 1], pages[index + 1]].map((item, i) => item ? `<a href="${item.id}.html"><small>${i ? '下一页 →' : '← 上一页'}</small><b>${item.title}</b></a>` : '<span></span>').join('');
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(page.title)} · Being Desktop 文档</title><meta name="description" content="${escape(page.description)}"><link rel="canonical" href="${base}${page.id === 'index' ? '' : page.id + '.html'}"><link rel="icon" href="assets/being.png"><link rel="stylesheet" href="assets/docs.css"><script src="assets/theme.js"></script><script src="assets/search-index.js" defer></script><script src="assets/docs.js" defer></script></head>
<body><a class="skip" href="#content">跳到正文</a><header><a class="brand" href="index.html"><img src="assets/being.png" width="28" height="28" alt=""><strong>Being Desktop</strong><span>文档</span></a><div class="header-actions"><a href="https://github.com/GuangCZ/BeingDesktop">GitHub ↗</a><button id="theme" aria-label="切换深浅主题" title="切换深浅主题">◐</button><button id="menu" aria-label="打开目录" aria-expanded="false" aria-controls="sidebar">☰</button></div></header>
<div class="layout"><aside id="sidebar"><button class="search-trigger" id="open-search"><span>⌕ 搜索文档</span><kbd>Ctrl K</kbd></button><nav aria-label="文档目录">${nav}</nav><div class="sidebar-footer">Windows x64 <span>v${version}</span></div></aside><main id="content" tabindex="-1"><div class="eyebrow">${page.group}</div><h1>${page.title}</h1><p class="lead">${page.description}</p>${sections}<nav class="adjacent" aria-label="相邻页面">${adjacent}</nav><footer>Being Desktop · v${version}<a href="https://github.com/GuangCZ/BeingDesktop/issues">反馈问题 ↗</a></footer></main><aside class="toc"><div>本页内容</div><nav aria-label="本页目录">${toc}</nav></aside></div>
<dialog id="search-dialog" aria-labelledby="search-label"><div class="search-heading"><label id="search-label" for="search-input">搜索文档</label><button id="close-search" aria-label="关闭搜索">Esc</button></div><input id="search-input" type="search" placeholder="搜索功能、设置或问题…" autocomplete="off"><p id="search-status" role="status"></p><div id="search-results"></div></dialog></body></html>`;
  fs.writeFileSync(path.join(out, `${page.id}.html`), html);
}
const search = pages.map(page => ({title:page.title, url:`${page.id}.html`, description:page.description, text:page.sections.map(section => `${section.title} ${section.html.replace(/<[^>]*>/g,' ')}`).join(' ')}));
fs.writeFileSync(path.join(out, 'assets/search-index.js'), `window.BEING_DOCS_INDEX=${JSON.stringify(search).replace(/</g, '\\u003c')};\n`);
fs.writeFileSync(path.join(out, '.nojekyll'), '');
fs.writeFileSync(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(page => `<url><loc>${base}${page.id === 'index' ? '' : page.id + '.html'}</loc></url>`).join('')}</urlset>`);
fs.writeFileSync(path.join(out, '404.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>页面不存在 · Being Desktop</title><style>body{font:18px system-ui;max-width:600px;margin:15vh auto;padding:24px}a{color:inherit}</style><h1>页面不存在</h1><p>链接可能已经更新。</p><a href="/BeingDesktop/">返回 Being Desktop 文档 →</a></html>');
console.log(`Built ${pages.length} documentation pages.`);
