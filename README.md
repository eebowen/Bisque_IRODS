# BisQue iRODS Uploader

A local Electron desktop app for uploading files and folders to BisQue iRODS storage without using the terminal.

## Build Releases

### Windows

Requirements:

- Windows 10 or 11
- Node.js 18+
- npm

Run:

```bat
.\scripts\build-win.bat
```

The script creates:

```text
dist/BisQue-iRODS-Uploader-win-x64.exe
```

### macOS

Requirements:

- macOS on Apple Silicon or Intel
- Node.js 18+
- npm

Run:

```bash
./scripts/build-mac.sh
```

The script creates:

```text
dist/BisQue-iRODS-Uploader-mac-universal.zip
```

For an optional local DMG build, run:

```bash
npm run dist:mac:dmg
```

This first Mac build is unsigned. If macOS blocks it, right-click the app, choose **Open**, then confirm that you want to open it. You may also need to approve it in **System Settings > Privacy & Security**.

### Linux

Requirements:

- Linux
- Node.js 18+
- npm

Run:

```bash
./scripts/build-linux.sh
```

The script creates:

```text
dist/BisQue-iRODS-Uploader-linux-x64.AppImage
```

For a direct packaging command, run:

```bash
npm run dist:linux
```

## Try The GitHub Actions Builds

1. Push this project to a GitHub repository.
2. Open the repository on GitHub.
3. Go to **Actions**.
4. Select **Build Mac App**, **Build Windows**, or **Build Linux**.
5. Click **Run workflow**.
6. Download the matching artifact when the workflow finishes.
7. Unzip or open the downloaded build as needed.

The first macOS build is unsigned. If macOS blocks it, right-click the app, choose **Open**, then confirm that you want to open it. You may also need to approve it in **System Settings > Privacy & Security**.

## Run During Development

```bash
npm install
npm start
```

## Security Notes

- BisQue credentials stay on your computer.
- The app uses Electron secure local storage for the saved password.
- A temporary GoCommands config is created only while testing the connection or uploading, then removed.
- GoCommands downloads on the first connection test or upload if it is not already installed by the app.
- Passwords are redacted from app logs.
