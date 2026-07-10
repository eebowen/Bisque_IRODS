const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bisque", {
  app: {
    openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
  },
  auth: {
    saveCredentials: (credentials) => ipcRenderer.invoke("auth:saveCredentials", credentials),
    getProfile: () => ipcRenderer.invoke("auth:getProfile"),
  },
  irods: {
    testConnection: () => ipcRenderer.invoke("irods:testConnection"),
  },
  upload: {
    pickFiles: () => ipcRenderer.invoke("upload:pickFiles"),
    pickFolder: () => ipcRenderer.invoke("upload:pickFolder"),
    summarize: (localPaths) => ipcRenderer.invoke("upload:summarize", localPaths),
    start: (payload) => ipcRenderer.invoke("upload:start", payload),
    cancel: (uploadId) => ipcRenderer.invoke("upload:cancel", uploadId),
    onProgress: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("upload:progress", listener);
      return () => ipcRenderer.removeListener("upload:progress", listener);
    },
  },
});
