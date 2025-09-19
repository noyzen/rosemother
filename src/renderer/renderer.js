document.addEventListener('DOMContentLoaded', () => {
  const jobsListEl = document.getElementById('jobs-list');
  const emptyStateEl = document.getElementById('empty-state');
  const addJobBtn = document.getElementById('add-job-btn');
  const startAllBtn = document.getElementById('start-all-btn');
  const stopAllBtn = document.getElementById('stop-all-btn');
  
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
  const jobExclusionsEnabledToggle = document.getElementById('job-exclusions-enabled');
  const exclusionsContainer = document.getElementById('exclusions-container');
  const excludedPathsList = document.getElementById('excluded-paths-list');
  const excludedExtensionsPathList = document.getElementById('excluded-extensions-list');
  const addExcludedFolderBtn = document.getElementById('add-excluded-folder-btn');
  
  const confirmModal = document.getElementById('confirm-modal');
  const confirmTitle = document.getElementById('confirm-title');
  const confirmMessage = document.getElementById('confirm-message');
  const confirmFileList = document.getElementById('confirm-file-list');

  // Job Errors Modal
  const errorsModal = document.getElementById('errors-modal');
  const errorsModalTitle = document.getElementById('errors-modal-title');
  const errorsModalJobId = document.getElementById('errors-modal-job-id');
  const errorsListContainer = document.getElementById('errors-list-container');
  const errorsSearchInput = document.getElementById('errors-search-input');
  const clearCurrentJobErrorsBtn = document.getElementById('clear-current-job-errors-btn');
  const closeErrorsBtn = document.getElementById('close-errors-btn');
  
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
  let appSettings = { preventSleep: false, autoCleanup: false };
  let confirmCallback = null;
  let pendingCleanups = {};
  let jobErrors = {};

  // --- New Centralized State Management ---
  let activeJobId = null; // ID of the job currently running (backup or cleanup)
  let activeJobStatus = null; // The detailed status of the active job
  let jobQueue = []; // For "Start All"
  let isBatchRunning = false;
  
  // Session-only state
  let shutdownOnCompletion = false;
  let shutdownInterval = null;
  
  // --- Job Errors Panel ---
  const renderErrorPanel = (jobId, filter = '') => {
      const searchTerm = filter.toLowerCase();
      const errors = jobErrors[jobId] || [];
      
      const filteredErrors = searchTerm
          ? errors.filter(e => e.path.toLowerCase().includes(searchTerm) || e.error.toLowerCase().includes(searchTerm))
          : errors;

      if (filteredErrors.length === 0) {
          errorsListContainer.innerHTML = `<div class="log-empty-state">No errors found${searchTerm ? ' matching your filter' : ''}.</div>`;
          return;
      }

      const html = filteredErrors.map(error => {
          return `<div class="error-entry">
                      <div class="error-path">${error.path}</div>
                      <div class="error-reason">${error.error}</div>
                  </div>`;
      }).join('');

      errorsListContainer.innerHTML = html;
  };

  const openErrorPanel = (jobId) => {
      const job = jobs.find(j => j.id === jobId);
      if (!job || !jobErrors[jobId]) return;

      errorsModalTitle.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Errors for ${job.name}`;
      errorsModalJobId.value = jobId;
      errorsSearchInput.value = '';
      renderErrorPanel(jobId, '');
      errorsModal.classList.remove('hidden');
  };

  errorsSearchInput.addEventListener('input', () => {
    const jobId = errorsModalJobId.value;
    if (jobId) {
        renderErrorPanel(jobId, errorsSearchInput.value);
    }
  });

  closeErrorsBtn.addEventListener('click', () => errorsModal.classList.add('hidden'));

  clearCurrentJobErrorsBtn.addEventListener('click', async () => {
      const jobId = errorsModalJobId.value;
      const job = jobs.find(j => j.id === jobId);
      if (!job || !jobErrors[jobId]) return;

      const confirmed = await showConfirm(
          `Clear errors for "${job.name}"?`,
          `Are you sure you want to clear ${jobErrors[jobId].length} persisted copy error(s) for this job? This action cannot be undone.`,
          'danger'
      );

      if (confirmed) {
          delete jobErrors[jobId];
          await window.electronAPI.setJobErrors(jobErrors);
          renderJobs();
          errorsModal.classList.add('hidden');
      }
  });
  // --- End Job Errors Panel ---

  const updateHeaderActionsState = () => {
    const hasJobs = jobs.length > 0;
    const isOperationRunning = activeJobId !== null;
    
    startAllBtn.classList.toggle('hidden', !hasJobs || isOperationRunning);
    stopAllBtn.classList.toggle('hidden', !isOperationRunning && !isBatchRunning);

    startAllBtn.disabled = isOperationRunning;
    stopAllBtn.disabled = !isOperationRunning && !isBatchRunning;
  };

  const renderJobs = () => {
    const hasJobs = jobs.length > 0;
    jobsListEl.classList.toggle('hidden', !hasJobs);
    
    emptyStateEl.classList.toggle('hidden', jobs.length > 0);

    jobsListEl.innerHTML = '';
    
    const isAnyOperationActive = activeJobId !== null;

    if (hasJobs) {
      jobs.forEach(job => {
        const hasPendingCleanup = pendingCleanups[job.id] && pendingCleanups[job.id].length > 0;
        const errorCount = (jobErrors[job.id] || []).length;
        const hasPersistedErrors = errorCount > 0;
        const isThisJobActive = job.id === activeJobId;
        const isQueued = isBatchRunning && jobQueue.includes(job.id);
        
        let statusText = 'Idle';
        
        // Handle transient status messages (e.g., after cleanup)
        if (job.lastStatusUntil && job.lastStatusUntil > Date.now()) {
            statusText = job.lastStatusMessage;
        } else if (hasPendingCleanup) {
            statusText = `${pendingCleanups[job.id].length} item(s) pending cleanup.`;
        } else if (hasPersistedErrors) {
            statusText = `Last run finished with ${errorCount} error(s)`;
        }

        if (isThisJobActive) {
            statusText = activeJobStatus || 'Starting...';
        } else if (isQueued) {
            statusText = 'Queued...';
        }
        
        const jobEl = document.createElement('div');
        jobEl.className = 'job-item';
        jobEl.dataset.id = job.id;
        jobEl.draggable = !isAnyOperationActive;

        if (isThisJobActive) jobEl.classList.add('is-running');
        if (isQueued) jobEl.classList.add('is-queued');
        if (hasPersistedErrors && !isThisJobActive) jobEl.classList.add('is-warning');
        
        // Handle transient status styling
        if (job.lastStatusUntil && job.lastStatusUntil > Date.now()) {
             jobEl.classList.add(job.lastStatusMessage.includes('fail') ? 'is-error' : 'is-done');
        }

        jobEl.innerHTML = `
            <div class="job-drag-handle" title="${isAnyOperationActive ? 'Cannot reorder while a job is running' : 'Drag to reorder'}"><i class="fa-solid fa-grip-vertical"></i></div>
            <div class="job-content">
                <div class="job-header">
                    <h3 class="job-name">${job.name || 'Untitled Job'}</h3>
                    <div class="job-actions">
                        <button class="btn btn-sm btn-warning btn-view-errors ${hasPersistedErrors && !isThisJobActive ? '' : 'hidden'}" title="View Errors"><i class="fa-solid fa-triangle-exclamation"></i> Errors${hasPersistedErrors ? ` (${errorCount})` : ''}</button>
                        <button class="btn btn-sm btn-warning btn-cleanup ${hasPendingCleanup ? '' : 'hidden'}" title="Cleanup Files" ${isAnyOperationActive ? 'disabled' : ''}><i class="fa-solid fa-broom"></i> Cleanup</button>
                        <button class="btn btn-sm ${isThisJobActive ? 'btn-danger is-stop' : 'btn-primary'} btn-start-stop" title="${isThisJobActive ? 'Stop Backup' : 'Start Backup'}" ${isAnyOperationActive && !isThisJobActive ? 'disabled' : ''}>
                            <i class="fa-solid ${isThisJobActive ? 'fa-stop' : 'fa-play'}"></i> ${isThisJobActive ? 'Stop' : 'Start'}
                        </button>
                        <div class="job-actions-divider"></div>
                        <button class="btn btn-sm btn-secondary btn-edit" title="Edit Job" ${isAnyOperationActive ? 'disabled' : ''}><i class="fa-solid fa-pencil"></i> Edit</button>
                        <button class="btn btn-sm btn-secondary btn-delete" title="Delete Job" ${isAnyOperationActive ? 'disabled' : ''}><i class="fa-solid fa-trash-can"></i> Delete</button>
                    </div>
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
                            <span class="status-text">${statusText}</span>
                            <div class="status-details">
                                <span class="status-warning hidden"></span>
                                <span class="status-count hidden"></span>
                                <span class="status-eta hidden"></span>
                            </div>
                        </div>
                        <div class="progress-bar-container">
                            <div class="progress-bar" style="width: 0%;"></div>
                        </div>
                     </div>
                </div>
            </div>`;
        jobsListEl.appendChild(jobEl);
      });
    }
    updateHeaderActionsState();
  };

  const saveJobs = async () => {
    await window.electronAPI.setJobs(jobs);
    renderJobs();
  };

  const loadSettings = async () => {
    const storedSettings = await window.electronAPI.getSettings();
    appSettings = {
        preventSleep: false,
        autoCleanup: false,
        ...storedSettings
    };
    preventSleepToggle.checked = appSettings.preventSleep;
    autoCleanupToggle.checked = appSettings.autoCleanup;
  };

  const saveSettings = async () => {
    appSettings.preventSleep = preventSleepToggle.checked;
    appSettings.autoCleanup = autoCleanupToggle.checked;
    await window.electronAPI.setSettings(appSettings);
  };

  const renderExclusionRule = (listEl, text) => {
    const item = document.createElement('div');
    item.className = 'exclusion-item';
    item.innerHTML = `
      <span>${text}</span>
      <button type="button" class="btn-icon-sm btn-delete-exclusion" title="Remove rule"><i class="fa-solid fa-times"></i></button>
    `;
    item.querySelector('.btn-delete-exclusion').addEventListener('click', () => item.remove());
    listEl.appendChild(item);
  };

  const openJobModal = (job = null) => {
    jobForm.reset();
    jobExclusionsEnabledToggle.checked = false;
    exclusionsContainer.classList.add('hidden');
    excludedPathsList.innerHTML = '';
    excludedExtensionsPathList.innerHTML = '';
    
    if (job) {
      modalTitle.textContent = 'Edit Backup Job';
      jobIdInput.value = job.id;
      jobNameInput.value = job.name || '';
      sourcePathInput.value = job.source;
      destPathInput.value = job.destination;
      
      if (job.exclusions && job.exclusions.enabled) {
        jobExclusionsEnabledToggle.checked = true;
        exclusionsContainer.classList.remove('hidden');
        (job.exclusions.paths || []).forEach(p => renderExclusionRule(excludedPathsList, p));
        (job.exclusions.extensions || []).forEach(e => renderExclusionRule(excludedExtensionsPathList, e));
      }
    } else {
      modalTitle.textContent = 'New Backup Job';
      jobIdInput.value = '';
      jobNameInput.value = '';
    }
    jobModal.classList.remove('hidden');
    jobNameInput.focus();
  };
  
  const closeJobModal = () => jobModal.classList.add('hidden');
  
  const showConfirm = (title, message, okClass = 'danger', data = null) => {
    return new Promise(resolve => {
        confirmTitle.textContent = title;
        confirmMessage.textContent = message;
        confirmFileList.innerHTML = '';

        if(data) {
            confirmFileList.classList.remove('hidden');
            const list = document.createElement('ul');
            
            if (Array.isArray(data)) { // Single job cleanup
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
  document.getElementById('close-job-btn').addEventListener('click', closeJobModal);
  
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

    const getRulesFromList = (listEl) => {
        return Array.from(listEl.querySelectorAll('.exclusion-item span')).map(span => span.textContent);
    };

    const newJobData = {
      name: jobNameInput.value.trim(),
      source: sourcePathInput.value,
      destination: destPathInput.value,
      exclusions: {
        enabled: jobExclusionsEnabledToggle.checked,
        paths: getRulesFromList(excludedPathsList),
        extensions: getRulesFromList(excludedExtensionsPathList),
      }
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
    } else { // Adding
      const newId = `job_${Date.now()}`;
      jobs.push({ id: newId, ...newJobData });
    }
    saveJobs();
    closeJobModal();
  });

  // --- Exclusion UI Logic ---
  jobExclusionsEnabledToggle.addEventListener('change', (e) => {
    exclusionsContainer.classList.toggle('hidden', !e.target.checked);
  });

  addExcludedFolderBtn.addEventListener('click', async () => {
    const sourcePath = sourcePathInput.value;
    if (!sourcePath) {
        alert('Please select a Source Folder before adding exclusions.');
        return;
    }
    
    const selectedPath = await window.electronAPI.openDialogAt(sourcePath);
    if (selectedPath && selectedPath.startsWith(sourcePath)) {
        let relativePath = selectedPath.substring(sourcePath.length);
        // Normalize leading slashes
        if (relativePath.startsWith('\\') || relativePath.startsWith('/')) {
            relativePath = relativePath.substring(1);
        }
        if (relativePath) {
           renderExclusionRule(excludedPathsList, relativePath);
        }
    } else if (selectedPath) {
        alert('The excluded folder must be inside the selected Source Folder.');
    }
  });


  const setupExclusionAdder = (inputId, buttonId, listEl) => {
    const input = document.getElementById(inputId);
    const button = document.getElementById(buttonId);
    const addRule = () => {
      const value = input.value.trim();
      if (value) {
        renderExclusionRule(listEl, value);
        input.value = '';
        input.focus();
      }
    };
    button.addEventListener('click', addRule);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addRule();
      }
    });
  };

  setupExclusionAdder('excluded-extension-input', 'add-excluded-extension-btn', excludedExtensionsPathList);


  // --- Drag and Drop Logic ---
  let draggedId = null;

  jobsListEl.addEventListener('dragstart', e => {
    if (activeJobId !== null) {
      e.preventDefault();
      return;
    }
    const target = e.target.closest('.job-item');
    if (target) {
        draggedId = target.dataset.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedId);
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
    renderJobs();
  });
  
  jobsListEl.addEventListener('click', async e => {
    const button = e.target.closest('button');
    if (!button || button.disabled) return;

    const jobItem = e.target.closest('.job-item');
    const jobId = jobItem.dataset.id;
    const job = jobs.find(j => j.id === jobId);
    
    if (button.classList.contains('btn-start-stop')) {
        if (activeJobId === jobId) { // It's a stop button
            window.electronAPI.stopJob(jobId);
            activeJobStatus = 'Stopping...';
            renderJobs();
        } else if (activeJobId === null) { // It's a start button and nothing else is running
            activeJobId = jobId;
            activeJobStatus = 'Starting...';
            delete jobErrors[jobId];
            delete pendingCleanups[jobId];
            window.electronAPI.startJob(jobId);
            renderJobs();
        }
    } else if (button.classList.contains('btn-view-errors')) {
        openErrorPanel(jobId);
    } else if (button.classList.contains('btn-edit')) {
        openJobModal(job);
    } else if (button.classList.contains('btn-delete')) {
        const confirmed = await showConfirm(`Delete "${job.name}"?`, 'Are you sure you want to permanently delete this job configuration?', 'danger');
        if (confirmed) {
            jobs = jobs.filter(j => j.id !== jobId);
            delete pendingCleanups[jobId];
            delete jobErrors[jobId];
            await window.electronAPI.setJobErrors(jobErrors);
            saveJobs();
        }
    } else if (button.classList.contains('btn-cleanup')) {
        if (activeJobId !== null) return;
        const filesToClean = pendingCleanups[jobId] || [];
        const confirmed = await showConfirm(
            'Confirm Cleanup',
            `Permanently delete ${filesToClean.length} item(s) from the destination? This cannot be undone.`,
            'danger',
            filesToClean
        );
        if (confirmed) {
            activeJobId = jobId;
            activeJobStatus = 'Preparing to clean...';
            window.electronAPI.cleanupJob({ jobId, files: filesToClean });
            renderJobs();
        }
    }
  });

  // --- Shutdown Logic ---
  const initiateShutdown = () => {
    let countdown = 10;
    shutdownCountdownTimer.textContent = countdown;
    shutdownConfirmModal.classList.remove('hidden');

    shutdownInterval = setInterval(() => {
        countdown--;
        shutdownCountdownTimer.textContent = countdown;
        if (countdown <= 0) {
            clearInterval(shutdownInterval);
            shutdownInterval = null;
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
  };

  cancelShutdownBtn.addEventListener('click', cancelShutdown);
  shutdownOnCompletionToggle.addEventListener('change', e => {
    shutdownOnCompletion = e.target.checked;
  });

  const processJobQueue = () => {
    if (jobQueue.length === 0) {
        isBatchRunning = false;
        if (shutdownOnCompletion) {
            initiateShutdown();
        }
        renderJobs();
        return;
    }
    const jobId = jobQueue.shift();
    activeJobId = jobId;
    activeJobStatus = 'Starting...';
    
    delete jobErrors[jobId];
    delete pendingCleanups[jobId];
    
    renderJobs();
    window.electronAPI.startJob(jobId);
  };

  startAllBtn.addEventListener('click', () => {
    if (activeJobId !== null || isBatchRunning) return;
    isBatchRunning = true;
    jobQueue = jobs.map(j => j.id);
    processJobQueue();
  });
  
  stopAllBtn.addEventListener('click', async () => {
    if (activeJobId === null && !isBatchRunning) return;

    const confirmMessage = isBatchRunning
        ? `Are you sure you want to stop the current job and clear the queue of ${jobQueue.length} upcoming job(s)?`
        : 'Are you sure you want to stop the currently running job?';

    const confirmed = await showConfirm('Stop Operation?', confirmMessage, 'danger');

    if (confirmed) {
        jobQueue = [];
        const wasBatchRunning = isBatchRunning;
        isBatchRunning = false;

        if (activeJobId) {
            window.electronAPI.stopJob(activeJobId);
            activeJobStatus = 'Stopping...';
        }
        
        // If only a batch was queued but not started, we need to manually re-render
        if (wasBatchRunning) {
            renderJobs();
        }
    }
  });

  // --- Settings Modal ---
  settingsBtn.addEventListener('click', () => settingsModal.classList.remove('hidden'));
  closeSettingsBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));
  
  autoCleanupToggle.addEventListener('change', saveSettings);
  preventSleepToggle.addEventListener('change', saveSettings);

  const settingsNav = document.querySelector('.settings-nav');
  const settingsPanes = document.querySelectorAll('.settings-pane');
  settingsNav.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;

    settingsNav.querySelectorAll('button').forEach(btn => btn.classList.remove('active'));
    button.classList.add('active');

    const targetPaneId = button.dataset.target;
    settingsPanes.forEach(pane => {
      pane.classList.toggle('active', pane.id === targetPaneId);
    });
  });

  exportJobsBtn.addEventListener('click', async () => {
    const exportData = {
        version: '1.0.0',
        rosemother_export: true,
        jobs: jobs.map(({ name, source, destination, exclusions }) => ({ name, source, destination, exclusions })),
    };
    const { success, error } = await window.electronAPI.saveJsonDialog(JSON.stringify(exportData, null, 2));
    if (!success && error !== 'Save dialog canceled.') {
        await showConfirm('Export Failed', `Could not save the file: ${error}`, 'info');
    }
  });

  importJobsBtn.addEventListener('click', async () => {
    const { success, content, error } = await window.electronAPI.openJsonDialog();
    if (!success) {
        if (error !== 'Open dialog canceled.') {
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
                        destination: importedJob.destination,
                        exclusions: importedJob.exclusions || { enabled: false, paths: [], extensions: [] }
                    });
                    importedCount++;
                }
            }
        });

        if (importedCount > 0) {
            await saveJobs();
            await showConfirm('Import Successful', `Successfully added ${importedCount} new job(s).`, 'info');
        } else {
            await showConfirm('Import Complete', 'No new jobs were imported. The jobs may already exist.', 'info');
        }

    } catch (e) {
        await showConfirm('Import Failed', `Could not parse the file: ${e.message}`, 'info');
    }
  });

  window.electronAPI.onJobUpdate(data => {
    const { jobId, status, progress, message, payload } = data;
    if (jobId !== activeJobId) return;

    const jobEl = document.querySelector(`.job-item[data-id="${jobId}"]`);
    if (!jobEl) return;

    activeJobStatus = message || status;
    
    // --- Update UI elements for the active job ---
    const statusText = jobEl.querySelector('.status-text');
    const statusCount = jobEl.querySelector('.status-count');
    const statusEta = jobEl.querySelector('.status-eta');
    const progressBar = jobEl.querySelector('.progress-bar');
    
    statusText.textContent = activeJobStatus;

    const isFinalState = ['Error', 'Done', 'DoneWithErrors', 'Stopped'].includes(status);
    
    if (isFinalState) {
      if (payload?.filesToDelete?.length > 0) {
          const showCleanupButton = !appSettings.autoCleanup || status !== 'Done';
          if (showCleanupButton) {
              pendingCleanups[jobId] = payload.filesToDelete;
          }
      }
      if (payload?.copyErrors) {
          jobErrors[jobId] = payload.copyErrors;
      }
    }

    if (progress < 0) {
      progressBar.style.width = '100%';
      progressBar.classList.add('indeterminate');
    } else {
      progressBar.classList.remove('indeterminate');
      progressBar.style.width = `${progress}%`;
    }

    jobEl.classList.remove('is-scanning', 'is-copying', 'is-cleaning', 'is-done', 'is-error', 'is-warning');
    if (status === 'Scanning') jobEl.classList.add('is-scanning');
    if (status === 'Copying') jobEl.classList.add('is-copying');
    if (status === 'Cleaning') jobEl.classList.add('is-cleaning');
    if (status === 'Done') jobEl.classList.add('is-done');
    if (['Error', 'DoneWithErrors'].includes(status)) jobEl.classList.add('is-error');

    if (status === 'Copying' && payload && payload.totalSourceFiles > 0) {
        statusCount.textContent = `${payload.processedFiles.toLocaleString()} of ${payload.totalSourceFiles.toLocaleString()}`;
        statusCount.classList.remove('hidden');
    } else {
        statusCount.classList.add('hidden');
    }
    
    // --- State Transition Logic ---
    if (isFinalState) {
        activeJobId = null;
        activeJobStatus = null;
        if (isBatchRunning) {
            setTimeout(processJobQueue, 500);
        } else {
            // Set a transient status for the completed job
            const job = jobs.find(j => j.id === jobId);
            if (job) {
                job.lastStatusMessage = message;
                job.lastStatusUntil = Date.now() + 8000;
            }
            // Re-render to unlock UI
            setTimeout(renderJobs, 500); 
        }
    } else {
        renderJobs(); // Re-render to update things like error counts in real-time
    }
  });
  
  window.electronAPI.onCleanupComplete(({ jobId, success, error }) => {
     if (jobId !== activeJobId) return;
     
     activeJobId = null;
     activeJobStatus = null;
     delete pendingCleanups[jobId];
     
     const job = jobs.find(j => j.id === jobId);
     if(job) {
        job.lastStatusMessage = success ? 'Cleanup complete.' : `Cleanup failed: ${error}`;
        job.lastStatusUntil = Date.now() + 8000;
     }

     if (isBatchRunning) {
        processJobQueue();
     } else {
        renderJobs();
     }
  });

  async function initializeApp() {
    await loadSettings();
    jobs = await window.electronAPI.getJobs();
    jobErrors = await window.electronAPI.getJobErrors();
    renderJobs();
  }

  initializeApp();
});