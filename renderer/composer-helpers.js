'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.beingComposerHelpers = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
function tokenAtCaret(text, start, end = start) {
  if (typeof text !== 'string' || !Number.isInteger(start) || start < 0 || start > text.length || start !== end) return null;
  const match = /(^|\s)([/@])([^\s/@]{0,200})$/u.exec(text.slice(0, start));
  if (!match) return null;
  const remaining = /^[^\s/@]*/u.exec(text.slice(start))[0];
  return {kind:match[2] === '/' ? 'kit' : 'member', prefix:match[2], query:match[3], start:start - match[3].length - 1, end:start + remaining.length};
}

function composerSuggestions(data, token) {
  if (!token) return [];
  const query = token.query.toLocaleLowerCase();
  const source = token.kind === 'kit' ? data.kits : data.members;
  return source.filter(item => `${item.name} ${item.handle} ${item.id} ${item.description}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(!a.handle.toLocaleLowerCase().startsWith(query)) - Number(!b.handle.toLocaleLowerCase().startsWith(query)))
    .slice(0, 12);
}

function replaceComposerToken(text, token, item) {
  const inserted = `${token.prefix}${item.handle}`;
  const suffix = text.slice(token.end);
  const separator = /^\s/u.test(suffix) ? '' : ' ';
  return {text:text.slice(0, token.start) + inserted + separator + suffix, caret:token.start + inserted.length + (separator ? 1 : 0)};
}

function composerReferences(text, items, prefix) {
  return items.filter(item => {
    const marker = prefix + item.handle;
    let cursor = 0;
    while ((cursor = text.indexOf(marker, cursor)) !== -1) {
      const before = cursor === 0 || /\s/u.test(text[cursor - 1]);
      const after = text[cursor + marker.length];
      if (before && (!after || /[\s.,!?;:，。！？；：、)\]}]/u.test(after))) return true;
      cursor += marker.length;
    }
    return false;
  });
}

function buildKitPrompt(text, kits) {
  const referenced = composerReferences(text, kits, '/');
  if (!referenced.length) return text;
  const instructions = [];
  const builtin = referenced.filter(item => item.builtin);
  if (builtin.length) {
    const abilities = builtin.map(item => item.builtin === 'search' ? '网络搜索（Search），搜索互联网并读取相关网页正文' : '网页读取（Browse），读取指定公开网页，必要时使用 JavaScript 渲染，不控制本机浏览器');
    instructions.push(`请使用 Being 的内置能力完成我的请求：${abilities.join('；')}。如果缺少搜索主题或网页地址，请先询问我；如果能力不可用，请说明原因。`);
  }
  const remote = referenced.filter(item => !item.builtin);
  if (remote.length) {
    const names = remote.map(item => `「${item.name}」（Kit ID: ${item.id}）`).join('、');
    instructions.push(`请使用以下 Kit 完成我的请求：${names}。先检查 Kit 是否已经可用，再调用其中适合本次请求的工具；如果尚不可用，请说明缺少的配置，不要自动安装或登记。`);
  }
  return `${instructions.join('\n')}\n\n${text}`;
}

return {tokenAtCaret, composerSuggestions, replaceComposerToken, composerReferences, buildKitPrompt};
});
