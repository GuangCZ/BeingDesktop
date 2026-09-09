'use strict';

// Runs in Loom's page world. Keep received process data outside chat messages.
function createEventHistory({key, ownId, messages, presentError=value=>value}) {
  const prefix = key + ':events:' + ownId + ':';
  const groups = new Map(), dirty = new Set(), nodes = new Map();
  let container, observer, scheduled = false, timer, storageError = false;
  for (let index = 0; index < localStorage.length; index++) {
    const name = localStorage.key(index);
    if (!name?.startsWith(prefix)) continue;
    try {
      const group = JSON.parse(localStorage.getItem(name));
      if (group?.id && Array.isArray(group.entries)) groups.set(group.id, group);
    } catch {}
  }
  function flush() {
    clearTimeout(timer); timer=null;
    for (const id of dirty) {
      try {
        localStorage.setItem(prefix + id, JSON.stringify(groups.get(id)));
        dirty.delete(id);
      } catch { storageError = true; schedule(); return; }
    }
    if (storageError) { storageError = false; schedule(); }
  }
  function text(value) {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
  }
  function duration(group) {
    if (group.finished && !group.endedAt) return '';
    // A quarantined response can deliver its first error only after a long wait.
    // Without a known request start, a first-event timestamp is not a duration.
    if (!group.startedAt && group.entries.every(entry=>entry.event==='error')) return '';
    const seconds = Math.max(0, Math.floor(((group.endedAt || Date.now()) - Date.parse(group.at)) / 1000));
    if (!Number.isFinite(seconds)) return '';
    return seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
  }
  function rows(group) {
    const result = [];
    for (const entry of group.entries) {
      const {event} = entry;
      const data=event==='error'&&entry.data?.message?{...entry.data,message:presentError(entry.data.message)}:entry.data;
      if (['message_start', 'message_stop', 'content_block_start', 'content_block_stop', 'ping'].includes(event) && !Object.keys(data || {}).length) continue;
      if (event === 'thinking' || event === 'reasoning') {
        const value = typeof data?.text === 'string' ? data.text : text(data);
        const previous = result.at(-1);
        if (previous?.event === event) previous.body += value;
        else result.push({seq:entry.seq, event, title:event === 'thinking' ? '思考' : '推理', body:value});
        const extra = {...data}; delete extra.text;
        if (typeof data?.text === 'string' && Object.keys(extra).length) result.push({seq:entry.seq + ':data', event:'data', title:'附加信息', body:text(extra)});
      } else {
        const labels = {tool_use:'工具调用', tool_result:'工具返回', error:'错误', usage:'用量', message_start:'开始回复', message_stop:'回复完成', content_block_start:'内容开始', content_block_stop:'内容结束'};
        const label = event === 'tool_result' && data?.summary !== undefined && data?.output === undefined && data?.result === undefined && data?.content === undefined ? '工具返回（服务端摘要）' : labels[event] || event;
        const body=text(data);
        if(event==='error'&&result.at(-1)?.event==='error'&&result.at(-1).body===body)continue;
        result.push({seq:entry.seq, event, title:label + (data?.name ? ' · ' + data.name : ''), body});
      }
    }
    const calls = [];
    const dataBySeq = new Map(group.entries.map(entry => [entry.seq, entry.data]));
    return result.filter(entry => {
      const data = dataBySeq.get(entry.seq);
      if (entry.event === 'tool_use') {
        entry.data = data;
        entry.status = group.finished ? 'unknown' : 'running';
        let input = data?.input || data?.arguments || data?.args || {};
        if (typeof input === 'string') {
          try { input = JSON.parse(input); } catch { input = {command:input}; }
        }
        input ||= {};
        const detail = input.command || input.cmd || input.file_path || input.path || input.query || input.url;
        entry.title = (data?.name || '工具调用') + (detail ? ' · ' + text(detail).replace(/\s+/g, ' ').slice(0, 180) : '');
        calls.push(entry);
      } else if (entry.event === 'tool_result') {
        const id = data?.tool_use_id || data?.tool_call_id || data?.call_id || data?.id;
        const candidates = calls.filter(item => !item.result && (id ? [item.data?.id, item.data?.call_id, item.data?.tool_call_id].includes(id) : data?.name ? item.data?.name === data.name : !item.data?.id && !item.data?.call_id && !item.data?.tool_call_id));
        // Without an identifier, merge only an unambiguous pending call.
        const call = candidates.length === 1 ? candidates[0] : null;
        if (call) {
          call.result = entry;
          call.status = data?.is_error || data?.error ? 'error' : 'done';
          return false;
        }
      }
      return true;
    });
  }
  function render() {
    scheduled = false;
    if (!container) return;
    observer.disconnect();
    const following = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    // Match the persisted transcript: native system notices have no saved row.
    const transcript = [...container.querySelectorAll(':scope > .message:not(.thinking-indicator)')]
      .filter(row => row.classList.contains('user') || row.classList.contains('being'));
    const saved = messages();
    for (const group of [...groups.values()].sort((a,b)=>a.at.localeCompare(b.at) || a.startSeq-b.startSeq)) {
      const entries = rows(group);
      if (!entries.length) continue;
      let node = nodes.get(group.id);
      if (!node) {
        node = document.createElement('details');
        node.className = 'desktop-process'; node.dataset.deliveryId = group.id;
        node.open = !group.finished;
        const heading = document.createElement('summary'); heading.className = 'desktop-process-heading';
        const body = document.createElement('div'); body.className = 'desktop-process-body';
        node.append(heading, body); nodes.set(group.id, node);
      }
      if (group.finished && node.dataset.finished === 'false') node.open = false;
      node.dataset.finished = String(group.finished);
      const toolCount = entries.filter(entry => entry.event === 'tool_use').length;
      const title = (group.finished ? (group.entries.some(entry => entry.event === 'error') ? '处理出错' : '已处理') : '处理中') + (duration(group) ? ' ' + duration(group) : '')
        + (toolCount ? ` · ${toolCount} 次工具调用` : '') + (storageError ? ' · 本地存储不足，过程暂未保存' : '');
      if (node.firstChild.textContent !== title) node.firstChild.textContent = title;
      const body = node.lastChild;
      const followLog = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
      entries.forEach((entry,index)=>{
        let article = body.children[index];
        if (article && article.dataset.seq !== String(entry.seq)) {
          article.remove();
          article = null;
        }
        if (!article) {
          article = document.createElement('details');
          const label = document.createElement('summary'); label.className = 'desktop-process-label';
          article.append(label,document.createElement('pre')); body.insertBefore(article, body.children[index] || null);
        }
        article.dataset.seq = String(entry.seq);
        article.dataset.event = entry.event;
        article.dataset.status = entry.status || (entry.event === 'error' ? 'error' : '');
        const status = {running:'调用中',done:'已完成',error:'失败',unknown:'已结束'}[entry.status];
        const preview = ['thinking','reasoning'].includes(entry.event) ? ' · ' + entry.body.replace(/\s+/g, ' ').slice(0, 160) : '';
        const label = (status ? status + ' · ' : '') + entry.title + preview;
        if (article.firstChild.textContent !== label) article.firstChild.textContent = label;
        article.firstChild.title = label;
        if (article.children[1].textContent !== entry.body) article.children[1].textContent = entry.body;
        let output = article.querySelector('[data-event="tool_result"]');
        if (entry.result) {
          if (!output) {
            output = document.createElement('div'); output.dataset.event = 'tool_result';
            const label = document.createElement('div'); label.className = 'desktop-process-label';
            output.append(label, document.createElement('pre')); article.append(output);
          }
          output.firstChild.textContent = entry.result.title;
          if (output.lastChild.textContent !== entry.result.body) output.lastChild.textContent = entry.result.body;
        } else output?.remove();
      });
      while (body.children.length > entries.length) body.lastChild.remove();
      if (followLog) body.scrollTop = body.scrollHeight;
      const reply = transcript.find((row,index)=>(row.dataset.deliveryId || saved[index]?.delivery_id) === group.id);
      if (reply) {
        if (node.nextSibling !== reply) container.insertBefore(node,reply);
      } else {
        const requestRows = transcript.filter((row,index)=>group.requestId && (row.dataset.requestId || saved[index]?.request_id) === group.requestId);
        let anchor = requestRows.at(-1);
        if (!anchor) anchor = transcript.find((row,index)=>saved[index]?.at && saved[index].at > group.at)?.previousSibling;
        if (anchor) {
          while (anchor.nextSibling?.classList?.contains('desktop-process') && anchor.nextSibling !== node) anchor = anchor.nextSibling;
          if (anchor.nextSibling !== node) container.insertBefore(node,anchor.nextSibling);
        } else if (node.parentNode !== container) container.append(node);
      }
    }
    observer.observe(container,{childList:true});
    if (following && typeof scrollToBottom === 'function') scrollToBottom();
  }
  function schedule() {
    if (!scheduled) { scheduled = true; requestAnimationFrame(render); }
  }
  function record({deliveryId, streamId, requestId, startedAt, event, data, seq}) {
    // Reply text already appears in its full message; render other delta fields.
    if (event === 'content_block_delta') {
      const delta = {...data?.delta}; delete delta.text; delete delta.type;
      const extra = {...data}; delete extra.delta; delete extra.type; delete extra.index;
      if (!Object.keys(delta).length && !Object.keys(extra).length) return;
      data = {...extra,delta};
    }
    let group = groups.get(deliveryId);
    if (!group) {
      const knownStart=Number.isFinite(Date.parse(startedAt))&&Date.parse(startedAt)<=Date.now()?startedAt:undefined;
      group = {id:deliveryId,streamId,requestId,startedAt:knownStart,at:knownStart||new Date().toISOString(),startSeq:seq,entries:[],finished:false};
      groups.set(deliveryId,group);
    }
    if (requestId) group.requestId = requestId;
    if (!group.entries.some(entry=>entry.seq === seq)) {
      group.entries.push({seq,event,data}); group.entries.sort((a,b)=>a.seq-b.seq);
    }
    if ((event === 'message_stop' || event === 'error') && !group.finished) {
      group.finished = true;
      group.endedAt = Date.now();
    }
    dirty.add(group.id); schedule();
    if (!timer) timer = setTimeout(flush,250);
    if (group.finished) flush();
  }
  document.addEventListener('DOMContentLoaded',()=>{
    container = document.getElementById('messages');
    if (!container) return;
    observer = new MutationObserver(schedule); observer.observe(container,{childList:true});
    schedule(); window.addEventListener('pagehide',flush);
    const ticker = setInterval(() => {
      if ([...groups.values()].some(group => !group.finished)) schedule();
    }, 1000);
    window.addEventListener('pagehide', () => { clearInterval(ticker); observer.disconnect(); }, {once:true});
  },{once:true});
  return {record,flush};
}

module.exports = {createEventHistory};
