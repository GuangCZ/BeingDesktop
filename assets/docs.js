'use strict';
const dialog = document.querySelector('#search-dialog');
const input = document.querySelector('#search-input');
const results = document.querySelector('#search-results');
const status = document.querySelector('#search-status');
const trigger = document.querySelector('#open-search');
let returnFocus;
function renderSearch() {
  const query = input.value.trim().toLocaleLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  const matches = (window.BEING_DOCS_INDEX || []).filter(page => terms.every(term => `${page.title} ${page.description} ${page.text}`.toLocaleLowerCase().includes(term)));
  results.replaceChildren();
  status.textContent = query ? `${matches.length} 个结果` : '浏览文档';
  if (!matches.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '没有找到相关文档，试试“连接”或“Portal”。';
    results.append(empty);
  }
  for (const page of matches) {
    const link = document.createElement('a');
    link.href = page.url;
    const title = document.createElement('strong');
    title.textContent = page.title;
    const description = document.createElement('span');
    description.textContent = page.description;
    link.append(title, description);
    results.append(link);
  }
}
function openSearch() {
  if (dialog.open) return;
  returnFocus = document.activeElement;
  dialog.showModal();
  input.value = '';
  renderSearch();
  input.focus();
}
trigger.addEventListener('click', openSearch);
document.querySelector('#close-search').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => returnFocus?.focus());
dialog.addEventListener('click', event => {if (event.target === dialog && (event.offsetX < 0 || event.offsetY < 0 || event.offsetX > dialog.clientWidth || event.offsetY > dialog.clientHeight)) dialog.close();});
input.addEventListener('input', renderSearch);
dialog.addEventListener('keydown', event => {
  const links = [...results.querySelectorAll('a')];
  const index = links.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' && links.length) {event.preventDefault(); links[(index + 1) % links.length].focus();}
  if (event.key === 'ArrowUp' && links.length) {event.preventDefault(); if (index <= 0) input.focus(); else links[index - 1].focus();}
  if (event.key === 'Enter' && document.activeElement === input && links[0]) links[0].click();
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {event.preventDefault(); openSearch();}
  if (event.key === 'Escape') setMenu(false);
});
const menu = document.querySelector('#menu');
function setMenu(open) {
  document.body.classList.toggle('menu-open', open);
  menu.setAttribute('aria-expanded', String(open));
  menu.setAttribute('aria-label', open ? '关闭目录' : '打开目录');
}
menu.addEventListener('click', () => setMenu(menu.getAttribute('aria-expanded') !== 'true'));
document.querySelector('main').addEventListener('click', () => setMenu(false));
document.querySelector('#theme').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {localStorage.setItem('being-docs-theme', next);} catch {}
});
for (const pre of document.querySelectorAll('pre')) {
  const button = document.createElement('button');
  button.className = 'copy';
  button.textContent = '复制';
  button.setAttribute('aria-label', '复制代码');
  button.addEventListener('click', async () => {
    try {await navigator.clipboard.writeText(pre.querySelector('code').textContent); button.textContent = '已复制';}
    catch {button.textContent = '请选择代码复制';}
    setTimeout(() => {button.textContent = '复制';}, 1800);
  });
  pre.append(button);
}
