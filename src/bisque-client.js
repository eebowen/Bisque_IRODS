const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const https = require("https");
const path = require("path");

const DEFAULT_BISQUE_URL = "https://bisque2.ece.ucsb.edu";
const DEFAULT_IRODS_HOST = "brain.ece.ucsb.edu";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

class BisqueApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "BisqueApiError";
    this.status = options.status;
    this.code = options.code;
  }
}

class BisqueClient {
  constructor(options) {
    const config = options || {};
    this.baseUrl = String(config.baseUrl || DEFAULT_BISQUE_URL).replace(/\/+$/, "");
    this.irodsHost = config.irodsHost || DEFAULT_IRODS_HOST;
    this.username = String(config.username || "").trim();
    this.password = String(config.password || "");
    this.request = config.request || requestText;
    this.retryDelays = config.retryDelays || [5000, 15000];

    const parsedBaseUrl = new URL(this.baseUrl);
    if (parsedBaseUrl.protocol !== "https:" && !config.allowInsecure) {
      throw new Error("The BisQue API address must use HTTPS.");
    }
    if (!this.username || !this.password) {
      throw new Error("BisQue username and password are required.");
    }
  }

  async createDatasetFromIrodsPaths(options) {
    const config = options || {};
    const datasetName = normalizeDatasetName(config.datasetName);
    const inputs = config.files || (config.irodsPaths || []).map((irodsPath) => ({ irodsPath }));
    const filesByPath = new Map();
    for (const input of inputs) {
      const irodsPath = normalizeIrodsPath(input.irodsPath);
      if (!filesByPath.has(irodsPath)) {
        filesByPath.set(irodsPath, { irodsPath, localPath: input.localPath });
      }
    }
    const files = [...filesByPath.values()];
    const resourceUris = [];
    const skipped = [];
    const failed = [];

    if (files.length === 0) {
      throw new BisqueApiError("No uploaded iRODS files were available for the dataset.", {
        code: "NO_IRODS_FILES",
      });
    }

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      notify(config.onProgress, {
        stage: "register",
        index,
        total: files.length,
        irodsPath: file.irodsPath,
      });

      const onRetry = retryNotifier(config, { index, total: files.length, irodsPath: file.irodsPath });
      let fileResourceUris = null;
      let failureReason = "";
      try {
        const registration = await this.withRetries(
          () => this.registerIrodsPath(file.irodsPath, config.signal),
          { signal: config.signal, onRetry },
        );
        fileResourceUris = registration.resourceUris;
      } catch (error) {
        rethrowIfFatal(error);
        failureReason = `in-place registration failed (${error.message})`;
      }

      if (fileResourceUris == null && file.localPath) {
        notify(config.onProgress, {
          stage: "transfer",
          index,
          total: files.length,
          irodsPath: file.irodsPath,
        });
        try {
          const transfer = await this.withRetries(
            () => this.transferLocalFile(file.localPath, path.posix.basename(file.irodsPath), config.signal),
            { signal: config.signal, onRetry },
          );
          fileResourceUris = transfer.resourceUris;
        } catch (error) {
          rethrowIfFatal(error);
          failureReason += `; direct upload failed (${error.message})`;
        }
      }

      if (fileResourceUris == null) {
        failed.push({ irodsPath: file.irodsPath, reason: failureReason });
        continue;
      }
      if (fileResourceUris.length === 0) {
        skipped.push({
          irodsPath: file.irodsPath,
          reason: "BisQue accepted this file, but did not return a registered resource for it.",
        });
        continue;
      }
      resourceUris.push(...fileResourceUris);
    }

    return this.finalizeDataset(datasetName, resourceUris, skipped, failed, config);
  }

  async createDatasetFromLocalFiles(options) {
    const config = options || {};
    const datasetName = normalizeDatasetName(config.datasetName);
    const filesByPath = new Map();
    for (const input of config.files || []) {
      const localPath = String(input.localPath || "");
      if (localPath && !filesByPath.has(localPath)) {
        filesByPath.set(localPath, { localPath, name: input.name || path.basename(localPath) });
      }
    }
    const files = [...filesByPath.values()];
    const resourceUris = [];
    const skipped = [];
    const failed = [];

    if (files.length === 0) {
      throw new BisqueApiError("No files were available for the dataset.", {
        code: "NO_LOCAL_FILES",
      });
    }

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      notify(config.onProgress, {
        stage: "transfer",
        index,
        total: files.length,
        name: file.name,
        localPath: file.localPath,
      });

      let fileResourceUris;
      try {
        const transfer = await this.withRetries(
          () => this.transferLocalFile(file.localPath, file.name, config.signal),
          {
            signal: config.signal,
            onRetry: retryNotifier(config, { index, total: files.length, name: file.name }),
          },
        );
        fileResourceUris = transfer.resourceUris;
      } catch (error) {
        rethrowIfFatal(error);
        failed.push({ name: file.name, localPath: file.localPath, reason: error.message });
        continue;
      }

      if (fileResourceUris.length === 0) {
        skipped.push({
          name: file.name,
          localPath: file.localPath,
          reason: "BisQue accepted this file, but did not return a registered resource for it.",
        });
        continue;
      }
      resourceUris.push(...fileResourceUris);
    }

    return this.finalizeDataset(datasetName, resourceUris, skipped, failed, config);
  }

  async finalizeDataset(datasetName, resourceUris, skipped, failed, config) {
    const uniqueResourceUris = [...new Set(resourceUris)];
    if (uniqueResourceUris.length === 0) {
      if (failed.length > 0) {
        throw new BisqueApiError(
          `BisQue could not register any of the uploaded files. First failure: ${failed[0].irodsPath || failed[0].name}: ${failed[0].reason}`,
          { code: "BISQUE_REGISTRATION_FAILED" },
        );
      }
      throw new BisqueApiError(
        "BisQue did not return a registered resource for any uploaded file, so no dataset was created.",
        { code: "NO_BISQUE_RESOURCES" },
      );
    }

    notify(config.onProgress, {
      stage: "dataset",
      total: uniqueResourceUris.length,
      datasetName,
    });
    const onRetry = retryNotifier(config, { datasetName });
    const existingDatasetUri = await this.withRetries(
      () => this.findDatasetByName(datasetName, config.signal),
      { signal: config.signal, onRetry },
    );
    const dataset = existingDatasetUri
      ? await this.withRetries(
          () => this.appendToDataset(existingDatasetUri, uniqueResourceUris, config.signal),
          { signal: config.signal, onRetry },
        )
      : await this.withRetries(
          () => this.createDataset(datasetName, uniqueResourceUris, config.signal),
          { signal: config.signal, onRetry },
        );

    return {
      datasetName,
      datasetUri: dataset.datasetUri,
      resourceUris: uniqueResourceUris,
      appendedToExisting: Boolean(existingDatasetUri),
      addedCount: dataset.addedCount,
      memberCount: dataset.memberCount,
      skipped,
      failed,
    };
  }

  async findDatasetByName(datasetName, signal) {
    const cleanName = normalizeDatasetName(datasetName);
    const response = await this.authorizedRequest(
      `/data_service/dataset?name=${encodeURIComponent(cleanName)}`,
      { method: "GET", headers: { Accept: "application/xml, text/xml" }, signal },
    );
    assertSuccess(response, "look up the BisQue dataset name");

    // The query matches server-side, but only trust datasets whose name is an
    // exact match; take the first one when duplicates exist.
    for (const tag of extractStartTags(response.body, "dataset")) {
      const attributes = parseAttributes(tag);
      if (attributes.name !== cleanName) continue;
      if (attributes.uri) return normalizeBisqueUri(attributes.uri, this.baseUrl);
      if (attributes.resource_uniq) {
        return normalizeBisqueUri(`/data_service/${attributes.resource_uniq}`, this.baseUrl);
      }
    }
    return null;
  }

  async appendToDataset(datasetUri, resourceUris, signal) {
    const separator = datasetUri.includes("?") ? "&" : "?";
    const response = await this.authorizedRequest(`${datasetUri}${separator}view=full`, {
      method: "GET",
      headers: { Accept: "application/xml, text/xml" },
      signal,
      absoluteUrl: true,
    });
    assertSuccess(response, "read the existing BisQue dataset");

    const existingMembers = new Set(extractMemberValues(response.body, this.baseUrl));
    const newMembers = [...new Set(resourceUris.map((uri) => normalizeBisqueUri(uri, this.baseUrl)))]
      .filter((uri) => !existingMembers.has(uri));
    if (newMembers.length === 0) {
      return { datasetUri, addedCount: 0, memberCount: existingMembers.size };
    }

    const values = newMembers
      .map((uri) => `<value type="object">${escapeXml(uri)}</value>`)
      .join("");
    const updateResponse = await this.authorizedRequest(datasetUri, {
      method: "PUT",
      headers: {
        Accept: "application/xml, text/xml",
        "Content-Type": "text/xml; charset=utf-8",
      },
      body: appendValuesToDatasetXml(response.body, values),
      signal,
      absoluteUrl: true,
    });
    assertSuccess(updateResponse, "add files to the existing BisQue dataset");
    throwForBisqueXmlError(updateResponse.body, "the existing BisQue dataset");

    return {
      datasetUri,
      addedCount: newMembers.length,
      memberCount: existingMembers.size + newMembers.length,
    };
  }

  async registerIrodsPath(irodsPath, signal) {
    const normalizedPath = normalizeIrodsPath(irodsPath);
    const encodedPath = normalizedPath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const irodsUrl = `irods://${this.irodsHost}${encodedPath}`;
    const resourceXml =
      `<resource name="${escapeXml(path.posix.basename(normalizedPath))}" ` +
      `value="${escapeXml(irodsUrl)}" />`;
    const body = new URLSearchParams({ irods_resource: resourceXml }).toString();
    const response = await this.authorizedRequest("/import/insert_inplace", {
      method: "POST",
      headers: {
        Accept: "application/xml, text/xml",
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body,
      signal,
    });

    assertSuccess(response, "register the iRODS file");
    throwForBisqueXmlError(response.body, normalizedPath);

    const resourceUris = extractUploadedResourceUris(response.body, this.baseUrl);
    const datasetUris = extractResourceUris(response.body, "dataset", this.baseUrl);
    if (resourceUris.length === 0 && datasetUris.length > 0) {
      for (const datasetUri of datasetUris) {
        const separator = datasetUri.includes("?") ? "&" : "?";
        const datasetResponse = await this.authorizedRequest(`${datasetUri}${separator}view=deep`, {
          method: "GET",
          headers: { Accept: "application/xml, text/xml" },
          signal,
          absoluteUrl: true,
        });
        assertSuccess(datasetResponse, "read the registered BisQue dataset");
        resourceUris.push(
          ...extractUploadedResourceUris(datasetResponse.body, this.baseUrl, {
            includeMemberValues: true,
          }),
        );
      }
    }

    return {
      irodsPath: normalizedPath,
      irodsUrl,
      resourceUris: [...new Set(resourceUris)],
      responseXml: response.body,
    };
  }

  async transferLocalFile(localPath, fileName, signal) {
    const stat = await fsp.stat(localPath);
    if (!stat.isFile()) {
      throw new BisqueApiError(`Cannot upload ${localPath} to BisQue: it is not a file.`, {
        code: "INVALID_LOCAL_FILE",
      });
    }

    const boundary = `----bisque-${crypto.randomBytes(12).toString("hex")}`;
    const safeName = String(fileName || path.basename(localPath)).replace(/[\r\n"]/g, "_");
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
        "Content-Type: application/octet-stream\r\n\r\n",
      "utf8",
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const response = await this.authorizedRequest("/import/transfer", {
      method: "POST",
      headers: {
        Accept: "application/xml, text/xml",
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      bodyParts: [head, { filePath: localPath, size: stat.size }, tail],
      signal,
    });

    assertSuccess(response, "upload the file to BisQue");
    throwForBisqueXmlError(response.body, safeName);

    return { resourceUris: extractUploadedResourceUris(response.body, this.baseUrl) };
  }

  async createDataset(datasetName, resourceUris, signal) {
    const cleanName = normalizeDatasetName(datasetName);
    const members = [...new Set(resourceUris.map((uri) => normalizeBisqueUri(uri, this.baseUrl)))];
    if (members.length === 0) {
      throw new BisqueApiError("A BisQue dataset needs at least one file.", {
        code: "EMPTY_DATASET",
      });
    }

    const values = members
      .map((uri) => `<value type="object">${escapeXml(uri)}</value>`)
      .join("");
    const datasetXml = `<dataset name="${escapeXml(cleanName)}">${values}</dataset>`;
    const response = await this.authorizedRequest("/data_service/dataset", {
      method: "POST",
      headers: {
        Accept: "application/xml, text/xml",
        "Content-Type": "text/xml; charset=utf-8",
      },
      body: datasetXml,
      signal,
    });

    assertSuccess(response, "create the BisQue dataset");
    throwForBisqueXmlError(response.body, cleanName);

    const datasetUris = extractResourceUris(response.body, "dataset", this.baseUrl);
    if (datasetUris.length === 0) {
      throw new BisqueApiError(
        "BisQue accepted the dataset request but did not return a dataset URL.",
        { code: "MISSING_DATASET_URI" },
      );
    }

    return {
      datasetUri: datasetUris[0],
      addedCount: members.length,
      memberCount: members.length,
      responseXml: response.body,
    };
  }

  async withRetries(action, options) {
    const config = options || {};
    const delays = this.retryDelays;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        if (
          attempt >= delays.length ||
          !isTransientError(error) ||
          (config.signal && config.signal.aborted)
        ) {
          throw error;
        }
        const delayMs = delays[attempt];
        if (config.onRetry) {
          config.onRetry({
            attempt: attempt + 1,
            maxAttempts: delays.length + 1,
            delayMs,
            errorMessage: String(error && error.message ? error.message : error),
          });
        }
        await sleep(delayMs, config.signal);
      }
    }
  }

  authorizedRequest(target, options) {
    const requestOptions = { ...(options || {}) };
    const absoluteUrl = requestOptions.absoluteUrl;
    delete requestOptions.absoluteUrl;
    const url = absoluteUrl ? target : `${this.baseUrl}${target}`;
    const targetUrl = new URL(url);
    const baseUrl = new URL(this.baseUrl);
    if (targetUrl.origin !== baseUrl.origin) {
      throw new BisqueApiError("BisQue returned a resource on an unexpected server.", {
        code: "UNTRUSTED_BISQUE_ORIGIN",
      });
    }

    requestOptions.headers = {
      ...(requestOptions.headers || {}),
      Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`, "utf8").toString("base64")}`,
    };
    return this.request(url, requestOptions);
  }
}

function requestText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const bodyParts = options.bodyParts
      ? options.bodyParts.slice()
      : options.body == null
        ? []
        : [Buffer.from(String(options.body), "utf8")];
    const headers = { ...(options.headers || {}) };
    if (
      bodyParts.length > 0 &&
      !Object.keys(headers).some((name) => name.toLowerCase() === "content-length")
    ) {
      headers["Content-Length"] = bodyParts.reduce(
        (sum, part) => sum + (Buffer.isBuffer(part) ? part.length : part.size),
        0,
      );
    }

    const request = transport.request(
      parsed,
      {
        method: options.method || "GET",
        headers,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("BisQue returned an unexpectedly large response."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          cleanupAbortListener();
          resolve({
            status: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    const abort = () => {
      const error = new Error("Operation cancelled.");
      error.name = "AbortError";
      request.destroy(error);
    };
    const cleanupAbortListener = () => options.signal?.removeEventListener("abort", abort);

    request.on("error", (error) => {
      cleanupAbortListener();
      reject(error);
    });
    request.setTimeout(60000, () => request.destroy(new Error("BisQue request timed out.")));

    if (options.signal) {
      if (options.signal.aborted) {
        abort();
        return;
      }
      options.signal.addEventListener("abort", abort, { once: true });
    }

    writeBodyParts(request, bodyParts).then(
      () => request.end(),
      (error) => request.destroy(error),
    );
  });
}

function writeBodyParts(request, parts) {
  return parts.reduce(
    (chain, part) =>
      chain.then(() => {
        if (Buffer.isBuffer(part)) {
          return new Promise((resolve, reject) => {
            request.write(part, (error) => (error ? reject(error) : resolve()));
          });
        }
        return new Promise((resolve, reject) => {
          const stream = fs.createReadStream(part.filePath);
          const stopStream = () => stream.destroy();
          request.once("error", stopStream);
          request.once("close", stopStream);
          stream.on("error", reject);
          stream.on("end", resolve);
          stream.pipe(request, { end: false });
        });
      }),
    Promise.resolve(),
  );
}

function rethrowIfFatal(error) {
  if (error && (error.name === "AbortError" || error.code === "BISQUE_AUTH_FAILED")) {
    throw error;
  }
}

const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

function isTransientError(error) {
  if (!error || error.name === "AbortError") return false;
  if (error instanceof BisqueApiError) {
    return error.code === "BISQUE_HTTP_ERROR" && Number(error.status) >= 500;
  }
  if (TRANSIENT_ERROR_CODES.has(String(error.code || ""))) return true;
  return /timed out|socket hang up/i.test(String(error.message || ""));
}

function retryNotifier(config, context) {
  return (info) => notify(config.onProgress, { stage: "retry", ...context, ...info });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abortError = () => {
      const error = new Error("Operation cancelled.");
      error.name = "AbortError";
      return error;
    };
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function assertSuccess(response, action) {
  if (response.status >= 200 && response.status < 300) return;
  const detail = extractErrorMessage(response.body);
  const redirectLocation = String(response.headers?.location || "");
  if (
    response.status === 401 ||
    response.status === 403 ||
    ([301, 302, 303, 307, 308].includes(response.status) && /auth_service\/login/i.test(redirectLocation))
  ) {
    throw new BisqueApiError("BisQue rejected the username or password.", {
      status: response.status,
      code: "BISQUE_AUTH_FAILED",
    });
  }
  if (/register the iRODS file/i.test(action) && /(?:unsupported|illegal|handler|driver)[^<\n]*irods|irods[^<\n]*(?:unsupported|illegal|scheme|handler|driver)/i.test(response.body)) {
    throw new BisqueApiError("The BisQue server does not support registering this iRODS resource.", {
      status: response.status,
      code: "IRODS_REGISTRATION_UNAVAILABLE",
    });
  }
  throw new BisqueApiError(
    `Could not ${action} (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
    { status: response.status, code: "BISQUE_HTTP_ERROR" },
  );
}

function throwForBisqueXmlError(xml, subject) {
  const message = extractErrorMessage(xml);
  if (!message) return;
  throw new BisqueApiError(`BisQue could not process ${subject}: ${message}`, {
    code: /unsupported|illegal.*scheme|irods/i.test(message)
      ? "IRODS_REGISTRATION_UNAVAILABLE"
      : "BISQUE_IMPORT_ERROR",
  });
}

function extractErrorMessage(xml) {
  for (const tag of extractStartTags(xml, "tag")) {
    const attributes = parseAttributes(tag);
    if (String(attributes.name || "").toLowerCase() === "error" && attributes.value) {
      return attributes.value;
    }
  }
  const match = String(xml || "").match(/<(?:error|message)\b[^>]*>([\s\S]*?)<\/(?:error|message)>/i);
  if (match) return decodeXml(stripXmlTags(match[1])).trim();
  return "";
}

// Resource elements the BisQue import service can return for a single uploaded
// file. Non-image files (PDF, CSV, ...) come back as <file> or a generic
// <resource>; datasets can reference any of them as members.
const UPLOADED_RESOURCE_TAGS = ["image", "file", "table", "resource"];

function extractUploadedResourceUris(xml, baseUrl, options) {
  const uris = [];
  for (const tagName of UPLOADED_RESOURCE_TAGS) {
    uris.push(...extractResourceUris(xml, tagName, baseUrl));
  }
  if (options && options.includeMemberValues) {
    uris.push(...extractMemberValues(xml, baseUrl));
  }
  return [...new Set(uris)];
}

function extractMemberValues(xml, baseUrl) {
  const uris = [];
  const valuePattern = /<value\b([^>]*)>([\s\S]*?)<\/value>/gi;
  let match;
  while ((match = valuePattern.exec(String(xml || "")))) {
    const attributes = parseAttributes(match[1]);
    if (String(attributes.type || "").toLowerCase() !== "object") continue;
    const value = decodeXml(stripXmlTags(match[2])).trim();
    if (value) uris.push(normalizeBisqueUri(value, baseUrl));
  }
  return uris;
}

// Inserts new <value> members into a fetched dataset document, keeping the
// rest of the document (tags, existing members) untouched for the PUT update.
function appendValuesToDatasetXml(datasetXml, valuesXml) {
  const xml = String(datasetXml || "");
  const closeIndex = xml.lastIndexOf("</dataset>");
  if (closeIndex !== -1) {
    return xml.slice(0, closeIndex) + valuesXml + xml.slice(closeIndex);
  }
  const selfClosing = xml.match(/<dataset\b[^>]*\/>/i);
  if (selfClosing) {
    const opened = selfClosing[0].replace(/\s*\/>$/, ">");
    return xml.replace(selfClosing[0], `${opened}${valuesXml}</dataset>`);
  }
  throw new BisqueApiError("BisQue returned an unexpected dataset document.", {
    code: "INVALID_DATASET_DOCUMENT",
  });
}

function extractResourceUris(xml, tagName, baseUrl) {
  const uris = [];
  for (const tag of extractStartTags(xml, tagName)) {
    const attributes = parseAttributes(tag);
    if (attributes.uri) {
      uris.push(normalizeBisqueUri(attributes.uri, baseUrl));
    } else if (attributes.resource_uniq) {
      uris.push(normalizeBisqueUri(`/data_service/${attributes.resource_uniq}`, baseUrl));
    }
  }
  return [...new Set(uris)];
}

function extractStartTags(xml, tagName) {
  const escapedName = String(tagName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<${escapedName}\\b([^>]*)>`, "gi");
  const tags = [];
  let match;
  while ((match = pattern.exec(String(xml || "")))) tags.push(match[1]);
  return tags;
}

function parseAttributes(source) {
  const attributes = {};
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(String(source || "")))) {
    attributes[match[1]] = decodeXml(match[2] == null ? match[3] : match[2]);
  }
  return attributes;
}

function normalizeDatasetName(value) {
  const name = String(value || "").trim();
  if (!name) throw new BisqueApiError("Enter a name for the BisQue dataset.", { code: "DATASET_NAME_REQUIRED" });
  if (name.length > 200) {
    throw new BisqueApiError("The BisQue dataset name must be 200 characters or fewer.", {
      code: "DATASET_NAME_TOO_LONG",
    });
  }
  return name;
}

function normalizeIrodsPath(value) {
  const remotePath = String(value || "").trim().replace(/\\/g, "/");
  if (!remotePath.startsWith("/ucsb/home/")) {
    throw new BisqueApiError("BisQue registration requires a path inside /ucsb/home/.", {
      code: "INVALID_IRODS_PATH",
    });
  }
  const segments = remotePath.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new BisqueApiError("The iRODS path contains an invalid segment.", {
      code: "INVALID_IRODS_PATH",
    });
  }
  return `/${segments.join("/")}`;
}

function normalizeBisqueUri(value, baseUrl) {
  const parsed = new URL(decodeXml(String(value || "").trim()), `${String(baseUrl).replace(/\/+$/, "")}/`);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new BisqueApiError("BisQue returned an invalid resource URL.", {
      code: "INVALID_BISQUE_URI",
    });
  }
  return parsed.toString();
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripXmlTags(value) {
  return String(value).replace(/<[^>]+>/g, "");
}

function notify(callback, event) {
  if (typeof callback === "function") callback(event);
}

module.exports = {
  BisqueApiError,
  BisqueClient,
  DEFAULT_BISQUE_URL,
  decodeXml,
  escapeXml,
  extractUploadedResourceUris,
  extractResourceUris,
  normalizeDatasetName,
  normalizeIrodsPath,
  requestText,
};
