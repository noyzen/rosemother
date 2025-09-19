# Hello Electron

Cross-platform Hello World Electron app with custom titlebar, disabled menu, window state persistence, and packaging via electron-builder.

## Scripts
- npm run electron:dev — Run the app in development
- npm run electorn:build — Alias to build (typo preserved per request)
- npm run electron:build — Build installers (AppImage on Linux, NSIS exe on Windows)

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
# Linux AppImage
npm run electron:build

# Windows exe (on Windows or with proper cross-compile setup)
npm run electron:build
```

Notes:
- Default OS menubar is removed. Custom titlebar works on Linux and Windows.
- Window size and position persist across runs using electron-window-state.
- App is offline/portable and uses no network by default.
