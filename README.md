# Rosemother Backup Utility

![Rosemother Screenshot](https://i.imgur.com/o9jtRo9.jpeg)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.0.0-brightgreen.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey.svg)](#)

A simple, powerful, and reliable file mirror backup utility built with Electron. Rosemother ensures your destination folder is an exact replica of your source, providing peace of mind for your valuable data.



---

## What is Rosemother?

Rosemother is not just another file copy tool. It's a sophisticated backup utility designed to create and maintain **exact mirror backups**. This means the destination folder will be an identical twin of the source folder—no more, no less. It intelligently adds new files, updates changed ones, and, crucially, removes files from the destination that you've deleted from the source.

It's perfect for developers backing up code, photographers archiving photos, or anyone who needs a reliable, up-to-date replica of their important folders.

## Key Features

- **Multiple Backup Jobs**: Create and manage several backup tasks, each with its own specific configuration, all from a single, clean interface.

- **Two Powerful Verification Modes**:
  - **⚡ Standard Check (Default)**: A fast and efficient index-based backup. It uses file size and modification dates to quickly identify changes. Perfect for most daily backup needs.
  - **🛡️ Deep Verification**: A highly reliable mode that compares file sizes and a cryptographic signature (SHA-256 hash) of the file content. This is essential when you can't trust file timestamps (e.g., across different operating systems, network drives, or after using certain software) and provides the highest level of data integrity.

- **Intelligent Cleanup**: After a successful backup, Rosemother can automatically clean the destination folder by deleting files and directories that no longer exist in the source. This keeps your backup tidy and truly mirrored.

- **Advanced Exclusion Rules**: Exclude specific sub-folders (like `node_modules` or `__pycache__`) or file types (like `.log` or `.tmp`) from your backup jobs to save space and time.

- **Real-Time Progress Tracking**: A detailed per-job progress bar and status message keeps you informed every step of the way—from scanning millions of files to copying and cleaning up.

- **Data Portability**: Easily export all your job configurations to a single JSON file. Back them up or import them on another machine to get set up in seconds.

- **Modern & User-Friendly**: A clean, intuitive dark-theme UI that's easy on the eyes and simple to navigate.

- **Cross-Platform**: Built with Electron to run on both Windows and Linux.

## Getting Started

Follow these instructions to get Rosemother up and running on your local machine for development and testing purposes.

### Prerequisites

You need to have [Node.js](https://nodejs.org/) and npm (which comes with Node.js) installed on your system.

### Installation

1.  Clone the repository to your local machine:
    ```sh
    git clone https://github.com/your-username/rosemother.git
    cd rosemother
    ```

2.  Install the dependencies:
    ```sh
    npm install
    ```

### Running the Application

To run the application in development mode:

```sh
npm run electron:dev
```

### Building for Production

To build the application installers for your current platform (e.g., AppImage for Linux, NSIS for Windows):

```sh
npm run electron:build
```

The compiled installers will be located in the `dist/` directory.

## License

This project is licensed under the MIT License.