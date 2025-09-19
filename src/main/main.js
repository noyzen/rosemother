

const { app, BrowserWindow, Menu, ipcMain, dialog, powerSaveBlocker } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs/promises');
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

function sendUpdateForJob(jobId, status, progress = 0, message = '', payload = {}) {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send('job:update', { jobId, status, progress, message, payload });
    }
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

ipcMain.handle('dialog:openDirectoryAt', async (event, defaultPath) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: defaultPath
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

function isExcluded(relativePath, jobExclusions) {
    if (!jobExclusions || !jobExclusions.enabled) return false;

    const lowerCaseRelativePath = relativePath.toLowerCase();

    // Check excluded paths (case-insensitive)
    // This now checks if the item's path starts with an excluded path.
    if (jobExclusions.paths && jobExclusions.paths.length > 0) {
        for (const excludedPath of jobExclusions.paths) {
            const lowerCaseExcludedPath = excludedPath.toLowerCase();
            if (lowerCaseRelativePath === lowerCaseExcludedPath || lowerCaseRelativePath.startsWith(lowerCaseExcludedPath + path.sep)) {
                return true;
            }
        }
    }

    // Check excluded extensions (case-insensitive)
    if (jobExclusions.extensions && jobExclusions.extensions.length > 0) {
        const lowerCaseExcludedExts = jobExclusions.extensions.map(e => e.toLowerCase().startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`);
        const ext = path.extname(lowerCaseRelativePath).toLowerCase();
        if (ext && lowerCaseExcludedExts.includes(ext)) return true;
    }

    return false;
}

async function countFiles(startPath, jobId, job = null) {
    logToRenderer('INFO', `Job ${jobId}: countFiles started for path: ${startPath}`);
    let fileCount = 0;
    let dirCount = 0;
    const queue = [startPath];
    const LOG_INTERVAL = 500; // Log every 500 directories

    while (queue.length > 0) {
        if (stopFlags.has(jobId)) {
            logToRenderer('WARN', `Job ${jobId}: countFiles received stop signal.`);
            throw new Error('COUNT_STOPPED');
        }
        const currentPath = queue.shift();

        // Periodically log progress
        dirCount++;
        if (dirCount % LOG_INTERVAL === 0) {
            logToRenderer('INFO', `Job ${jobId}: countFiles progress - Dirs processed: ${dirCount}, Queue size: ${queue.length}. Next to process: ${currentPath}`);
        }

        let dirents;
        try {
            dirents = await fs.readdir(currentPath, { withFileTypes: true });
        } catch (e) {
            logToRenderer('WARN', `Job ${jobId}: countFiles could not read directory ${currentPath}. Error: ${e.message}`);
            continue;
        }

        for (const dirent of dirents) {
            const fullPath = path.join(currentPath, dirent.name);
            const relativePath = path.relative(startPath, fullPath);

            if (job && job.exclusions && isExcluded(relativePath, job.exclusions)) {
                continue;
            }

            if (dirent.isDirectory()) {
                queue.push(fullPath);
            } else if (dirent.isFile()) {
                fileCount++;
            }
        }
    }
    logToRenderer('INFO', `Job ${jobId}: countFiles finished for path: ${startPath}. Total files: ${fileCount}, Dirs: ${dirCount}.`);
    return fileCount;
}

// Backup Logic
async function performCleanup(job, files, progressCallback) {
    if (!job || !files || files.length === 0) {
        return { success: false, error: "Job or files not found." };
    }
    logToRenderer('INFO', `Starting cleanup for job ${job.id}. Deleting ${files.length} items.`);
    try {
        const filesToDelete = files.filter(item => item.type === 'file').map(item => item.path);
        const dirsToDelete = files.filter(item => item.type === 'dir').map(item => item.path);
        
        const totalCount = filesToDelete.length + dirsToDelete.length;
        let deletedCount = 0;

        for (const relativePath of filesToDelete) {
            await fs.rm(path.join(job.destination, relativePath), { force: true }).catch(err => logToRenderer('ERROR', `Failed to delete file ${relativePath}: ${err.message}`));
            deletedCount++;
            if (progressCallback) {
                const progress = totalCount > 0 ? (deletedCount / totalCount) * 100 : 100;
                progressCallback(progress, `Deleting file ${deletedCount} of ${totalCount}`);
            }
        }

        dirsToDelete.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
        for (const relativePath of dirsToDelete) {
            await fs.rm(path.join(job.destination, relativePath), { recursive: true, force: true }).catch(err => logToRenderer('ERROR', `Failed to delete directory ${relativePath}: ${err.message}`));
            deletedCount++;
            if (progressCallback) {
                const progress = totalCount > 0 ? (deletedCount / totalCount) * 100 : 100;
                progressCallback(progress, `Deleting folder ${deletedCount} of ${totalCount}`);
            }
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
    if (runningJobsInMain.has(jobId)) {
        logToRenderer('WARN', `Job ${jobId} is already running. Start request ignored.`);
        return;
    }

    const jobs = store.get('jobs', []);
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;

    const settings = store.get('settings', { loggingEnabled: true, preventSleep: false, autoCleanup: false });
    const sendUpdate = (status, progress, message, payload) => sendUpdateForJob(jobId, status, progress, message, payload);

    const indexesPath = path.join(app.getPath('userData'), 'job_indexes');
    await fs.mkdir(indexesPath, { recursive: true });
    const indexFilePath = path.join(indexesPath, `${job.id}.json`);
    const tempIndexFilePath = `${indexFilePath}.tmp`;

    let destIndex = {};
    
    let saveTimeout = null;
    const SAVE_INTERVAL = 3000;
    const scheduleSave = () => {
        if (saveTimeout) return;
        saveTimeout = setTimeout(async () => {
            saveTimeout = null;
            if (stopFlags.has(jobId)) return;
            try {
                const indexToSave = { destinationPath: job.destination, files: destIndex };
                await fs.writeFile(tempIndexFilePath, JSON.stringify(indexToSave));
            } catch (e) {
                logToRenderer('WARN', `Job ${jobId}: Periodic index save failed: ${e.message}`);
            }
        }, SAVE_INTERVAL);
    };

    runningJobsInMain.add(jobId);
    stopFlags.delete(jobId);

    try {
        if (runningJobsInMain.size === 1) { // Only when the first job starts
            if (settings.preventSleep) {
                powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
                if (powerSaveBlocker.isStarted(powerSaveBlockerId)) {
                    logToRenderer('INFO', 'System sleep is being prevented during job execution.');
                }
            }
        }
        
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

        sendUpdate('Scanning', -1, 'Loading destination index...');
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
            destIndex = {};
            sendUpdate('Scanning', -1, 'Counting destination files...');
            let totalFileCount = 0;
            try {
                logToRenderer('INFO', `Job ${jobId}: Starting to count destination files at ${job.destination}.`);
                totalFileCount = await countFiles(job.destination, jobId);
                if (stopFlags.has(jobId)) { throw new Error('COUNT_STOPPED'); } // Re-check after long operation
                logToRenderer('INFO', `Job ${jobId}: Finished counting. Found approx ${totalFileCount.toLocaleString()} files in destination.`);
            } catch (err) {
                if (err.message === 'COUNT_STOPPED') {
                    logToRenderer('WARN', `Job ${jobId}: Stop requested during destination file count.`);
                    sendUpdate('Stopped', 0, 'Job stopped by user.');
                    return;
                }
                logToRenderer('WARN', `Job ${jobId}: Could not count dest files. Progress indeterminate. Error: ${err.message}`);
            }

            if (stopFlags.has(jobId)) { sendUpdate('Stopped', 0, 'Job stopped by user.'); return; }

            let scannedFileCount = 0;
            async function buildIndex(relativeDir) {
                if (stopFlags.has(jobId)) return;
                const dir = path.join(job.destination, relativeDir);
                let dirents;
                try { dirents = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return; }

                for (const dirent of dirents) {
                    if (stopFlags.has(jobId)) return;
                    const relativePath = path.join(relativeDir, dirent.name);
                    const fullPath = path.join(dir, dirent.name);
                    if (dirent.isDirectory()) {
                        await buildIndex(relativePath);
                    } else if (dirent.isFile()) {
                        scannedFileCount++;
                        const progress = totalFileCount > 0 ? Math.min((scannedFileCount / totalFileCount) * 100, 100) : -1;
                        const message = totalFileCount > 0 ? `Scanning: ${scannedFileCount.toLocaleString()} of ${totalFileCount.toLocaleString()}` : `Scanning destination: ${scannedFileCount.toLocaleString()} files...`;
                        sendUpdate('Scanning', progress, message);

                        try {
                            const stats = await fs.stat(fullPath);
                            destIndex[relativePath] = { size: stats.size, mtimeMs: stats.mtimeMs };
                            scheduleSave();
                        } catch (err) { logToRenderer('WARN', `Job ${jobId}: Could not scan ${relativePath}: ${err.message}`); }
                    }
                }
            }
            await buildIndex('');
            if (stopFlags.has(jobId)) { sendUpdate('Stopped', 0, 'Job stopped by user.'); return; }
        }

        sendUpdate('Scanning', -1, 'Counting source files...');
        let totalSourceFiles = 0;
        try {
            logToRenderer('INFO', `Job ${jobId}: Starting to count source files at ${job.source}.`);
            totalSourceFiles = await countFiles(job.source, jobId, job); // Pass job for exclusions
            if (stopFlags.has(jobId)) { throw new Error('COUNT_STOPPED'); } // Re-check
            logToRenderer('INFO', `Job ${jobId}: Finished counting. Found approx ${totalSourceFiles.toLocaleString()} files in source.`);
        } catch (err) {
            if (err.message === 'COUNT_STOPPED') { 
                logToRenderer('WARN', `Job ${jobId}: Stop requested during source file count.`);
                sendUpdate('Stopped', 0, 'Job stopped by user.'); 
                return; 
            }
            logToRenderer('WARN', `Job ${jobId}: Could not count source files. Progress will be indeterminate.`);
        }

        if (stopFlags.has(jobId)) { sendUpdate('Stopped', 0, 'Job stopped by user.'); return; }

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

                const isItemExcluded = job.exclusions && isExcluded(relativePath, job.exclusions);
                if (isItemExcluded) {
                    if (dirent.isDirectory()) await syncDirectory(relativePath);
                    continue;
                }
                
                const sourcePath = path.join(job.source, relativePath);
                const destPath = path.join(job.destination, relativePath);
                
                if (dirent.isDirectory()) {
                    await fs.mkdir(destPath, { recursive: true }).catch(() => {});
                    await syncDirectory(relativePath);
                } else if (dirent.isFile()) {
                    processedFiles++;
                    const progress = totalSourceFiles > 0 ? (processedFiles / totalSourceFiles) * 100 : -1;
                    const copyPayload = { processedFiles, totalSourceFiles };
                    
                    try {
                        sendUpdate('Copying', progress, `Checking: ${relativePath}`, copyPayload);
                        const sourceStats = await fs.stat(sourcePath);
                        const destEntry = destIndex[relativePath];

                        let needsCopy = false;
                        if (!destEntry) {
                            needsCopy = true;
                        } else {
                            const sizeChanged = destEntry.size !== sourceStats.size;
                            // Allow 2-second tolerance for modification time differences across filesystems (e.g. FAT)
                            const mtimeChanged = Math.abs(destEntry.mtimeMs - sourceStats.mtimeMs) > 2000;
                            if (sizeChanged || mtimeChanged) {
                                needsCopy = true;
                            }
                        }

                        if (needsCopy) {
                            const action = destEntry ? 'Updating' : 'Copying';
                            sendUpdate('Copying', progress, `${action}: ${relativePath}`, copyPayload);
                            
                            await fs.mkdir(path.dirname(destPath), { recursive: true });
                            await fs.copyFile(sourcePath, destPath);
                            await fs.utimes(destPath, new Date(sourceStats.mtimeMs), new Date(sourceStats.mtimeMs));
                            
                            destIndex[relativePath] = { size: sourceStats.size, mtimeMs: sourceStats.mtimeMs };
                            scheduleSave();
                        }
                    } catch (error) {
                        const errorMessage = `Failed to process: ${relativePath}. ${error.message}`;
                        copyErrors.push({ path: relativePath, error: error.message });
                        logToRenderer('ERROR', `Job ${jobId}: ${errorMessage}`);
                    }
                }
            }
        }

        sendUpdate('Copying', 0, `Starting backup of ${totalSourceFiles.toLocaleString()} file(s)...`);
        await syncDirectory('');

        if (stopFlags.has(jobId)) {
            logToRenderer('WARN', `Job ${jobId} was stopped by the user.`);
            sendUpdate('Stopped', 0, 'Job stopped by user.');
            return;
        }

        if (copyErrors.length > 0) {
            const allErrors = store.get('jobErrors', {});
            const existingErrors = allErrors[jobId] || [];
            allErrors[jobId] = [...existingErrors, ...copyErrors];
            store.set('jobErrors', allErrors);
        }

        sendUpdate('Cleaning', -1, 'Checking for files to delete...');
        const toDelete = [];
        for (const destPath in destIndex) {
            if (!sourcePaths.has(destPath)) {
                toDelete.push({ path: destPath, type: 'file' });
                delete destIndex[destPath];
            }
        }
        logToRenderer('INFO', `Job ${jobId}: Found ${toDelete.length} orphan items in destination.`);
        
        let finalStatus = copyErrors.length > 0 ? 'DoneWithErrors' : 'Done';
        const payload = { 
            ...(copyErrors.length > 0 && { copyErrors }),
            filesToDelete: toDelete 
        };
        
        let finalMessage;
        if (settings.autoCleanup && toDelete.length > 0 && copyErrors.length === 0) {
            sendUpdate(finalStatus, 100, `Auto-cleaning ${toDelete.length} item(s)...`, payload);
            const cleanupResult = await performCleanup(job, toDelete, (progress, message) => {
                sendUpdate('Cleaning', progress, message);
            });
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

    } catch(err) {
        logToRenderer('ERROR', `A critical error occurred in job ${jobId}: ${err.message}\n${err.stack}`);
        sendUpdate('Error', 0, `A critical error occurred: ${err.message}`);
    } finally {
        if (saveTimeout) clearTimeout(saveTimeout);
        if (Object.keys(destIndex).length > 0 && !stopFlags.has(jobId)) {
            try {
                const newIndexData = { destinationPath: job.destination, files: destIndex };
                await fs.writeFile(tempIndexFilePath, JSON.stringify(newIndexData));
                await fs.rename(tempIndexFilePath, indexFilePath);
                logToRenderer('INFO', `Job ${jobId}: Destination index saved.`);
            } catch (e) {
                logToRenderer('ERROR', `Job ${jobId}: Failed to save destination index on exit: ${e.message}`);
            }
        }

        runningJobsInMain.delete(jobId);
        stopFlags.delete(jobId); // Ensure stop flag is always cleared on exit
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
    const progressCallback = (progress, message) => {
        sendUpdateForJob(jobId, 'Cleaning', progress, message);
    };
    const result = await performCleanup(job, files, progressCallback);
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
