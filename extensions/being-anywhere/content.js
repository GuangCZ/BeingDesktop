(() => {
  "use strict";

  const INSTANCE_KEY = "__beingAnywhereSelectionWidget";
  const MAX_SELECTION = 20000;
  const MAX_PROMPT = 8000;
  const VERSION = chrome.runtime.getManifest().version;
  const logoSrcset = [16, 20, 24, 32, 40, 48, 64, 80, 96, 112, 128, 160, 192, 256]
    .map(size => `${chrome.runtime.getURL(`icons/being-${size}.png`)} ${size}w`).join(', ');
  const existing = globalThis[INSTANCE_KEY];
  if (existing) return;

  const host = document.createElement("div");
  host.setAttribute("data-being-anywhere", "");
  host.style.cssText = "all:initial!important;position:fixed!important;inset:0 auto auto 0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; color-scheme: dark; }
      * { box-sizing: border-box; }
      button, textarea { font: inherit; }
      button { cursor: pointer; }
      button:focus-visible, textarea:focus-visible {
        outline: 2px solid #b4b4b4; outline-offset: 3px;
      }
      [hidden] { display: none !important; }
      .panel {
        position: fixed; pointer-events: auto; width: min(360px, calc(100vw - 16px));
        max-height: calc(100vh - 16px); overflow: hidden; color: #f4f4f4;
        border: 1px solid #414141; border-radius: 17px; background: #242424;
        box-shadow: none;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px; line-height: 1.5; text-align: left;
      }
      .composer { padding: 11px 12px 9px; }
      .prompt-row { display: flex; align-items: flex-start; gap: 10px; }
      .mark {
        display: block; object-fit: contain; mix-blend-mode: screen; width: 29px; height: 30px; flex: 0 0 auto;
        border: 0; border-radius: 0; background: transparent; color: #fff;
        
      }
      .prompt-field { position: relative; flex: 1; min-width: 0; height: 42px; margin-top: 3px; }
      textarea {
        display: block; width: 100%; min-width: 0; height: 42px; resize: none;
        margin: 0; padding: 2px 0; border: 0; border-radius: 3px; overflow: hidden;
        background: transparent; color: #f4f4f4; font-size: 13px; line-height: 19px;
        scrollbar-width: none;
      }
      textarea::-webkit-scrollbar { display: none; }
      textarea::placeholder { color: #aaaaaa; }
      textarea:focus { outline: 0; }
      .prompt-preview {
        position: absolute; inset: 2px 0; display: -webkit-box; -webkit-box-orient: vertical;
        -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; white-space: pre-wrap;
        font-size: 13px; line-height: 19px; pointer-events: none;
      }
      .prompt-field.has-preview textarea { color: transparent; }
      .submit {
        display: grid; place-items: center; flex: 0 0 auto; width: 29px; height: 29px;
        margin-top: 2px; padding: 0; border: 0; border-radius: 50%;
        background: #efefef; color: #222222;
      }
      .submit:hover { background: #fff; }
      .submit:disabled { opacity: .45; cursor: wait; }
      svg { display: block; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
      .toolbar { display: flex; align-items: center; gap: 4px; margin: 6px 0 0 38px; }
      .chips { display: flex; align-items: center; gap: 3px; min-width: 0; }
      .chip {
        display: inline-flex; align-items: center; gap: 4px; padding: 3px 6px;
        border: 0; border-radius: 6px; background: transparent; color: #b7b7b7;
        font-size: 11px; white-space: nowrap;
      }
      .chip svg { width: 13px; height: 13px; }
      .chip:hover { background: #383838; color: #fff; }
      .icon-button {
        display: grid; place-items: center; width: 26px; height: 26px; flex: 0 0 auto;
        padding: 0; border: 0; border-radius: 7px; background: transparent; color: #aaaaaa;
      }
      .icon-button:hover { background: #383838; color: #fff; }
      .compact-close { margin-left: auto; }
      .error { margin: 8px 0 0 38px; color: #dddddd; font-size: 11px; overflow-wrap: anywhere; }
      .header { display: flex; align-items: center; gap: 8px; height: 48px; min-height: 48px; padding: 0 11px 0 14px; border-bottom: 1px solid #393939; }
      .header .mark { width: 27px; height: 27px; }
      .name { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: -.2px; }
      .window-actions { display: flex; align-items: center; gap: 3px; margin-left: auto; }
      .panel.expanded { display: flex; flex-direction: column; width: min(408px, calc(100vw - 16px)); height: min(520px, calc(100vh - 16px)); overflow: hidden; }
      .panel.minimized { height: 49px; }
      .panel.minimized .header { border-bottom: 0; }
      .chat-body { flex: 1; min-height: 0; }
      .chat-loading { display: grid; place-items: center; height: 100%; color: #aaaaaa; font-size: 12px; }
      .conversation-frame { display: block; width: 100%; height: 100%; border: 0; background: #1b1b1b; color-scheme: dark; }
      @media (max-width: 340px) {
        .composer { padding-left: 10px; padding-right: 10px; }
        .prompt-row { gap: 8px; }
        .toolbar, .error { margin-left: 0; }
        .chip { padding-left: 7px; padding-right: 7px; }
      }
      @media (prefers-reduced-motion: no-preference) {
        button { transition: background .12s, color .12s; }
      }
    </style>
    <section class="panel compact" role="dialog" aria-label="BeingAnywhere 快速提问" hidden>
      <div class="composer">
        <div class="prompt-row">
          <img class="mark" src="${chrome.runtime.getURL("icons/being-32.png")}" srcset="${logoSrcset}" sizes="29px" alt="" aria-hidden="true">
          <div class="prompt-field">
            <textarea id="being-prompt" aria-label="向 Being 提问" maxlength="8000" rows="2" placeholder="问问 Being…" spellcheck="false"></textarea>
            <span class="prompt-preview" aria-hidden="true" hidden></span>
          </div>
          <button class="submit" type="button" aria-label="发送问题" title="发送问题 · Enter">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m-5 5 5-5 5 5"/></svg>
          </button>
        </div>
        <div class="toolbar">
          <div class="chips" aria-label="快捷提问">
            <button class="chip" type="button" data-prompt="请用通俗易懂的语言解释这段内容。"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 11.5h5M6 14h4M5 9.5a4.5 4.5 0 1 1 6 0c-.5.5-.5 1-.5 2h-5c0-1 0-1.5-.5-2Z"/></svg>解释</button>
            <button class="chip" type="button" data-prompt="请总结这段内容，提炼关键观点。"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6"/></svg>总结</button>
            <button class="chip" type="button" data-prompt="请将这段内容翻译成简体中文；如果原文已是中文，请翻译成英文。"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h7M5.5 2v2M4 4c0 4 3 6 5 7M8 4c0 3-3 6-6 7m7 3 3-8 3 8m-5-2h4"/></svg>翻译</button>
          </div>
          <button class="chip install-link" type="button" hidden aria-label="安装链接到 Being" title="将选中的 MCP / Skill 链接交给 Being 安装"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 12 4-4m-6 5-1 1a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0m2 1 1-1a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0"/></svg>安装</button>
          <button class="icon-button compact-close" type="button" aria-label="关闭提问条" title="关闭 · Esc"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8"/></svg></button>
        </div>
        <p class="error" role="alert" hidden></p>
      </div>
      <div class="header" hidden>
        <img class="mark" src="${chrome.runtime.getURL("icons/being-32.png")}" srcset="${logoSrcset}" sizes="27px" alt="" aria-hidden="true">
        <p class="name">BeingAnywhere</p>
        <div class="window-actions">
          <button class="icon-button minimize" type="button" aria-label="收起对话" aria-expanded="true" title="收起"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10h10"/></svg></button>
          <button class="icon-button chat-close" type="button" aria-label="关闭悬浮窗" title="关闭悬浮窗"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8"/></svg></button>
        </div>
      </div>
      <div class="chat-body" hidden></div>
    </section>
  `;

  const panel = shadow.querySelector(".panel");
  const composer = shadow.querySelector(".composer");
  const header = shadow.querySelector(".header");
  const chatBody = shadow.querySelector(".chat-body");
  const promptInput = shadow.querySelector("textarea");
  const promptField = shadow.querySelector(".prompt-field");
  const promptPreview = shadow.querySelector(".prompt-preview");
  const submit = shadow.querySelector(".submit");
  const minimize = shadow.querySelector(".minimize");
  const error = shadow.querySelector(".error");
  const installButton = shadow.querySelector('.install-link');
  const installCandidate = () => {
    const value = promptInput.value.trim() || selected?.text || '';
    return /^https:\/\/(?:github\.com|raw\.githubusercontent\.com)\/[^\s]+$/i.test(value) ? value : '';
  };
  let selected = null;
  let selectionRect = null;
  let frame = 0;
  let busy = false;
  let composing = false;
  let lastFocus = null;
  let operation = 0;
  let chatFrame = null;
  let chatId = "";
  let expanded = false;
  let minimized = false;
  let retainedRange = null;
  let selectionObserver = null;
  const highlightName = "being-anywhere-selection-" + Math.random().toString(36).slice(2);
  const highlightStyle = document.createElement("style");
  highlightStyle.setAttribute("data-being-anywhere-selection-style", "");
  highlightStyle.textContent = "::highlight(" + highlightName + ") { background-color: #d4d4d4; color: #1b1b1b; }";

  function ensureMounted() {
    if (!host.isConnected) (document.documentElement || document.body).appendChild(host);
  }

  function truncate(value, limit) {
    const text = value.slice(0, limit);
    return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
  }

  function safeSource(value) {
    try {
      const url = new URL(value || location.href);
      return /^(https?:)$/.test(url.protocol) ? url.origin + url.pathname : "";
    } catch {
      return "";
    }
  }

  function normalizeSelection(value) {
    return {
      text: typeof value?.text === "string" ? truncate(value.text.trim(), MAX_SELECTION) : "",
      title: truncate(typeof value?.title === "string" ? value.title : document.title, 300),
      url: safeSource(value?.url),
    };
  }

  function isFormSelection(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(element?.isContentEditable || element?.closest("input, textarea, select, [role='textbox']"));
  }

  function isWidgetNode(node) {
    return Boolean(node && (node === host || node.getRootNode() === shadow || host.contains(node)));
  }

  function readSelection() {
    if (!panel.hidden && (shadow.activeElement || document.activeElement === host)) return null;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    if (isWidgetNode(selection.anchorNode) || isWidgetNode(selection.focusNode) ||
        isFormSelection(selection.anchorNode) || isFormSelection(selection.focusNode)) return null;
    const range = selection.getRangeAt(0);
    if (isWidgetNode(range.commonAncestorContainer) || isFormSelection(range.commonAncestorContainer)) return null;
    const text = truncate(selection.toString().trim(), MAX_SELECTION);
    if (!text) return null;
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return { selection: normalizeSelection({ text }), rect, range: range.cloneRange() };
  }

  function clearRetainedRange() {
    globalThis.CSS?.highlights?.delete(highlightName);
    highlightStyle.remove();
    selectionObserver?.disconnect();
    retainedRange = null;
  }

  function validRetainedRange() {
    if (!retainedRange || retainedRange.collapsed || !retainedRange.startContainer.isConnected ||
        !retainedRange.endContainer.isConnected || isWidgetNode(retainedRange.startContainer) ||
        isWidgetNode(retainedRange.endContainer) || isFormSelection(retainedRange.startContainer) ||
        isFormSelection(retainedRange.endContainer)) return false;
    return truncate(retainedRange.toString().trim(), MAX_SELECTION) === selected?.text;
  }

  function highlightRetainedSelection() {
    if (panel.hidden || !validRetainedRange()) {
      clearRetainedRange();
      return;
    }
    if (!globalThis.CSS?.highlights || !globalThis.Highlight) return;
    if (!highlightStyle.isConnected) (document.head || document.documentElement).appendChild(highlightStyle);
    CSS.highlights.set(highlightName, new Highlight(retainedRange));
    if (!selectionObserver) {
      selectionObserver = new MutationObserver(() => {
        if (!host.isConnected || !validRetainedRange()) clearRetainedRange();
      });
    }
    selectionObserver.observe(document.documentElement, { childList: true, characterData: true, attributes: true, attributeFilter: ["contenteditable", "role"], subtree: true });
  }

  function place(element, rect) {
    const margin = 8;
    const gap = 8;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const viewportWidth = document.documentElement.clientWidth || innerWidth;
    const viewportHeight = window.innerHeight;
    let left = rect ? rect.right - width : (viewportWidth - width) / 2;
    let top = rect ? rect.bottom + gap : Math.min(100, viewportHeight / 5);
    if (rect && top + height > viewportHeight - margin) {
      if (rect.top - height - gap >= margin) top = rect.top - height - gap;
      else if (rect.right + gap + width <= viewportWidth - margin) {
        left = rect.right + gap;
        top = rect.top;
      } else if (rect.left - gap - width >= margin) {
        left = rect.left - width - gap;
        top = rect.top;
      } else if (rect.top > viewportHeight - rect.bottom) top = rect.top - height - gap;
    }
    left = Math.max(margin, Math.min(left, viewportWidth - width - margin));
    top = Math.max(margin, Math.min(top, viewportHeight - height - margin));
    element.style.left = Math.round(left) + "px";
    element.style.top = Math.round(top) + "px";
  }

  function resetError() {
    error.hidden = true;
    error.textContent = "";
  }

  function updatePromptPreview(focused = shadow.activeElement === promptInput) {
    const visible = !focused && promptInput.value.length > 0;
    promptPreview.textContent = promptInput.value;
    promptPreview.hidden = !visible;
    promptField.classList.toggle("has-preview", visible);
  }

  function setBusy(value) {
    busy = value;
    submit.disabled = value;
    promptInput.readOnly = value;
    panel.setAttribute("aria-busy", String(value));
    submit.setAttribute("aria-label", value ? "正在打开对话…" : "发送问题");
    shadow.querySelectorAll(".chip").forEach(chip => { chip.disabled = value; });
  }

  function revealChat(loading = false) {
    ensureMounted();
    expanded = true;
    minimized = false;
    panel.classList.add("expanded");
    panel.classList.remove("compact", "minimized");
    panel.setAttribute("aria-label", "BeingAnywhere 悬浮对话");
    composer.hidden = true;
    header.hidden = false;
    chatBody.hidden = false;
    if (chatFrame && !loading) chatFrame.hidden = false;
    minimize.setAttribute("aria-label", "收起对话");
    minimize.setAttribute("aria-expanded", "true");
    minimize.title = "收起";
    panel.hidden = false;
    place(panel, selectionRect);
  }

  function show(value, current = readSelection()) {
    ensureMounted();
    if (chatFrame && (expanded || !value)) {
      revealChat();
      return;
    }
    selected = value ? normalizeSelection(value) : current?.selection || normalizeSelection({});
    const matchingRange = current?.selection.text === selected.text ? current : null;
    clearRetainedRange();
    retainedRange = matchingRange?.range || null;
    selectionRect = matchingRange?.rect || (selected.text ? selectionRect : null);
    operation += 1;
    setBusy(false);
    lastFocus = document.activeElement;
    expanded = false;
    minimized = false;
    panel.classList.remove("expanded", "minimized");
    panel.classList.add("compact");
    panel.setAttribute("aria-label", "BeingAnywhere 快速提问");
    composer.hidden = false;
    header.hidden = true;
    chatBody.hidden = true;
    panel.hidden = false;
    promptInput.value = "";
    installButton.hidden = !installCandidate();
    updatePromptPreview();
    resetError();
    place(panel, selectionRect);
  }

  function close(restoreFocus = false) {
    operation += 1;
    panel.hidden = true;
    clearRetainedRange();
    chatBody.querySelectorAll(".chat-loading").forEach(loading => loading.remove());
    setBusy(false);
    resetError();
    if (restoreFocus && lastFocus instanceof HTMLElement && lastFocus.isConnected) {
      lastFocus.focus({ preventScroll: true });
    }
  }

  function refreshSelection() {
    frame = 0;
    if (busy || (expanded && !panel.hidden) || (!panel.hidden && shadow.activeElement)) return;
    const current = readSelection();
    if (!current) {
      if (!expanded) close();
      return;
    }
    if (!panel.hidden && selected?.text === current.selection.text && !expanded) return;
    selectionRect = current.rect;
    expanded = false;
    show(current.selection, current);
  }

  function scheduleSelection(event) {
    if (!event.isTrusted || event.composedPath().includes(host) || busy || (expanded && !panel.hidden)) return;
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(refreshSelection);
  }

  function releaseContext(id) {
    if (!id) return;
    void chrome.runtime.sendMessage({ type: "being:float-release", id }).catch(() => {});
  }

  async function stage(event, explicitPrompt, installLink) {
    const shortcut = typeof explicitPrompt === "string";
    if (!event.isTrusted || busy || (!shortcut && (event.isComposing || composing))) return;
    const prompt = (shortcut ? explicitPrompt : promptInput.value).trim();
    if (prompt.length > MAX_PROMPT) {
      error.textContent = "问题最多可输入 8000 个字符，请缩短后再发送。";
      error.hidden = false;
      promptInput.focus({ preventScroll: true });
      place(panel, selectionRect);
      return;
    }
    if (!prompt) {
      error.textContent = "写下你的问题，或点击下方快捷操作。";
      error.hidden = false;
      promptInput.focus({ preventScroll: true });
      place(panel, selectionRect);
      return;
    }
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    setBusy(true);
    resetError();
    if (chatFrame) chatFrame.hidden = true;
    const loading = document.createElement("div");
    loading.className = "chat-loading";
    loading.setAttribute("role", "status");
    loading.textContent = "正在打开 Being 对话…";
    chatBody.appendChild(loading);
    revealChat(true);
    const requestOperation = operation;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "being:float",
        selection: normalizeSelection(selected),
        prompt,
        ...(installLink ? {installLink} : {}),
      });
      if (requestOperation !== operation) {
        loading.remove();
        if (response?.ok && typeof response.id === "string") releaseContext(response.id);
        return;
      }
      if (!response?.ok || typeof response.id !== "string" || !response.id) {
        throw new Error("FLOAT_UNAVAILABLE");
      }
      const nextFrame = document.createElement("iframe");
      nextFrame.className = "conversation-frame";
      nextFrame.title = "BeingAnywhere 对话";
      nextFrame.referrerPolicy = "no-referrer";
      nextFrame.src = chrome.runtime.getURL("floating.html") + "?id=" + encodeURIComponent(response.id);
      const previousId = chatId;
      chatBody.replaceChildren(nextFrame);
      releaseContext(previousId);
      chatFrame = nextFrame;
      chatId = response.id;
      revealChat();
    } catch (failure) {
      loading.remove();
      if (requestOperation !== operation) return;
      expanded = false;
      minimized = false;
      panel.classList.remove("expanded", "minimized");
      panel.classList.add("compact");
      panel.setAttribute("aria-label", "BeingAnywhere 快速提问");
      composer.hidden = false;
      header.hidden = true;
      chatBody.hidden = true;
      error.textContent = failure?.message?.includes("Extension context invalidated")
        ? "扩展已更新，请刷新网页后重试。"
        : "暂时无法打开对话，请重试。";
      error.hidden = false;
      place(panel, selectionRect);
      promptInput.focus({ preventScroll: true });
    } finally {
      if (requestOperation === operation) setBusy(false);
    }
  }

  installButton.addEventListener('click', event => {
    const link = installCandidate();
    if (link) void stage(event, '安装到 Being', link);
  });
  shadow.querySelector(".compact-close").addEventListener("click", event => {
    if (event.isTrusted) close(true);
  });
  shadow.querySelector(".chat-close").addEventListener("click", event => {
    if (event.isTrusted) close(true);
  });
  minimize.addEventListener("click", event => {
    if (!event.isTrusted) return;
    minimized = !minimized;
    panel.classList.toggle("minimized", minimized);
    chatBody.hidden = minimized;
    minimize.setAttribute("aria-label", minimized ? "展开对话" : "收起对话");
    minimize.setAttribute("aria-expanded", String(!minimized));
    minimize.title = minimized ? "展开" : "收起";
    place(panel, selectionRect);
  });
  shadow.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", event => { void stage(event, chip.dataset.prompt); });
  });
  submit.addEventListener("click", stage);
  promptInput.addEventListener("compositionstart", () => { composing = true; });
  promptInput.addEventListener("compositionend", () => { composing = false; });
  promptInput.addEventListener("keydown", event => {
    if (event.isTrusted && !event.isComposing && event.keyCode !== 229 &&
        event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      void stage(event);
    }
  });
  promptInput.addEventListener("input", () => {
    installButton.hidden = !installCandidate();
    resetError();
    updatePromptPreview();
  });
  promptInput.addEventListener("focus", () => {
    updatePromptPreview(true);
    highlightRetainedSelection();
  });
  promptInput.addEventListener("blur", () => updatePromptPreview(false));
  document.addEventListener("keydown", event => {
    if (event.isTrusted && event.key === "Escape" && !event.isComposing && !composing && !panel.hidden) {
      close(true);
    }
  }, true);
  document.addEventListener("pointerdown", event => {
    if (!event.isTrusted) return;
    if (event.composedPath().includes(host)) {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      highlightRetainedSelection();
    } else {
      clearRetainedRange();
      if (!expanded) close();
    }
  }, true);
  document.addEventListener("mouseup", scheduleSelection, true);
  document.addEventListener("selectionchange", scheduleSelection);
  document.addEventListener("scroll", event => {
    if (panel.hidden || event.composedPath().includes(host)) return;
    if (expanded) place(panel, null);
    else close();
  }, true);
  window.addEventListener("resize", () => {
    if (!panel.hidden) place(panel, selectionRect);
  });
  window.addEventListener("message", event => {
    if (!chatFrame || event.source !== chatFrame.contentWindow ||
        event.origin !== (() => { const url = new URL(chrome.runtime.getURL("/")); return url.origin === "null" ? url.protocol + "//" + url.host : url.origin; })() ||
        event.data?.type !== "being:float-dismiss" || event.data?.id !== chatId) return;
    close();
  });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "being:widget-status") {
      respond({ ok: true, version: VERSION, visible: host.isConnected && !panel.hidden });
    } else if (message?.type === "being:capture-selection") {
      const current = readSelection();
      const retained = !panel.hidden && (shadow.activeElement || document.activeElement === host) ? selected : null;
      respond({ ok: true, selection: current?.selection || retained || normalizeSelection({}) });
    } else if (message?.type === "being:show") {
      show(message.selection);
      respond({ ok: true });
    }
  });

  globalThis[INSTANCE_KEY] = { show, version: VERSION };
  refreshSelection();
})();
