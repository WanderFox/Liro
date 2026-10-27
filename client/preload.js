// Exposes the desktop-only capabilities (discovery, settings, offline cache) to the shared web UI.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liroNative', {
  isNative: true,
  platform: process.platform,
  discover: () => ipcRenderer.invoke('discover'),
  download: (url) => ipcRenderer.invoke('download', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  cache: {
    load: (serverId, boardId) => ipcRenderer.invoke('cache:load', serverId, boardId),
    save: (serverId, boardId, data) => ipcRenderer.invoke('cache:save', serverId, boardId, data),
    remove: (serverId, boardId) => ipcRenderer.invoke('cache:remove', serverId, boardId),
    list: (serverId) => ipcRenderer.invoke('cache:list', serverId),
  },
  media: {
    localUrl: (serverId, boardId, name) => ipcRenderer.sendSync('media:localUrl', serverId, boardId, name),
    save: (serverId, boardId, name, buffer) => ipcRenderer.invoke('media:save', serverId, boardId, name, buffer),
    download: (serverUrl, serverId, boardId, name) => ipcRenderer.invoke('media:download', serverUrl, serverId, boardId, name),
    upload: (serverUrl, targetBoardId, serverId, sourceBoardId, name) =>
      ipcRenderer.invoke('media:upload', serverUrl, targetBoardId, serverId, sourceBoardId, name),
    read: (serverId, boardId, name) => ipcRenderer.invoke('media:read', serverId, boardId, name).then((b) => (b ? new Blob([b]) : null)),
    prepare: async () => {},
  },
  // Locally added assets (icons, shapes, fonts) for work without a server.
  assets: {
    list: (kind) => ipcRenderer.invoke('assets:list', kind),
    save: (kind, name, buffer) => ipcRenderer.invoke('assets:save', kind, name, buffer),
    read: (kind, name) => ipcRenderer.invoke('assets:read', kind, name).then((b) => (b ? new Blob([b]) : null)),
    remove: (kind, name) => ipcRenderer.invoke('assets:remove', kind, name),
  },
});
