document.addEventListener('DOMContentLoaded', () => {
  const jobsListEl = document.getElementById('jobs-list');
  const emptyStateEl = document.getElementById('empty-state');
  const addJobBtn = document.getElementById('add-job-btn');
  const startAllBtn = document.getElementById('start-all-btn');
  const logBtn = document.getElementById('log-btn');
  
  // Header buttons
  const settingsBtn = document.getElementById('settings-btn');

  // Modals
  const jobModal = document.getElementById('job-modal');
  const jobForm = document.getElementById('job-form');
  const modalTitle = document.getElementById('modal-title');
  const jobIdInput = document.getElementById('job-id-input');
  const jobNameInput = document.getElementById('job-name');
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
  
  // Settings Modal Elements
  const settingsModal = document.getElementById('settings-modal');
  const closeSettingsBtn = document.getElementById('close-settings-btn');
  const exportJobsBtn = document.getElementById('export-jobs-btn');
  const importJobsBtn = document.getElementById('import-jobs-btn');
  const autoCleanupToggle = document.getElementById('auto-cleanup-toggle');
  const preventSleepToggle = document.getElementById('prevent-sleep-toggle');
  const shutdownOnCompletionToggle = document.getElementById('shutdown-on-completion-toggle');

  // Shutdown Modal Elements
  const shutdownConfirmModal = document.getElementById('shutdown-confirm-modal');
  const shutdownCountdownTimer = document.getElementById('shutdown-countdown-timer');
  const cancelShutdownBtn = document.getElementById('cancel-shutdown-btn');

  let jobs = [];
  let appSettings = { loggingEnabled: true, preventSleep: false, autoCleanup: false };
  let confirmCallback = null;
  let pendingCleanups = {};
  let jobQueue = [];
  let isBatchRunning = false;
  let jobErrors = {};
  let runningJobs = new Set();
  
  // Session-only state
  let shutdownOnCompletion = false;
  let shutdownInterval = null;
  
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
    appSettings.loggingEnabled = e.target.checked;
    saveSettings();

    if (appSettings.loggingEnabled) {
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

  const formatETA = (ms) => {
    if (ms <= 0 || !isFinite(ms)) {
      return '';
    }
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));

    if (days > 0) return `~${days}d ${hours}h left`;
    if (hours > 0) return `~${hours}h ${minutes}m left`;
    if (minutes > 0) return `~${minutes}m ${seconds}s left`;
    return `~${seconds}s left`;
  };

  const renderJobs = () => {
    const hasJobs = jobs.length > 0;
    emptyStateEl.classList.toggle('hidden', !hasJobs);
    jobsListEl.classList.toggle('hidden', !hasJobs);
    startAllBtn.classList.toggle('hidden', !hasJobs);
    
    jobsListEl.innerHTML = '';

    if (hasJobs) {
      jobs.forEach(job => {
        const hasPendingCleanup = pendingCleanups[job.id] && pendingCleanups[job.id].length > 0;
        const hasPersistedErrors = jobErrors[job.id] && jobErrors[job.id].length > 0;
        
        let idleMessage = 'Idle';
        if (hasPendingCleanup) {
            idleMessage = `${pendingCleanups[job.id].length} item(s) pending cleanup.`;
        } else if (hasPersistedErrors) {
            idleMessage = 'Last run finished with errors';
        }
        
        const jobEl = document.createElement('div');
        jobEl.className = 'job-item';
        if (hasPersistedErrors) {
            jobEl.classList.add('is-warning');
        }
        jobEl.dataset.id = job.id;
        jobEl.draggable = true;

        jobEl.innerHTML = `
            <div class="job-drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></div>
            <div class="job-content">
                <div class="job-header">
                    <h3 class="job-name">${job.name || 'Untitled Job'}</h3>
                </div>

                <div class="job-paths-container">
                    <div class="job-path-block">
                        <div class="job-path-label">SOURCE</div>
                        <div class="path-display" title="${job.source}">
                            <i class="fa-regular fa-folder-open source-icon"></i>
                            <span class="path-text">${job.source}</span>
                        </div>
                    </div>
                    <div class="job-path-arrow">
                        <i class="fa-solid fa-right-long"></i>
                    </div>
                    <div class="job-path-block">
                        <div class="job-path-label">DESTINATION</div>
                        <div class="path-display" title="${job.destination}">
                            <i class="fa-solid fa-server dest-icon"></i>
                            <span class="path-text">${job.destination}</span>
                        </div>
                    </div>
                </div>

                <div class="job-footer">
                     <div class="job-status-container">
                        <div class="job-status">
                            <span class="status-text">${idleMessage}</span>
                            <span class="status-eta hidden"></span>
                            <span class="status-warning ${hasPersistedErrors ? '' : 'hidden'}">${hasPersistedErrors ? `${jobErrors[job.id].length} file(s) failed` : ''}</span>
                        </div>
                        <div class="progress-bar-container">
                            <div class="progress-bar"></div>
                        </div>
                     </div>
                     <div class="job-actions">
                        <button class="btn btn-sm btn-warning btn-view-errors ${hasPersistedErrors ? '' : 'hidden'}" title="View Errors"><i class="fa-solid fa-triangle-exclamation"></i> Errors</button>
                        <button class="btn btn-sm btn-warning btn-cleanup ${hasPendingCleanup ? '' : 'hidden'}" title="Cleanup Files"><i class="fa-solid fa-broom"></i> Cleanup</button>
                        <button class="btn btn-sm btn-primary btn-start-stop" title="Start Backup"><i class="fa-solid fa-play"></i> Start</button>
                        <div class="job-actions-divider"></div>
                        <button class="btn btn-sm btn-secondary btn-edit" title="Edit Job"><i class="fa-solid fa-pencil"></i> Edit</button>
                        <button class="btn btn-sm btn-secondary btn-delete" title="Delete Job"><i class="fa-solid fa-trash-can"></i> Delete</button>
                    </div>
                </div>
            </div>`;
        jobsListEl.appendChild(jobEl);
      });
    }
  };

  const saveJobs = async () => {
    await window.electronAPI.setJobs(jobs);
    addLog('INFO', `Job configurations saved. Total jobs: ${jobs.length}.`);
    renderJobs();
  };

  const loadSettings = async () => {
    const storedSettings = await window.electronAPI.getSettings();
    appSettings = {
        loggingEnabled: true,
        preventSleep: false,
        autoCleanup: false,
        ...storedSettings
    };
    loggingEnabledToggle.checked = appSettings.loggingEnabled;
    preventSleepToggle.checked = appSettings.preventSleep;
    autoCleanupToggle.checked = appSettings.autoCleanup;
    addLog('INFO', `Settings loaded (Logging: ${appSettings.loggingEnabled}, Prevent Sleep: ${appSettings.preventSleep}, Auto Cleanup: ${appSettings.autoCleanup}).`);
  };

  const saveSettings = async () => {
    appSettings.loggingEnabled = loggingEnabledToggle.checked;
    appSettings.preventSleep = preventSleepToggle.checked;
    appSettings.autoCleanup = autoCleanupToggle.checked;
    await window.electronAPI.setSettings(appSettings);
    addLog('INFO', `Settings saved (Logging: ${appSettings.loggingEnabled}, Prevent Sleep: ${appSettings.preventSleep}, Auto Cleanup: ${appSettings.autoCleanup}).`);
  };

  const openJobModal = (job = null) => {
    jobForm.reset();
    if (job) {
      modalTitle.textContent = 'Edit Backup Job';
      jobIdInput.value = job.id;
      jobNameInput.value = job.name || '';
      sourcePathInput.value = job.source;
      destPathInput.value = job.destination;
    } else {
      modalTitle.textContent = 'New Backup Job';
      jobIdInput.value = '';
      jobNameInput.value = '';
    }
    jobModal.classList.remove('hidden');
    jobNameInput.focus();
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
                    const jobName = job ? job.name : 'Unknown Job';
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
      name: jobNameInput.value.trim(),
      source: sourcePathInput.value,
      destination: destPathInput.value
    };

    if (!newJobData.name) {
        alert('Job Name is required.');
        return;
    }

    if (!newJobData.source || !newJobData.destination) {
        alert('Source and Destination folders must be selected.');
        return;
    }
    
    if (id) { // Editing
      const index = jobs.findIndex(job => job.id === id);
      jobs[index] = { ...jobs[index], ...newJobData };
      delete jobs[index].autoCleanup;
      addLog('INFO', `Job "${newJobData.name}" has been edited.`);
    } else { // Adding
      const newId = `job_${Date.now()}`;
      jobs.push({ id: newId, ...newJobData });
      addLog('INFO', `New job "${newJobData.name}" has been added.`);
    }
    saveJobs();
    closeJobModal();
  });

  // --- Drag and Drop Logic ---
  let draggedId = null;

  jobsListEl.addEventListener('dragstart', e => {
    const target = e.target.closest('.job-item');
    if (target) {
        draggedId = target.dataset.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedId);
        // Delay adding class to allow browser to capture drag image
        setTimeout(() => {
            target.classList.add('dragging');
        }, 0);
    }
  });

  jobsListEl.addEventListener('dragend', e => {
    const target = e.target.closest('.job-item');
    if (target) {
        target.classList.remove('dragging');
    }
    document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    draggedId = null;
  });

  jobsListEl.addEventListener('dragover', e => {
      e.preventDefault();
      const target = e.target.closest('.job-item');

      document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });

      if (target && target.dataset.id !== draggedId) {
          const rect = target.getBoundingClientRect();
          const isAfter = e.clientY > rect.top + rect.height / 2;
          target.classList.toggle('drag-over-bottom', isAfter);
          target.classList.toggle('drag-over-top', !isAfter);
      }
  });

  jobsListEl.addEventListener('drop', async e => {
    e.preventDefault();
    document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    const droppedOnElement = e.target.closest('.job-item');
    if (!droppedOnElement || droppedOnElement.dataset.id === draggedId) {
        return;
    }

    const draggedIndex = jobs.findIndex(j => j.id === draggedId);
    const targetIndex = jobs.findIndex(j => j.id === droppedOnElement.dataset.id);

    if (draggedIndex === -1 || targetIndex === -1) return;
    
    const [draggedItem] = jobs.splice(draggedIndex, 1);
    const rect = droppedOnElement.getBoundingClientRect();
    const isAfter = e.clientY > rect.top + rect.height / 2;
    
    const newTargetIndex = jobs.findIndex(j => j.id === droppedOnElement.dataset.id);

    if (isAfter) {
        jobs.splice(newTargetIndex + 1, 0, draggedItem);
    } else {
        jobs.splice(newTargetIndex, 0, draggedItem);
    }
    
    await window.electronAPI.setJobs(jobs);
    addLog('INFO', 'Job order changed.');
    renderJobs();
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
        const job = jobs.find(j => j.id === jobId);
        const confirmed = await showConfirm(`Delete "${job.name}"?`, 'Are you sure you want to permanently delete this job configuration?', 'danger');
        if (confirmed) {
            jobs = jobs.filter(j => j.id !== jobId);
            delete pendingCleanups[jobId];
            delete jobErrors[jobId];
            addLog('WARN', `Job "${job.name}" has been deleted.`);
            await window.electronAPI.setJobErrors(jobErrors);
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

  // --- Shutdown Logic ---
  const initiateShutdown = () => {
    let countdown = 10;
    shutdownCountdownTimer.textContent = countdown;
    shutdownConfirmModal.classList.remove('hidden');
    addLog('WARN', 'All jobs completed. System shutdown initiated with a 10-second countdown.');

    shutdownInterval = setInterval(() => {
        countdown--;
        shutdownCountdownTimer.textContent = countdown;
        if (countdown <= 0) {
            clearInterval(shutdownInterval);
            shutdownInterval = null;
            addLog('WARN', 'Countdown finished. Executing system shutdown.');
            window.electronAPI.executeShutdown();
        }
    }, 1000);
  };

  const cancelShutdown = () => {
    if (shutdownInterval) {
        clearInterval(shutdownInterval);
        shutdownInterval = null;
    }
    shutdownConfirmModal.classList.add('hidden');
    addLog('INFO', 'System shutdown was canceled by the user.');
  };

  cancelShutdownBtn.addEventListener('click', cancelShutdown);
  shutdownOnCompletionToggle.addEventListener('change', e => {
    shutdownOnCompletion = e.target.checked;
    if (shutdownOnCompletion) {
        addLog('WARN', 'Shutdown on completion has been enabled for this session.');
    } else {
        addLog('INFO', 'Shutdown on completion has been disabled.');
    }
  });

  const processJobQueue = () => {
    if (jobQueue.length === 0) {
        isBatchRunning = false;
        startAllBtn.disabled = false;
        startAllBtn.innerHTML = '<i class="fa-solid fa-play-circle"></i> Start All';
        addLog('SUCCESS', 'Batch run for all jobs completed.');
        if (shutdownOnCompletion) {
            initiateShutdown();
        }
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
  
  // --- Settings Modal ---
  settingsBtn.addEventListener('click', () => settingsModal.classList.remove('hidden'));
  closeSettingsBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));
  
  autoCleanupToggle.addEventListener('change', saveSettings);
  preventSleepToggle.addEventListener('change', saveSettings);

  exportJobsBtn.addEventListener('click', async () => {
    addLog('INFO', 'Attempting to export jobs...');
    const exportData = {
        version: '1.0.0',
        rosemother_export: true,
        jobs: jobs.map(({ name, source, destination }) => ({ name, source, destination })),
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
                        name: importedJob.name || `Imported Job ${importedCount + 1}`,
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

    const statusText = jobEl.querySelector('.status-text');
    const statusEta = jobEl.querySelector('.status-eta');
    const statusWarning = jobEl.querySelector('.status-warning');
    const progressBar = jobEl.querySelector('.progress-bar');
    const startStopBtn = jobEl.querySelector('.btn-start-stop');
    const cleanupBtn = jobEl.querySelector('.btn-cleanup');
    const viewErrorsBtn = jobEl.querySelector('.btn-view-errors');
    
    const isCounting = (message || '').startsWith('Counting');
    if (isCounting && progress < 0) {
      const textNode = document.createTextNode(` ${message}`);
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-spinner fa-spin status-spinner';
      statusText.innerHTML = ''; // Clear previous content
      statusText.appendChild(icon);
      statusText.appendChild(textNode);
    } else {
      statusText.textContent = message || status;
    }
    
    if (progress < 0) { // Indeterminate state
      progressBar.style.width = '100%';
      progressBar.classList.add('indeterminate');
    } else {
      progressBar.classList.remove('indeterminate');
      progressBar.style.width = `${progress}%`;
    }
    
    const isRunning = ['Scanning', 'Copying', 'Syncing', 'Cleaning'].includes(status);
    jobEl.classList.toggle('is-running', isRunning);

    if (isRunning) {
      runningJobs.add(jobId);
      startStopBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
      startStopBtn.setAttribute('title', 'Stop Backup');
      startStopBtn.classList.add('is-stop', 'btn-danger');
      startStopBtn.classList.remove('btn-primary');
    } else {
      runningJobs.delete(jobId);
      startStopBtn.innerHTML = '<i class="fa-solid fa-play"></i> Start';
      startStopBtn.setAttribute('title', 'Start Backup');
      startStopBtn.classList.remove('is-stop', 'btn-danger');
      startStopBtn.classList.add('btn-primary');
    }

    if (status === 'Copying' && payload && payload.eta > 0) {
        statusEta.textContent = formatETA(payload.eta);
        statusEta.classList.remove('hidden');
    } else {
        statusEta.classList.add('hidden');
    }
    
    if (payload && payload.copyErrors && payload.copyErrors.length > 0) {
      jobErrors[jobId] = payload.copyErrors;
      jobEl.classList.add('is-warning');
      viewErrorsBtn.classList.remove('hidden');
      statusWarning.textContent = `${payload.copyErrors.length} file(s) failed.`;
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
        if (!appSettings.autoCleanup) { // Only show manual cleanup button if auto cleanup is off
            pendingCleanups[jobId] = payload.filesToDelete;
            cleanupBtn.classList.remove('hidden');
        }
      } else {
        delete pendingCleanups[jobId];
        cleanupBtn.classList.add('hidden');
      }
    }

    if (['Error', 'Done', 'DoneWithErrors', 'Stopped'].includes(status)) {
      if (isBatchRunning) {
        setTimeout(processJobQueue, 500);
      }
      setTimeout(() => {
        jobEl.classList.remove('is-error', 'is-done');
        const hasPersistedErrors = jobErrors[jobId] && jobErrors[jobId].length > 0;
        const hasPendingCleanup = pendingCleanups[jobId] && pendingCleanups[jobId].length > 0;
        
        if (hasPendingCleanup) {
            statusText.textContent = `${pendingCleanups[jobId].length} item(s) pending cleanup.`;
        } else if (hasPersistedErrors) {
            statusText.textContent = 'Last run finished with errors';
            jobEl.classList.add('is-warning');
        } else {
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

  async function initializeApp() {
    await loadSettings();
    jobs = await window.electronAPI.getJobs();
    addLog('INFO', `Loaded ${jobs.length} jobs from storage.`);
    jobErrors = await window.electronAPI.getJobErrors();
    addLog('INFO', `Loaded ${Object.keys(jobErrors).length} persisted job error logs.`);
    renderJobs();
  }

  initializeApp();
});