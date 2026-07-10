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
    const irodsPaths = [...new Set((config.irodsPaths || []).map(normalizeIrodsPath))];
    const imageUris = [];
    const skipped = [];

    if (irodsPaths.length === 0) {
      throw new BisqueApiError("No uploaded iRODS files were available for the dataset.", {
        code: "NO_IRODS_FILES",
      });
    }

    for (let index = 0; index < irodsPaths.length; index += 1) {
      const irodsPath = irodsPaths[index];
      notify(config.onProgress, {
        stage: "register",
        index,
        total: irodsPaths.length,
        irodsPath,
      });

      const registration = await this.registerIrodsPath(irodsPath, config.signal);
      if (registration.imageUris.length === 0) {
        skipped.push({
          irodsPath,
          reason: "BisQue registered this file, but did not identify it as an image.",
        });
        continue;
      }
      imageUris.push(...registration.imageUris);
    }

    const uniqueImageUris = [...new Set(imageUris)];
    if (uniqueImageUris.length === 0) {
      throw new BisqueApiError(
        "BisQue did not identify any uploaded files as images, so no dataset was created.",
        { code: "NO_BISQUE_IMAGES" },
      );
    }

    notify(config.onProgress, {
      stage: "dataset",
      total: uniqueImageUris.length,
      datasetName,
    });
    const dataset = await this.createDataset(datasetName, uniqueImageUris, config.signal);

    return {
      datasetName,
      datasetUri: dataset.datasetUri,
      imageUris: uniqueImageUris,
      skipped,
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

    let imageUris = extractImageUris(response.body, this.baseUrl);
    const datasetUris = extractResourceUris(response.body, "dataset", this.baseUrl);
    if (imageUris.length === 0 && datasetUris.length > 0) {
      for (const datasetUri of datasetUris) {
        const separator = datasetUri.includes("?") ? "&" : "?";
        const datasetResponse = await this.authorizedRequest(`${datasetUri}${separator}view=deep`, {
          method: "GET",
          headers: { Accept: "application/xml, text/xml" },
          signal,
          absoluteUrl: true,
        });
        assertSuccess(datasetResponse, "read the registered BisQue dataset");
        imageUris.push(...extractImageUris(datasetResponse.body, this.baseUrl));
      }
    }

    return {
      irodsPath: normalizedPath,
      irodsUrl,
      imageUris: [...new Set(imageUris)],
      responseXml: response.body,
    };
  }

  async createDataset(datasetName, imageUris, signal) {
    const cleanName = normalizeDatasetName(datasetName);
    const members = [...new Set(imageUris.map((uri) => normalizeBisqueUri(uri, this.baseUrl)))];
    if (members.length === 0) {
      throw new BisqueApiError("A BisQue dataset needs at least one image.", {
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

    return { datasetUri: datasetUris[0], responseXml: response.body };
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
    const body = options.body == null ? null : Buffer.from(String(options.body), "utf8");
    const headers = { ...(options.headers || {}) };
    if (body && !Object.keys(headers).some((name) => name.toLowerCase() === "content-length")) {
      headers["Content-Length"] = body.length;
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

    if (body) request.write(body);
    request.end();
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

function extractImageUris(xml, baseUrl) {
  const uris = extractResourceUris(xml, "image", baseUrl);
  const valuePattern = /<value\b([^>]*)>([\s\S]*?)<\/value>/gi;
  let match;
  while ((match = valuePattern.exec(String(xml || "")))) {
    const attributes = parseAttributes(match[1]);
    if (String(attributes.type || "").toLowerCase() !== "object") continue;
    const value = decodeXml(stripXmlTags(match[2])).trim();
    if (value) uris.push(normalizeBisqueUri(value, baseUrl));
  }
  return [...new Set(uris)];
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
  extractImageUris,
  extractResourceUris,
  normalizeDatasetName,
  normalizeIrodsPath,
  requestText,
};
