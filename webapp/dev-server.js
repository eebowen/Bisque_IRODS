// Local development server for the web app.
//
// Serves two things:
//   http://localhost:8000  - the static web app (this folder)
//   http://localhost:8081  - a WebDAV server with CORS, mimicking SFTPGo
//                            (Basic auth: test / test, files stored in ./dev-data)
//
// Usage: node webapp/dev-server.js

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_HOST = process.env.APP_HOST || "0.0.0.0";
const APP_PORT = Number(process.env.APP_PORT || 8000);
const DAV_PORT = Number(process.env.DAV_PORT || 8081);
const DAV_USER = process.env.DAV_USER || "test";
const DAV_PASS = process.env.DAV_PASS || "test";
const APP_ROOT = __dirname;
const DAV_ROOT = path.join(__dirname, "dev-data");

fs.mkdirSync(DAV_ROOT, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
};

// --- Static app server ---------------------------------------------------

const appServer = http.createServer((req, res) => {
  if (new URL(req.url, "http://localhost").pathname === "/dev-config.json") {
    const body = JSON.stringify({ webdavUrl: requestWebDavUrl(req) });
    res
      .writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      })
      .end(body);
    return;
  }

  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let filePath = path.normalize(path.join(APP_ROOT, urlPath));
  if (!filePath.startsWith(APP_ROOT)) {
    res.writeHead(403).end();
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
});

function requestWebDavUrl(req) {
  let hostname = "localhost";
  try {
    hostname = new URL(`http://${req.headers.host || "localhost"}`).hostname;
  } catch {
    // Keep the safe localhost fallback for a malformed Host header.
  }
  return `http://${hostname}:${DAV_PORT}`;
}

function lanAddresses() {
  try {
    const addresses = [];
    for (const [name, interfaceAddresses] of Object.entries(os.networkInterfaces())) {
      if (/^(br-|docker|veth|virbr|vboxnet|vmnet)/i.test(name)) continue;
      for (const address of interfaceAddresses || []) {
        if (address.family === "IPv4" && !address.internal) addresses.push(address.address);
      }
    }
    return [...new Set(addresses)];
  } catch {
    return [];
  }
}

// --- WebDAV server --------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, PUT, DELETE, OPTIONS, PROPFIND, MKCOL",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Depth",
  "Access-Control-Max-Age": "86400",
};

const davServer = http.createServer((req, res) => {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const auth = req.headers.authorization || "";
  const expected = `Basic ${Buffer.from(`${DAV_USER}:${DAV_PASS}`).toString("base64")}`;
  if (auth !== expected) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="SFTPGo WebDAV"' }).end("Unauthorized");
    return;
  }

  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const target = path.normalize(path.join(DAV_ROOT, urlPath));
  if (!target.startsWith(DAV_ROOT)) {
    res.writeHead(403).end();
    return;
  }

  try {
    handleDav(req, res, urlPath, target);
  } catch (error) {
    res.writeHead(500).end(String(error.message || error));
  }
});

function handleDav(req, res, urlPath, target) {
  const exists = fs.existsSync(target);

  switch (req.method) {
    case "PROPFIND": {
      if (!exists) {
        res.writeHead(404).end();
        return;
      }
      const depth = req.headers.depth === "0" ? 0 : 1;
      const entries = [propEntry(urlPath, target)];
      if (depth === 1 && fs.statSync(target).isDirectory()) {
        for (const name of fs.readdirSync(target)) {
          entries.push(propEntry(path.posix.join(urlPath, name), path.join(target, name)));
        }
      }
      const body = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${entries.join("")}</D:multistatus>`;
      res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" }).end(body);
      return;
    }

    case "MKCOL": {
      if (exists) {
        res.writeHead(405).end();
        return;
      }
      if (!fs.existsSync(path.dirname(target))) {
        res.writeHead(409).end();
        return;
      }
      fs.mkdirSync(target);
      res.writeHead(201).end();
      return;
    }

    case "PUT": {
      if (!fs.existsSync(path.dirname(target))) {
        res.writeHead(409).end();
        return;
      }
      const stream = fs.createWriteStream(target);
      req.pipe(stream);
      stream.on("finish", () => res.writeHead(exists ? 204 : 201).end());
      stream.on("error", (error) => res.writeHead(500).end(String(error.message)));
      return;
    }

    case "HEAD":
    case "GET": {
      if (!exists || fs.statSync(target).isDirectory()) {
        res.writeHead(exists ? 405 : 404).end();
        return;
      }
      res.writeHead(200, { "Content-Length": fs.statSync(target).size });
      if (req.method === "GET") {
        fs.createReadStream(target).pipe(res);
      } else {
        res.end();
      }
      return;
    }

    case "DELETE": {
      if (!exists) {
        res.writeHead(404).end();
        return;
      }
      fs.rmSync(target, { recursive: true });
      res.writeHead(204).end();
      return;
    }

    default:
      res.writeHead(405).end();
  }
}

function propEntry(urlPath, filePath) {
  const stat = fs.statSync(filePath);
  const isDir = stat.isDirectory();
  const href = urlPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return (
    `<D:response><D:href>${href || "/"}${isDir && href ? "/" : ""}</D:href>` +
    `<D:propstat><D:prop>` +
    `<D:resourcetype>${isDir ? "<D:collection/>" : ""}</D:resourcetype>` +
    (isDir ? "" : `<D:getcontentlength>${stat.size}</D:getcontentlength>`) +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  );
}

appServer.listen(APP_PORT, APP_HOST, () => {
  console.log(`Web app:       http://localhost:${APP_PORT}`);
  const addresses = lanAddresses();
  if (addresses.length > 0) {
    for (const address of addresses) {
      console.log(`Open on iPhone: http://${address}:${APP_PORT}`);
    }
  } else {
    console.log(`Open on iPhone: http://<this-computer's-IP>:${APP_PORT}`);
  }
});
davServer.listen(DAV_PORT, APP_HOST, () => {
  console.log(`WebDAV server: http://localhost:${DAV_PORT}  (user: ${DAV_USER}, pass: ${DAV_PASS})`);
  console.log(`WebDAV files:  ${DAV_ROOT}`);
});
