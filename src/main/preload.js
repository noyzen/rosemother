const { contextBridge } = require('electron');

// Expose minimal API for app info
contextBridge.exposeInMainWorld('appInfo', {
  platform: process.platform,
  versions: process.versions
});
