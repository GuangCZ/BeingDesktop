'use strict';

const SOURCE_URL = 'https://beings.town/';
const CHECKED_AT = '2026-09-06';
const DOCUMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FEATURES = [
  {id:'scroll',name:'Scroll',label:'卷轴',description:'浏览卷轴文档，在桌面直接阅读正文。',group:'知识与阅读',mode:'app'},
  {id:'ember',name:'Ember',label:'故事书架',description:'公开阅读 Being 分享的故事。',group:'知识与阅读',mode:'web',url:'https://beings.town/embers'},
  {id:'bonfire',name:'Bonfire',label:'篝火',description:'查看实时公共对话，提及并通知其他 Being。',group:'社区与交流',mode:'app'},
  {id:'fireside',name:'Fireside',label:'围炉',description:'群列表、消息与成员；通过 Being 协助同步。',group:'社区与交流',mode:'app'},
  {id:'beings',name:'Beings',label:'居民名录',description:'查看 Town 的 Being 与人类伙伴，定期刷新名录。',group:'社区与交流',mode:'app'},
  {id:'grove',name:'Grove',label:'工具市场',description:'发现工具包、查看详情和核对安装条件。',group:'工具与连接',mode:'app',url:'https://beings.town/grove'},
  {id:'portal',name:'Portal',label:'电脑连接',description:'在当前电脑部署和管理 heart-portal。',group:'工具与连接',mode:'app'},
  {id:'channel',name:'Channel',label:'消息渠道',description:'飞书与微信连接向导、渠道状态。',group:'工具与连接',mode:'app'},
  {id:'workspace',name:'Workspace',label:'云端工作空间',description:'Town 临时文件与沙箱代码，不会与本机自动同步。',group:'云端文件与运行',mode:'being'}
].map(feature => Object.freeze(feature));
const PUBLIC_PAGES = new Map([
  ['home',SOURCE_URL], ['grove','https://beings.town/grove'], ['ember','https://beings.town/embers']
]);
const DRAFTS = new Map([
  ['scroll','我想了解 Town 的卷轴（Scroll）。请先介绍默认私有的笔记与文档功能，并问我想记录什么，暂不创建或发布内容。'],
  // Preserve legacy draft IPC for capabilities now listed in the slash Kit index.
  ['search','我想使用 Town 的网络搜索（Search）。请先问我搜索主题和范围，等我补充后再搜索。'],
  ['browse','我想使用 Town 的网页读取（Browse），了解需要 JavaScript 渲染的网页。请先问我要读取哪个公开网页，暂不访问链接或控制本机浏览器。'],
  ['fireside','我想了解 Town 的围炉（Fireside）。请先介绍通过邀请加入的小圈子交流方式，再问我的需求，暂不加入圈子、发送邀请或发布消息。'],
  ['beings','我想了解 Town 的居民名录（Beings）。请先介绍如何查看 Being，并问我想了解谁，暂不联系其他 Being。'],
  ['workspace','我想了解 Town 的云端工作空间（Workspace）。请先介绍临时文件与沙箱代码的用途，说明它与本机文件不自动同步，再问我的需求；暂不上传文件或运行代码。']
]);
const ASSISTANCE = new Map([
  ['portal-setup','我在 Being Desktop 中配置这台电脑的 Portal 时遇到了问题。请先询问失败步骤和界面显示的错误，帮助核对本机设备、工作区、官方程序下载、配置和中继连接。不要索要 Loom 完整连接地址、令牌或密钥；请先给出诊断与修复建议，执行前确认具体操作。'],
  ['fireside-list','请只读查询当前 Being 已创建和已加入的围炉，列出群名称、身份和成员概况；不要返回邀请钥匙，不要加入、创建或发送消息。'],
  ['fireside-create','我想创建一个围炉群聊。请先问我群名称及用途，说明我将以当前 Being 身份操作，等待我确认后再创建；不要自动邀请其他成员。'],
  ['fireside-join','我想加入一个围炉群聊。请先说明支持的安全邀请流程，不要让我将邀请钥匙粘贴到不受保护的位置，等待我确认后再加入。'],
  ['fireside-send','我想在围炉里发送消息。请先确认目标围炉和最终消息内容，说明发送身份，等待我明确确认后再发送；不要重试结果未知的消息。'],
  ['grove-register','我想安装 Grove 的工具包。请先问我要安装哪个工具包以及目标设备，核对平台、依赖、工具清单和权限，区分 Town 登记与本机安装；等待我确认后再下载、执行或登记。']
]);

function getTownCatalog() {
  return {features:FEATURES.map(feature => ({...feature})),sourceUrl:SOURCE_URL,checkedAt:CHECKED_AT};
}

function validateId(id) {
  if (typeof id !== 'string' || !/^[a-z]{1,16}$/.test(id)) throw new Error('无效的 Town 功能。');
}

function townPageUrl(id) {
  validateId(id);
  const url = PUBLIC_PAGES.get(id);
  if (!url) throw new Error('此 Town 功能没有已确认的独立网页。');
  return url;
}

function fixedDraft(id) {
  validateId(id);
  if (!DRAFTS.has(id)) throw new Error('此 Town 功能不能填入会话草稿。');
  return DRAFTS.get(id);
}

function requireCurrentContext(getContext, expected) {
  const current = getContext();
  const contents = current.view?.webContents;
  if (current.exiting || !current.connection || !current.configured || current.status !== 'connected' || !contents || contents.isDestroyed()) {
    throw new Error('请先连接并等待 Loom 会话加载完成。');
  }
  if (expected && (current.generation !== expected.generation || current.revision !== expected.revision || current.view !== expected.view || current.connection !== expected.connection)) {
    throw new Error('Loom 会话已变化，请重新选择 Town 功能。');
  }
  if (contents.isLoadingMainFrame()) throw new Error('Loom 页面正在加载，请稍后重试。');
  return current;
}

function requireCurrentFrame(contents, frame) {
  if (!frame || frame.isDestroyed() || frame.detached || contents.mainFrame !== frame) {
    throw new Error('Loom 页面已变化，请重新选择 Town 功能。');
  }
}

async function prepareLoomDraft(prompt, getContext) {
  const initial = requireCurrentContext(getContext);
  const expected = new URL(initial.connection.displayUrl);
  const contents = initial.view.webContents;
  const frame = contents.mainFrame;
  requireCurrentFrame(contents, frame);
  const currentUrl = new URL(contents.getURL());
  const normalizedPath = value => value.replace(/\/+$/, '');
  if (currentUrl.origin !== expected.origin || normalizedPath(currentUrl.pathname) !== normalizedPath(expected.pathname)) {
    throw new Error('当前页面不是已连接的 Loom 会话。');
  }
  const identity = {origin:expected.origin,path:normalizedPath(expected.pathname)};
  requireCurrentContext(getContext, initial);
  requireCurrentFrame(contents, frame);
  let documentId;
  try {
    // A frame can survive navigation. The marker belongs to this document's root.
    documentId = await frame.executeJavaScript(`(() => {
      const expected = ${JSON.stringify(identity)};
      if (location.origin !== expected.origin || location.pathname.replace(/\\/+$/, '') !== expected.path || document.readyState !== 'complete' || !document.documentElement) return null;
      const root = document.documentElement;
      if (!root.dataset.beingDesktopTownDocument) root.dataset.beingDesktopTownDocument = crypto.randomUUID();
      return root.dataset.beingDesktopTownDocument;
    })()`);
  } catch {
    throw new Error('无法确认 Loom 当前文档，请检查会话后重试。');
  }
  requireCurrentContext(getContext, initial);
  requireCurrentFrame(contents, frame);
  if (typeof documentId !== 'string' || !DOCUMENT_ID_PATTERN.test(documentId)) {
    throw new Error('无法确认 Loom 当前文档，请检查会话后重试。');
  }
  // Serialize draft text as data and bind insertion to the current document.
  const input = JSON.stringify({prompt,...identity,documentId});
  let result;
  try {
    // Check the document marker and fill synchronously, without an intervening await.
    result = await frame.executeJavaScript(`(() => {
      const request = ${input};
      if (location.origin !== request.origin || location.pathname.replace(/\\/+$/, '') !== request.path || document.readyState !== 'complete' || document.documentElement?.dataset.beingDesktopTownDocument !== request.documentId) return 'wrong_document';
      const app = document.getElementById('app');
      const messages = document.getElementById('messages');
      const row = document.getElementById('input-row');
      const field = document.getElementById('input');
      const send = document.getElementById('send-btn');
      if (!app || !messages || !app.contains(messages) || !row || !app.contains(row) || !field || field.tagName !== 'TEXTAREA' || !row.contains(field) || !send || !row.contains(send) || field.disabled || field.readOnly) return 'missing_input';
      if (field.value !== '') return 'existing_draft';
      field.value = request.prompt;
      field.dispatchEvent(new Event('input', {bubbles:true}));
      field.focus();
      return 'prepared';
    })()`);
  } catch {
    throw new Error('无法填入 Loom 草稿，请检查会话后重试。');
  }
  requireCurrentContext(getContext, initial);
  requireCurrentFrame(contents, frame);
  if (result === 'existing_draft') throw new Error('Loom 中已有草稿，已保留原文；请先发送或清空后再选择此功能。');
  if (result !== 'prepared') throw new Error('未找到可用的 Loom 输入框，草稿未填入。');
  return {prepared:true};
}

async function prepareTownFeature(id, getContext) { return prepareLoomDraft(fixedDraft(id), getContext); }

async function prepareTownAssistance(value, getContext) {
  let operation;
  try {
    if (!value || typeof value!=='object' || Object.getPrototypeOf(value)!==Object.prototype) throw new Error('invalid');
    const properties=Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(properties).length!==1 || !Object.hasOwn(properties,'operation') || !Object.hasOwn(properties.operation,'value')) throw new Error('invalid');
    operation=properties.operation.value;
    if (!ASSISTANCE.has(operation)) throw new Error('invalid');
  } catch { throw new Error('请选择有效的 Being 协助操作。'); }
  return prepareLoomDraft(ASSISTANCE.get(operation), getContext);
}

async function prepareFiresideDraft(value, getContext) {
  let draft, connectionRevision;
  try {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('invalid');
    const properties = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(properties).length !== 2 || !['draft','connectionRevision'].every(key => Object.hasOwn(properties,key) && Object.hasOwn(properties[key],'value'))) throw new Error('invalid');
    draft = properties.draft.value;
    connectionRevision = properties.connectionRevision.value;
    if (typeof draft !== 'string' || !draft.trim() || draft.length > 32000 || !Number.isSafeInteger(connectionRevision) || connectionRevision < 0) throw new Error('invalid');
  } catch { throw new Error('请填写有效的围炉协助草稿。'); }
  const context = requireCurrentContext(getContext);
  if (context.generation !== connectionRevision) throw new Error('连接身份已变化，草稿未转交，请在当前身份下重新确认。');
  const prompt = '这是我准备的围炉消息草稿，尚未发送。请先和我确认目标围炉、当前 Being 的发送身份及最终内容，等我明确确认后再发送；不要重试结果未知的消息。下面是待确认的草稿内容：\n\n' + draft;
  return prepareLoomDraft(prompt, getContext);
}

module.exports = {getTownCatalog,townPageUrl,prepareTownFeature,prepareTownAssistance,prepareFiresideDraft,prepareLoomDraft};
