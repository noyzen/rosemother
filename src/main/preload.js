const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Renderer to Main (and back)
  getJobs: () => ipcRenderer.invoke('jobs:get'),
  setJobs: (jobs) => ipcRenderer.invoke('jobs:set', jobs),
  getJobErrors: () => ipcRenderer.invoke('jobErrors:get'),
  setJobErrors: (errors) => ipcRenderer.invoke('jobErrors:set', errors),
  openDialog: () => ipcRenderer.invoke('dialog:openDirectory'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  saveJsonDialog: (content) => ipcRenderer.invoke('dialog:saveJson', content),
  openJsonDialog: () => ipcRenderer.invoke('dialog:openJson'),
  
  // Renderer to Main (one-way)
  startJob: (id) => ipcRenderer.send('job:start', id),
  stopJob: (id) => ipcRenderer.send('job:stop', id),
  cleanupJob: (data) => ipcRenderer.send('job:cleanup', data),
  executeShutdown: () => ipcRenderer.send('system:shutdown'),
  
  // Main to Renderer
  onJobUpdate: (callback) => ipcRenderer.on('job:update', (_event, value) => callback(value)),
  onCleanupComplete: (callback) => ipcRenderer.on('job:cleanup-complete', (_event, value) => callback(value)),
  onLogMessage: (callback) => ipcRenderer.on('log:message', (_event, value) => callback(value)),
});