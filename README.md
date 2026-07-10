# BisQue iRODS Uploader

A local Electron desktop app for uploading files and folders to BisQue iRODS storage without using the terminal. After upload, the desktop app registers the images with BisQue and creates one new BisQue dataset using the name supplied by the user.

## Create a BisQue Dataset from the Desktop App

The desktop workflow performs three separate operations:

1. Upload the selected files to an iRODS folder with GoCommands.
2. Register each uploaded iRODS file through the BisQue import service.
3. Create a new BisQue dataset containing every resource BisQue identified as an image.

Run the app:

```bash
npm install
npm start
```

In the app, save your real BisQue login, choose files or a folder, enter the **iRODS Folder Path**, and name the new BisQue dataset. For the provided test image, use:

```text
iRODS Folder Path: /ucsb/home/bowen68/test
Selected local file: image.jpg
Resulting iRODS path: /ucsb/home/bowen68/test/image.jpg
BisQue Dataset Name: any name you choose for this upload
```

The final status includes an **Open in BisQue** link when dataset creation succeeds. If the iRODS upload succeeds but BisQue reports that `irods://` resources are unsupported, the files remain safely in iRODS, but a BisQue administrator must enable the iRODS blob-storage driver and give the BisQue service account read access before a dataset can be created.

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

## Mobile / Web App (iOS and Android)

The `webapp/` folder contains a browser-based iRODS uploader (a PWA) for phones and tablets. It talks WebDAV directly to the SFTPGo service (`http://brain.ece.ucsb.edu:8080`), so there is no App Store or Apple developer fee. Automatic BisQue dataset creation is currently implemented only in the desktop app.

### Try it locally

On the computer running this project:

```bash
npm install
npm run webapp
```

This starts the app and a local test WebDAV server. The terminal prints an address similar to:

```text
Open on iPhone: http://192.168.1.25:8000
```

To test from an iPhone:

1. Connect the iPhone and computer to the same Wi-Fi network. Guest Wi-Fi often blocks devices from seeing each other.
2. Keep `npm run webapp` running and open the printed **Open on iPhone** address in Safari. Do not use `localhost` on the phone; on an iPhone, `localhost` means the iPhone itself.
3. The app automatically fills the test WebDAV address using the computer's IP. Log in with username `test` and password `test`.
4. Choose a small file and upload it. It will appear under `webapp/dev-data/` on the computer.

If Safari cannot open the page, allow incoming connections for Node.js in the computer's firewall and make sure TCP ports `8000` and `8081` are reachable on the local network. A VPN can also prevent local-device access.

### Deploy for real use

The local server above is for testing; the computer must remain on while the iPhone uses it. For normal use, host the static files in `webapp/` (excluding `dev-server.js` and `dev-data/`) on an HTTPS website such as a campus VM or GitHub Pages. Two things must be true before phones can upload to the real iRODS WebDAV endpoint:

1. **CORS** must be enabled on SFTPGo (`webdavd.cors` in its config) for the exact HTTPS origin hosting this app. Allow `GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`, `PROPFIND`, and `MKCOL`, plus the `Authorization`, `Content-Type`, and `Depth` headers.
2. **HTTPS** must be enabled on the WebDAV endpoint (SFTPGo supports TLS natively, or put a reverse proxy such as Caddy in front). Browsers block HTTPS pages from calling plain-HTTP servers, and Basic auth over plain HTTP exposes passwords.

Ask the iRODS server admins for both, or run a small Caddy reverse proxy that adds TLS + CORS in front of port 8080.

### Install on a phone

Open the deployed page in Safari (iOS) or Chrome (Android), then on iPhone choose **Share → Add to Home Screen**, enable **Open as Web App**, and tap **Add**. It launches full-screen like a native app. Uploads run only while the page is open, and iOS Safari cannot select folders — use the desktop app for large folder transfers.

## Run During Development

```bash
npm install
npm start
```

## Security Notes

- Desktop BisQue credentials stay on your computer.
- The app uses Electron secure local storage for the saved password.
- A temporary GoCommands config is created only while testing the connection or uploading, then removed.
- GoCommands downloads on the first connection test or upload if it is not already installed by the app.
- Passwords are redacted from app logs.
- Dataset registration only follows resource links returned by the configured `https://bisque2.ece.ucsb.edu` server.
