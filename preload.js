const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lsp', {
  send: (json) => ipcRenderer.send('lsp-send', json),
  onMessage: (cb) => ipcRenderer.on('lsp-message', (_e, msg) => cb(msg)),
  onStatus: (cb) => ipcRenderer.on('lsp-status', (_e, s) => cb(s)),
  getInfo: () => ipcRenderer.invoke('lsp-info'),
});

contextBridge.exposeInMainWorld('term', {
  start: (payload) => ipcRenderer.send('run-start', payload),
  input: (data) => ipcRenderer.send('run-input', data),
  resize: (size) => ipcRenderer.send('run-resize', size),
  kill: () => ipcRenderer.send('run-kill'),
  onData: (cb) => ipcRenderer.on('term-data', (_e, d) => cb(d)),
  onExit: (cb) => ipcRenderer.on('term-exit', (_e, c) => cb(c)),
});

contextBridge.exposeInMainWorld('ui', {
  onShowShortcuts: (cb) => ipcRenderer.on('show-shortcuts', () => cb()),
});
