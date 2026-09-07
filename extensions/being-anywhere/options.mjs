import { BeingClient, parseConnection } from './being-client.mjs';
const $ = id => document.getElementById(id);
let checking = null;
const error = text => { $('error').textContent = text; $('error').hidden = !text; };
function permissionOrigin(connection) { return `${connection.origin}/*`; }
$('connection-form').addEventListener('submit', event => {
  event.preventDefault(); error('');
  let connection;
  try { connection = parseConnection($('loom-url').value); } catch (err) { error(err.message); return; }
  // Request just the configured server origin during the explicit Save click.
  const granted = chrome.permissions.request({ origins: [permissionOrigin(connection)] });
  checking?.abort(); checking = new AbortController();
  const controller = checking;
  $('connect').disabled = true; $('result').textContent = '正在验证连接…';
  void (async () => {
    try {
      if (!await granted) throw new Error('未授予 Being 服务的访问权限，连接尚未保存。');
      await new BeingClient(connection).status({ signal: controller.signal });
      if (controller.signal.aborted) return;
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      await chrome.storage.local.set({ connection: { url: connection.url } });
      $('loom-url').value = ''; $('loom-url').placeholder = '已保存。输入新地址可更换 Being';
      $('result').textContent = `已连接 ${connection.beingName} · ${connection.displayUrl}`;
    } catch (err) {
      if (!controller.signal.aborted) { error(err.message || '连接失败，请检查地址与访问权限。'); $('result').textContent = ''; }
    } finally { if (checking === controller) { checking = null; $('connect').disabled = false; } }
  })();
});
$('disconnect').addEventListener('click', async () => {
  checking?.abort(); checking = null; $('connect').disabled = false;
  const saved = (await chrome.storage.local.get('connection')).connection;
  await chrome.storage.local.remove('connection');
  const session = await chrome.storage.session.get(null);
  await chrome.storage.session.remove(Object.keys(session).filter(key => key.startsWith('chat:')));
  if (saved?.url) {
    try { await chrome.permissions.remove({ origins: [permissionOrigin(parseConnection(saved.url))] }); } catch { /* Removing the credential still disconnects this extension. */ }
  }
  $('loom-url').value = ''; $('result').textContent = '已断开连接。Being 的历史仍保留在服务端。'; error('');
});
void chrome.storage.local.get('connection').then(({ connection }) => {
  if (connection?.url) {
    try { const parsed = parseConnection(connection.url); $('result').textContent = `已保存 ${parsed.beingName} · ${parsed.displayUrl}`; $('loom-url').placeholder = '已保存。输入新地址可更换 Being'; } catch { error('保存的地址无效，请重新连接。'); }
  }
});
