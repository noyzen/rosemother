const { app, BrowserWindow, Menu, nativeTheme } = require('electron');
const path = require('path');
const WindowState = require('electron-window-state');

// Disable hardware acceleration for better compatibility on some VMs (optional)
// app.disableHardwareAcceleration();

// Ensure single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

let mainWindow;

function createWindow() {
  // Load previous window state with fallback to defaults
  const mainWindowState = WindowState({
    defaultWidth: 1000,
    defaultHeight: 700
  });

  mainWindow = new BrowserWindow({
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 600,
    minHeight: 400,
    icon: path.join(__dirname, '../../appicon.png'),
    // Use OS default frame (frame: true is default)
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Let windowState manager watch and save state
  mainWindowState.manage(mainWindow);

  // Remove the default menu entirely
  Menu.setApplicationMenu(null);

  // Load index.html
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Optional: Open devtools in dev mode
  if (!app.isPackaged) {
    // mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Allow toggling devtools with Ctrl+Shift+I on all platforms
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isCtrlOrCmd = process.platform === 'darwin' ? input.meta : input.control;
    if (isCtrlOrCmd && input.shift && input.key.toLowerCase() === 'i') {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
      event.preventDefault();
    }
  });
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  // quit on all platforms for this simple app
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
