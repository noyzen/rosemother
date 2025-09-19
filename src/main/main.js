const { app, BrowserWindow, Menu, ipcMain, dialog, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const WindowState = require('electron-window-state');
const Store = require('electron-store');

const store = new Store();
let isLoggingEnabled = store.get('settings', { autoCleanup: false, loggingEnabled: true, preventSleep: false, cpuUsage: 'normal' }).loggingEnabled;
const stopFlags = new Map();
const runningJobsInMain = new Set();
let powerSaveBlockerId = null;

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

function logToRenderer(level, message) {
    if (!isLoggingEnabled) return;
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('log:message', { level, message });
    }
    const levelMap = { INFO: 'log', WARN: 'warn', ERROR: 'error', SUCCESS: 'log' };
    (console[levelMap[level]] || console.log)(`[${level}] ${message}`);
}

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

  mainWindow.webContents.on('did-finish-load', () => {
    logToRenderer('INFO', 'Application successfully started.');
  });

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

ipcMain.handle('dialog:saveJson', async (event, content) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Jobs',
        defaultPath: 'rosemother_jobs.json',
        filters: [{ name: 'JSON Files', extensions: ['json'] }]
    });
    if (!canceled && filePath) {
        try {
            await fs.writeFile(filePath, content);
            logToRenderer('SUCCESS', `Successfully exported jobs to ${filePath}`);
            return { success: true };
        } catch (error) {
            logToRenderer('ERROR', `Failed to save file: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    logToRenderer('INFO', 'Job export was canceled by user.');
    return { success: false, error: 'Save dialog canceled.' };
});

ipcMain.handle('dialog:openJson', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'Import Jobs',
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
        properties: ['openFile']
    });
    if (!canceled && filePaths.length > 0) {
        try {
            const content = await fs.readFile(filePaths[0], 'utf-8');
            logToRenderer('INFO', `Reading jobs for import from ${filePaths[0]}`);
            return { success: true, content };
        } catch (error) {
            logToRenderer('ERROR', `Failed to read file for import: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    logToRenderer('INFO', 'Job import was canceled by user.');
    return { success: false, error: 'Open dialog canceled.' };
});

ipcMain.handle('jobs:get', () => store.get('jobs', []));
ipcMain.handle('jobs:set', (event, jobs) => store.set('jobs', jobs));
ipcMain.handle('settings:get', () => store.get('settings', { autoCleanup: false, loggingEnabled: true, preventSleep: false, cpuUsage: 'normal' }));
ipcMain.handle('settings:set', (event, settings) => {
    if (typeof settings.loggingEnabled !== 'undefined') {
        isLoggingEnabled = settings.loggingEnabled;
    }
    store.set('settings', settings);
});

// Backup Logic
async function scanDirectory(dirPath, jobId, phase, sendUpdate) {
    const entries = new Map();
    const stack = [];

    try {
        const initialStats = await fs.stat(dirPath);
        if (initialStats.isDirectory()) {
            stack.push({ p: dirPath, r: '' }); // p: absolute path, r: relative path
        }
    } catch (error) {
        logToRenderer('ERROR', `Job ${jobId}: Cannot access ${phase.toLowerCase()} directory ${dirPath}: ${error.message}`);
        throw error;
    }
    
    logToRenderer('INFO', `Job ${jobId}: Starting ${phase} scan of ${dirPath}`);
    let processedCount = 0;
    let lastUpdateTime = Date.now();

    while (stack.length > 0) {
        if (stopFlags.has(jobId)) {
            return null; // Signal that the operation was stopped
        }

        const current = stack.pop();
        
        try {
            const dirents = await fs.readdir(current.p, { withFileTypes: true });

            for (const dirent of dirents) {
                const direntRelativePath = path.join(current.r, dirent.name);

                if (dirent.isDirectory()) {
                    entries.set(direntRelativePath, { type: 'dir' });
                    stack.push({ p: path.join(current.p, dirent.name), r: direntRelativePath });
                } else if (dirent.isFile()) {
                    try {
                        const fullPath = path.join(current.p, dirent.name);
                        const stats = await fs.stat(fullPath);
                        entries.set(direntRelativePath, { type: 'file', size: stats.size, mtime: stats.mtimeMs });
                    } catch (statError) {
                        logToRenderer('WARN', `Job ${jobId}: Could not stat file ${direntRelativePath}: ${statError.message}`);
                    }
                }
                
                processedCount++;
                const now = Date.now();
                if (now - lastUpdateTime > 250) { // Update UI every 250ms
                    sendUpdate('Scanning', 0, `${phase} scan in progress... Found ${processedCount.toLocaleString()} items.`);
                    lastUpdateTime = now;
                }
            }
        } catch (readError) {
            logToRenderer('WARN', `Job ${jobId}: Could not read directory ${current.p}: ${readError.message}`);
        }
    }
    
    logToRenderer('INFO', `Job ${jobId}: Finished ${phase} scan. Found ${entries.size} total items.`);
    sendUpdate('Scanning', 0, `Finished ${phase} scan. Found ${entries.size.toLocaleString()} items.`);
    return entries;
}


async function performCleanup(job, files) {
    if (!job || !files || files.length === 0) {
        return { success: false, error: "Job or files not found." };
    }
    logToRenderer('INFO', `Starting cleanup for job ${job.id}. Deleting ${files.length} items.`);
    try {
        const filesToDelete = files.filter(item => item.type === 'file').map(item => item.path);
        const dirsToDelete = files.filter(item => item.type === 'dir').map(item => item.path);

        for (const relativePath of filesToDelete) {
            await fs.unlink(path.join(job.destination, relativePath)).catch(err => logToRenderer('ERROR', `Failed to delete file ${relativePath}: ${err.message}`));
        }

        dirsToDelete.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
        for (const relativePath of dirsToDelete) {
            await fs.rmdir(path.join(job.destination, relativePath)).catch(err => logToRenderer('ERROR', `Failed to delete directory ${relativePath}: ${err.message}`));
        }
        logToRenderer('SUCCESS', `Cleanup for job ${job.id} completed.`);
        return { success: true };
    } catch (error) {
        logToRenderer('ERROR', `Error during cleanup for job ${job.id}: ${error.message}`);
        return { success: false, error: error.message };
    }
}

ipcMain.on('job:stop', (event, jobId) => {
    logToRenderer('WARN', `Stop request received for job ${jobId}.`);
    stopFlags.set(jobId, true);
});

ipcMain.on('job:start', async (event, jobId) => {
    const jobs = store.get('jobs', []);
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;

    try {
        if (runningJobsInMain.size === 0) {
            const settings = store.get('settings', {});
            if (settings.preventSleep) {
                powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
                if (powerSaveBlocker.isStarted(powerSaveBlockerId)) {
                    logToRenderer('INFO', 'System sleep is being prevented during job execution.');
                }
            }
        }
        runningJobsInMain.add(jobId);

        stopFlags.delete(jobId);

        logToRenderer('INFO', `Job ${jobId} started.`);
        const sendUpdate = (status, progress = 0, message = '', payload = {}) => {
            mainWindow.webContents.send('job:update', { jobId, status, progress, message, payload });
        };

        try {
            await fs.access(job.source);
            await fs.access(job.destination);
        } catch (err) {
            const errorMessage = `Path not found: ${err.path}. Please check the job configuration.`;
            sendUpdate('Error', 0, errorMessage, { errorType: 'PATH_ERROR' });
            logToRenderer('ERROR', `Job ${jobId} failed: ${errorMessage}`);
            return;
        }

        sendUpdate('Scanning', 0, 'Scanning source folder...');
        const sourceEntries = await scanDirectory(job.source, jobId, 'Source', sendUpdate);

        if (stopFlags.has(jobId)) {
            logToRenderer('WARN', `Job ${jobId} was stopped by the user during source scan.`);
            sendUpdate('Stopped', 0, 'Job stopped by user.');
            stopFlags.delete(jobId);
            return;
        }

        sendUpdate('Scanning', 0, 'Scanning destination folder...');
        const destEntries = await scanDirectory(job.destination, jobId, 'Destination', sendUpdate);

        if (stopFlags.has(jobId)) {
            logToRenderer('WARN', `Job ${jobId} was stopped by the user during destination scan.`);
            sendUpdate('Stopped', 0, 'Job stopped by user.');
            stopFlags.delete(jobId);
            return;
        }
        
        logToRenderer('INFO', `Job ${jobId}: Found ${sourceEntries.size} source items and ${destEntries.size} destination items.`);
        sendUpdate('Scanning', 0, 'Comparing file lists...');

        const toCreateDirs = [];
        for (const [relativePath, sourceEntry] of sourceEntries.entries()) {
            if (sourceEntry.type === 'dir' && !destEntries.has(relativePath)) {
                toCreateDirs.push(relativePath);
            }
        }
        toCreateDirs.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
        for (const relativePath of toCreateDirs) {
            if (stopFlags.has(jobId)) { // Check stop flag during directory creation
                logToRenderer('WARN', `Job ${jobId} was stopped by the user.`);
                sendUpdate('Stopped', 0, 'Job stopped by user.');
                stopFlags.delete(jobId);
                return;
            }
            await fs.mkdir(path.join(job.destination, relativePath), { recursive: true }).catch(error => {
                const errorMessage = `Failed to create directory: ${relativePath}. ${error.message}`;
                logToRenderer('ERROR', `Job ${jobId}: ${errorMessage}`);
            });
        }

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
        logToRenderer('INFO', `Job ${jobId}: Found ${toCopy.length} files to copy.`);

        const copyErrors = [];
        let copiedSize = 0;
        const copyStartTime = Date.now();

        for (let i = 0; i < toCopy.length; i++) {
            if (stopFlags.has(jobId)) {
                logToRenderer('WARN', `Job ${jobId} was stopped by the user.`);
                sendUpdate('Stopped', (totalCopySize > 0 ? (copiedSize / totalCopySize) * 100 : 0), 'Job stopped by user.');
                stopFlags.delete(jobId);
                return;
            }

            const relativePath = toCopy[i];

            const elapsedTime = Date.now() - copyStartTime;
            const copySpeed = elapsedTime > 500 && copiedSize > 0 ? copiedSize / elapsedTime : 0; // bytes/ms
            const remainingSize = totalCopySize - copiedSize;
            const eta = copySpeed > 0 ? remainingSize / copySpeed : 0; // in ms

            const updatePayload = {
                ...(copyErrors.length > 0 && { copyErrors }),
                eta
            };

            sendUpdate('Copying', totalCopySize > 0 ? (copiedSize / totalCopySize) * 100 : 0, `Copying file ${i + 1} of ${toCopy.length}: ${relativePath}`, updatePayload);
            try {
                const destPath = path.join(job.destination, relativePath);
                await fs.mkdir(path.dirname(destPath), { recursive: true });
                await fs.copyFile(path.join(job.source, relativePath), destPath);
                copiedSize += sourceEntries.get(relativePath).size;
            } catch (error) {
                const errorMessage = `Failed to copy: ${relativePath}. ${error.message}`;
                copyErrors.push({ path: relativePath, error: error.message });
                logToRenderer('ERROR', `Job ${jobId}: ${errorMessage}`);
            }
        }

        if (stopFlags.has(jobId)) {
            logToRenderer('WARN', `Job ${jobId} was stopped by the user after copy phase.`);
            sendUpdate('Stopped', 100, 'Job stopped by user.');
            stopFlags.delete(jobId);
            return;
        }

        let finalStatus = copyErrors.length > 0 ? 'DoneWithErrors' : 'Done';
        let finalMessage;
        const payload = copyErrors.length > 0 ? { copyErrors } : {};

        sendUpdate(finalStatus, 100, 'Checking for files to delete...', payload);
        const toDelete = [];
        for (const [relativePath, destEntry] of destEntries.entries()) {
            if (!sourceEntries.has(relativePath)) {
                toDelete.push({ path: relativePath, type: destEntry.type });
            }
        }
        payload.filesToDelete = toDelete;
        logToRenderer('INFO', `Job ${jobId}: Found ${toDelete.length} items to delete from destination.`);

        const settings = store.get('settings', { autoCleanup: false });
        if (settings.autoCleanup && toDelete.length > 0 && copyErrors.length === 0) {
            sendUpdate(finalStatus, 100, `Auto-cleaning ${toDelete.length} item(s)...`, payload);
            const cleanupResult = await performCleanup(job, toDelete);
            if (cleanupResult.success) {
                finalMessage = `Backup and cleanup completed successfully at ${new Date().toLocaleTimeString()}.`;
                logToRenderer('SUCCESS', `Job ${jobId}: ${finalMessage}`);
            } else {
                finalStatus = 'DoneWithErrors';
                finalMessage = `Backup complete, but auto-cleanup failed: ${cleanupResult.error}`;
                logToRenderer('WARN', `Job ${jobId}: ${finalMessage}`);
            }
            sendUpdate(finalStatus, 100, finalMessage, payload);
        } else {
            if (copyErrors.length > 0) {
                finalMessage = `Backup finished with ${copyErrors.length} error(s).`;
                if (toDelete.length > 0) finalMessage += ` ${toDelete.length} item(s) pending cleanup.`;
                if (settings.autoCleanup && toDelete.length > 0) finalMessage += ' Auto-cleanup was skipped due to copy errors.';
            } else {
                finalMessage = toDelete.length > 0
                    ? `Backup complete. ${toDelete.length} item(s) pending cleanup.`
                    : `Backup completed successfully at ${new Date().toLocaleTimeString()}.`;
            }
            sendUpdate(finalStatus, 100, finalMessage, payload);
            logToRenderer(finalStatus === 'Done' ? 'SUCCESS' : 'WARN', `Job ${jobId}: ${finalMessage}`);
        }
    } finally {
        runningJobsInMain.delete(jobId);
        if (runningJobsInMain.size === 0 && powerSaveBlockerId) {
            powerSaveBlocker.stop(powerSaveBlockerId);
            logToRenderer('INFO', 'System sleep prevention has been lifted.');
            powerSaveBlockerId = null;
        }
    }
});

ipcMain.on('job:cleanup', async (event, { jobId, files }) => {
    const jobs = store.get('jobs', []);
    const job = jobs.find(j => j.id === jobId);
    if (!job) {
        mainWindow.webContents.send('job:cleanup-complete', { jobId, success: false, error: "Job not found." });
        return;
    }
    const result = await performCleanup(job, files);
    mainWindow.webContents.send('job:cleanup-complete', { jobId, ...result });
});