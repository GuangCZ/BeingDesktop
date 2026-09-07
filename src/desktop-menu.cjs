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

function commandForInput(input) {
  if (input.type !== 'keyDown' || input.shift || input.meta) return null;
  const key = String(input.key).toLowerCase();
  if (input.alt && !input.control) {
    if (key === 'arrowleft') return 'navigate-back';
    if (key === 'arrowright') return 'navigate-forward';
  }
  if (!input.control || input.alt) return null;
  switch (key) {
    case 'b': return 'toggle-sidebar';
    case '1': return 'chat';
    case '2': return 'workspace';
    case ',': return 'settings';
    default: return null;
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

function createDesktopMenuTemplate(name, {sendCommand, closeWindow, editTarget}) {
  const separator = () => ({type: 'separator'});
  const command = (label, id, accelerator) => ({
    label,
    click: () => sendCommand(id),
    // The renderer and Loom input handler already own these shortcuts.
    ...(accelerator ? {accelerator, registerAccelerator: false} : {}),
  });
  const edit = (label, role, accelerator) => editTarget ? {
    label, accelerator, registerAccelerator: false,
    click: () => { if (!editTarget.isDestroyed()) editTarget[role](); },
  } : {label, role};
  switch (name) {
    case 'file': return [
      command('对话', 'chat', 'Ctrl+1'),
      command('工作区', 'workspace', 'Ctrl+2'),
      command('选择工作区…', 'select-workspace'),
      separator(),
      command('连接与设置…', 'settings', 'Ctrl+,'),
      separator(),
      {label: '关闭窗口', accelerator: 'Alt+F4', registerAccelerator: false, click: closeWindow},
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
      command('后退', 'navigate-back', 'Alt+Left'),
      command('前进', 'navigate-forward', 'Alt+Right'),
      separator(),
      command('切换侧栏', 'toggle-sidebar', 'Ctrl+B'),
      command('切换详情面板', 'toggle-inspector'),
      separator(),
      command('刷新状态', 'refresh'),
      command('打开浏览器', 'open-browser'),
      command('打开控制台', 'open-console'),
    ];
    case 'help': return [command('关于 Being Desktop', 'about')];
    default: throw new Error('请选择有效的应用菜单。');
  }
}

module.exports = {normalizeAppMenuRequest, commandForInput, captureMenuEditingTarget, getDesktopWindowState, createDesktopMenuTemplate};
