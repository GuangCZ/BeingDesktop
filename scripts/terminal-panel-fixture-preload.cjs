'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const subscribe=(channel,callback)=>{const listener=(_event,value)=>callback(value);ipcRenderer.on(channel,listener);return()=>ipcRenderer.removeListener(channel,listener);};
contextBridge.exposeInMainWorld('terminalFixture',{
  getTerminalState:()=>ipcRenderer.invoke('terminal-fixture:state'),
  getDesktopTools:()=>ipcRenderer.invoke('terminal-fixture:tools'),
  onToolsState:callback=>subscribe('terminal-fixture:tools-change',callback),
  setBrowserView:value=>ipcRenderer.invoke('terminal-fixture:viewport',value),
  terminalAction:(name,value)=>ipcRenderer.invoke('terminal-fixture:action',name,value),
  readTerminal:id=>ipcRenderer.invoke('terminal-fixture:read',id),
  onTerminalState:callback=>subscribe('terminal-fixture:state-change',callback),
  onTerminalData:callback=>subscribe('terminal-fixture:data',callback),
  readNativeText:()=>ipcRenderer.invoke('terminal-fixture:clipboard-read'),
  copyDesktopText:text=>ipcRenderer.invoke('terminal-fixture:clipboard-write',text),
  desktopAction:(name,value)=>ipcRenderer.invoke('terminal-fixture:desktop',name,value),
  reportError:message=>ipcRenderer.invoke('terminal-fixture:error',message),
  selectWorkspace:()=>ipcRenderer.invoke('terminal-fixture:workspace'),
});
