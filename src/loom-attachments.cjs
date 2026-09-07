'use strict';

function imageChatBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.hasOwn(body, 'content')
      || !Array.isArray(body.attachments)) return body;
  const images = [], remaining = [];
  for (const attachment of body.attachments) {
    if (attachment && /^image\/(?:png|jpeg|webp|gif)$/i.test(attachment.media_type)
        && typeof attachment.data === 'string' && attachment.data.length
        && /^[A-Za-z0-9+/]*={0,2}$/.test(attachment.data)) {
      images.push({type:'image', media_type:attachment.media_type, data:attachment.data});
    } else remaining.push(attachment);
  }
  if (!images.length) return body;
  const {message, attachments, ...rest} = body;
  return {...rest, content:[...(typeof message === 'string' && message ? [{type:'text', text:message}] : []), ...images],
    ...(remaining.length ? {attachments:remaining} : {})};
}

// Adapt the observed Loom attachment UI and native queue in its own page world.
// No clipboard reader, local paths, credentials or desktop bridge are exposed.
function installAttachments(imageChatBody) {
  if (globalThis.__beingDesktopAttachments) return true;
  const area = document.getElementById('input-area');
  const tray = document.getElementById('pending-files');
  const picker = document.getElementById('file-input');
  const input = document.getElementById('input');
  if (!area || !tray || !picker || !input || typeof pendingFiles === 'undefined'
      || typeof renderPendingFiles !== 'function' || typeof send !== 'function'
      || typeof queueDraft !== 'function' || typeof sendQueue === 'undefined'
      || typeof updateQueueIndicator !== 'function' || typeof handleFiles !== 'function'
      || typeof fetchWithRetry !== 'function' || typeof apiUrl !== 'function') return false;
  const originalRender = renderPendingFiles, originalSend = send;
  const originalAddMessage = typeof addMessage === 'function' ? addMessage : null;
  const originalRequest = fetchWithRetry;
  const chatPath = new URL(apiUrl('/api/chat/stream'), location.href).pathname;
  const queued = new WeakMap();
  let echoFiles = null;
  let statusText = '';
  let reading = 0;
  const hint = document.createElement('div');
  hint.id = 'desktop-attachment-status';
  hint.setAttribute('role', 'status');
  hint.setAttribute('aria-live', 'polite');
  area.append(hint);
  const attach = document.getElementById('desktop-attach');
  if (attach) {
    attach.title = '添加图片或文件 · 支持粘贴截图和拖拽 · 单个文件最大 10 MB';
    attach.setAttribute('aria-label', '添加图片或文件');
  }
  picker.setAttribute('aria-label', '选择图片或文件');
  tray.setAttribute('aria-label', '待发送附件');
  fetchWithRetry = function (url, optionsFactory, ...args) {
    let target;
    try { target = new URL(url, location.href); } catch { return originalRequest.call(this, url, optionsFactory, ...args); }
    if (target.origin !== location.origin || target.pathname !== chatPath || typeof optionsFactory !== 'function') {
      return originalRequest.call(this, url, optionsFactory, ...args);
    }
    return originalRequest.call(this, url, function (...factoryArgs) {
      const options = optionsFactory.apply(this, factoryArgs);
      if (options?.method?.toUpperCase() !== 'POST' || typeof options.body !== 'string') return options;
      let body;
      try { body = JSON.parse(options.body); } catch { return options; }
      // Heart parses multimodal content blocks. Legacy Loom attachments are ignored.
      // Convert each retry's own body so image bytes and text remain together.
      const converted = imageChatBody(body);
      return converted === body ? options : {...options, body:JSON.stringify(converted)};
    }, ...args);
  };
  function imagePreview(file, className) {
    if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(file.type) || typeof file.base64 !== 'string'
        || file.base64.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) return null;
    const image = document.createElement('img');
    image.className = className;
    image.alt = typeof file.name === 'string' ? file.name : '图片附件';
    image.src = `data:${file.type};base64,${file.base64}`;
    image.addEventListener('error', () => {image.remove();}, {once:true});
    return image;
  }
  if (originalAddMessage) {
    addMessage = function (role, ...args) {
      const content = originalAddMessage(role, ...args);
      if (role !== 'user' || !echoFiles || !content) return content;
      const files = echoFiles;
      echoFiles = null;
      const attachments = document.createElement('div');
      attachments.className = 'desktop-message-attachments';
      attachments.setAttribute('aria-label', '本条消息的附件');
      for (const file of files) {
        const card = document.createElement('div');
        card.className = 'desktop-message-attachment';
        const preview = imagePreview(file, 'desktop-message-image');
        if (preview) card.append(preview);
        const name = document.createElement('span');
        name.textContent = typeof file.name === 'string' ? file.name : '附件';
        card.append(name);
        attachments.append(card);
      }
      content.append(attachments);
      return content;
    };
  }
  function queuedNotice() {
    hint.replaceChildren();
    if (statusText) hint.append(document.createTextNode(statusText));
    if (reading) hint.append(document.createTextNode(`正在准备 ${reading} 个附件…`));
    for (const item of sendQueue.filter(item => queued.has(item.files))) {
      const row = document.createElement('div');
      row.className = 'desktop-attachment-queued';
      const label = document.createElement('span');
      label.textContent = `${item.files.length} 个附件待发送 · 当前回复结束后发送`;
      const cancel = document.createElement('button'); cancel.type = 'button';
      cancel.textContent = '取消待发';
      cancel.addEventListener('click', () => {
        const index = sendQueue.indexOf(item);
        if (index >= 0) {sendQueue.splice(index, 1);updateQueueIndicator();queuedNotice();}
      });
      row.append(label, cancel); hint.append(row);
    }
  }
  renderPendingFiles = function () {
    originalRender();
    queuedNotice();
    for (let index = 0; index < pendingFiles.length; index++) {
      const file = pendingFiles[index], card = tray.children[index];
      if (!card || !file) continue;
      const remove = card.querySelector('.remove');
      if (remove) {
        remove.setAttribute('role', 'button'); remove.tabIndex = 0;
        remove.setAttribute('aria-label', `移除附件 ${file.name}`);
        remove.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {event.preventDefault();event.stopPropagation();remove.click();}
        });
      }
      const preview = imagePreview(file, 'desktop-attachment-preview');
      if (preview) {
        card.prepend(preview); card.classList.add('desktop-image-attachment');
      }
    }
  };
  handleFiles = function (fileList) {
    const batchSession = sessionId, batchUrl = location.href;
    const files = Array.from(fileList || []).filter(file => file instanceof File);
    picker.value = '';statusText = '';
    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) {statusText = `${file.name} 超过 10 MB，请选择较小的文件。`;continue;}
      const reader = new FileReader();reading++;
      reader.onload = () => {
        if (location.href !== batchUrl || sessionId !== batchSession) {statusText = '会话已变化，附件未加入新会话。';return;}
        if (typeof reader.result !== 'string' || !reader.result.includes(',')) {statusText = '附件读取失败，请重新添加。';return;}
        pendingFiles.push({name:file.name,type:file.type,size:file.size,base64:reader.result.slice(reader.result.indexOf(',') + 1)});
        renderPendingFiles();
      };
      reader.onerror = () => {statusText = `${file.name} 读取失败，请重新添加。`;};
      reader.onabort = () => {statusText = '附件读取已停止，请重新添加。';};
      reader.onloadend = () => {reading--;queuedNotice();};
      reader.readAsDataURL(file);
    }
    queuedNotice();
  };
  send = async function (text, filesOverride = null, options = {}) {
    if (reading && !Array.isArray(filesOverride)) {statusText = '附件准备完成后即可发送，文字与图片均已保留。';queuedNotice();return;}
    const files = Array.isArray(filesOverride) ? filesOverride : pendingFiles;
    const ownership = queued.get(files);
    if (ownership && (ownership.url !== location.href || ownership.session && ownership.session !== sessionId)) {
      statusText = '会话已变化，旧会话的附件没有发送。请回到原会话重新添加。';queuedNotice();
      return;
    }
    statusText = '';
    if (isStreaming && files.length) {
      // Native spliceSend is text-only and clears attachments. Keep each whole
      // message in Loom's existing queue until its stream completion drains it.
      if (Array.isArray(filesOverride)) {
        sendQueue.push({message: (text || '').trim(), files: [...files]});
        updateQueueIndicator();
      } else {
        if (!queueDraft()) return;
      }
      const entry = sendQueue[sendQueue.length - 1];
      entry.files = entry.files.map(file => ({...file}));
      queued.set(entry.files, {id: crypto.randomUUID(), url: location.href, session: sessionId});
      queuedNotice();
      return;
    }
    // Loom creates its local echo synchronously before the first network await.
    // Decorate that exact message, without implying upstream image acceptance.
    echoFiles = files.length && !options.isManualRetry ? files.map(file => ({...file})) : null;
    try {
      const result = originalSend(text, filesOverride, options);
      queuedNotice();
      return result;
    } finally {
      echoFiles = null;
    }
  };
  const observer = new MutationObserver(queuedNotice);
  observer.observe(input, {attributes: true, attributeFilter: ['class']});
  globalThis.__beingDesktopAttachments = {installed: true};
  renderPendingFiles();
  return true;
}

async function applyLoomAttachments(contents) {
  if (!contents || contents.isDestroyed()) return false;
  return contents.executeJavaScript(`(${installAttachments.toString()})(${imageChatBody.toString()})`);
}

module.exports = {applyLoomAttachments, imageChatBody};
