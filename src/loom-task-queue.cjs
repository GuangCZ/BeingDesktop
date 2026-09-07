'use strict';

// Runs in Loom's main world before its scripts. Never consumes a second stream.
function installTaskQueue() {
  if (globalThis.__beingDesktopTaskQueue) return;
  const pending = new Map();
  let sequence = 0;
  const preview = value => typeof value === 'string' ? value.slice(0, 4000) : '';
  const storageKey = 'being-desktop-message-tasks-v1:' + location.pathname;
  function save() {
    try { sessionStorage.setItem(storageKey, JSON.stringify([...pending.values()])); } catch { /* Storage failure cannot affect message delivery. */ }
  }
  try {
    const restored = JSON.parse(sessionStorage.getItem(storageKey));
    if (Array.isArray(restored)) for (const value of restored) {
      if (!value || typeof value.id !== 'string' || typeof value.text !== 'string') continue;
      pending.set(value.id, {id:preview(value.id), text:preview(value.text), startedAt:preview(value.startedAt), sessionId:preview(value.sessionId),
        status:value.status === 'accepted' ? 'accepted' : 'interrupted', phase:'awaiting_first', streamId:preview(value.streamId), tool:''});
    }
  } catch { /* A missing or obsolete page ledger starts empty. */ }
  function observe(item, event, data) {
    if (event === 'meta' && typeof data.stream_id === 'string') { item.streamId = preview(data.stream_id); save(); }
    const phases = {thinking:'reasoning', reasoning:'reasoning', tool_use:'tool', tool_result:'working', content_block_delta:'text', message_stop:'continuing', error:'error'};
    if (!Object.hasOwn(phases, event)) return;
    item.phase = phases[event];
    item.status = event === 'error' ? 'error' : 'responding';
    item.tool = event === 'tool_use' ? preview(data.name).slice(0, 160) : '';
    // Do not retain reasoning, tool arguments, results or response text.
  }
  globalThis.__beingDesktopTaskQueue = {
    snapshot() {
      const queueKnown = typeof sendQueue !== 'undefined' && Array.isArray(sendQueue);
      const ownSession = globalThis.__beingDesktopSessions?.list().activeId;
      return {
        pending: [...pending.values()].filter(item => !ownSession || item.sessionId === ownSession).map(item => ({...item})), queueKnown,
        queued: queueKnown ? sendQueue.map((item, index) => ({
          id: `queued-${index}`, text: preview(item.message) || '附件消息',
          attachments: Array.isArray(item.files) ? item.files.length : 0
        })) : []
      };
    }
  };
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async function(input, options) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.endsWith('/api/chat/stream')) return originalFetch(input, options);
    let body;
    try { body = JSON.parse(options?.body ?? await input.clone().text()); } catch { return originalFetch(input, options); }
    const id = `sent-${Date.now()}-${++sequence}`;
    const text = preview(body.message) || preview(Array.isArray(body.content) ? body.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : body.content) || '附件消息';
    const item = {id, text, startedAt: new Date().toISOString(), sessionId: preview(globalThis.__beingDesktopSessions?.list().activeId || body.session_id), status:'sending', phase:'awaiting_first', streamId:'', tool:''};
    pending.set(id, item);
    save();
    const finish = () => { pending.delete(id); save(); };
    try {
      const response = await originalFetch(input, options);
      if (response.status === 202) {
        item.status = 'accepted';
        save();
        return response;
      }
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        finish(); return response;
      }
      item.status = 'waiting';
      const decoder = new TextDecoder();
      let buffer = '';
      function observeChunk(value) {
        buffer += decoder.decode(value, {stream:true});
        let boundary;
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, boundary).replace(/\r$/, '');
          buffer = buffer.slice(boundary + 1);
          if (line.startsWith('event:')) eventType = line.slice(6).trim();
          else if (line.startsWith('data:')) {
            try { const data = JSON.parse(line.slice(5)); if (data && typeof data === 'object') observe(item, eventType, data); } catch { /* Observation never interrupts the response. */ }
          } else if (!line) eventType = '';
        }
        // A malformed or huge event must not create unbounded observer memory.
        if (buffer.length > 1024 * 1024) buffer = '';
      }
      let eventType = '';
      const reader = response.body.getReader();
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const {done, value} = await reader.read();
            if (done) { finish(); controller.close(); }
            else { observeChunk(value); controller.enqueue(value); }
          } catch (error) { item.status = 'interrupted'; save(); controller.error(error); }
        },
        cancel(reason) { finish(); return reader.cancel(reason); }
      });
      return new Response(stream, {status:response.status, statusText:response.statusText, headers:response.headers});
    } catch (error) { finish(); throw error; }
  };
}

module.exports = {installTaskQueue};
