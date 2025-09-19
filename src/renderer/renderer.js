// Initial setup on load.
(function init() {
  // Set static text content
  document.getElementById('hello').textContent = 'Hello, Electron!';
  document.getElementById('desc').textContent = 'A simple, cross-platform desktop app to get you started.';
  document.getElementById('platform-label').textContent = 'Platform';
})();

// Display platform info once the DOM is ready.
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('platform').textContent = `${window.appInfo.platform}`;
});
