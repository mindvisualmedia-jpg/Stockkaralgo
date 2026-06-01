const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  minimize:         () => ipcRenderer.send('win-minimize'),
  maximize:         () => ipcRenderer.send('win-maximize'),
  close:            () => ipcRenderer.send('win-close'),
  request:          (opts) => ipcRenderer.invoke('http-request', opts),
  stockkarLogin:    () => ipcRenderer.invoke('stockkar-login'),
  stockkarRefresh:  () => ipcRenderer.invoke('stockkar-refresh'),
  stockkarGetToken: () => ipcRenderer.invoke('stockkar-get-token'),
  stockkarStatus:   () => ipcRenderer.invoke('stockkar-auth-status'),
});
