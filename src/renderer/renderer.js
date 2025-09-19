document.addEventListener('DOMContentLoaded', () => {
  const jobsListEl = document.getElementById('jobs-list');
  const emptyStateEl = document.getElementById('empty-state');
  const addJobBtn = document.getElementById('add-job-btn');
  const startAllBtn = document.getElementById('start-all-btn');
  const batchCleanupBtn = document.getElementById('batch-cleanup-btn');
  const exportJobsBtn = document.getElementById('export-jobs-btn');
  const importJobsBtn = document.getElementById('import-jobs-btn');
  const autoCleanupToggle = document.getElementById('auto-cleanup-toggle');

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

  let jobs = [];
  let appSettings = { autoCleanup: false };
  let confirmCallback = null;
  let pendingCleanups = {};
  let jobQueue = [];
  let isBatchRunning = false;

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
              <div class="progress-bar-container">
                <div class="progress-bar"></div>
              </div>
            </div>
            <div class="job-actions">
              <button class="btn-icon btn-cleanup ${hasPendingCleanup ? '' : 'hidden'}" aria-label="Cleanup Files"><i class="fa-solid fa-broom"></i></button>
              <button class="btn-icon btn-start" aria-label="Start Backup"><i class="fa-solid fa-play"></i></button>
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
    renderJobs();
  };

  const loadJobs = async () => {
    jobs = await window.electronAPI.getJobs();
    renderJobs();
  };

  const loadSettings = async () => {
    appSettings = await window.electronAPI.getSettings();
    autoCleanupToggle.checked = appSettings.autoCleanup;
  };

  const saveSettings = async () => {
    await window.electronAPI.setSettings(appSettings);
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

  const showConfirm = (title, message, okClass = 'btn-danger', cleanupData = null) => {
    return new Promise(resolve => {
        confirmTitle.textContent = title;
        confirmMessage.textContent = message;
        confirmFileList.innerHTML = '';

        if(cleanupData) {
            confirmFileList.classList.remove('hidden');
            const list = document.createElement('ul');
            
            if (Array.isArray(cleanupData)) { // Single job
                 cleanupData.slice(0, 100).forEach(file => {
                    const item = document.createElement('li');
                    item.textContent = file.path;
                    list.appendChild(item);
                });
                if (cleanupData.length > 100) {
                    const item = document.createElement('li');
                    item.textContent = `...and ${cleanupData.length - 100} more items.`;
                    list.appendChild(item);
                }
            } else { // Batch object
                 Object.entries(cleanupData).forEach(([jobId, files]) => {
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
        okBtn.className = `btn-${okClass.startsWith('btn-') ? okClass : `btn-${okClass}`}`;
        
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
    } else { // Adding
      jobs.push({ id: `job_${Date.now()}`, ...newJobData });
    }
    saveJobs();
    closeJobModal();
  });
  
  jobsListEl.addEventListener('click', async e => {
    const button = e.target.closest('button');
    if (!button) return;

    const jobItem = e.target.closest('.job-item');
    const jobId = jobItem.dataset.id;
    
    if (button.classList.contains('btn-start')) {
        window.electronAPI.startJob(jobId);
    } else if (button.classList.contains('btn-edit')) {
        const job = jobs.find(j => j.id === jobId);
        openJobModal(job);
    } else if (button.classList.contains('btn-delete')) {
        const confirmed = await showConfirm('Delete Job', 'Are you sure you want to permanently delete this job configuration?', 'danger');
        if (confirmed) {
            jobs = jobs.filter(j => j.id !== jobId);
            delete pendingCleanups[jobId];
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
            button.disabled = true;
        }
    }
  });

  const processJobQueue = () => {
    if (jobQueue.length === 0) {
        isBatchRunning = false;
        startAllBtn.disabled = false;
        startAllBtn.innerHTML = '<i class="fa-solid fa-play-circle"></i> Start All';
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
    const exportData = {
        version: '1.0.0',
        rosemother_export: true,
        jobs: jobs.map(({ source, destination }) => ({ source, destination })),
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
                        source: importedJob.source,
                        destination: importedJob.destination
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
    const jobEl = document.querySelector(`.job-item[data-id="${jobId}"]`);
    if (jobEl) {
        const statusText = jobEl.querySelector('.status-text');
        const progressBar = jobEl.querySelector('.progress-bar');
        const startBtn = jobEl.querySelector('.btn-start');
        const cleanupBtn = jobEl.querySelector('.btn-cleanup');
        
        statusText.textContent = message || status;
        progressBar.style.width = `${progress}%`;
        
        const isRunning = ['Scanning', 'Copying', 'Syncing'].includes(status);
        [startBtn, ...jobEl.querySelectorAll('.btn-edit, .btn-delete, .btn-cleanup')].forEach(b => b.disabled = isRunning);
        jobEl.classList.toggle('is-running', isRunning);
        jobEl.classList.toggle('is-error', status === 'Error');
        jobEl.classList.toggle('is-done', status === 'Done');

        if (status === 'Done') {
             if (payload && payload.filesToDelete && payload.filesToDelete.length > 0) {
                pendingCleanups[jobId] = payload.filesToDelete;
                cleanupBtn.classList.remove('hidden');
             } else {
                delete pendingCleanups[jobId];
                cleanupBtn.classList.add('hidden');
             }
             updateBatchCleanupButton();
        }

        if (status === 'Error' || status === 'Done') {
            if (isBatchRunning) {
                setTimeout(processJobQueue, 500);
            }
            setTimeout(() => {
                jobEl.classList.remove('is-error', 'is-done');
                if (!Object.keys(pendingCleanups).includes(jobId)) {
                    statusText.textContent = 'Idle';
                    progressBar.style.width = '0%';
                }
            }, 8000);
        }
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
        } else {
            statusText.textContent = 'Cleanup failed.';
            jobEl.classList.add('is-error');
        }

        setTimeout(() => {
             jobEl.classList.remove('is-error', 'is-done');
             statusText.textContent = 'Idle';
        }, 5000);
     }
  });

  loadSettings();
  loadJobs();
});
