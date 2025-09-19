



const { app, BrowserWindow, Menu, ipcMain, dialog, powerSaveBlocker } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs/promises');
const { createHash } = require('crypto');
const { createReadStream } = require('fs');
const WindowState = require('electron-window-state');
const Store = require('electron-store');

const store = new Store();
let isLoggingEnabled = store.get('settings', { loggingEnabled: true, preventSleep: false, autoCleanup: false }).loggingEnabled;
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
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
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
ipcMain.handle('jobErrors:get', () => store.get('jobErrors', {}));
ipcMain.handle('jobErrors:set', (event, errors) => store.set('jobErrors', errors));
ipcMain.handle('settings:get', () => store.get('settings', { loggingEnabled: true, preventSleep: false, autoCleanup: false }));
ipcMain.handle('settings:set', (event, settings) => {
    if (typeof settings.loggingEnabled !== 'undefined') {
        isLoggingEnabled = settings.loggingEnabled;
    }
    store.set('settings', settings);
});

async function calculateFileHash(filePath, jobId) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(filePath);
        stream.on('data', (chunk) => {
            if (stopFlags.has(jobId)) {
                stream.destroy();
                resolve(null); // Stopped
                return;
            }
            hash.update(chunk);
        });
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// Backup Logic
async function performCleanup(job, files) {
    if (!job || !files || files.length === 0) {
        return { success: false, error: "Job or files not found." };
    }
    logToRenderer('INFO', `Starting cleanup for job ${job.id}. Deleting ${files.length} items.`);
    try {
        const filesToDelete = files.filter(item => item.type === 'file').map(item => item.path);
        const dirsToDelete = files.filter(item => item.type === 'dir').map(item => item.path);

        for (const relativePath of filesToDelete) {
            await fs.rm(path.join(job.destination, relativePath), { force: true }).catch(err => logToRenderer('ERROR', `Failed to delete file ${relativePath}: ${err.message}`));
        }

        dirsToDelete.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
        for (const relativePath of dirsToDelete) {
            await fs.rm(path.join(job.destination, relativePath), { recursive: true, force: true }).catch(err => logToRenderer('ERROR', `Failed to delete directory ${relativePath}: ${err.message}`));
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

    const settings = store.get('settings', { loggingEnabled: true, preventSleep: false, autoCleanup: false });

    const sendUpdate = (status, progress = 0, message = '', payload = {}) => {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
            mainWindow.webContents.send('job:update', { jobId, status, progress, message, payload });
        }
    };

    // Store indexes in the app's user data directory for safety and persistence.
    const indexesPath = path.join(app.getPath('userData'), 'job_indexes');
    await fs.mkdir(indexesPath, { recursive: true });
    const indexFilePath = path.join(indexesPath, `${job.id}.json`);
    const tempIndexFilePath = `${indexFilePath}.tmp`;

    let destIndex = {};
    
    // --- Throttled Saving Logic ---
    let saveTimeout = null;
    const SAVE_INTERVAL = 3000;
    const scheduleSave = () => {
        if (saveTimeout) return; // A save is already scheduled
        saveTimeout = setTimeout(async () => {
            saveTimeout = null; // Clear lock so a new save can be scheduled
            if (stopFlags.has(jobId)) return;
            try {
                const indexToSave = {
                    destinationPath: job.destination,
                    files: destIndex,
                };
                await fs.writeFile(tempIndexFilePath, JSON.stringify(indexToSave));
            } catch (e) {
                logToRenderer('WARN', `Job ${jobId}: Periodic index save failed: ${e.message}`);
            }
        }, SAVE_INTERVAL);
    };
    // --- End Throttled Saving ---

    try {
        const allErrors = store.get('jobErrors', {});
        delete allErrors[jobId];
        store.set('jobErrors', allErrors);

        if (runningJobsInMain.size === 0) {
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

        try {
            await fs.access(job.source);
            await fs.mkdir(job.destination, { recursive: true });
        } catch (err) {
            const errorMessage = `Path not found or accessible: ${err.path}.`;
            sendUpdate('Error', 0, errorMessage, { errorType: 'PATH_ERROR' });
            logToRenderer('ERROR', `Job ${jobId} failed: ${errorMessage}`);
            return;
        }

        const copyErrors = [];
        let needsIndexBuild = false;

        sendUpdate('Copying', -1, 'Loading destination index...');
        try {
            const indexData = await fs.readFile(indexFilePath, 'utf-8');
            const parsedIndex = JSON.parse(indexData);
            if (parsedIndex.destinationPath !== job.destination) {
                logToRenderer('WARN', `Job ${jobId}: Destination path has changed. Rebuilding index.`);
                needsIndexBuild = true;
            } else {
                destIndex = parsedIndex.files || {};
            }
        } catch (e) {
            logToRenderer('WARN', `Job ${jobId}: Destination index not found or corrupted. A new one will be built.`);
            needsIndexBuild = true;
        }

        if (needsIndexBuild) {
            destIndex = {}; // Clear old data if rebuilding
            let scannedFileCount = 0;
            async function buildFastIndex(relativeDir) {
                if (stopFlags.has(jobId)) return;
                const dir = path.join(job.destination, relativeDir);
                let dirents;
                try { dirents = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return; }

                for (const dirent of dirents) {
                    if (stopFlags.has(jobId)) return;
                    
                    const relativePath = path.join(relativeDir, dirent.name);
                    if (dirent.isDirectory()) {
                        await buildFastIndex(relativePath);
                    } else if (dirent.isFile()) {
                        scannedFileCount++;
                        sendUpdate('Copying', -1, `Scanning destination: ${scannedFileCount.toLocaleString()} files...`);
                        const fullPath = path.join(dir, dirent.name);
                        try {
                            const stats = await fs.stat(fullPath);
                            // Store only metadata. Hash will be added on-demand.
                            destIndex[relativePath] = { size: stats.size, mtimeMs: stats.mtimeMs };
                            scheduleSave();
                        } catch (err) { logToRenderer('WARN', `Job ${jobId}: Could not scan ${relativePath}: ${err.message}`); }
                    }
                }
            }
            logToRenderer('INFO', `Job ${jobId}: Starting fast destination scan.`);
            await buildFastIndex('');
            if (stopFlags.has(jobId)) {
                logToRenderer('WARN', `Job ${jobId} was stopped during destination scan.`);
                sendUpdate('Stopped', 0, 'Job stopped by user.');
                return;
            }
        }
        
        const hashToPathMap = Object.entries(destIndex).reduce((acc, [path, meta]) => {
            if (meta.hash) {
                acc[meta.hash] = path;
            }
            return acc;
        }, {});

        const sourcePaths = new Set();
        let processedFiles = 0;

        async function syncDirectory(relativeDir) {
            if (stopFlags.has(jobId)) return;
            const sourceDir = path.join(job.source, relativeDir);
            let dirents;
            try { dirents = await fs.readdir(sourceDir, { withFileTypes: true }); } catch (err) { return; }

            for (const dirent of dirents) {
                if (stopFlags.has(jobId)) return;
                const relativePath = path.join(relativeDir, dirent.name);
                sourcePaths.add(relativePath);

                const sourcePath = path.join(job.source, relativePath);
                const destPath = path.join(job.destination, relativePath);
                
                if (dirent.isDirectory()) {
                    try { await fs.mkdir(destPath, { recursive: true }); } catch (e) {}
                    await syncDirectory(relativePath);
                } else if (dirent.isFile()) {
                    processedFiles++;
                    sendUpdate('Copying', -1, `Processing: ${processedFiles.toLocaleString()} files...`);
                    try {
                        const sourceStats = await fs.stat(sourcePath);
                        const destEntry = destIndex[relativePath];

                        // Optimization: Skip hashing if file metadata is identical.
                        if (destEntry && destEntry.size === sourceStats.size && destEntry.mtimeMs === sourceStats.mtimeMs) {
                            continue;
                        }

                        // Hashing is required now to determine the next step.
                        const sourceHash = await calculateFileHash(sourcePath, jobId);
                        if (!sourceHash) continue; // Stopped or error during hashing

                        // Skip if content hash is identical (metadata changed, but content didn't).
                        if (destEntry && destEntry.hash === sourceHash) {
                            continue;
                        }

                        // Check if this content exists elsewhere (a move/rename).
                        const movedPath = hashToPathMap[sourceHash];
                        if (movedPath && movedPath !== relativePath) {
                            sendUpdate('Copying', -1, `Moving: ${movedPath} -> ${relativePath}`);
                            const oldFullPath = path.join(job.destination, movedPath);
                            await fs.rename(oldFullPath, destPath);
                            delete destIndex[movedPath]; // Remove old index entry
                            logToRenderer('INFO', `Job ${jobId}: Detected move for ${relativePath}`);
                        } else {
                            // This is a new or truly modified file, so copy it.
                            sendUpdate('Copying', -1, `Copying: ${relativePath}`);
                            await fs.copyFile(sourcePath, destPath);
                        }

                        // Update timestamps and the index with the new hash.
                        await fs.utimes(destPath, new Date(sourceStats.mtimeMs), new Date(sourceStats.mtimeMs));
                        destIndex[relativePath] = { size: sourceStats.size, mtimeMs: sourceStats.mtimeMs, hash: sourceHash };
                        hashToPathMap[sourceHash] = relativePath;
                        scheduleSave();
                    } catch (error) {
                        const errorMessage = `Failed to process: ${relativePath}. ${error.message}`;
                        copyErrors.push({ path: relativePath, error: error.message });
                        logToRenderer('ERROR', `Job ${jobId}: ${errorMessage}`);
                    }
                }
            }
        }

        sendUpdate('Copying', -1, 'Starting backup process...');
        await syncDirectory('');

        if (stopFlags.has(jobId)) {
            logToRenderer('WARN', `Job ${jobId} was stopped by the user.`);
            sendUpdate('Stopped', 0, 'Job stopped by user.');
            return;
        }

        if (copyErrors.length > 0) {
            const allErrors = store.get('jobErrors', {});
            allErrors[jobId] = copyErrors;
            store.set('jobErrors', allErrors);
        }

        sendUpdate('Cleaning', -1, 'Checking for files to delete...');
        const toDelete = [];
        for (const destPath in destIndex) {
            if (!sourcePaths.has(destPath)) {
                toDelete.push({ path: destPath, type: 'file' }); // Simplified, assumes files for now
                delete destIndex[destPath];
            }
        }
        // A more robust orphan check would need to find empty dirs too, but this is a good start.
        logToRenderer('INFO', `Job ${jobId}: Found ${toDelete.length} orphan items in destination.`);
        
        let finalStatus = copyErrors.length > 0 ? 'DoneWithErrors' : 'Done';
        const payload = { 
            ...(copyErrors.length > 0 && { copyErrors }),
            filesToDelete: toDelete 
        };
        
        let finalMessage;
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
        
        if (saveTimeout) clearTimeout(saveTimeout);
        // Atomically save the index. Use non-prettified JSON for performance with large file lists.
        const newIndexData = {
            destinationPath: job.destination,
            files: destIndex,
        };
        await fs.writeFile(tempIndexFilePath, JSON.stringify(newIndexData));
        await fs.rename(tempIndexFilePath, indexFilePath);
        logToRenderer('INFO', `Job ${jobId}: Destination index saved.`);

    } catch(err) {
        logToRenderer('ERROR', `A critical error occurred in job ${jobId}: ${err.message}\n${err.stack}`);
        sendUpdate('Error', 0, `A critical error occurred: ${err.message}`);
    } finally {
        runningJobsInMain.delete(jobId);
        stopFlags.delete(jobId);
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

ipcMain.on('system:shutdown', () => {
    logToRenderer('WARN', 'Shutdown command received. Shutting down the system.');
    const command = process.platform === 'win32' ? 'shutdown /s /t 0' : 'shutdown -h now';
    exec(command, (error, stdout, stderr) => {
        if (error) {
            logToRenderer('ERROR', `Shutdown failed: ${error.message}`);
            return;
        }
        if (stderr) {
            logToRenderer('ERROR', `Shutdown stderr: ${stderr}`);
            return;
        }
        logToRenderer('INFO', `Shutdown stdout: ${stdout}`);
    });
});