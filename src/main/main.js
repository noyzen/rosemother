const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const WindowState = require('electron-window-state');
const Store = require('electron-store');

const store = new Store();

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
  const mainWindowState = WindowState({
    defaultWidth: 1000,
    defaultHeight: 700
  });

  mainWindow = new BrowserWindow({
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, '../../appicon.png'),
    backgroundColor: '#121212',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindowState.manage(mainWindow);
  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isCtrlOrCmd = process.platform === 'darwin' ? input.meta : input.control;
    if (isCtrlOrCmd && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.isDevToolsOpened()
        ? mainWindow.webContents.closeDevTools()
        : mainWindow.webContents.openDevTools({ mode: 'detach' });
      event.preventDefault();
    }
  });
}

app.on('ready', createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// IPC Handlers
ipcMain.handle('dialog:openDirectory', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (!canceled) {
    return filePaths[0];
  }
});

ipcMain.handle('jobs:get', () => store.get('jobs', []));
ipcMain.handle('jobs:set', (event, jobs) => store.set('jobs', jobs));

// Backup Logic
async function getFileSystemEntries(dir) {
    const entries = new Map();
    try {
        const dirents = await fs.readdir(dir, { withFileTypes: true, recursive: true });
        for (const dirent of dirents) {
            const fullPath = path.join(dirent.path, dirent.name);
            const relativePath = path.relative(dir, fullPath);
            if (dirent.isFile()) {
                const stats = await fs.stat(fullPath);
                entries.set(relativePath, { type: 'file', size: stats.size, mtime: stats.mtimeMs });
            } else if (dirent.isDirectory()) {
                entries.set(relativePath, { type: 'dir' });
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') console.error(`Error reading directory ${dir}:`, error);
    }
    return entries;
}

ipcMain.on('job:start', async (event, jobId) => {
    const jobs = store.get('jobs', []);
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;

    const sendUpdate = (status, progress = 0, message = '', payload = {}) => {
        mainWindow.webContents.send('job:update', { jobId, status, progress, message, payload });
    };

    try {
        await fs.access(job.source);
        await fs.access(job.destination);
    } catch (err) {
        sendUpdate('Error', 0, `Path not found: ${err.path}`);
        return;
    }

    sendUpdate('Scanning', 0, 'Scanning source and destination folders...');
    const [sourceEntries, destEntries] = await Promise.all([getFileSystemEntries(job.source), getFileSystemEntries(job.destination)]);

    // Create missing directories
    sendUpdate('Copying', 0, 'Creating directory structure...');
    const toCreateDirs = [];
    for (const [relativePath, sourceEntry] of sourceEntries.entries()) {
        if (sourceEntry.type === 'dir' && !destEntries.has(relativePath)) {
            toCreateDirs.push(relativePath);
        }
    }

    // Sort by path depth to ensure parent directories are created first
    toCreateDirs.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);

    for (const relativePath of toCreateDirs) {
        const destPath = path.join(job.destination, relativePath);
        try {
            await fs.mkdir(destPath, { recursive: true });
        } catch (error) {
            sendUpdate('Error', 0, `Failed to create directory: ${relativePath}. ${error.message}`);
            return;
        }
    }


    // Identify files to copy
    const toCopy = [];
    let totalCopySize = 0;
    for (const [relativePath, sourceEntry] of sourceEntries.entries()) {
        if (sourceEntry.type === 'file') {
            const destEntry = destEntries.get(relativePath);
            if (!destEntry || destEntry.size !== sourceEntry.size || destEntry.mtime !== sourceEntry.mtime) {
                toCopy.push(relativePath);
                totalCopySize += sourceEntry.size;
            }
        }
    }

    let copiedSize = 0;
    for (let i = 0; i < toCopy.length; i++) {
        const relativePath = toCopy[i];
        const sourcePath = path.join(job.source, relativePath);
        const destPath = path.join(job.destination, relativePath);
        
        sendUpdate(
            'Copying',
            totalCopySize > 0 ? (copiedSize / totalCopySize) * 100 : 0,
            `Copying file ${i + 1} of ${toCopy.length}: ${relativePath}`
        );

        try {
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await fs.copyFile(sourcePath, destPath);
            const sourceStat = sourceEntries.get(relativePath);
            if (sourceStat) {
                copiedSize += sourceStat.size;
            }
        } catch (error) {
            sendUpdate('Error', 0, `Failed to copy: ${relativePath}. ${error.message}`);
            return;
        }
    }

    sendUpdate('Syncing', 100, 'Checking for files to delete...');
    const toDelete = [];
    for (const [relativePath, destEntry] of destEntries.entries()) {
        if (!sourceEntries.has(relativePath)) {
            toDelete.push({ path: relativePath, type: destEntry.type });
        }
    }

    const finalMessage = toDelete.length > 0
        ? `Backup complete. ${toDelete.length} item(s) pending cleanup.`
        : `Backup completed successfully at ${new Date().toLocaleTimeString()}.`;

    sendUpdate('Done', 100, finalMessage, { filesToDelete: toDelete });
});

ipcMain.on('job:cleanup', async (event, { jobId, files }) => {
    const jobs = store.get('jobs', []);
    const job = jobs.find(j => j.id === jobId);
    if (!job || !files || files.length === 0) {
        mainWindow.webContents.send('job:cleanup-complete', { jobId, success: false, error: "Job or files not found." });
        return;
    }

    try {
        const filesToDelete = files.filter(item => item.type === 'file').map(item => item.path);
        const dirsToDelete = files.filter(item => item.type === 'dir').map(item => item.path);

        // Delete files first
        for (const relativePath of filesToDelete) {
            const destPath = path.join(job.destination, relativePath);
            try {
                await fs.unlink(destPath);
            } catch (error) {
                 console.error(`Failed to delete file ${destPath}:`, error);
            }
        }

        // Delete directories, longest path first to ensure they are empty
        dirsToDelete.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
        for (const relativePath of dirsToDelete) {
            const destPath = path.join(job.destination, relativePath);
            try {
                await fs.rmdir(destPath);
            } catch (error) {
                 console.error(`Failed to delete directory ${destPath}:`, error);
            }
        }
        
        mainWindow.webContents.send('job:cleanup-complete', { jobId, success: true });

    } catch (error) {
        console.error(`Error during cleanup for job ${jobId}:`, error);
        mainWindow.webContents.send('job:cleanup-complete', { jobId, success: false, error: error.message });
    }
});
