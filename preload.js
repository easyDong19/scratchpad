const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lsp', {
  send: (json) => ipcRenderer.send('lsp-send', json),
  onMessage: (cb) => ipcRenderer.on('lsp-message', (_e, msg) => cb(msg)),
  onStatus: (cb) => ipcRenderer.on('lsp-status', (_e, s) => cb(s)),
  getInfo: () => ipcRenderer.invoke('lsp-info'),
});
