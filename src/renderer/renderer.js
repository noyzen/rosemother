// Wire up window controls using the safe preload bridge
const minBtn = document.getElementById('min-btn');
const maxBtn = document.getElementById('max-btn');
const maxIcon = document.getElementById('max-icon');
const closeBtn = document.getElementById('close-btn');

// Updates the maximize/restore button icon and tooltip.
async function refreshMaxButton() {
  try {
    const maximized = await window.windowControls.isMaximized();
    document.body.classList.toggle('maximized', maximized);
    if (maximized) {
      maxIcon.classList.remove('fa-window-maximize');
      maxIcon.classList.add('fa-window-restore');
      const text = 'Restore';
      maxBtn.title = text;
      maxBtn.setAttribute('aria-label', text);
    } else {
      maxIcon.classList.remove('fa-window-restore');
      maxIcon.classList.add('fa-window-maximize');
      const text = 'Maximize';
      maxBtn.title = text;
      maxBtn.setAttribute('aria-label', text);
    }
  } catch {}
}

// Wire up window control buttons.
minBtn?.addEventListener('click', () => window.windowControls.minimize());
maxBtn?.addEventListener('click', () => window.windowControls.maximize());
closeBtn?.addEventListener('click', () => window.windowControls.close());

// Listen to maximize changes from main process to update icon.
window.windowControls.onMaximizeChanged(refreshMaxButton);

// Initial setup on load.
(function init() {
  // Set static text content
  document.getElementById('window-title').textContent = 'Hello Electron';
  document.getElementById('hello').textContent = 'Hello, Electron!';
  document.getElementById('desc').textContent = 'A simple, cross-platform desktop app to get you started.';
  document.getElementById('platform-label').textContent = 'Platform';

  refreshMaxButton();
})();

// Display platform info once the DOM is ready.
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('platform').textContent = `${window.appInfo.platform}`;
});