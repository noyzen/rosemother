# Rosemother Backup Utility

A simple, powerful, and cross-platform file backup utility built with Electron.

## Features
- Create and manage multiple backup jobs.
- Define a source and destination folder for each job.
- Differential backup: only copies new or modified files, skipping unchanged ones.
- Post-backup sync: option to delete files from the destination that no longer exist in the source.
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
