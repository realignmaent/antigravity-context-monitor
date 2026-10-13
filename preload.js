'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitor', {
  onUpdate: (handler) => ipcRenderer.on('context:update', (_event, payload) => handler(payload)),
  refresh: () => ipcRenderer.send('window:refresh'),
  hide: () => ipcRenderer.send('window:hide'),
  quit: () => ipcRenderer.send('window:quit'),
});
