'use strict';

const {contextBridge,ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('fixtureBridge',{
  getDesktopTools:() => ipcRenderer.invoke('tools-fixture:get'),
  desktopAction:(name,value) => ipcRenderer.invoke('tools-fixture:action',name,value),
  setBrowserView:value => ipcRenderer.invoke('tools-fixture:viewport',value),
  selectWorkspace:() => ipcRenderer.invoke('tools-fixture:workspace'),
  copyDesktopText:text => ipcRenderer.invoke('tools-fixture:copy',text),
  onToolsState:callback => {
    const listener = (_event,state) => callback(state);
    ipcRenderer.on('tools-fixture:state',listener);
    return () => ipcRenderer.removeListener('tools-fixture:state',listener);
  },
});
