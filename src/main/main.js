



const { app, BrowserWindow, Menu, ipcMain, dialog, powerSaveBlocker } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const crypto = require('crypto');
const WindowState = require('electron-window-state');
const Store = require('electron-store');

const store = new Store();
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
    console.log('[INFO] Application successfully started.');
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
            console.log(`[SUCCESS] Successfully exported jobs to ${filePath}`);
            return { success: true };
        } catch (error) {
            console.error(`[ERROR] Failed to save file: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    console.log('[INFO] Job export was canceled by user.');
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
            console.log(`[INFO] Reading jobs for import from ${filePaths[0]}`);
            return { success: true, content };
        } catch (error) {
            console.error(`[ERROR] Failed to read file for import: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    console.log('[INFO] Job import was canceled by user.');
    return { success: false, error: 'Open dialog canceled.' };
});

ipcMain.handle('jobs:get', () => store.get('jobs', []));
ipcMain.handle('jobs:set', (event, jobs) => store.set('jobs', jobs));
ipcMain.handle('jobErrors:get', () => store.get('jobErrors', {}));
ipcMain.handle('jobErrors:set', (event, errors) => store.set('jobErrors', errors));
ipcMain.handle('settings:get', () => store.get('settings', { preventSleep: false, autoCleanup: false }));
ipcMain.handle('settings:set', (event, settings) => {
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
    console.log(`[INFO] Job ${jobId}: countFiles started for path: ${startPath}`);
    let fileCount = 0;
    let dirCount = 0;
    const queue = [startPath];
    const YIELD_THRESHOLD = 500; // Yield to event loop every 500 directories processed
    
    while (queue.length > 0) {
        if (stopFlags.has(jobId)) {
            console.warn(`[WARN] Job ${jobId}: countFiles received stop signal.`);
            throw new Error('COUNT_STOPPED');
        }
        const currentPath = queue.shift();

        dirCount++;
        if (dirCount % YIELD_THRESHOLD === 0) {
             await new Promise(resolve => setImmediate(resolve));
        }

        let dirents;
        try {
            dirents = await fs.readdir(currentPath, { withFileTypes: true });
        } catch (e) {
            console.warn(`[WARN] Job ${jobId}: countFiles could not read directory ${currentPath}. Error: ${e.message}`);
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
    console.log(`[INFO] Job ${jobId}: countFiles finished for path: ${startPath}. Total files: ${fileCount}, Dirs: ${dirCount}.`);
    return fileCount;
}

function robustDelete(fullPath) {
    return new Promise((resolve, reject) => {
        // Safety check to prevent deleting critical paths
        if (!fullPath || fullPath === '/' || fullPath.length < 3) {
            return reject(new Error(`Deletion of unsafe path rejected: ${fullPath}`));
        }

        const quotedPath = `"${fullPath}"`;
        const isWindows = process.platform === 'win32';
        
        // This command will delete a file, or recursively delete a directory. It's designed to succeed even if the path doesn't exist.
        const command = isWindows 
            ? `(if exist ${quotedPath} ( (del /f /q ${quotedPath} 2>nul & rmdir /s /q ${quotedPath} 2>nul) || (rmdir /s /q ${quotedPath} 2>nul) ))`
            : `rm -rf ${quotedPath}`;
        
        exec(command, (error, stdout, stderr) => {
            if (error) {
                // This block should only be hit on serious issues like permission errors.
                console.error(`[EXEC ERROR] robustDelete failed for path "${fullPath}". Error: ${error.message}`);
                if (stderr) console.error(`[EXEC STDERR] ${stderr}`);
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

async function performCleanup(job, items, progressCallback) {
    if (!job || !items || items.length === 0) {
        return { success: false, error: "Job or items to clean not found." };
    }
    console.log(`[INFO] Starting cleanup for job ${job.id}. Deleting ${items.length} items.`);

    try {
        // Sort items by path depth, deepest first. This ensures children are processed before parents,
        // which is a safe and orderly approach even with recursive deletion.
        items.sort((a, b) => b.path.split(path.sep).length - a.path.split(path.sep).length);

        const totalCount = items.length;
        let processedCount = 0;
        const errors = [];
        
        // Since `robustDelete` on a parent directory will also delete its children, we can optimize
        // by only deleting the highest-level orphan paths.
        const processedPaths = new Set();

        for (const item of items) {
            // Check if this item is inside a directory we've already handled.
            const isAlreadyHandled = [...processedPaths].some(p => item.path.startsWith(p + path.sep));
            if(isAlreadyHandled) {
                continue;
            }

            processedCount++;
            if (stopFlags.has(job.id)) {
                console.warn(`[WARN] Cleanup for job ${job.id} was stopped.`);
                break;
            }

            const progress = totalCount > 0 ? (processedCount / totalCount) * 100 : 100;
            const message = `Deleting ${item.type} ${processedCount} of ${totalCount}`;
            if (progressCallback) {
                progressCallback(progress, message);
            }

            const fullPath = path.join(job.destination, item.path);
            try {
                // Use the new robust shell-based deletion.
                await robustDelete(fullPath);
                processedPaths.add(item.path); // Mark this path as handled.
            } catch (err) {
                // If robustDelete fails, it's likely a permissions issue.
                errors.push({ path: item.path, error: err.message });
            }
        }
        
        if (errors.length > 0) {
            errors.forEach(e => console.error(`[ERROR] Failed to delete ${e.path}: ${e.error}`));
            return { success: false, error: `Cleanup finished with ${errors.length} errors.` };
        }

        console.log(`[SUCCESS] Cleanup for job ${job.id} completed.`);
        return { success: true };
    } catch (error) {
        console.error(`[ERROR] A critical error occurred during cleanup for job ${job.id}: ${error.message}`);
        return { success: false, error: error.message };
    }
}

ipcMain.on('job:stop', (event, jobId) => {
    console.warn(`[WARN] Stop request received for job ${jobId}.`);
    stopFlags.set(jobId, true);
});

async function getAllRelativeDirs(startPath, jobId) {
    const dirs = new Set();
    const queue = [startPath];
    const YIELD_THRESHOLD = 500;
    let processedCount = 0;
    
    while (queue.length > 0) {
        if (stopFlags.has(jobId)) {
            console.warn(`[WARN] Job ${jobId}: getAllRelativeDirs received stop signal.`);
            throw new Error('DIR_SCAN_STOPPED');
        }
        const currentPath = queue.shift();

        processedCount++;
        if (processedCount % YIELD_THRESHOLD === 0) {
             await new Promise(resolve => setImmediate(resolve));
        }

        let dirents;
        try {
            dirents = await fs.readdir(currentPath, { withFileTypes: true });
        } catch (e) {
            continue;
        }

        for (const dirent of dirents) {
            if (dirent.isDirectory()) {
                const fullPath = path.join(currentPath, dirent.name);
                const relativePath = path.relative(startPath, fullPath);
                dirs.add(relativePath);
                queue.push(fullPath);
            }
        }
    }
    return Array.from(dirs);
}

function calculateOrphanFiles(sourcePaths, destIndex) {
    const toDelete = [];
    for (const destPath in destIndex) {
        if (!sourcePaths.has(destPath)) {
            toDelete.push({ path: destPath, type: 'file' });
        }
    }
    return toDelete;
}

function calculateFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fsSync.createReadStream(filePath);
        stream.on('data', data => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', err => reject(err));
    });
}

async function loadIndex(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);
        // Basic validation
        if (data && typeof data.files === 'object') {
            return data.files;
        }
    } catch (error) {
        // It's fine if the file doesn't exist or is invalid, we'll just build a new one.
        console.warn(`[WARN] Could not load previous index from ${filePath}. A new one will be created. Reason: ${error.message}`);
    }
    return {};
}

ipcMain.on('job:start', async (event, jobId) => {
    if (runningJobsInMain.has(jobId)) {
        console.warn(`[WARN] Job ${jobId} is already running. Start request ignored.`);
        return;
    }

    const jobs = store.get('jobs', []);
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;

    // Clear any errors from previous runs of this job.
    const allErrorsStore = store.get('jobErrors', {});
    if (allErrorsStore[jobId]) {
        delete allErrorsStore[jobId];
        store.set('jobErrors', allErrorsStore);
    }

    const settings = store.get('settings', { preventSleep: false, autoCleanup: false });
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
                console.warn(`[WARN] Job ${jobId}: Periodic index save failed: ${e.message}`);
            }
        }, SAVE_INTERVAL);
    };

    runningJobsInMain.add(jobId);
    stopFlags.delete(jobId);
    
    const sourcePaths = new Set();
    const YIELD_THRESHOLD = 500; // General threshold for yielding to event loop
    const copyErrors = [];

    try {
        if (runningJobsInMain.size === 1) { // Only when the first job starts
            if (settings.preventSleep) {
                powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
                if (powerSaveBlocker.isStarted(powerSaveBlockerId)) {
                    console.log('[INFO] System sleep is being prevented during job execution.');
                }
            }
        }
        
        console.log(`[INFO] Job ${jobId} started.`);

        try {
            await fs.access(job.source);
            await fs.mkdir(job.destination, { recursive: true });
        } catch (err) {
            const errorMessage = `Path not found or accessible: ${err.path}.`;
            sendUpdate('Error', 0, errorMessage, { errorType: 'PATH_ERROR' });
            console.error(`[ERROR] Job ${jobId} failed: ${errorMessage}`);
            return;
        }

        // --- Reliable Index Rebuilding ---
        // 1. Load the old index ONLY to get cached hashes.
        const oldIndexWithHashes = await loadIndex(indexFilePath);

        // 2. Always rebuild the index from what's currently on disk for reliability.
        destIndex = {};
        sendUpdate('Scanning', -1, 'Scanning destination for changes...');
        let totalFileCount = 0;
        try {
            console.log(`[INFO] Job ${jobId}: Starting to count destination files at ${job.destination}.`);
            totalFileCount = await countFiles(job.destination, jobId);
            if (stopFlags.has(jobId)) { throw new Error('COUNT_STOPPED'); }
            console.log(`[INFO] Job ${jobId}: Finished counting. Found approx ${totalFileCount.toLocaleString()} files in destination.`);
        } catch (err) {
            if (err.message === 'COUNT_STOPPED') {
                console.warn(`[WARN] Job ${jobId}: Stop requested during destination file count.`);
                sendUpdate('Stopped', 0, 'Job stopped by user.');
                return;
            }
            console.warn(`[WARN] Job ${jobId}: Could not count dest files. Progress indeterminate. Error: ${err.message}`);
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
                    if (scannedFileCount % YIELD_THRESHOLD === 0) {
                        await new Promise(resolve => setImmediate(resolve));
                    }
                    const progress = totalFileCount > 0 ? Math.min((scannedFileCount / totalFileCount) * 100, 100) : -1;
                    const message = totalFileCount > 0 ? `Scanning destination: ${scannedFileCount.toLocaleString()} of ${totalFileCount.toLocaleString()}` : `Scanning destination: ${scannedFileCount.toLocaleString()} files...`;
                    sendUpdate('Scanning', progress, message);

                    try {
                        const stats = await fs.stat(fullPath);
                        destIndex[relativePath] = { size: stats.size, mtimeMs: stats.mtimeMs };

                        // 3. Carry over the hash from the old index if file metadata matches.
                        // This avoids re-hashing the entire destination every time.
                        const oldEntry = oldIndexWithHashes[relativePath];
                        if (oldEntry && oldEntry.size === stats.size && oldEntry.mtimeMs === stats.mtimeMs && oldEntry.hash) {
                            destIndex[relativePath].hash = oldEntry.hash;
                        }

                        scheduleSave();
                    } catch (err) { console.warn(`[WARN] Job ${jobId}: Could not scan ${relativePath}: ${err.message}`); }
                }
            }
        }
        await buildIndex('');
        if (stopFlags.has(jobId)) { sendUpdate('Stopped', 0, 'Job stopped by user.'); return; }
        
        sendUpdate('Scanning', -1, 'Counting source files...');
        let totalSourceFiles = 0;
        try {
            console.log(`[INFO] Job ${jobId}: Starting to count source files at ${job.source}.`);
            totalSourceFiles = await countFiles(job.source, jobId, job); // Pass job for exclusions
            if (stopFlags.has(jobId)) { throw new Error('COUNT_STOPPED'); } // Re-check
            console.log(`[INFO] Job ${jobId}: Finished counting. Found approx ${totalSourceFiles.toLocaleString()} files in source.`);
        } catch (err) {
            if (err.message === 'COUNT_STOPPED') { 
                console.warn(`[WARN] Job ${jobId}: Stop requested during source file count.`);
                sendUpdate('Stopped', 0, 'Job stopped by user.'); 
                return; 
            }
            console.warn(`[WARN] Job ${jobId}: Could not count source files. Progress will be indeterminate.`);
        }

        if (stopFlags.has(jobId)) { sendUpdate('Stopped', 0, 'Job stopped by user.'); return; }

        let processedFiles = 0;

        async function syncDirectory(relativeDir) {
            if (stopFlags.has(jobId)) return;
            const sourceDir = path.join(job.source, relativeDir);
            let dirents;
            try { dirents = await fs.readdir(sourceDir, { withFileTypes: true }); } catch (err) { return; }

            for (const [index, dirent] of dirents.entries()) {
                if (stopFlags.has(jobId)) return;
                
                // Yield to event loop to keep UI responsive on very large directories
                if (index > 0 && index % YIELD_THRESHOLD === 0) {
                    await new Promise(resolve => setImmediate(resolve));
                }

                const relativePath = path.join(relativeDir, dirent.name);
                sourcePaths.add(relativePath);
                
                if (job.exclusions && isExcluded(relativePath, job.exclusions)) {
                    continue; // Skip excluded files and directories
                }
                
                const sourcePath = path.join(job.source, relativePath);
                const destPath = path.join(job.destination, relativePath);
                
                if (dirent.isDirectory()) {
                    await fs.mkdir(destPath, { recursive: true }).catch(() => {});
                    await syncDirectory(relativePath);
                } else if (dirent.isFile()) {
                    processedFiles++; // Increment counter only for files
                    const progress = totalSourceFiles > 0 ? Math.min((processedFiles / totalSourceFiles) * 100, 100) : -1;
                    const copyPayload = { processedFiles, totalSourceFiles, errorCount: copyErrors.length };
                    
                    try {
                        sendUpdate('Copying', progress, `Checking: ${relativePath}`, copyPayload);
                        const sourceStats = await fs.stat(sourcePath);
                        const destEntry = destIndex[relativePath];

                        let needsCopy = false;
                        if (!destEntry) {
                            needsCopy = true;
                        } else if (sourceStats.size !== destEntry.size) {
                            needsCopy = true;
                        } else if (job.verifyContent) {
                            // Content verification enabled: size matches, now check hash
                            sendUpdate('Copying', progress, `Verifying: ${relativePath}`, copyPayload);
                            const sourceHash = await calculateFileHash(sourcePath);
                            const destHash = destEntry.hash || await calculateFileHash(destPath);
                            if (sourceHash !== destHash) {
                                needsCopy = true;
                            } else if (!destEntry.hash) {
                                destEntry.hash = destHash; // Cache the calculated hash
                            }
                        } else {
                            // Standard check: size matches, check modification time
                            const mtimeChanged = Math.abs(destEntry.mtimeMs - sourceStats.mtimeMs) > 2000;
                            if (mtimeChanged) {
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
                            if (job.verifyContent) {
                                // If we copied, we know the hash matches the source hash.
                                destIndex[relativePath].hash = await calculateFileHash(sourcePath);
                            }
                            scheduleSave();
                        }
                    } catch (error) {
                        if (error.code === 'ENOENT') {
                            // This happens if file was deleted between readdir and stat. Not a critical copy error.
                            console.warn(`[WARN] Job ${jobId}: Source file disappeared during scan: ${relativePath}. Skipping.`);
                            totalSourceFiles = Math.max(0, totalSourceFiles - 1); // Adjust total for accuracy
                        } else {
                            const newError = { path: relativePath, error: error.message };
                            copyErrors.push(newError);
                            const errorMessage = `Failed to process: ${relativePath}. ${error.message}`;
                            console.error(`[ERROR] Job ${jobId}: ${errorMessage}`);
                            sendUpdate('Copying', progress, `Error: ${relativePath}`, {
                                processedFiles,
                                totalSourceFiles,
                                errorCount: copyErrors.length,
                                newError: newError
                            });
                        }
                    }
                }
            }
        }

        sendUpdate('Copying', 0, `Starting backup of ${totalSourceFiles.toLocaleString()} file(s)...`);
        await syncDirectory('');

        // --- UNIFIED COMPLETION AND STOP LOGIC ---
        const wasStopped = stopFlags.has(jobId);
        if (wasStopped) {
            console.warn(`[WARN] Job ${jobId} was stopped by the user.`);
        }

        if (copyErrors.length > 0) {
            const allErrors = store.get('jobErrors', {});
            allErrors[jobId] = copyErrors;
            store.set('jobErrors', allErrors);
        }

        sendUpdate('Cleaning', -1, 'Checking for files to delete...');
        const orphanFiles = calculateOrphanFiles(sourcePaths, destIndex);
        const allDestDirs = await getAllRelativeDirs(job.destination, jobId);
        const orphanDirs = allDestDirs
            .filter(dir => !sourcePaths.has(dir))
            .map(p => ({ path: p, type: 'dir' }));
            
        const toDelete = [...orphanFiles, ...orphanDirs];
        console.log(`[INFO] Job ${jobId}: Found ${toDelete.length} orphan items in destination (${orphanFiles.length} files, ${orphanDirs.length} directories).`);
        
        // Core Decision Logic: Should we auto-cleanup?
        // Cleanup runs if enabled, there are files to delete, and no copy errors occurred (for safety).
        const shouldAutoCleanup = settings.autoCleanup && toDelete.length > 0 && copyErrors.length === 0;

        if (shouldAutoCleanup) {
            const cleanupMessage = wasStopped ? `Auto-cleaning ${toDelete.length} item(s) after stop...` : `Auto-cleaning ${toDelete.length} item(s)...`;
            sendUpdate('Cleaning', 0, cleanupMessage, { filesToDelete: toDelete });

            const cleanupResult = await performCleanup(job, toDelete, (progress, message) => {
                sendUpdate('Cleaning', progress, message);
            });
            
            let finalStatus, finalMessage;
            if (cleanupResult.success) {
                toDelete.forEach(item => delete destIndex[item.path]); // remove cleaned files from index
                finalStatus = wasStopped ? 'Stopped' : 'Done';
                finalMessage = wasStopped ? 'Job stopped and cleanup complete.' : `Backup and cleanup completed successfully at ${new Date().toLocaleTimeString()}.`;
            } else {
                finalStatus = wasStopped ? 'Stopped' : 'DoneWithErrors';
                finalMessage = wasStopped ? `Job stopped, but auto-cleanup failed: ${cleanupResult.error}` : `Backup complete, but auto-cleanup failed: ${cleanupResult.error}`;
            }
            sendUpdate(finalStatus, wasStopped ? 0 : 100, finalMessage, { 
                filesToDelete: cleanupResult.success ? [] : toDelete, 
                ...(copyErrors.length > 0 && { copyErrors }) 
            });

        } else { // No auto-cleanup: either disabled, nothing to delete, or copy errors occurred.
            let finalStatus, finalMessage;
            if (wasStopped) {
                finalStatus = 'Stopped';
                finalMessage = 'Job stopped by user.';
            } else {
                finalStatus = copyErrors.length > 0 ? 'DoneWithErrors' : 'Done';
                if (copyErrors.length > 0) {
                    finalMessage = `Backup finished with ${copyErrors.length} error(s).`;
                    if (toDelete.length > 0) finalMessage += ` ${toDelete.length} item(s) pending cleanup.`;
                    if (settings.autoCleanup && toDelete.length > 0) finalMessage += ' Auto-cleanup was skipped due to copy errors.';
                } else {
                    finalMessage = toDelete.length > 0
                        ? `Backup complete. ${toDelete.length} item(s) pending cleanup.`
                        : `Backup completed successfully at ${new Date().toLocaleTimeString()}.`;
                }
            }
            const payload = {
                filesToDelete: toDelete,
                ...(copyErrors.length > 0 && { copyErrors })
            };
            sendUpdate(finalStatus, wasStopped ? 0 : 100, finalMessage, payload);
        }

    } catch(err) {
        console.error(`[ERROR] A critical error occurred in job ${jobId}: ${err.message}\n${err.stack}`);
        const orphanFiles = calculateOrphanFiles(sourcePaths, destIndex);
        const allDestDirs = await getAllRelativeDirs(job.destination, jobId).catch(() => []);
        const orphanDirs = allDestDirs
            .filter(dir => !sourcePaths.has(dir))
            .map(p => ({ path: p, type: 'dir' }));
        const toDelete = [...orphanFiles, ...orphanDirs];
        if (toDelete.length > 0) {
            console.log(`[INFO] Job ${jobId}: Found ${toDelete.length} orphan items that can be cleaned up despite the error.`);
        }
        sendUpdate('Error', 0, `A critical error occurred: ${err.message}`, { filesToDelete: toDelete });
    } finally {
        if (saveTimeout) clearTimeout(saveTimeout);
        if (Object.keys(destIndex).length > 0 && !stopFlags.has(jobId)) {
            try {
                const newIndexData = { destinationPath: job.destination, files: destIndex };
                await fs.writeFile(tempIndexFilePath, JSON.stringify(newIndexData));
                await fs.rename(tempIndexFilePath, indexFilePath);
                console.log(`[INFO] Job ${jobId}: Destination index saved.`);
            } catch (e) {
                console.error(`[ERROR] Job ${jobId}: Failed to save destination index on exit: ${e.message}`);
            }
        }

        runningJobsInMain.delete(jobId);
        stopFlags.delete(jobId); // Ensure stop flag is always cleared on exit
        if (runningJobsInMain.size === 0 && powerSaveBlockerId) {
            powerSaveBlocker.stop(powerSaveBlockerId);
            console.log('[INFO] System sleep prevention has been lifted.');
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
    console.warn('[WARN] Shutdown command received. Shutting down the system.');
    const command = process.platform === 'win32' ? 'shutdown /s /t 0' : 'shutdown -h now';
    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`[ERROR] Shutdown failed: ${error.message}`);
            return;
        }
        if (stderr) {
            console.error(`[ERROR] Shutdown stderr: ${stderr}`);
            return;
        }
        console.log(`[INFO] Shutdown stdout: ${stdout}`);
    });
});