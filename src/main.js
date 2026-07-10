const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const https = require("https");
const os = require("os");
const path = require("path");
const {
  BisqueClient,
  DEFAULT_BISQUE_URL,
  normalizeDatasetName,
} = require("./bisque-client");

const IRODS = {
  host: "brain.ece.ucsb.edu",
  port: 1247,
  zone: "ucsb",
};

const GOCMD_VERSION_URL = "https://raw.githubusercontent.com/cyverse/gocommands/main/VERSION.txt";
const GOCMD_RELEASE_URL = "https://github.com/cyverse/gocommands/releases/download";
const SMALL_FILE_LIMIT_BYTES = 100 * 1024 * 1024;

const activeUploads = new Map();
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 920,
    minHeight: 680,
    title: "BisQue iRODS Uploader",
    backgroundColor: "#f6f5f2",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function getUserDataPath(...parts) {
  return path.join(app.getPath("userData"), ...parts);
}

function credentialsPath() {
  return getUserDataPath("credentials.json");
}

function defaultRemotePath(username) {
  return `/ucsb/home/${username}/`;
}

function rejectNewlines(value, fieldName) {
  if (/[\r\n]/.test(String(value))) {
    throw new Error(`${fieldName} cannot contain line breaks.`);
  }
}

async function saveCredentials(username, password) {
  const cleanUsername = String(username || "").trim();
  const cleanPassword = String(password || "");

  if (!cleanUsername || !cleanPassword) {
    throw new Error("Enter both your BisQue username and password.");
  }

  rejectNewlines(cleanUsername, "Username");
  rejectNewlines(cleanPassword, "Password");

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure local credential storage is not available on this computer.");
  }

  const encryptedPassword = safeStorage.encryptString(cleanPassword).toString("base64");
  await fsp.mkdir(app.getPath("userData"), { recursive: true });
  await fsp.writeFile(
    credentialsPath(),
    JSON.stringify({ username: cleanUsername, encryptedPassword }, null, 2),
    "utf8",
  );

  return { username: cleanUsername, defaultRemotePath: defaultRemotePath(cleanUsername) };
}

async function loadCredentials() {
  let raw;
  try {
    raw = await fsp.readFile(credentialsPath(), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  const parsed = JSON.parse(raw);
  const password = safeStorage.decryptString(Buffer.from(parsed.encryptedPassword, "base64"));
  return { username: parsed.username, password };
}

function normalizeRemotePath(remotePath) {
  const value = String(remotePath || "").trim();
  if (!value) throw new Error("Choose an iRODS destination path.");
  if (!value.startsWith("/ucsb/")) {
    throw new Error("Destination must be an iRODS path that starts with /ucsb/.");
  }
  return value;
}

function normalizeRemoteCollectionPath(remotePath) {
  const value = normalizeRemotePath(remotePath).replace(/\/+$/, "");
  if (value === "/ucsb") {
    throw new Error("Choose a folder inside your iRODS home, not /ucsb itself.");
  }
  return value;
}

function remoteTargetForSelection(remoteCollectionPath, selectedPath) {
  return `${remoteCollectionPath}/${path.basename(selectedPath)}`;
}

async function remoteFilesForSelection(remoteTarget, selectedPath) {
  const stat = await fsp.stat(selectedPath);
  if (stat.isFile()) return [remoteTarget];
  if (!stat.isDirectory()) return [];

  const remoteFiles = [];
  await walkDirectory(selectedPath, async (filePath) => {
    const relativePath = path.relative(selectedPath, filePath).split(path.sep).join("/");
    remoteFiles.push(path.posix.join(remoteTarget, relativePath));
  });
  return remoteFiles;
}

function getPlatformAssetName(version) {
  const arch = os.arch();
  const platform = os.platform();

  if (platform === "linux" && arch === "x64") return `gocmd-${version}-linux-amd64.tar.gz`;
  if (platform === "linux" && arch === "arm64") return `gocmd-${version}-linux-arm64.tar.gz`;
  if (platform === "darwin" && arch === "x64") return `gocmd-${version}-darwin-amd64.tar.gz`;
  if (platform === "darwin" && arch === "arm64") return `gocmd-${version}-darwin-arm64.tar.gz`;
  if (platform === "win32" && arch === "x64") return `gocmd-${version}-windows-amd64.zip`;

  throw new Error(`This computer is not supported yet (${platform}/${arch}).`);
}

function gocmdExecutableName() {
  return os.platform() === "win32" ? "gocmd.exe" : "gocmd";
}

async function ensureGocmd(uploadId) {
  const binDir = getUserDataPath("bin");
  const executable = path.join(binDir, gocmdExecutableName());

  if (fs.existsSync(executable)) return executable;

  await fsp.mkdir(binDir, { recursive: true });
  sendUploadEvent(uploadId, {
    type: "tool",
    message: "Installing the upload tool for this computer...",
  });

  const version = (await httpsGetText(GOCMD_VERSION_URL)).trim();
  const assetName = getPlatformAssetName(version);
  const archivePath = path.join(binDir, assetName);
  const downloadUrl = `${GOCMD_RELEASE_URL}/${version}/${assetName}`;

  sendUploadEvent(uploadId, {
    type: "tool",
    message: `Downloading GoCommands ${version}...`,
  });

  try {
    await downloadFile(downloadUrl, archivePath);
    await extractArchive(archivePath, binDir);
    const extractedExecutable = await findExtractedExecutable(binDir);
    if (!extractedExecutable) {
      throw new Error("The upload tool downloaded, but the gocmd executable was not found.");
    }
    if (extractedExecutable !== executable) {
      await fsp.copyFile(extractedExecutable, executable);
    }
    if (os.platform() !== "win32") await fsp.chmod(executable, 0o755);
  } catch (error) {
    await cleanupFile(archivePath);
    throw error;
  }

  return executable;
}

function requestUrl(url, consumeResponse, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirectCount >= 5) {
          reject(new Error("Too many redirects while downloading GoCommands."));
          return;
        }

        requestUrl(new URL(response.headers.location, url).toString(), consumeResponse, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}.`));
        return;
      }

      consumeResponse(response, resolve, reject);
    });

    request.on("error", reject);
    request.setTimeout(60000, () => {
      request.destroy(new Error("Download timed out."));
    });
  });
}

function httpsGetText(url) {
  return requestUrl(url, (response, resolve) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      body += chunk;
    });
    response.on("end", () => resolve(body));
  });
}

function downloadFile(url, outputPath) {
  return requestUrl(url, (response, resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    response.pipe(file);
    file.on("finish", () => file.close(resolve));
    file.on("error", (error) => {
      file.close();
      reject(error);
    });
  });
}

function extractArchive(archivePath, destinationDir) {
  return new Promise((resolve, reject) => {
    const args = archivePath.endsWith(".zip")
      ? ["-xf", archivePath, "-C", destinationDir]
      : ["-xzf", archivePath, "-C", destinationDir];
    const extractor = spawn("tar", args, { windowsHide: true });

    let stderr = "";
    extractor.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    extractor.on("error", reject);
    extractor.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || "Could not unpack the GoCommands archive."));
    });
  });
}

async function findExtractedExecutable(binDir) {
  const target = gocmdExecutableName();
  const queue = [binDir];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) queue.push(entryPath);
      if (entry.isFile() && entry.name === target) return entryPath;
    }
  }

  return null;
}

async function cleanupFile(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not delete ${filePath}: ${error.message}`);
    }
  }
}

function quoteYaml(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

async function writeTemporaryConfig(username, password, uploadId = "session") {
  const configDir = getUserDataPath("sessions");
  await fsp.mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, `${uploadId}.yaml`);
  const yaml = [
    `irods_host: ${quoteYaml(IRODS.host)}`,
    `irods_port: ${IRODS.port}`,
    `irods_user_name: ${quoteYaml(username)}`,
    `irods_zone_name: ${quoteYaml(IRODS.zone)}`,
    `irods_user_password: ${quoteYaml(password)}`,
    "",
  ].join("\n");

  await fsp.writeFile(configPath, yaml, { encoding: "utf8", mode: 0o600 });
  return configPath;
}

async function deleteTemporaryConfig(configPath) {
  if (!configPath) return;
  await cleanupFile(configPath);
}

async function summarizePaths(pathsToSummarize) {
  const summary = {
    totalBytes: 0,
    totalFiles: 0,
    smallFiles: 0,
    entries: [],
  };

  for (const selectedPath of pathsToSummarize) {
    const entry = await summarizePath(selectedPath);
    summary.totalBytes += entry.bytes;
    summary.totalFiles += entry.files;
    summary.smallFiles += entry.smallFiles;
    summary.entries.push(entry);
  }

  summary.recommendedMode = shouldUseBput(summary) ? "bput" : "put";
  return summary;
}

async function summarizePath(selectedPath) {
  const stat = await fsp.stat(selectedPath);
  const entry = {
    path: selectedPath,
    name: path.basename(selectedPath),
    bytes: 0,
    files: 0,
    smallFiles: 0,
    isDirectory: stat.isDirectory(),
  };

  if (stat.isFile()) {
    entry.bytes = stat.size;
    entry.files = 1;
    entry.smallFiles = stat.size < SMALL_FILE_LIMIT_BYTES ? 1 : 0;
    return entry;
  }

  if (!stat.isDirectory()) return entry;

  await walkDirectory(selectedPath, async (_filePath, fileStat) => {
    entry.bytes += fileStat.size;
    entry.files += 1;
    if (fileStat.size < SMALL_FILE_LIMIT_BYTES) entry.smallFiles += 1;
  });

  return entry;
}

async function walkDirectory(directory, onFile) {
  const dirents = await fsp.readdir(directory, { withFileTypes: true });
  for (const dirent of dirents) {
    const childPath = path.join(directory, dirent.name);
    if (dirent.isDirectory()) {
      await walkDirectory(childPath, onFile);
    } else if (dirent.isFile()) {
      const stat = await fsp.stat(childPath);
      await onFile(childPath, stat);
    }
  }
}

function shouldUseBput(summary) {
  return summary.totalFiles > 50 && summary.smallFiles / summary.totalFiles >= 0.8;
}

function formatError(error) {
  const message = String(error && error.message ? error.message : error);
  if (error && error.code === "IRODS_REGISTRATION_UNAVAILABLE") {
    return "The files reached iRODS, but this BisQue server is not configured to register irods:// resources. Ask the BisQue administrator to enable the iRODS blob-storage driver and read access, then retry.";
  }
  if (error && error.code === "NO_BISQUE_IMAGES") {
    return "The files reached iRODS, but BisQue did not identify any of them as images. No dataset was created.";
  }
  if (error && error.code === "BISQUE_AUTH_FAILED") {
    return "The files reached iRODS, but BisQue rejected the saved username or password while creating the dataset.";
  }
  if (error && /^BISQUE_|^MISSING_DATASET|^UNTRUSTED_BISQUE/i.test(String(error.code || ""))) {
    return `The files reached iRODS, but the BisQue dataset could not be created. ${message}`;
  }
  if (/interactive prompt|Overwrite\?/i.test(message)) {
    return "Upload stopped because the destination already contains an item with the same name. Choose a new iRODS folder or change the existing-file option.";
  }
  if (/Data object .* already exists/i.test(message)) {
    return "That iRODS path already exists as a file, not a folder. Choose a new iRODS folder and try again.";
  }
  if (/CAT_INVALID_AUTHENTICATION|AUTHENTICATION|password|PAM_AUTH/i.test(message)) {
    return "BisQue login failed. Check your username and password, then try again.";
  }
  if (/SYS_NOT_ALLOWED/i.test(message)) {
    return "The iRODS server rejected replication for this upload. Ask an administrator if --no_replication is required.";
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|timeout/i.test(message)) {
    return "Could not reach the BisQue iRODS server. Check your connection and try again.";
  }
  return message;
}

function isMissingRemotePathError(error) {
  const message = String(error && error.message ? error.message : error);
  return /does not exist|not found|CAT_NO_ROWS_FOUND|CAT_UNKNOWN|USER_FILE_DOES_NOT_EXIST|remote path.*missing/i.test(message);
}

function sendUploadEvent(uploadId, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("upload:progress", {
    uploadId,
    timestamp: new Date().toISOString(),
    ...payload,
  });
}

function spawnGocmd(executable, args, uploadId, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    const upload = activeUploads.get(uploadId);
    if (upload) upload.child = child;

    let stderr = "";
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (!options.suppressOutput) emitProcessOutput(uploadId, text, false);
      handleInteractivePrompt(child, reject, text, options);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!options.suppressOutput) emitProcessOutput(uploadId, text, true);
      handleInteractivePrompt(child, reject, text, options);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      const current = activeUploads.get(uploadId);
      if (current) current.child = null;

      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(current && current.cancelled ? "Upload cancelled." : stderr.trim() || stdout.trim() || `gocmd exited with code ${code}.`));
    });
  });
}

function emitProcessOutput(uploadId, text, isError) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const cleanLine = stripAnsi(line);
    const percent = parsePercent(line);
    sendUploadEvent(uploadId, {
      type: percent == null ? "log" : "progress",
      message: redactSensitiveText(cleanLine),
      percent,
      isError,
    });
  }
}

function handleInteractivePrompt(child, reject, text, options) {
  if (!/Overwrite\?\s*\[yes\(y\)\/no\(n\)\/yes-all\(a\)\/no-all\(na\)\]:/i.test(stripAnsi(text))) {
    return;
  }

  if (options.overwriteResponse === "yes") {
    child.stdin.write("y\n");
    return;
  }

  if (options.overwriteResponse === "no") {
    child.stdin.write("n\n");
    return;
  }

  child.kill();
  reject(new Error("GoCommands opened an interactive overwrite prompt."));
}

function stripAnsi(text) {
  return String(text).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function parsePercent(line) {
  const match = line.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (!match) return null;
  return Math.max(0, Math.min(100, Number(match[1])));
}

function redactSensitiveText(text) {
  return String(text).replace(/irods_user_password:\s*.+/gi, "irods_user_password: [hidden]");
}

async function ensureRemoteCollection(executable, configPath, remoteCollectionPath, uploadId) {
  sendUploadEvent(uploadId, {
    type: "log",
    message: `Preparing dataset folder ${remoteCollectionPath}`,
  });

  try {
    await spawnGocmd(executable, ["-c", configPath, "mkdir", "-p", remoteCollectionPath], uploadId);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/unknown shorthand|flag provided but not defined|unknown flag|invalid option/i.test(message)) {
      try {
        await spawnGocmd(executable, ["-c", configPath, "mkdir", remoteCollectionPath], uploadId);
      } catch (fallbackError) {
        if (!isCollectionAlreadyExistsError(fallbackError)) {
          throw fallbackError;
        }
      }
      return;
    }

    if (isCollectionAlreadyExistsError(error)) {
      return;
    }

    throw error;
  }
}

function isCollectionAlreadyExistsError(error) {
  const message = String(error && error.message ? error.message : error);
  return /already exists|CAT_NAME_EXISTS_AS_COLLECTION/i.test(message);
}

async function remotePathExists(executable, configPath, remoteTarget, uploadId) {
  try {
    await spawnGocmd(executable, ["-c", configPath, "ls", remoteTarget], uploadId, { suppressOutput: true });
    return true;
  } catch (error) {
    if (isMissingRemotePathError(error)) {
      return false;
    }
    throw error;
  }
}

function normalizeDuplicateMode(mode) {
  if (mode === "overwrite" || mode === "fail") return mode;
  return "skip";
}

async function runUpload(uploadId, payload) {
  let configPath;
  try {
    const credentials = await loadCredentials();
    if (!credentials) throw new Error("Save your BisQue login before uploading.");

    const localPaths = Array.isArray(payload.localPaths) ? payload.localPaths.filter(Boolean) : [];
    if (localPaths.length === 0) throw new Error("Choose at least one file or folder to upload.");

    for (const selectedPath of localPaths) {
      if (!fs.existsSync(selectedPath)) throw new Error(`Selected path does not exist: ${selectedPath}`);
    }

    const remotePath = normalizeRemoteCollectionPath(payload.remotePath || defaultRemotePath(credentials.username));
    const datasetName = normalizeDatasetName(payload.datasetName);
    const summary = await summarizePaths(localPaths);
    const command = payload.mode === "bput" || payload.mode === "put" ? payload.mode : summary.recommendedMode;
    const duplicateMode = normalizeDuplicateMode(payload.duplicateMode);
    const controller = new AbortController();

    activeUploads.set(uploadId, { cancelled: false, child: null, controller });
    sendUploadEvent(uploadId, {
      type: "started",
      command,
      message: `Uploading to iRODS for dataset “${datasetName}”`,
      summary,
    });

    const executable = await ensureGocmd(uploadId);
    configPath = await writeTemporaryConfig(credentials.username, credentials.password, uploadId);
    await ensureRemoteCollection(executable, configPath, remotePath, uploadId);

    const uploadedRemoteFiles = [];
    for (let index = 0; index < localPaths.length; index += 1) {
      const selectedPath = localPaths[index];
      const remoteTarget = remoteTargetForSelection(remotePath, selectedPath);
      const expectedRemoteFiles = await remoteFilesForSelection(remoteTarget, selectedPath);
      const current = activeUploads.get(uploadId);
      if (!current || current.cancelled) throw new Error("Upload cancelled.");

      if (await remotePathExists(executable, configPath, remoteTarget, uploadId)) {
        if (duplicateMode === "skip") {
          sendUploadEvent(uploadId, {
            type: "log",
            message: `Using existing iRODS item ${path.basename(selectedPath)} for this dataset.`,
          });
          uploadedRemoteFiles.push(...expectedRemoteFiles);
          continue;
        }

        if (duplicateMode === "fail") {
          throw new Error(`Data object "${remoteTarget}" already exists.`);
        }
      }

      sendUploadEvent(uploadId, {
        type: "file",
        message: `Uploading ${path.basename(selectedPath)} (${index + 1} of ${localPaths.length})`,
        currentPath: selectedPath,
      });

      await spawnGocmd(
        executable,
        ["-c", configPath, command, "--progress", selectedPath, remoteTarget],
        uploadId,
        { overwriteResponse: duplicateMode === "overwrite" ? "yes" : undefined },
      );
      uploadedRemoteFiles.push(...expectedRemoteFiles);
    }

    const uniqueRemoteFiles = [...new Set(uploadedRemoteFiles)];
    sendUploadEvent(uploadId, {
      type: "upload-complete",
      percent: 88,
      message: `iRODS upload complete. Registering ${uniqueRemoteFiles.length} file${uniqueRemoteFiles.length === 1 ? "" : "s"} with BisQue...`,
    });

    const bisque = new BisqueClient({
      baseUrl: DEFAULT_BISQUE_URL,
      irodsHost: IRODS.host,
      username: credentials.username,
      password: credentials.password,
    });
    const dataset = await bisque.createDatasetFromIrodsPaths({
      datasetName,
      irodsPaths: uniqueRemoteFiles,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.stage === "register") {
          const percent = 88 + Math.round(((event.index + 1) / event.total) * 9);
          sendUploadEvent(uploadId, {
            type: "registering",
            percent,
            message: `Registering ${path.posix.basename(event.irodsPath)} with BisQue (${event.index + 1} of ${event.total})`,
          });
        } else if (event.stage === "dataset") {
          sendUploadEvent(uploadId, {
            type: "dataset",
            percent: 98,
            message: `Creating BisQue dataset “${event.datasetName}” with ${event.total} image${event.total === 1 ? "" : "s"}...`,
          });
        }
      },
    });

    for (const skipped of dataset.skipped) {
      sendUploadEvent(uploadId, {
        type: "log",
        message: `Not added to the dataset: ${skipped.irodsPath} (${skipped.reason})`,
      });
    }

    sendUploadEvent(uploadId, {
      type: "done",
      percent: 100,
      message: `Created BisQue dataset “${dataset.datasetName}” with ${dataset.imageUris.length} image${dataset.imageUris.length === 1 ? "" : "s"}.`,
      datasetName: dataset.datasetName,
      datasetUri: dataset.datasetUri,
      imageCount: dataset.imageUris.length,
      skippedCount: dataset.skipped.length,
    });
  } catch (error) {
    const current = activeUploads.get(uploadId);
    const cancelled = Boolean(current && current.cancelled) || error.name === "AbortError" || /cancelled/i.test(String(error.message));
    sendUploadEvent(uploadId, {
      type: cancelled ? "cancelled" : "error",
      message: formatError(error),
    });
  } finally {
    activeUploads.delete(uploadId);
    await deleteTemporaryConfig(configPath);
  }
}

ipcMain.handle("auth:saveCredentials", async (_event, credentials) => {
  return saveCredentials(credentials.username, credentials.password);
});

ipcMain.handle("auth:getProfile", async () => {
  const credentials = await loadCredentials();
  if (!credentials) return null;
  return {
    username: credentials.username,
    defaultRemotePath: defaultRemotePath(credentials.username),
  };
});

ipcMain.handle("irods:testConnection", async () => {
  let configPath;
  try {
    const credentials = await loadCredentials();
    if (!credentials) throw new Error("Save your BisQue login first.");

    const uploadId = "connection-test";
    const executable = await ensureGocmd(uploadId);
    configPath = await writeTemporaryConfig(credentials.username, credentials.password, uploadId);
    await spawnGocmd(executable, ["-c", configPath, "ls", defaultRemotePath(credentials.username)], uploadId);
    return { ok: true, message: "Connected to BisQue iRODS." };
  } catch (error) {
    return { ok: false, message: formatError(error) };
  } finally {
    await deleteTemporaryConfig(configPath);
  }
});

ipcMain.handle("upload:pickFiles", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose files to upload",
    properties: ["openFile", "multiSelections"],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("upload:pickFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a folder to upload",
    properties: ["openDirectory"],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("upload:summarize", async (_event, localPaths) => {
  return summarizePaths(Array.isArray(localPaths) ? localPaths : []);
});

ipcMain.handle("upload:start", async (_event, payload) => {
  const uploadId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  runUpload(uploadId, payload || {});
  return { uploadId };
});

ipcMain.handle("upload:cancel", async (_event, uploadId) => {
  const upload = activeUploads.get(uploadId);
  if (!upload) return { ok: false, message: "No active upload found." };

  upload.cancelled = true;
  if (upload.child) upload.child.kill();
  if (upload.controller) upload.controller.abort();

  sendUploadEvent(uploadId, {
    type: "cancelling",
    message: "Cancelling upload and dataset creation...",
  });

  return { ok: true };
});

ipcMain.handle("app:openExternal", async (_event, target) => {
  const parsed = new URL(String(target || ""));
  const bisqueOrigin = new URL(DEFAULT_BISQUE_URL).origin;
  if (parsed.protocol !== "https:" || parsed.origin !== bisqueOrigin) {
    throw new Error("Only links to the configured BisQue server can be opened.");
  }
  await shell.openExternal(parsed.toString());
  return { ok: true };
});
