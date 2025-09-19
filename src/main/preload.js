const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Renderer to Main (and back)
  getJobs: () => ipcRenderer.invoke('jobs:get'),
  setJobs: (jobs) => ipcRenderer.invoke('jobs:set', jobs),
  openDialog: () => ipcRenderer.invoke('dialog:openDirectory'),
  
  // Renderer to Main (one-way)
  startJob: (id) => ipcRenderer.send('job:start', id),
  
  // Main to Renderer
  onJobUpdate: (callback) => ipcRenderer.on('job:update', (_event, value) => callback(value)),

  // Special handler for delete confirmation
  handleConfirmDelete: (callback) => {
    // This is tricky. We'll use a one-time listener setup.
    ipcRenderer.removeHandler('job:confirm-delete'); // Clean up previous handler
    ipcRenderer.handle('job:confirm-delete', async (_event, value) => {
      return await callback(value);
    });
  }
});
