const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Renderer to Main (and back)
  getJobs: () => ipcRenderer.invoke('jobs:get'),
  setJobs: (jobs) => ipcRenderer.invoke('jobs:set', jobs),
  openDialog: () => ipcRenderer.invoke('dialog:openDirectory'),
  
  // Renderer to Main (one-way)
  startJob: (id) => ipcRenderer.send('job:start', id),
  sendDeleteConfirmation: (jobId, confirmed) => ipcRenderer.send(`job:confirm-delete-response-${jobId}`, confirmed),
  
  // Main to Renderer
  onJobUpdate: (callback) => ipcRenderer.on('job:update', (_event, value) => callback(value)),
  onDeleteRequest: (callback) => ipcRenderer.on('job:request-delete-confirmation', (_event, value) => callback(value)),
});