/**
 * Minimal HTTP transport for the explicitly optional research service.
 * Never mounted by index.html; never imports or reads browser Task data.
 */
import { createServer } from "node:http";
import { MemoryTelemetryStore, TelemetryError } from "./telemetry-service.js";

const LIMIT = 64 * 1024;
function headers() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'"
  };
}
function json(res, status, payload) {
  res.writeHead(status, headers());
  res.end(JSON.stringify(payload));
}
function tokenFromHeader(value) {
  const matches = typeof value === "string" ? /^Bearer ([A-Za-z0-9_-]+)$/.exec(value) : null;
  if (!matches) throw new TelemetryError(401, "UNAUTHORIZED");
  return matches[1];
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let length = 0, ended = false;
    const parts = [];
    req.on("data", part => {
      if (ended) return;
      length += part.length;
      if (length > limit) {
        ended = true;
        parts.length = 0;
        req.resume();  // discard remaining bytes without buffering
        reject(new TelemetryError(413, "BODY_TOO_LARGE"));
      } else parts.push(part);
    });
    req.on("end", () => {
      if (ended) return;
      ended = true;
      try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8"))); }
      catch { reject(new TelemetryError(400, "INVALID_JSON")); }
    });
    req.on("error", () => {
      if (!ended) {
        ended = true;
        reject(new TelemetryError(400, "REQUEST_ABORTED"));
      }
    });
  });
}
function contentTypeOk(value) {
  return typeof value === "string" && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value);
}

export function createTelemetryServer({ store = new MemoryTelemetryStore(), maxBodyBytes = LIMIT } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://local.invalid");
      // Exact-path routing: no querystrings, no wildcard proxy, no cookies.
      if (url.search) throw new TelemetryError(404, "NOT_FOUND");
      if (req.method === "GET" && url.pathname === "/healthz") {
        json(res, 200, { status: "ok" });
        return;
      }
      const allowed = new Set([
        "/api/v1/telemetry/registrations",
        "/api/v1/telemetry/events:batch",
        "/api/v1/privacy/delete-events"
      ]);
      if (req.method !== "POST" || !allowed.has(url.pathname)) {
        throw new TelemetryError(404, "NOT_FOUND");
      }
      if (!contentTypeOk(req.headers["content-type"])) {
        throw new TelemetryError(415, "UNSUPPORTED_MEDIA_TYPE");
      }
      // No logging of headers, body, task content or secret tokens.
      const body = await readBody(req, maxBodyBytes);
      if (url.pathname === "/api/v1/telemetry/registrations") {
        json(res, 201, store.register(body));
      } else if (url.pathname === "/api/v1/telemetry/events:batch") {
        const token = tokenFromHeader(req.headers.authorization);
        json(res, 202, store.recordEvents(token, body));
      } else {
        const token = tokenFromHeader(req.headers.authorization);
        // Delete endpoint accepts precisely {} so callers cannot smuggle text.
        if (!body || Array.isArray(body) || Object.keys(body).length !== 0) {
          throw new TelemetryError(400, "INVALID_DELETE_REQUEST");
        }
        json(res, 200, store.deleteEvents(token));
      }
    } catch (error) {
      const known = error instanceof TelemetryError;
      const status = known ? error.status : 500;
      const code = known ? error.code : "INTERNAL_ERROR";
      // Constant public errors; never echo attacker-controlled field values.
      json(res, status, { error: { code, message: "Request could not be processed" } });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
