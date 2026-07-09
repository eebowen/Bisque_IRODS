const state = {
  localPaths: [],
  summary: null,
  activeUploadId: null,
};

const elements = {
  loginForm: document.querySelector("#login-form"),
  username: document.querySelector("#username"),
  password: document.querySelector("#password"),
  remotePath: document.querySelector("#remote-path"),
  authStatus: document.querySelector("#auth-status"),
  testConnection: document.querySelector("#test-connection"),
  pickFiles: document.querySelector("#pick-files"),
  pickFolder: document.querySelector("#pick-folder"),
  dropZone: document.querySelector("#drop-zone"),
  emptySelection: document.querySelector("#empty-selection"),
  selectionList: document.querySelector("#selection-list"),
  fileCount: document.querySelector("#file-count"),
  totalSize: document.querySelector("#total-size"),
  uploadMode: document.querySelector("#upload-mode"),
  duplicateMode: document.querySelector("#duplicate-mode"),
  startUpload: document.querySelector("#start-upload"),
  cancelUpload: document.querySelector("#cancel-upload"),
  progressTitle: document.querySelector("#progress-title"),
  progressPercent: document.querySelector("#progress-percent"),
  progressBar: document.querySelector("#progress-bar"),
  logOutput: document.querySelector("#log-output"),
};

init();

async function init() {
  wireEvents();
  window.bisque.upload.onProgress(handleUploadProgress);

  const profile = await window.bisque.auth.getProfile();
  if (profile) {
    elements.username.value = profile.username;
    elements.remotePath.value = profile.defaultRemotePath;
    setAuthStatus(`Saved login for ${profile.username}.`, "success");
  }
}

function wireEvents() {
  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveLogin();
  });

  elements.testConnection.addEventListener("click", async () => {
    setAuthStatus("Testing connection...", "muted");
    const result = await window.bisque.irods.testConnection();
    setAuthStatus(result.message, result.ok ? "success" : "error");
  });

  elements.pickFiles.addEventListener("click", async () => {
    const paths = await window.bisque.upload.pickFiles();
    await addPaths(paths);
  });

  elements.pickFolder.addEventListener("click", async () => {
    const paths = await window.bisque.upload.pickFolder();
    await addPaths(paths);
  });

  elements.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("dragging");
  });

  elements.dropZone.addEventListener("dragleave", () => {
    elements.dropZone.classList.remove("dragging");
  });

  elements.dropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragging");
    const paths = [...event.dataTransfer.files].map((file) => file.path).filter(Boolean);
    await addPaths(paths);
  });

  elements.startUpload.addEventListener("click", startUpload);
  elements.cancelUpload.addEventListener("click", cancelUpload);
}

async function saveLogin() {
  try {
    const profile = await window.bisque.auth.saveCredentials({
      username: elements.username.value,
      password: elements.password.value,
    });
    elements.password.value = "";
    elements.remotePath.value = profile.defaultRemotePath;
    setAuthStatus(`Saved login for ${profile.username}.`, "success");
  } catch (error) {
    setAuthStatus(error.message, "error");
  }
}

async function addPaths(paths) {
  const incoming = Array.isArray(paths) ? paths : [];
  const nextPaths = new Set([...state.localPaths, ...incoming]);
  state.localPaths = [...nextPaths];
  await refreshSummary();
}

async function refreshSummary() {
  if (state.localPaths.length === 0) {
    state.summary = null;
    renderSummary();
    return;
  }

  state.summary = await window.bisque.upload.summarize(state.localPaths);
  renderSummary();
}

function renderSummary() {
  elements.selectionList.innerHTML = "";
  elements.emptySelection.hidden = state.localPaths.length > 0;
  elements.startUpload.disabled = state.localPaths.length === 0 || Boolean(state.activeUploadId);

  if (!state.summary) {
    elements.fileCount.textContent = "0";
    elements.totalSize.textContent = "0 B";
    return;
  }

  for (const entry of state.summary.entries) {
    const item = document.createElement("li");
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(entry.name)}</strong>
        <span>${entry.isDirectory ? "Folder" : "File"} · ${entry.files} file${entry.files === 1 ? "" : "s"}</span>
      </div>
      <button type="button" aria-label="Remove ${escapeHtml(entry.name)}">×</button>
    `;
    item.querySelector("button").addEventListener("click", async () => {
      state.localPaths = state.localPaths.filter((selectedPath) => selectedPath !== entry.path);
      await refreshSummary();
    });
    elements.selectionList.appendChild(item);
  }

  elements.fileCount.textContent = String(state.summary.totalFiles);
  elements.totalSize.textContent = formatBytes(state.summary.totalBytes);
  elements.uploadMode.querySelector("option[value='auto']").textContent = `Auto (${state.summary.recommendedMode})`;
}

async function startUpload() {
  resetProgress();
  elements.startUpload.disabled = true;
  elements.cancelUpload.disabled = false;

  try {
    const result = await window.bisque.upload.start({
      localPaths: state.localPaths,
      remotePath: elements.remotePath.value,
      mode: elements.uploadMode.value,
      duplicateMode: elements.duplicateMode.value,
    });
    state.activeUploadId = result.uploadId;
  } catch (error) {
    appendLog(error.message, true);
    elements.progressTitle.textContent = "Could not start upload";
    elements.startUpload.disabled = false;
    elements.cancelUpload.disabled = true;
  }
}

async function cancelUpload() {
  if (!state.activeUploadId) return;
  await window.bisque.upload.cancel(state.activeUploadId);
}

function handleUploadProgress(event) {
  if (state.activeUploadId && event.uploadId !== state.activeUploadId) {
    return;
  }

  if (!state.activeUploadId && event.type === "started") {
    state.activeUploadId = event.uploadId;
  }

  if (event.message) {
    appendLog(event.message, event.isError || event.type === "error");
  }

  if (event.type === "started") {
    elements.progressTitle.textContent = event.message;
  } else if (event.type === "file" || event.type === "tool") {
    elements.progressTitle.textContent = event.message;
  } else if (event.type === "done") {
    elements.progressTitle.textContent = "Upload complete";
    setProgress(100);
    finishUpload();
  } else if (event.type === "cancelled") {
    elements.progressTitle.textContent = "Upload cancelled";
    finishUpload();
  } else if (event.type === "error") {
    elements.progressTitle.textContent = "Upload failed";
    finishUpload();
  }

  if (typeof event.percent === "number") {
    setProgress(event.percent);
  }
}

function finishUpload() {
  state.activeUploadId = null;
  elements.startUpload.disabled = state.localPaths.length === 0;
  elements.cancelUpload.disabled = true;
}

function resetProgress() {
  elements.progressTitle.textContent = "Starting upload";
  setProgress(0);
  elements.logOutput.textContent = "";
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
