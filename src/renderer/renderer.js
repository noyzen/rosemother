document.addEventListener('DOMContentLoaded', () => {
  const jobsListEl = document.getElementById('jobs-list');
  const emptyStateEl = document.getElementById('empty-state');
  const addJobBtn = document.getElementById('add-job-btn');
  const startAllBtn = document.getElementById('start-all-btn');
  const batchCleanupBtn = document.getElementById('batch-cleanup-btn');
  const exportJobsBtn = document.getElementById('export-jobs-btn');
  const importJobsBtn = document.getElementById('import-jobs-btn');
  const autoCleanupToggle = document.getElementById('auto-cleanup-toggle');
  const logBtn = document.getElementById('log-btn');

  // Modals
  const jobModal = document.getElementById('job-modal');
  const jobForm = document.getElementById('job-form');
  const modalTitle = document.getElementById('modal-title');
  const jobIdInput = document.getElementById('job-id-input');
  const sourcePathInput = document.getElementById('source-path');
  const destPathInput = document.getElementById('dest-path');
  
  const confirmModal = document.getElementById('confirm-modal');
  const confirmTitle = document.getElementById('confirm-title');
  const confirmMessage = document.getElementById('confirm-message');
  const confirmFileList = document.getElementById('confirm-file-list');

  const logModal = document.getElementById('log-modal');
  const logListContainer = document.getElementById('log-list-container');
  const logSearchInput = document.getElementById('log-search-input');
  const loggingEnabledToggle = document.getElementById('logging-enabled-toggle');

  let jobs = [];
  let appSettings = { autoCleanup: false, loggingEnabled: true };
  let confirmCallback = null;
  let pendingCleanups = {};
  let jobQueue = [];
  let isBatchRunning = false;
  let jobErrors = {};
  let runningJobs = new Set();
  
  // --- Logging System ---
  let logs = [];
  const MAX_LOGS = 5000;

  const addLog = (level, message) => {
    if (!appSettings.loggingEnabled) return;
    logs.push({
      timestamp: new Date(),
      level, // INFO, SUCCESS, WARN, ERROR
      message
    });
    if (logs.length > MAX_LOGS) {
      logs.splice(0, logs.length - MAX_LOGS);
    }
  };

  const renderLogs = (filter = '') => {
    const searchTerm = filter.toLowerCase();
    const filteredLogs = searchTerm 
      ? logs.filter(log => log.message.toLowerCase().includes(searchTerm) || log.level.toLowerCase().includes(searchTerm))
      : logs;

    if (filteredLogs.length === 0) {
        logListContainer.innerHTML = `<div class="log-empty-state">No logs found${searchTerm ? ' matching your search' : ''}.</div>`;
        return;
    }
    
    const logHTML = filteredLogs.map(log => {
      const time = log.timestamp.toLocaleTimeString('en-US', { hour12: false });
      return `
        <div class="log-entry">
          <span class="log-timestamp">${time}</span>
          <span class="log-level log-${log.level.toLowerCase()}">${log.level}</span>
          <span class="log-message">${log.message.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</span>
        </div>
      `;
    }).join('');
    
    logListContainer.innerHTML = logHTML;
    logListContainer.scrollTop = logListContainer.scrollHeight;
  };

  logBtn.addEventListener('click', () => {
    logSearchInput.value = '';
    renderLogs();
    logModal.classList.remove('hidden');
  });

  document.getElementById('close-log-btn').addEventListener('click', () => {
    logModal.classList.add('hidden');
  });

  document.getElementById('clear-log-btn').addEventListener('click', async () => {
    const confirmed = await showConfirm('Clear Logs', 'Are you sure you want to permanently clear all application logs? This action cannot be undone.', 'danger');
    if (confirmed) {
        logs = [];
        addLog('WARN', 'Log history has been cleared.');
        renderLogs();
    }
  });

  document.getElementById('copy-log-btn').addEventListener('click', e => {
    const logText = logs.map(log => `[${log.timestamp.toISOString()}] [${log.level}] ${log.message}`).join('\n');
    navigator.clipboard.writeText(logText);
    const btn = e.currentTarget;
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
    btn.disabled = true;
    setTimeout(() => {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }, 1500);
  });
  
  logSearchInput.addEventListener('input', () => renderLogs(logSearchInput.value));
  
  loggingEnabledToggle.addEventListener('change', e => {
    const isEnabled = e.target.checked;
    appSettings.loggingEnabled = isEnabled;
    saveSettings();

    if (isEnabled) {
        addLog('WARN', 'Logging has been enabled.');
    } else {
        const msg = 'Logging has been disabled. New events will not be recorded.';
        logs.push({
            timestamp: new Date(),
            level: 'WARN',
            message: msg
        });
        if (!logModal.classList.contains('hidden')) {
            renderLogs(logSearchInput.value);
        }
    }
  });
  // --- End Logging System ---

  const renderJobs = () => {
    jobsListEl.innerHTML = '';
    const hasJobs = jobs.length > 0;
    emptyStateEl.classList.toggle('hidden', hasJobs);
    jobsListEl.classList.toggle('hidden', !hasJobs);
    startAllBtn.classList.toggle('hidden', !hasJobs);
    exportJobsBtn.classList.toggle('hidden', !hasJobs);

    if (hasJobs) {
      jobs.forEach(job => {
        const hasPendingCleanup = pendingCleanups[job.id] && pendingCleanups[job.id].length > 0;
        const jobEl = document.createElement('div');
        jobEl.className = 'job-item';
        jobEl.dataset.id = job.id;
        jobEl.innerHTML = `
          <div class="job-paths">
            <div class="path-display">
              <i class="fa-regular fa-folder-open"></i>
              <span class="path-text" title="${job.source}">${job.source}</span>
            </div>
            <i class="fa-solid fa-arrow-right-long path-arrow"></i>
            <div class="path-display">
              <i class="fa-solid fa-server"></i>
              <span class="path-text" title="${job.destination}">${job.destination}</span>
            </div>
          </div>
          <div class="job-details">
            <div class="job-status">
              <span class="status-text">${hasPendingCleanup ? `${pendingCleanups[job.id].length} item(s) pending cleanup.` : 'Idle'}</span>
              <span class="status-warning hidden"></span>
              <div class="progress-bar-container">
                <div class="progress-bar"></div>
              </div>
            </div>
            <div class="job-actions">
              <button class="btn-icon btn-view-errors hidden" aria-label="View Errors"><i class="fa-solid fa-triangle-exclamation"></i></button>
              <button class="btn-icon btn-cleanup ${hasPendingCleanup ? '' : 'hidden'}" aria-label="Cleanup Files"><i class="fa-solid fa-broom"></i></button>
              <button class="btn-icon btn-start-stop" aria-label="Start Backup"><i class="fa-solid fa-play"></i></button>
              <button class="btn-icon btn-edit" aria-label="Edit Job"><i class="fa-solid fa-pencil"></i></button>
              <button class="btn-icon btn-delete" aria-label="Delete Job"><i class="fa-solid fa-trash-can"></i></button>
            </div>
          </div>
        `;
        jobsListEl.appendChild(jobEl);
      });
    }
    updateBatchCleanupButton();
  };

  const saveJobs = async () => {
    await window.electronAPI.setJobs(jobs);
    addLog('INFO', `Job configurations saved. Total jobs: ${jobs.length}.`);
    renderJobs();
  };

  const loadJobs = async () => {
    jobs = await window.electronAPI.getJobs();
    addLog('INFO', `Loaded ${jobs.length} jobs from storage.`);
    renderJobs();
  };

  const loadSettings = async () => {
    const storedSettings = await window.electronAPI.getSettings();
    appSettings = {
        autoCleanup: false,
        loggingEnabled: true,
        ...storedSettings
    };
    autoCleanupToggle.checked = appSettings.autoCleanup;
    loggingEnabledToggle.checked = appSettings.loggingEnabled;
    addLog('INFO', `Settings loaded (Auto Cleanup: ${appSettings.autoCleanup}, Logging: ${appSettings.loggingEnabled}).`);
  };

  const saveSettings = async () => {
    await window.electronAPI.setSettings(appSettings);
    addLog('INFO', `Settings saved (Auto Cleanup: ${appSettings.autoCleanup}, Logging: ${appSettings.loggingEnabled}).`);
  };

  const updateBatchCleanupButton = () => {
    const hasPending = Object.values(pendingCleanups).some(files => files.length > 0);
    batchCleanupBtn.classList.toggle('hidden', !hasPending);
  };

  const openJobModal = (job = null) => {
    jobForm.reset();
    if (job) {
      modalTitle.textContent = 'Edit Backup Job';
      jobIdInput.value = job.id;
      sourcePathInput.value = job.source;
      destPathInput.value = job.destination;
    } else {
      modalTitle.textContent = 'New Backup Job';
      jobIdInput.value = '';
    }
    jobModal.classList.remove('hidden');
  };
  
  const closeJobModal = () => jobModal.classList.add('hidden');
  
  const showCopyErrorsModal = async (jobId) => {
    const errors = jobErrors[jobId] || [];
    if (errors.length === 0) return;

    await showConfirm(
        `Copy Errors (${errors.length})`,
        `The following files failed to copy during the backup process:`,
        'info',
        { type: 'copyErrors', errors }
    );
  };

  const showConfirm = (title, message, okClass = 'danger', data = null) => {
    return new Promise(resolve => {
        confirmTitle.textContent = title;
        confirmMessage.textContent = message;
        confirmFileList.innerHTML = '';

        if(data) {
            confirmFileList.classList.remove('hidden');
            const list = document.createElement('ul');
            
            if (data.type === 'copyErrors') {
                data.errors.slice(0, 100).forEach(err => {
                    const item = document.createElement('li');
                    item.className = 'confirm-error-item';
                    item.innerHTML = `
                        <span class="confirm-error-path">${err.path}</span>
                        <span class="confirm-error-reason">${err.error}</span>`;
                    list.appendChild(item);
                });
                if (data.errors.length > 100) {
                    const item = document.createElement('li');
                    item.textContent = `...and ${data.errors.length - 100} more errors.`;
                    list.appendChild(item);
                }
            } else if (Array.isArray(data)) { // Single job cleanup
                 data.slice(0, 100).forEach(file => {
                    const item = document.createElement('li');
                    item.textContent = file.path;
                    list.appendChild(item);
                });
                if (data.length > 100) {
                    const item = document.createElement('li');
                    item.textContent = `...and ${data.length - 100} more items.`;
                    list.appendChild(item);
                }
            } else { // Batch cleanup
                 Object.entries(data).forEach(([jobId, files]) => {
                    if (files.length === 0) return;
                    const job = jobs.find(j => j.id === jobId);
                    const jobName = job ? `${job.source.split(/[\\/]/).pop()} → ${job.destination.split(/[\\/]/).pop()}` : 'Unknown Job';
                    const header = document.createElement('li');
                    header.className = 'confirm-job-header';
                    header.innerHTML = `<strong>${jobName}</strong> (${files.length} items)`;
                    list.appendChild(header);

                    const sublist = document.createElement('ul');
                    sublist.className = 'confirm-job-sublist';
                    files.slice(0, 20).forEach(file => {
                        const item = document.createElement('li');
                        item.textContent = file.path;
                        sublist.appendChild(item);
                    });
                    if (files.length > 20) {
                        const item = document.createElement('li');
                        item.textContent = `...and ${files.length - 20} more.`;
                        sublist.appendChild(item);
                    }
                    list.appendChild(sublist);
                });
            }
            confirmFileList.appendChild(list);
        } else {
            confirmFileList.classList.add('hidden');
        }

        const okBtn = document.getElementById('confirm-ok-btn');
        okBtn.className = `btn btn-${okClass}`;
        
        document.getElementById('confirm-cancel-btn').classList.toggle('hidden', okClass === 'info');
        okBtn.textContent = okClass === 'info' ? 'Close' : 'OK';

        confirmModal.classList.remove('hidden');
        confirmCallback = (confirmed) => {
            confirmModal.classList.add('hidden');
            document.getElementById('confirm-cancel-btn').classList.remove('hidden');
            okBtn.textContent = 'OK';
            resolve(confirmed);
        };
    });
  };

  document.getElementById('confirm-cancel-btn').addEventListener('click', () => confirmCallback(false));
  document.getElementById('confirm-ok-btn').addEventListener('click', () => confirmCallback(true));
  
  addJobBtn.addEventListener('click', () => openJobModal());
  document.getElementById('cancel-job-btn').addEventListener('click', closeJobModal);
  
  document.querySelectorAll('.btn-browse').forEach(button => {
    button.addEventListener('click', async (e) => {
      const targetId = e.currentTarget.dataset.target;
      const path = await window.electronAPI.openDialog();
      if (path) {
        document.getElementById(targetId).value = path;
      }
    });
  });

  jobForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = jobIdInput.value;
    const newJobData = {
      source: sourcePathInput.value,
      destination: destPathInput.value
    };

    if (!newJobData.source || !newJobData.destination) {
        alert('Source and Destination folders must be selected.');
        return;
    }
    
    if (id) { // Editing
      const index = jobs.findIndex(job => job.id === id);
      jobs[index] = { ...jobs[index], ...newJobData };
      addLog('INFO', `Job ${id} has been edited.`);
    } else { // Adding
      const newId = `job_${Date.now()}`;
      jobs.push({ id: newId, ...newJobData });
      addLog('INFO', `New job ${newId} has been added.`);
    }
    saveJobs();
    closeJobModal();
  });
  
  jobsListEl.addEventListener('click', async e => {
    const button = e.target.closest('button');
    if (!button) return;

    const jobItem = e.target.closest('.job-item');
    const jobId = jobItem.dataset.id;
    
    if (button.classList.contains('btn-start-stop')) {
        if(runningJobs.has(jobId)) {
            window.electronAPI.stopJob(jobId);
        } else {
            window.electronAPI.startJob(jobId);
        }
    } else if (button.classList.contains('btn-view-errors')) {
        showCopyErrorsModal(jobId);
    } else if (button.classList.contains('btn-edit')) {
        const job = jobs.find(j => j.id === jobId);
        openJobModal(job);
    } else if (button.classList.contains('btn-delete')) {
        const confirmed = await showConfirm('Delete Job', 'Are you sure you want to permanently delete this job configuration?', 'danger');
        if (confirmed) {
            jobs = jobs.filter(j => j.id !== jobId);
            delete pendingCleanups[jobId];
            delete jobErrors[jobId];
            addLog('WARN', `Job ${jobId} has been deleted.`);
            saveJobs();
        }
    } else if (button.classList.contains('btn-cleanup')) {
        const filesToClean = pendingCleanups[jobId] || [];
        const confirmed = await showConfirm(
            'Confirm Cleanup',
            `Permanently delete ${filesToClean.length} item(s) from the destination? This cannot be undone.`,
            'danger',
            filesToClean
        );
        if (confirmed) {
            window.electronAPI.cleanupJob({ jobId, files: filesToClean });
            jobItem.querySelector('.status-text').textContent = 'Cleaning up...';
            addLog('INFO', `Manual cleanup started for job ${jobId}.`);
            button.disabled = true;
        }
    }
  });

  const processJobQueue = () => {
    if (jobQueue.length === 0) {
        isBatchRunning = false;
        startAllBtn.disabled = false;
        startAllBtn.innerHTML = '<i class="fa-solid fa-play-circle"></i> Start All';
        addLog('SUCCESS', 'Batch run for all jobs completed.');
        return;
    }
    const jobId = jobQueue.shift();
    window.electronAPI.startJob(jobId);
  };

  startAllBtn.addEventListener('click', () => {
    if (isBatchRunning) return;
    isBatchRunning = true;
    startAllBtn.disabled = true;
    startAllBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Running All';
    jobQueue = jobs.map(j => j.id);
    addLog('INFO', 'Starting batch run for all jobs.');
    processJobQueue();
  });
  
  batchCleanupBtn.addEventListener('click', async () => {
    const totalFiles = Object.values(pendingCleanups).reduce((sum, files) => sum + files.length, 0);
    const confirmed = await showConfirm(
        'Confirm Batch Cleanup',
        `Permanently delete a total of ${totalFiles} item(s) across all jobs? This cannot be undone.`,
        'danger',
        pendingCleanups
    );
    if (confirmed) {
        addLog('INFO', `Starting batch cleanup for ${Object.keys(pendingCleanups).length} jobs.`);
        Object.entries(pendingCleanups).forEach(([jobId, files]) => {
            if (files.length > 0) {
                window.electronAPI.cleanupJob({ jobId, files });
            }
        });
    }
  });

  autoCleanupToggle.addEventListener('change', (e) => {
    appSettings.autoCleanup = e.target.checked;
    saveSettings();
  });

  exportJobsBtn.addEventListener('click', async () => {
    addLog('INFO', 'Attempting to export jobs...');
    const exportData = {
        version: '1.0.0',
        rosemother_export: true,
        jobs: jobs.map(({ source, destination }) => ({ source, destination })),
    };
    const { success, error } = await window.electronAPI.saveJsonDialog(JSON.stringify(exportData, null, 2));
    if (!success && error !== 'Save dialog canceled.') {
        addLog('ERROR', `Export failed: ${error}`);
        await showConfirm('Export Failed', `Could not save the file: ${error}`, 'info');
    } else if (success) {
        addLog('SUCCESS', 'Jobs exported successfully.');
    }
  });

  importJobsBtn.addEventListener('click', async () => {
    addLog('INFO', 'Attempting to import jobs...');
    const { success, content, error } = await window.electronAPI.openJsonDialog();
    if (!success) {
        if (error !== 'Open dialog canceled.') {
            addLog('ERROR', `Import failed: ${error}`);
            await showConfirm('Import Failed', `Could not open the file: ${error}`, 'info');
        }
        return;
    }
    try {
        const data = JSON.parse(content);
        if (!data.rosemother_export || !Array.isArray(data.jobs)) {
            throw new Error('Invalid or corrupted export file.');
        }

        let importedCount = 0;
        data.jobs.forEach(importedJob => {
            if (importedJob.source && importedJob.destination) {
                const alreadyExists = jobs.some(j => j.source === importedJob.source && j.destination === importedJob.destination);
                if (!alreadyExists) {
                    jobs.push({
                        id: `job_${Date.now()}_${importedCount}`,
                        source: importedJob.source,
                        destination: importedJob.destination
                    });
                    importedCount++;
                }
            }
        });

        if (importedCount > 0) {
            await saveJobs();
            addLog('SUCCESS', `Successfully imported ${importedCount} new job(s).`);
            await showConfirm('Import Successful', `Successfully added ${importedCount} new job(s).`, 'info');
        } else {
            addLog('WARN', 'Import complete, but no new jobs were added (they may already exist).');
            await showConfirm('Import Complete', 'No new jobs were imported. The jobs may already exist.', 'info');
        }

    } catch (e) {
        addLog('ERROR', `Import failed during parsing: ${e.message}`);
        await showConfirm('Import Failed', `Could not parse the file: ${e.message}`, 'info');
    }
  });

  window.electronAPI.onJobUpdate(data => {
    const { jobId, status, progress, message, payload } = data;
    const jobEl = document.querySelector(`.job-item[data-id="${jobId}"]`);
    if (!jobEl) return;
    
    if (payload && payload.errorType === 'PATH_ERROR') {
      showConfirm('Job Error', message, 'info');
      return;
    }

    const statusText = jobEl.querySelector('.status-text');
    const statusWarning = jobEl.querySelector('.status-warning');
    const progressBar = jobEl.querySelector('.progress-bar');
    const startStopBtn = jobEl.querySelector('.btn-start-stop');
    const cleanupBtn = jobEl.querySelector('.btn-cleanup');
    const viewErrorsBtn = jobEl.querySelector('.btn-view-errors');
    
    statusText.textContent = message || status;
    progressBar.style.width = `${progress}%`;
    
    const isRunning = ['Scanning', 'Copying', 'Syncing'].includes(status);
    jobEl.classList.toggle('is-running', isRunning);

    if (isRunning) {
      runningJobs.add(jobId);
      startStopBtn.innerHTML = '<i class="fa-solid fa-stop"></i>';
      startStopBtn.setAttribute('aria-label', 'Stop Backup');
      startStopBtn.classList.add('is-stop');
    } else {
      runningJobs.delete(jobId);
      startStopBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
      startStopBtn.setAttribute('aria-label', 'Start Backup');
      startStopBtn.classList.remove('is-stop');
    }
    
    if (payload && payload.copyErrors && payload.copyErrors.length > 0) {
      jobErrors[jobId] = payload.copyErrors;
      jobEl.classList.add('is-warning');
      viewErrorsBtn.classList.remove('hidden');
      statusWarning.textContent = `${payload.copyErrors.length} file(s) failed to copy.`;
      statusWarning.classList.remove('hidden');
    } else if (status !== 'Copying') { // Don't clear warnings while copying
      jobEl.classList.remove('is-warning');
      viewErrorsBtn.classList.add('hidden');
      statusWarning.classList.add('hidden');
      delete jobErrors[jobId];
    }

    [...jobEl.querySelectorAll('.btn-edit, .btn-delete')].forEach(b => b.disabled = isRunning);
    startStopBtn.disabled = false;
    cleanupBtn.disabled = isRunning;
    
    jobEl.classList.toggle('is-error', status === 'Error');
    jobEl.classList.toggle('is-done', status === 'Done');

    if (status === 'DoneWithErrors') {
      jobEl.classList.add('is-warning');
    }
    
    if (status === 'Done' || status === 'DoneWithErrors') {
      if (payload && payload.filesToDelete && payload.filesToDelete.length > 0) {
        pendingCleanups[jobId] = payload.filesToDelete;
        cleanupBtn.classList.remove('hidden');
      } else {
        delete pendingCleanups[jobId];
        cleanupBtn.classList.add('hidden');
      }
      updateBatchCleanupButton();
    }

    if (['Error', 'Done', 'DoneWithErrors', 'Stopped'].includes(status)) {
      if (isBatchRunning) {
        setTimeout(processJobQueue, 500);
      }
      setTimeout(() => {
        jobEl.classList.remove('is-error', 'is-done');
        if (!Object.keys(pendingCleanups).includes(jobId) && !Object.keys(jobErrors).includes(jobId)) {
          statusText.textContent = 'Idle';
          progressBar.style.width = '0%';
        }
      }, 8000);
    }
  });
  
  window.electronAPI.onCleanupComplete(({ jobId, success }) => {
     const jobEl = document.querySelector(`.job-item[data-id="${jobId}"]`);
     if (jobEl) {
        delete pendingCleanups[jobId];
        updateBatchCleanupButton();
        
        const statusText = jobEl.querySelector('.status-text');
        const cleanupBtn = jobEl.querySelector('.btn-cleanup');
        
        cleanupBtn.classList.add('hidden');
        cleanupBtn.disabled = false;
        
        if(success) {
            statusText.textContent = 'Cleanup complete.';
            jobEl.classList.add('is-done');
            addLog('SUCCESS', `Cleanup for job ${jobId} finished successfully.`);
        } else {
            statusText.textContent = 'Cleanup failed.';
            jobEl.classList.add('is-error');
            addLog('ERROR', `Cleanup for job ${jobId} failed.`);
        }

        setTimeout(() => {
             jobEl.classList.remove('is-error', 'is-done');
             statusText.textContent = 'Idle';
        }, 5000);
     }
  });

  window.electronAPI.onLogMessage(({ level, message }) => {
    addLog(level, message);
  });

  loadSettings();
  loadJobs();
});