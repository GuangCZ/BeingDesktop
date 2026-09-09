'use strict';

// Serialized into the page world. Message headers, not transport connections, own routing.
function createSessionRouter({key, ownId, sessions, receive}) {
  const prefix = key + ':reply:';
  const header = /^会话id[：:]\s*([0-9a-f-]{36})\r?\n(?:请求id[：:]\s*([0-9a-f-]{36})\r?\n)?/i;
  const seen = new Set();
  const previews = new Map();
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(key + ':routing') : null;
  if (channel) {
    channel.onmessage = event => {
      const item=event.data;
      if(item?.partial===true && item.session_id===ownId && typeof item.delivery_id==='string' && typeof item.content==='string') receive(item);
    };
    window.addEventListener('pagehide',()=>channel.close(),{once:true});
  }
  function messages() {
    const result = [];
    for (let index = 0; index < localStorage.length; index++) {
      const name = localStorage.key(index);
      if (!name?.startsWith(prefix)) continue;
      try {
        const item = JSON.parse(localStorage.getItem(name));
        if (item.session_id === ownId) result.push(item);
      } catch { /* Ignore incomplete or obsolete inbox entries. */ }
    }
    return result.sort((a,b) => a.at.localeCompare(b.at) || a.route_id.localeCompare(b.route_id));
  }
  function drain() {
    for (const item of messages()) if (!seen.has(item.route_id)) {
      if (receive(item) !== false) seen.add(item.route_id);
    }
  }
  if (typeof window.addEventListener === 'function') window.addEventListener('storage', event => {
    if (event.key?.startsWith(prefix)) drain();
  });
  return {
    messages, drain,
    preview(text, deliveryId) {
      const match=header.exec(text.trimStart());
      if(!match || !sessions().some(item=>item.id===match[1]))return;
      const body=text.trimStart().slice(match[0].length);
      // A split request-ID line is protocol metadata, never visible reply content.
      if(!body.trim() || /^请求id/i.test(body) || '请求id：'.startsWith(body))return;
      const now=Date.now();
      if(previews.has(deliveryId) && now-previews.get(deliveryId)<50)return;
      previews.set(deliveryId,now);
      const item={session_id:match[1],request_id:match[2] || '',delivery_id:deliveryId,partial:true,role:'being',content:body,at:new Date().toISOString()};
      if(item.session_id===ownId)receive(item);
      channel?.postMessage(item);
    },
    prompt(requestId) {
      return `会话id：${ownId}\n请求id：${requestId}\n这是 Be Desktop 的会话路由要求。你每条对用户的回复都必须以以下两行原样开头，然后换行输出回复正文；不要放进代码块，不要省略或沿用其他请求的 ID：\n会话id：${ownId}\n请求id：${requestId}\n仅回答本请求的用户消息。工具任务的专用协议与回执应保持独立，不得混入会话回复。\n\n`;
    },
    async route(text, {report = false, deliveryId = ''} = {}) {
      previews.delete(deliveryId);
      if (typeof text !== 'string' || !text.trim()) return false;
      const match = header.exec(text.trimStart());
      const body = match ? text.trimStart().slice(match[0].length).trim() : '';
      const known = match && sessions().some(item => item.id === match[1]);
      const task = /^\[Being Desktop Town sync:/.test(text.trim()) || /"protocol"\s*:\s*"(?:being-town-agent-read|being-desktop-channel-result)\//.test(text);
      if (!known || !body || task) {
        if (report && !task) {
          // A separate diagnostic slot never becomes a chat bubble.
          localStorage.setItem(key + ':unrouted', JSON.stringify({at:new Date().toISOString(), reason:match ? 'unknown-session' : 'missing-session', content:text}));
        }
        return false;
      }
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([match[1],match[2] || '',body])));
      const routeId = [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
      const name = prefix + routeId;
      if (!localStorage.getItem(name)) localStorage.setItem(name, JSON.stringify({route_id:routeId, request_id:match[2] || '', delivery_id:deliveryId, session_id:match[1], role:'being', content:body, at:new Date().toISOString()}));
      drain();
      return true;
    }
  };
}

module.exports = {createSessionRouter};
