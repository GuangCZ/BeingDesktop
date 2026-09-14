'use strict';

const MENU_NAMES = new Set(['file', 'edit', 'view', 'help']);

function normalizeAppMenuRequest(value, {width, height}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !MENU_NAMES.has(value.menu)
      || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new Error('请选择有效的应用菜单。');
  }
  return {
    menu: value.menu,
    x: Math.max(0, Math.min(Math.max(0, width - 1), Math.round(value.x))),
    y: Math.max(0, Math.min(Math.max(0, height - 1), Math.round(value.y))),
  };
}

function commandForInput(input, platform = process.platform) {
  if (input.type !== 'keyDown' || input.shift || (platform !== 'darwin' && input.meta)) return null;
  const key = String(input.key).toLowerCase();
  if (input.alt && !input.control && !input.meta) {
    if (key === 'arrowleft') return 'navigate-back';
    if (key === 'arrowright') return 'navigate-forward';
  }
  if (!(platform === 'darwin' ? input.meta : input.control) || input.alt) return null;
  switch (key) {
    case 'b': return 'toggle-sidebar';
    case 'n': return 'new-task';
    case 'k': return 'search-tasks';
    case 'o': return 'select-workspace';
    case '[': return 'navigate-back';
    case ']': return 'navigate-forward';
    case 'j': return 'toggle-console';
    case 't': return 'open-browser';
    case ',': return 'settings';
    default: return /^[1-9]$/.test(key) ? `task-${key}` : null;
  }
}

function captureMenuEditingTarget(window, preferred) {
  if (preferred && !preferred.isDestroyed() && (preferred === window.webContents
      || window.contentView.children.some(child => child.webContents === preferred && child.getVisible()))) return preferred;
  return window.webContents;
}

function getDesktopWindowState(window) {
  return {maximized: Boolean(window && !window.isDestroyed() && window.isMaximized())};
}

function createDesktopMenuTemplate(name, {sendCommand, closeWindow, editTarget}, platform = process.platform) {
  const separator = () => ({type: 'separator'});
  const command = (label, id, accelerator) => ({
    label,
    click: () => sendCommand(id),
    // The renderer and Loom input handler already own these shortcuts.
    ...(accelerator ? {accelerator:platform === 'darwin' ? accelerator.replace('Ctrl+', 'Cmd+') : accelerator, registerAccelerator: false} : {}),
  });
  const edit = (label, role, accelerator) => editTarget ? {
    label, accelerator:platform === 'darwin' ? accelerator.replace('Ctrl+', 'Cmd+') : accelerator, registerAccelerator: false,
    click: () => { if (!editTarget.isDestroyed()) editTarget[role](); },
  } : {label, role};
  switch (name) {
    case 'file': return [
      command('新会话', 'new-task', 'Ctrl+N'),
      command('搜索会话…', 'search-tasks', 'Ctrl+K'),
      command('添加项目…', 'select-workspace', 'Ctrl+O'),
      command('浏览项目文件', 'workspace'),
      separator(),
      command('连接与设置…', 'settings', 'Ctrl+,'),
      separator(),
      {label: '关闭窗口', accelerator: platform === 'darwin' ? 'Cmd+W' : 'Alt+F4', registerAccelerator: false, click: closeWindow},
    ];
    case 'edit': return [
      edit('撤销', 'undo', 'Ctrl+Z'),
      edit('重做', 'redo', 'Ctrl+Y'),
      separator(),
      edit('剪切', 'cut', 'Ctrl+X'),
      edit('复制', 'copy', 'Ctrl+C'),
      edit('粘贴', 'paste', 'Ctrl+V'),
      separator(),
      edit('全选', 'selectAll', 'Ctrl+A'),
    ];
    case 'view': return [
      command('后退', 'navigate-back', 'Ctrl+['),
      command('前进', 'navigate-forward', 'Ctrl+]'),
      separator(),
      command('切换侧栏', 'toggle-sidebar', 'Ctrl+B'),
      command('切换详情面板', 'toggle-inspector'),
      separator(),
      command('刷新状态', 'refresh'),
      command('打开浏览器', 'open-browser', 'Ctrl+T'),
      command('切换控制台', 'toggle-console', 'Ctrl+J'),
    ];
    case 'help': return [command('关于 Being Desktop', 'about')];
    default: throw new Error('请选择有效的应用菜单。');
  }
}

module.exports = {normalizeAppMenuRequest, commandForInput, captureMenuEditingTarget, getDesktopWindowState, createDesktopMenuTemplate};
