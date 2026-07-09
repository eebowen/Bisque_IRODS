# BisQue iRODS Uploader

A local Electron desktop app for uploading files and folders to BisQue iRODS storage without using the terminal.

## Try A Mac Build From GitHub Actions

1. Push this project to a GitHub repository.
2. Open the repository on GitHub.
3. Go to **Actions**.
4. Select **Build Mac App**.
5. Click **Run workflow**.
6. Download the `BisQue-iRODS-Uploader-mac-universal` artifact when the workflow finishes.
7. Unzip `BisQue-iRODS-Uploader-mac-universal.zip` and open the app.

This first Mac build is unsigned. If macOS blocks it, right-click the app, choose **Open**, then confirm that you want to open it. You may also need to approve it in **System Settings > Privacy & Security**.

## Build On Your Mac

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
