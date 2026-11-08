/* ------------------------------------------------------------------
   NOCTURNE / local server
   - serves the static dashboard
   - proxies DeepSeek balance requests so the browser never needs CORS
   No dependencies. Bind to localhost by default.
------------------------------------------------------------------- */

import http from "node:http";
import path from "node:path";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 4173;
const DEFAULT_HOST = "127.0.0.1";
const UPSTREAM_BALANCE_URL =
  process.env.DEEPSEEK_BALANCE_URL || "https://api.deepseek.com/user/balance";

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
});

const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' https://api.open-meteo.com",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "),
});

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

async function proxyBalance(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    sendJson(response, 405, { error: { message: "Method not allowed" } });
    return;
  }

  const authorization = request.headers.authorization || "";
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match || match[1].length < 8 || match[1].length > 512) {
    sendJson(response, 401, {
      error: { message: "A valid DeepSeek API key is required." },
    });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const upstream = await fetch(UPSTREAM_BALANCE_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${match[1]}`,
      },
      signal: controller.signal,
    });

    const text = await upstream.text();
    const payload = text.slice(0, 64_000);
    response.writeHead(upstream.status, {
      ...SECURITY_HEADERS,
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(payload),
    });
    response.end(payload);
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    sendJson(response, timedOut ? 504 : 502, {
      error: {
        message: timedOut
          ? "DeepSeek request timed out."
          : "DeepSeek is currently unreachable.",
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function serveStatic(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendJson(response, 405, { error: { message: "Method not allowed" } });
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: { message: "Bad request" } });
    return;
  }

  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const filePath = path.resolve(ROOT, relative);
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) {
    sendJson(response, 403, { error: { message: "Forbidden" } });
    return;
  }

  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    sendJson(response, 404, { error: { message: "Not found" } });
    return;
  }

  if (!fileStats.isFile()) {
    sendJson(response, 404, { error: { message: "Not found" } });
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[extension] || "application/octet-stream";
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": contentType,
    "Content-Length": fileStats.size,
    "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=0, must-revalidate",
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on("error", () => {
    if (!response.headersSent) {
      sendJson(response, 500, { error: { message: "Unable to read file" } });
    } else {
      response.destroy();
    }
  });
  stream.pipe(response);
}

export function createServer() {
  return http.createServer(async (request, response) => {
    let url;
    try {
      url = new URL(request.url || "/", "http://localhost");
    } catch {
      sendJson(response, 400, { error: { message: "Bad request" } });
      return;
    }

    if (url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, service: "nocturne", uptime: process.uptime() });
      return;
    }

    if (url.pathname === "/api/deepseek/balance") {
      await proxyBalance(request, response);
      return;
    }

    await serveStatic(request, response, url.pathname);
  });
}

export function startServer({ port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const url = `http://${host}:${address.port}`;
      resolve({ server, url, port: address.port });
    });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const host = process.env.HOST || DEFAULT_HOST;
  startServer({ port, host })
    .then(({ url }) => {
      console.log(`\n  NOCTURNE ready at ${url}\n`);
    })
    .catch((error) => {
      console.error("Unable to start NOCTURNE:", error.message);
      process.exitCode = 1;
    });
}
