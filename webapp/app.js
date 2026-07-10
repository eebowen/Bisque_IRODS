const DEFAULT_SERVER = "http://brain.ece.ucsb.edu:8080";
const DEFAULT_REMOTE_PATH = "/";
const STORAGE_KEYS = {
  server: "bisque.server",
  username: "bisque.username",
  password: "bisque.password",
  remotePath: "bisque.remotePath",
  duplicateMode: "bisque.duplicateMode",
};

const state = {
  authHeader: null,
  serverBase: null,
  entries: [],
  uploading: false,
  cancelled: false,
  activeXhr: null,
};

const elements = {
  loginForm: document.querySelector("#login-form"),
  serverUrl: document.querySelector("#server-url"),
  username: document.querySelector("#username"),
  password: document.querySelector("#password"),
  remember: document.querySelector("#remember"),
  connect: document.querySelector("#connect"),
  signOut: document.querySelector("#sign-out"),
  authStatus: document.querySelector("#auth-status"),
  uploadSection: document.querySelector("#upload-section"),
  remotePath: document.querySelector("#remote-path"),
  dropZone: document.querySelector("#drop-zone"),
  pickFiles: document.querySelector("#pick-files"),
  pickFolder: document.querySelector("#pick-folder"),
  fileInput: document.querySelector("#file-input"),
  folderInput: document.querySelector("#folder-input"),
  emptySelection: document.querySelector("#empty-selection"),
  selectionList: document.querySelector("#selection-list"),
  fileCount: document.querySelector("#file-count"),
  totalSize: document.querySelector("#total-size"),
  duplicateMode: document.querySelector("#duplicate-mode"),
  startUpload: document.querySelector("#start-upload"),
  cancelUpload: document.querySelector("#cancel-upload"),
  progressPanel: document.querySelector("#progress-panel"),
  progressTitle: document.querySelector("#progress-title"),
  progressPercent: document.querySelector("#progress-percent"),
  progressBar: document.querySelector("#progress-bar"),
  keepOpenNote: document.querySelector("#keep-open-note"),
  logOutput: document.querySelector("#log-output"),
};

init();

function init() {
  const savedServer = localStorage.getItem(STORAGE_KEYS.server);
  elements.serverUrl.value = savedServer || DEFAULT_SERVER;
  elements.username.value = localStorage.getItem(STORAGE_KEYS.username) || "";
  elements.remotePath.value = localStorage.getItem(STORAGE_KEYS.remotePath) || DEFAULT_REMOTE_PATH;
  elements.duplicateMode.value = localStorage.getItem(STORAGE_KEYS.duplicateMode) || "skip";

  const savedPassword = localStorage.getItem(STORAGE_KEYS.password);
  if (savedPassword) {
    elements.password.value = savedPassword;
    elements.remember.checked = true;
  }

  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!isIOS && "webkitdirectory" in elements.folderInput) {
    elements.pickFolder.hidden = false;
  }

  wireEvents();
  if (!savedServer) loadDevelopmentConfig();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

async function loadDevelopmentConfig() {
  try {
    const response = await fetch("./dev-config.json", { cache: "no-store" });
    if (!response.ok) return;
    const config = await response.json();
    if (
      config.webdavUrl &&
      !localStorage.getItem(STORAGE_KEYS.server) &&
      elements.serverUrl.value === DEFAULT_SERVER
    ) {
      elements.serverUrl.value = config.webdavUrl;
    }
  } catch {
    // Production static hosts do not provide this development-only endpoint.
  }
}

function wireEvents() {
  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await connect();
  });

  elements.signOut.addEventListener("click", signOut);

  elements.pickFiles.addEventListener("click", () => elements.fileInput.click());
  elements.pickFolder.addEventListener("click", () => elements.folderInput.click());

  elements.fileInput.addEventListener("change", () => {
    addFiles([...elements.fileInput.files]);
    elements.fileInput.value = "";
  });

  elements.folderInput.addEventListener("change", () => {
    addFiles([...elements.folderInput.files]);
    elements.folderInput.value = "";
  });

  elements.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("dragging");
  });

  elements.dropZone.addEventListener("dragleave", () => {
    elements.dropZone.classList.remove("dragging");
  });

  elements.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragging");
    addFiles([...event.dataTransfer.files]);
  });

  elements.remotePath.addEventListener("change", () => {
    localStorage.setItem(STORAGE_KEYS.remotePath, elements.remotePath.value);
  });

  elements.duplicateMode.addEventListener("change", () => {
    localStorage.setItem(STORAGE_KEYS.duplicateMode, elements.duplicateMode.value);
  });

  elements.startUpload.addEventListener("click", startUpload);
  elements.cancelUpload.addEventListener("click", cancelUpload);
}

async function connect() {
  const server = normalizeServerUrl(elements.serverUrl.value);
  const username = elements.username.value.trim();
  const password = elements.password.value;

  if (!server) {
    setAuthStatus("Enter the server address.", "error");
    return;
  }

  if (location.protocol === "https:" && server.startsWith("http:")) {
    setAuthStatus(
      "This page is served over HTTPS, so the browser blocks plain-HTTP servers. Use an HTTPS server address.",
      "error"
    );
    return;
  }

  elements.connect.disabled = true;
  setAuthStatus("Connecting...", "muted");

  const authHeader = `Basic ${base64Utf8(`${username}:${password}`)}`;

  try {
    const response = await davRequest(server, "/", "PROPFIND", authHeader, { depth: "0" });
    if (response.status === 401) {
      setAuthStatus("Login failed. Check your BisQue username and password.", "error");
      return;
    }
    if (!isDavSuccess(response.status)) {
      setAuthStatus(`Server responded with HTTP ${response.status}.`, "error");
      return;
    }

    state.serverBase = server;
    state.authHeader = authHeader;

    localStorage.setItem(STORAGE_KEYS.server, server);
    localStorage.setItem(STORAGE_KEYS.username, username);
    if (elements.remember.checked) {
      localStorage.setItem(STORAGE_KEYS.password, password);
    } else {
      localStorage.removeItem(STORAGE_KEYS.password);
    }

    setAuthStatus(`Connected as ${username}.`, "success");
    elements.signOut.hidden = false;
    elements.uploadSection.hidden = false;
    elements.progressPanel.hidden = false;
  } catch (error) {
    setAuthStatus(
      "Could not reach the server. Check the address, your network (VPN?), and that the server allows browser access (CORS).",
      "error"
    );
  } finally {
    elements.connect.disabled = false;
  }
}

function signOut() {
  state.authHeader = null;
  state.serverBase = null;
  localStorage.removeItem(STORAGE_KEYS.password);
  elements.password.value = "";
  elements.remember.checked = false;
  elements.signOut.hidden = true;
  elements.uploadSection.hidden = true;
  elements.progressPanel.hidden = true;
  setAuthStatus("Signed out.", "muted");
}

function addFiles(files) {
  for (const file of files) {
    const relPath = normalizeRelPath(file.webkitRelativePath || file.name);
    if (!relPath) continue;
    if (state.entries.some((entry) => entry.relPath === relPath)) continue;
    state.entries.push({ file, relPath });
  }
  renderSelection();
}

function renderSelection() {
  elements.selectionList.innerHTML = "";
  elements.emptySelection.hidden = state.entries.length > 0;
  elements.startUpload.disabled = state.entries.length === 0 || state.uploading;

  for (const entry of state.entries) {
    const item = document.createElement("li");
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = entry.relPath;
    const meta = document.createElement("span");
    meta.textContent = formatBytes(entry.file.size);
    info.append(name, meta);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${entry.relPath}`);
    remove.addEventListener("click", () => {
      state.entries = state.entries.filter((candidate) => candidate !== entry);
      renderSelection();
    });

    item.append(info, remove);
    elements.selectionList.appendChild(item);
  }

  elements.fileCount.textContent = String(state.entries.length);
  const totalBytes = state.entries.reduce((sum, entry) => sum + entry.file.size, 0);
  elements.totalSize.textContent = formatBytes(totalBytes);
}

async function startUpload() {
  if (!state.authHeader || state.entries.length === 0 || state.uploading) return;

  state.uploading = true;
  state.cancelled = false;
  elements.startUpload.disabled = true;
  elements.cancelUpload.disabled = false;
  elements.keepOpenNote.hidden = false;
  elements.logOutput.textContent = "";
  setProgress(0);

  const duplicateMode = elements.duplicateMode.value;
  const remoteRoot = normalizeRemotePath(elements.remotePath.value);
  const totalBytes = state.entries.reduce((sum, entry) => sum + entry.file.size, 0) || 1;
  let doneBytes = 0;
  let uploaded = 0;
  let skipped = 0;
  const ensuredCollections = new Set();

  try {
    elements.progressTitle.textContent = "Preparing destination...";
    await ensureCollection(remoteRoot, ensuredCollections);

    for (const entry of state.entries) {
      if (state.cancelled) throw new UploadCancelled();

      const destPath = joinPath(remoteRoot, entry.relPath);
      const parent = parentPath(destPath);
      if (parent && parent !== remoteRoot) {
        await ensureCollection(parent, ensuredCollections, remoteRoot);
      }

      if (duplicateMode !== "overwrite") {
        const exists = await remoteExists(destPath);
        if (state.cancelled) throw new UploadCancelled();
        if (exists && duplicateMode === "skip") {
          appendLog(`Skipped (already exists): ${entry.relPath}`);
          skipped += 1;
          doneBytes += entry.file.size;
          setProgress((doneBytes / totalBytes) * 100);
          continue;
        }
        if (exists && duplicateMode === "fail") {
          throw new Error(`Already exists on the server: ${entry.relPath}`);
        }
      }

      elements.progressTitle.textContent = `Uploading ${entry.relPath}`;
      await putFile(entry.file, destPath, (loaded) => {
        setProgress(((doneBytes + loaded) / totalBytes) * 100);
      });
      appendLog(`Uploaded: ${entry.relPath}`);
      uploaded += 1;
      doneBytes += entry.file.size;
      setProgress((doneBytes / totalBytes) * 100);
    }

    elements.progressTitle.textContent = "Upload complete";
    setProgress(100);
    appendLog(`Done. ${uploaded} uploaded, ${skipped} skipped.`);
    state.entries = [];
    renderSelection();
  } catch (error) {
    if (error instanceof UploadCancelled) {
      elements.progressTitle.textContent = "Upload cancelled";
      appendLog("Upload cancelled.", true);
    } else {
      elements.progressTitle.textContent = "Upload failed";
      appendLog(error.message, true);
    }
  } finally {
    state.uploading = false;
    state.activeXhr = null;
    elements.startUpload.disabled = state.entries.length === 0;
    elements.cancelUpload.disabled = true;
    elements.keepOpenNote.hidden = true;
  }
}

function cancelUpload() {
  if (!state.uploading) return;
  state.cancelled = true;
  if (state.activeXhr) {
    state.activeXhr.abort();
  }
}

class UploadCancelled extends Error {
  constructor() {
    super("Upload cancelled.");
  }
}

async function ensureCollection(path, ensured, stopAt = "/") {
  const segments = pathSegments(path);
  const stopDepth = pathSegments(stopAt).length;
  let current = "";
  for (let index = 0; index < segments.length; index += 1) {
    current += `/${segments[index]}`;
    if (index < stopDepth || ensured.has(current)) continue;
    const response = await davRequest(state.serverBase, current, "MKCOL", state.authHeader);
    if (!isDavSuccess(response.status) && response.status !== 405 && response.status !== 301) {
      throw new Error(`Could not create folder ${current} (HTTP ${response.status}).`);
    }
    ensured.add(current);
  }
  ensured.add(path);
}

async function remoteExists(path) {
  const response = await davRequest(state.serverBase, path, "PROPFIND", state.authHeader, {
    depth: "0",
  });
  if (response.status === 404) return false;
  if (isDavSuccess(response.status)) return true;
  throw new Error(`Could not check ${path} (HTTP ${response.status}).`);
}

function putFile(file, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    state.activeXhr = xhr;
    xhr.open("PUT", davUrl(state.serverBase, destPath));
    xhr.setRequestHeader("Authorization", state.authHeader);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else if (xhr.status === 401) {
        reject(new Error("Session rejected by the server. Sign in again."));
      } else {
        reject(new Error(`Upload of ${destPath} failed (HTTP ${xhr.status}).`));
      }
    });
    xhr.addEventListener("error", () =>
      reject(new Error(`Network error while uploading ${destPath}.`))
    );
    xhr.addEventListener("abort", () => reject(new UploadCancelled()));

    xhr.send(file);
  });
}

function davRequest(server, path, method, authHeader, extraHeaders = {}) {
  const headers = { Authorization: authHeader };
  if (extraHeaders.depth) headers.Depth = extraHeaders.depth;
  return fetch(davUrl(server, path), { method, headers });
}

function davUrl(server, path) {
  const encoded = pathSegments(path)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${server}/${encoded}`;
}

function isDavSuccess(status) {
  return status >= 200 && status < 300;
}

function normalizeServerUrl(value) {
  let server = String(value || "").trim();
  if (!server) return "";
  if (!/^https?:\/\//i.test(server)) server = `http://${server}`;
  return server.replace(/\/+$/, "");
}

function normalizeRemotePath(value) {
  const segments = pathSegments(value);
  return `/${segments.join("/")}`;
}

function normalizeRelPath(value) {
  return pathSegments(value).join("/");
}

function pathSegments(value) {
  return String(value || "")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..");
}

function joinPath(root, relPath) {
  const segments = [...pathSegments(root), ...pathSegments(relPath)];
  return `/${segments.join("/")}`;
}

function parentPath(path) {
  const segments = pathSegments(path);
  segments.pop();
  return `/${segments.join("/")}`;
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function setProgress(percent) {
  const bounded = Math.max(0, Math.min(100, Math.round(percent)));
  elements.progressPercent.textContent = `${bounded}%`;
  elements.progressBar.style.width = `${bounded}%`;
}

function appendLog(message, isError = false) {
  const prefix = isError ? "ERROR" : new Date().toLocaleTimeString();
  elements.logOutput.textContent += `[${prefix}] ${message}\n`;
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function setAuthStatus(message, kind) {
  elements.authStatus.textContent = message;
  elements.authStatus.className = `status ${kind}`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}
