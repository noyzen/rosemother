document.addEventListener('DOMContentLoaded', () => {
  const jobsListEl = document.getElementById('jobs-list');
  const emptyStateEl = document.getElementById('empty-state');
  const addJobBtn = document.getElementById('add-job-btn');

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
  let confirmCallback = null;

  const renderJobs = () => {
    jobsListEl.innerHTML = '';
    if (jobs.length === 0) {
      emptyStateEl.classList.remove('hidden');
      jobsListEl.classList.add('hidden');
    } else {
      emptyStateEl.classList.add('hidden');
      jobsListEl.classList.remove('hidden');
      jobs.forEach(job => {
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
              <span class="status-text">Idle</span>
              <div class="progress-bar-container">
                <div class="progress-bar"></div>
              </div>
            </div>
            <div class="job-actions">
              <button class="btn-icon btn-start" aria-label="Start Backup"><i class="fa-solid fa-play"></i></button>
              <button class="btn-icon btn-edit" aria-label="Edit Job"><i class="fa-solid fa-pencil"></i></button>
              <button class="btn-icon btn-delete" aria-label="Delete Job"><i class="fa-solid fa-trash-can"></i></button>
            </div>
          </div>
        `;
        jobsListEl.appendChild(jobEl);
      });
    }
  };

  const saveJobs = async () => {
    await window.electronAPI.setJobs(jobs);
    renderJobs();
  };

  const loadJobs = async () => {
    jobs = await window.electronAPI.getJobs();
    renderJobs();
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

  const showConfirm = (title, message, okClass = 'btn-danger', files = []) => {
    return new Promise(resolve => {
        confirmTitle.textContent = title;
        confirmMessage.textContent = message;
        confirmFileList.innerHTML = '';

        if(files.length > 0) {
            confirmFileList.classList.remove('hidden');
            const list = document.createElement('ul');
            files.slice(0, 100).forEach(file => { // show max 100 files
                const item = document.createElement('li');
                item.textContent = file;
                list.appendChild(item);
            });
            if (files.length > 100) {
                 const item = document.createElement('li');
                 item.textContent = `...and ${files.length - 100} more files.`;
                 list.appendChild(item);
            }
            confirmFileList.appendChild(list);
        } else {
            confirmFileList.classList.add('hidden');
        }

        const okBtn = document.getElementById('confirm-ok-btn');
        okBtn.className = `btn-${okClass}`;

        confirmModal.classList.remove('hidden');
        confirmCallback = (confirmed) => {
            confirmModal.classList.add('hidden');
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
            saveJobs();
        }
    }
  });

  window.electronAPI.onJobUpdate(data => {
    const { jobId, status, progress, message } = data;
    const jobEl = document.querySelector(`.job-item[data-id="${jobId}"]`);
    if (jobEl) {
        const statusText = jobEl.querySelector('.status-text');
        const progressBar = jobEl.querySelector('.progress-bar');
        const startBtn = jobEl.querySelector('.btn-start');

        statusText.textContent = message || status;
        progressBar.style.width = `${progress}%`;
        
        const isRunning = ['Scanning', 'Copying', 'Syncing'].includes(status);
        startBtn.disabled = isRunning;
        jobEl.classList.toggle('is-running', isRunning);
        jobEl.classList.toggle('is-error', status === 'Error');
        jobEl.classList.toggle('is-done', status === 'Done');

        if(status === 'Error' || status === 'Done') {
            setTimeout(() => {
                jobEl.classList.remove('is-error', 'is-done');
                statusText.textContent = 'Idle';
                progressBar.style.width = '0%';
            }, 8000);
        }
    }
  });

  window.electronAPI.handleConfirmDelete(async ({ jobId, files }) => {
    const confirmed = await showConfirm(
        'Confirm Sync Deletion',
        `The following ${files.length} files exist in the destination but not the source. Do you want to permanently delete them? This action cannot be undone.`,
        'danger',
        files
    );
    return { confirmed };
  });

  loadJobs();
});
