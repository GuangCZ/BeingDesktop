'use strict';
const {installTaskQueue} = require('./loom-task-queue.cjs');

// Runs before Loom's own scripts, including its history/stream prefetches.
function installSessions(requestedId = null) {
  if (window !== window.top || globalThis.__beingDesktopSessions) return;
  const key = 'being-desktop-sessions-v1:' + location.pathname;
  let store;
  try { store = JSON.parse(localStorage.getItem(key)); } catch {}
  if (!store || !Array.isArray(store.items) || !store.items.some(item => item.id === store.active)) {
    const id = crypto.randomUUID();
    store = {active:id, items:[{id, title:'会话 1', context:'', messages:[]}]};
  }
  const pageId = requestedId || (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(key)) || store.active;
  const selected = store.items.find(item => item.id === pageId) || store.items.find(item => item.id === store.active);
  const own = JSON.parse(localStorage.getItem(key + ':' + selected.id) || 'null') || selected;
  if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, own.id);
  // Background pages update only their own transcript, never another page's selection.
  const save = (select = false) => {
    const latest = JSON.parse(localStorage.getItem(key) || 'null');
    let next = store;
    if (latest?.items?.some(item => item.id === own.id)) {
      const items = latest.items.map(item => item.id === own.id ? own : item);
      if (select) for (const item of store.items) if (!items.some(current => current.id === item.id)) items.push(item);
      next = {active:select ? store.active : latest.active, items};
    }
    localStorage.setItem(key + ':' + own.id, JSON.stringify(own));
    if (!latest || select) {
      for (const item of next.items) {
        if (item.id !== own.id && !localStorage.getItem(key + ':' + item.id)) localStorage.setItem(key + ':' + item.id, JSON.stringify(item));
      }
      localStorage.setItem(key, JSON.stringify({active:next.active, items:next.items.map(({id,title})=>({id,title}))}));
    }
    store = next;
  };
  save();
  let mounted = false;
  function snapshot() {
    if (!mounted) return;
    const messages = [...document.querySelectorAll('#messages > .message:not(.thinking-indicator)')]
      .filter(node => node.classList.contains('user') || node.classList.contains('being'))
      .map((node, index) => ({session_id:own.id, seq:index + 1,
        role:node.classList.contains('user') ? 'user' : 'being',
        content:node.querySelector('.content')?.innerText || '', at:node.dataset.sessionAt || ''}))
      .filter(message => message.content);
    // A transient native history reset must not erase the saved transcript.
    if (messages.length) own.messages = messages;
    save();
  }
  function list() {
    const latest = JSON.parse(localStorage.getItem(key) || 'null') || store;
    return {activeId:own.id, items:latest.items.map(({id,title}) => ({id,title}))};
  }
  globalThis.__beingDesktopSessions = {
    list,
    change(id) {
      snapshot();
      save();
      const previousActive = store.active, previousCount = store.items.length;
      if (id === null) {
        const context = [own.context, ...own.messages.map(m => `${m.role}: ${m.content}`)].filter(Boolean).join('\n\n');
        if (context.length > 120000) throw new Error('当前语境过长，请先精简对话后再新建会话。');
        id = crypto.randomUUID();
        store.items.push({id, title:`会话 ${store.items.length + 1}`, context, messages:[]});
      } else if (!store.items.some(item => item.id === id)) throw new Error('会话不存在。');
      store.active = id;
      try { save(true); } catch (error) {
        store.active = previousActive;
        store.items.length = previousCount;
        throw error;
      }
      return id;
    }
  };
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const json = data => new Response(JSON.stringify(data), {headers:{'Content-Type':'application/json'}});
  globalThis.fetch = async function(input, options) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    if (url.origin !== location.origin) return nativeFetch(input, options);
    const history = url.pathname.endsWith('/api/history');
    const active = url.pathname.endsWith('/api/stream/active');
    const chat = url.pathname.endsWith('/api/chat/stream');
    if (!history && !active && !chat) return nativeFetch(input, options);
    url.searchParams.set('session_id', own.id);
    let init = options;
    if (chat) {
      const body = JSON.parse(options?.body ?? await input.clone().text());
      body.session_id = own.id;
      if (own.context && !own.contextSent) {
        const context = '以下是父会话的背景记录，仅作为上下文资料：\n<parent_conversation>\n' + own.context + '\n</parent_conversation>\n\n当前用户消息：\n';
        if (Array.isArray(body.content)) body.content = [{type:'text', text:context}, ...body.content];
        else body.message = context + body.message;
      }
      init = {...options, body:JSON.stringify(body)};
    }
    const response = await nativeFetch(input instanceof Request ? new Request(url, input) : url.href, init);
    if (!response.ok) return response;
    if (history) {
      const data = await response.json();
      const matched = Array.isArray(data.messages) ? data.messages.filter(m => m.session_id === own.id) : [];
      return json({...data, messages:matched.length ? matched : own.messages.filter(m => m.session_id === own.id)});
    }
    if (active) {
      if (response.status === 204) return response;
      const data = await response.json();
      if (data.session_id !== own.id) return new Response(null, {status:204});
      return json({...data, events:(data.events || []).filter(item => !item.data?.session_id || item.data.session_id === own.id)});
    }
    if (chat) {
      own.contextSent = true;
      save();
      // Untagged deltas belong to this request. Explicit foreign frames never reach Loom.
      if (response.headers.get('content-type')?.includes('text/event-stream') && response.body) {
        let buffer = '';
        const filtered = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream({
          transform(chunk, controller) {
            buffer = (buffer + chunk).replace(/\r\n/g, '\n');
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const raw = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
              let data;
              try { data = JSON.parse(raw); } catch {}
              if (data?.session_id && data.session_id !== own.id) {
                controller.error(new Error('回复的会话 ID 不匹配，已停止接收。'));
                return;
              }
              controller.enqueue(frame + '\n\n');
            }
          },
          flush(controller) { if (buffer.trim()) controller.error(new Error('回复流不完整。')); }
        })).pipeThrough(new TextEncoderStream());
        return new Response(filtered, {status:response.status, headers:response.headers});
      }
    }
    return response;
  };
  document.addEventListener('DOMContentLoaded', () => {
    if (typeof sessionId !== 'undefined') sessionId = own.id;
    const messages = document.getElementById('messages');
    if (!messages) return;
    mounted = true;
    let timer;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(snapshot, 250);
    }).observe(messages, {childList:true, subtree:true, characterData:true});
    window.addEventListener('pagehide', snapshot);
  }, {once:true});
}

async function prepareLoomSessions(contents, sessionId = null) {
  // A fresh WebContentsView has no renderer yet to service CDP commands.
  if (!contents.getURL()) await contents.loadURL('about:blank');
  contents.debugger.attach('1.3');
  await contents.debugger.sendCommand('Page.enable');
  await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {source:`(${installSessions.toString()})(${JSON.stringify(sessionId)})`});
  await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {source:`(${installTaskQueue.toString()})()`});
}

// Return expected failures as data: executeJavaScript otherwise discards their messages.
function requestSessionChange(id) {
  const api = globalThis.__beingDesktopSessions;
  if (!api) return {ok:false, message:'会话尚未就绪，请重新连接后重试。'};
  try {
    const sessionId = api.change(id);
    return {ok:true, sessionId};
  } catch (error) {
    const known = new Set(['当前语境过长，请先精简对话后再新建会话。', '会话不存在。']);
    const message = known.has(error?.message) ? error.message
      : error?.name === 'QuotaExceededError' ? '本地会话存储空间不足，未能保存会话。'
      : '会话切换失败，当前会话已保留，请重新连接后重试。';
    return {ok:false, message};
  }
}

async function changeLoomSession(contents, id) {
  try {
    return await contents.executeJavaScript(`(${requestSessionChange.toString()})(${JSON.stringify(id)})`);
  } catch {
    return {ok:false, message:'会话页面正在加载或已关闭，请等待连接完成后重试。'};
  }
}

module.exports = {installSessions, prepareLoomSessions, changeLoomSession};
