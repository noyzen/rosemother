# Rosemother Backup Utility

A simple, powerful, and cross-platform file backup utility built with Electron.

## Features
- Create and manage multiple backup jobs.
- Define a source and destination folder for each job.
- **Standard Check (Default):** Fast and efficient index-based backup. Uses file size and modification dates to detect changed, new, and deleted files.
- **Deep Verification (Optional):** A highly reliable verification mode that is safe for very large files. It compares file sizes and a cryptographic signature (SHA-256 hash) of the first 1MB of each file. This is much more robust than the standard modification date check and is recommended when you cannot trust file timestamps (e.g., when dealing with network drives or files from different operating systems).
- Per-job cleanup: Optionally configure each job to automatically delete files from the destination that no longer exist in the source.
- Real-time progress tracking for each job.
- Clean, modern dark-theme UI.
- Job configurations are persisted across app sessions.

## Scripts
- `npm run electron:dev` — Run the app in development mode.
- `npm run electron:build` — Build installers for your platform (AppImage for Linux, NSIS for Windows).

## Setup
```
npm install
```

## Run
```
npm run electron:dev
```

## Build
```
npm run electron:build
```