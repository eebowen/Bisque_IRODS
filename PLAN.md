# BisQue iRODS Uploader Desktop App Plan

## Summary
Build a local desktop app, not a plain `.html` file. A directly opened HTML page cannot safely run `gocmd`, access arbitrary folders, store credentials in the OS keychain, or stream uploads to iRODS like the CLI. The right version is a browser-like desktop app: simple HTML UI for users, plus a local app process that wraps GoCommands.

Use BisQue’s documented iRODS settings: host `brain.ece.ucsb.edu`, port `1247`, zone `ucsb`, and uploads like `gocmd put --progress local_path /ucsb/home/username/dest_dir`. GoCommands also supports config files/env vars and `put`/`bput`.

Sources:  
BisQue CLI docs: https://bisque.gitbook.io/docs/bisque-service/data-storage/cli_based_upload  
GoCommands repo/docs: https://github.com/cyverse/gocommands

## Key Changes
- Create a cross-platform Electron desktop app for Windows/macOS/Linux.
- UI flow:
  - Login screen: BisQue username/password.
  - Destination picker: defaults to `/ucsb/home/{username}/`.
  - File/folder picker with drag-and-drop.
  - Upload review screen showing size, file count, and destination.
  - Upload progress screen with cancel, logs, success/failure state.
- Bundle or auto-download the correct `gocmd` binary for the user’s OS/CPU.
- Store credentials locally only, using OS keychain storage.
- Generate a temporary GoCommands YAML config at runtime instead of asking users to run `gocmd init`.
- Run uploads through the local app process:
  - Use `put --progress` for normal files/folders.
  - Use `bput --progress` when there are many small files, defaulting to `bput` when file count is over 50 and most files are under 100 MB.
- Parse `gocmd` stdout/stderr into user-friendly progress, status, and error messages.
- Keep advanced CLI details hidden unless the user opens a “details” log view.

## Interfaces
- Renderer-to-main IPC:
  - `auth.saveCredentials(username, password)`
  - `irods.testConnection()`
  - `upload.pickFiles()`
  - `upload.pickFolder()`
  - `upload.start({ localPaths, remotePath, mode })`
  - `upload.cancel(uploadId)`
  - `upload.onProgress(callback)`
- Local config fields:
  - `irods_host: brain.ece.ucsb.edu`
  - `irods_port: 1247`
  - `irods_zone_name: ucsb`
  - `irods_user_name`
  - `irods_user_password`

## Test Plan
- Verify app downloads or locates `gocmd` on Windows, macOS, and Linux.
- Test login with valid and invalid BisQue credentials.
- Test upload of:
  - one small file
  - one large file
  - one folder
  - many small files using `bput`
  - destination path with spaces/special characters
- Test cancel behavior mid-upload.
- Test network failure and wrong password messages.
- Confirm passwords are not written to app logs or persistent plaintext files.
- Confirm uploaded files appear in the expected iRODS path and BisQue can access them.

## Assumptions
- Target users are non-technical people uploading from personal computers.
- Credentials stay local only.
- MVP focuses on upload, not full iRODS browsing, deleting, moving, or downloading.
- The app may look like a browser app, but it must be packaged as a desktop app because plain browser HTML cannot perform the required local CLI and filesystem operations.
