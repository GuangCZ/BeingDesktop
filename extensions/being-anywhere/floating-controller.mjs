import { normalizeSelection } from './being-client.mjs';
import { installRequest } from './install-link.mjs';

const ID = /^[a-f0-9-]{36}$/;
const failure = message => Object.assign(new Error(message), { public: true });

export function createFloatingController(chrome) {
  const locks = new Map();
  const serial = (key, work) => {
    const result = (locks.get(key) || Promise.resolve()).catch(() => {}).then(work);
    locks.set(key, result);
    void result.finally(() => { if (locks.get(key) === result) locks.delete(key); }).catch(() => {});
    return result;
  };
  const pageSender = sender => sender.tab && /^https?:\/\//.test(sender.url || '');
  const frameSender = (sender, id) => {
    try {
      const url = new URL(sender.url);
      const expected = new URL(chrome.runtime.getURL('floating.html'));
      return ID.test(id || '') && sender.tab && url.protocol === expected.protocol && url.host === expected.host && url.pathname === expected.pathname && url.searchParams.get('id') === id;
    } catch { return false; }
  };
  async function context(id, sender) {
    const value = (await chrome.storage.session.get(`float:${id}`))[`float:${id}`];
    if (!value || value.tabId !== sender.tab.id || value.windowId !== sender.tab.windowId) throw failure('浮窗已过期，请重新选择网页内容。');
    return value;
  }
  const guarded = work => work.catch(error => ({ ok: false, error: error?.public === true ? error.message : '浮窗操作未完成，请重试。' }));

  function handle(message, sender) {
    if (sender.id !== chrome.runtime.id) return null;
    if (message.type === 'being:float' && pageSender(sender)) {
      return guarded(serial(`tab:${sender.tab.id}`, async () => {
        let prompt = message.prompt, install = null;
        if (message.installLink !== undefined) {
          try { install = installRequest(message.installLink); prompt = install.prompt; }
          catch (error) { throw failure(error.message); }
        }
        if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) throw failure('请输入问题，最多 8,000 字。');
        const all = await chrome.storage.session.get(null);
        if (Object.entries(all).filter(([key, value]) => key.startsWith('float:') && value.tabId === sender.tab.id).length >= 20) throw failure('此页面的浮窗较多，请关闭并重新打开此标签页后重试。');
        const id = crypto.randomUUID();
        const value = { id, tabId: sender.tab.id, windowId: sender.tab.windowId, selection: normalizeSelection(install ? {text: install.link.url, title: install.link.repository, url: install.link.url} : { ...message.selection, title: sender.tab.title, url: sender.url }), prompt: prompt.trim(), started: false };
        await chrome.storage.session.set({ [`float:${id}`]: value });
        return { ok: true, id };
      }));
    }
    if (message.type === 'being:float-context' && frameSender(sender, message.id)) {
      return guarded(serial(`float:${message.id}`, async () => {
        const value = await context(message.id, sender);
        const autoSend = !value.started && !value.moved;
        // Claim before the first POST. Reloading can restore, never replay a request.
        if (autoSend) await chrome.storage.session.set({ [`float:${message.id}`]: { ...value, started: true } });
        return { ok: true, autoSend, moved: value.moved === true, context: { id: value.id, windowId: value.windowId, selection: value.selection, prompt: value.prompt } };
      }));
    }
    if (message.type === 'being:float-transfer' && frameSender(sender, message.id)) {
      return guarded(serial(`handoff:${sender.tab.windowId}`, async () => {
        const value = await context(message.id, sender);
        if (value.moved) return { ok: true };
        const keys = [`chat:float-${value.id}`, `composer:float-${value.id}`, `handoff:${value.windowId}`];
        const [stored, local] = await Promise.all([chrome.storage.session.get(keys), chrome.storage.local.get('connection')]);
        const chat = stored[keys[0]];
        if (!chat?.identity || chat.identity !== local.connection?.url || !Array.isArray(chat.messages)) throw failure('Being 连接已变化，请重新打开浮窗。');
        const queue = stored[keys[2]] || [];
        if (queue.length >= 10) throw failure('侧栏中有待接续的对话，请先处理。');
        if (!queue.some(item => item.floatId === value.id)) {
          queue.push({ id: crypto.randomUUID(), floatId: value.id, identity: chat.identity, sessionId: chat.sessionId, messages: chat.messages, composer: stored[keys[1]] || { prompt: '', selection: null } });
          await chrome.storage.session.set({ [keys[2]]: queue, [`float:${value.id}`]: { ...value, moved: true } });
        }
        return { ok: true };
      }));
    }
    if (message.type === 'being:consume-handoff' && sender.url === chrome.runtime.getURL('sidepanel.html')) {
      return guarded(serial(`handoff:${message.windowId}`, async () => {
        if (!Number.isInteger(message.windowId) || !ID.test(message.id || '')) throw failure('无效的对话请求。');
        const key = `handoff:${message.windowId}`;
        const [stored, local] = await Promise.all([chrome.storage.session.get(key), chrome.storage.local.get('connection')]);
        const queue = stored[key] || [];
        const item = queue.find(item => item.id === message.id);
        if (!item) return { ok: true, alreadyConsumed: true };
        if (item.identity !== local.connection?.url) throw failure('Being 连接已变化，请切回原连接后接续。');
        // Commit transcript, draft and consumption together so a reload cannot replay a draft.
        await chrome.storage.session.set({
          [key]: queue.filter(entry => entry.id !== message.id),
          [`chat:${message.windowId}`]: { identity: item.identity, sessionId: item.sessionId, messages: item.messages },
          [`composer:${message.windowId}`]: item.composer || { prompt: '', selection: null }
        });
        return { ok: true, handoff: item };
      }));
    }
    if (message.type === 'being:float-release' && pageSender(sender) && ID.test(message.id || '')) {
      return guarded(serial(`float:${message.id}`, async () => {
        await context(message.id, sender);
        await chrome.storage.session.remove([`float:${message.id}`, `chat:float-${message.id}`, `composer:float-${message.id}`]);
        return { ok: true };
      }));
    }
    return null;
  }

  async function cleanup(field, id) {
    const all = await chrome.storage.session.get(null);
    const keys = Object.entries(all).filter(([key, value]) => key.startsWith('float:') && value[field] === id).flatMap(([key, value]) => [key, `chat:float-${value.id}`, `composer:float-${value.id}`]);
    if (field === 'windowId') keys.push(`handoff:${id}`);
    if (keys.length) await chrome.storage.session.remove(keys);
  }
  return { handle, cleanup };
}
