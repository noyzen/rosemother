const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Renderer to Main (and back)
  getJobs: () => ipcRenderer.invoke('jobs:get'),
  setJobs: (jobs) => ipcRenderer.invoke('jobs:set', jobs),
  openDialog: () => ipcRenderer.invoke('dialog:openDirectory'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  saveJsonDialog: (content) => ipcRenderer.invoke('dialog:saveJson', content),
  openJsonDialog: () => ipcRenderer.invoke('dialog:openJson'),
  
  // Renderer to Main (one-way)
  startJob: (id) => ipcRenderer.send('job:start', id),
  cleanupJob: (data) => ipcRenderer.send('job:cleanup', data),
  
  // Main to Renderer
  onJobUpdate: (callback) => ipcRenderer.on('job:update', (_event, value) => callback(value)),
  onCleanupComplete: (callback) => ipcRenderer.on('job:cleanup-complete', (_event, value) => callback(value)),
});
