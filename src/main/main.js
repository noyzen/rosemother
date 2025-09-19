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
async function getFiles(dir) {
    const files = new Map();
    try {
        const dirents = await fs.readdir(dir, { withFileTypes: true, recursive: true });
        for (const dirent of dirents) {
            if (dirent.isFile()) {
                const fullPath = path.join(dirent.path, dirent.name);
                const relativePath = path.relative(dir, fullPath);
                const stats = await fs.stat(fullPath);
                files.set(relativePath, { size: stats.size, mtime: stats.mtimeMs });
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') console.error(`Error reading directory ${dir}:`, error);
    }
    return files;
}

ipcMain.on('job:start', async (event, jobId) => {
    const jobs = store.get('jobs', []);
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;

    const sendUpdate = (status, progress = 0, message = '') => {
        mainWindow.webContents.send('job:update', { jobId, status, progress, message });
    };

    try {
        await fs.access(job.source);
        await fs.access(job.destination);
    } catch (err) {
        sendUpdate('Error', 0, `Path not found: ${err.path}`);
        return;
    }

    sendUpdate('Scanning', 0, 'Scanning source and destination folders...');
    const [sourceFiles, destFiles] = await Promise.all([getFiles(job.source), getFiles(job.destination)]);

    const toCopy = [];
    let totalCopySize = 0;
    for (const [relativePath, sourceStat] of sourceFiles.entries()) {
        const destStat = destFiles.get(relativePath);
        if (!destStat || destStat.size !== sourceStat.size || destStat.mtime !== sourceStat.mtime) {
            toCopy.push(relativePath);
            totalCopySize += sourceStat.size;
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
            const sourceStat = sourceFiles.get(relativePath);
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
    for (const relativePath of destFiles.keys()) {
        if (!sourceFiles.has(relativePath)) {
            toDelete.push(relativePath);
        }
    }

    if (toDelete.length > 0) {
        const userChoice = await mainWindow.webContents.invoke('job:confirm-delete', { jobId, files: toDelete });
        if (userChoice && userChoice.confirmed) {
            for (const relativePath of toDelete) {
                const destPath = path.join(job.destination, relativePath);
                try {
                    await fs.unlink(destPath);
                } catch (error) {
                     console.error(`Failed to delete ${destPath}:`, error);
                }
            }
            // Simple empty directory cleanup
            try {
                const destDirs = Array.from(destFiles.keys()).map(f => path.dirname(f)).sort((a,b) => b.length - a.length);
                for(const dir of [...new Set(destDirs)]){
                    const fullDirPath = path.join(job.destination, dir);
                    try {
                        const filesInDir = await fs.readdir(fullDirPath);
                        if(filesInDir.length === 0){
                            await fs.rmdir(fullDirPath);
                        }
                    } catch (readErr) {
                        // Ignore if directory doesn't exist anymore
                        if (readErr.code !== 'ENOENT') console.error("Could not read directory for pruning", readErr);
                    }
                }
            } catch(e) {
                console.error("Could not prune empty directories", e);
            }
        }
    }

    sendUpdate('Done', 100, `Backup completed successfully at ${new Date().toLocaleTimeString()}.`);
});