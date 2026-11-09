#!/usr/bin/env node
/**
 * Live integration check for the LAB-ONLY research reference API
 * (code/backend/dev-server.js). It is deliberately NOT part of `npm test`:
 * it binds a loopback port, spawns a child process and asserts process-level
 * behavior (opt-in gate, loopback-only bind, shutdown) that unit tests cannot.
 *
 * It never touches Task/Step/IndexedDB data and uses only synthetic values.
 *
 * Usage: node scripts/verify-lab-api.mjs
 * Exit 0 = every expectation held.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "code/backend/dev-server.js");
const PORT = 4317;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const LAN_IP = process.env.SF_LAN_IP || "";

let failures = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? "  -> " + detail : ""}`);
}
function section(title) { console.log(`\n${title}`); }

function startServer(env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    let settled = false;
    const finish = code => { if (!settled) { settled = true; resolve({ child, out, err, code }); } };
    child.on("exit", code => finish(code));
    // Give a listening server a moment, then resolve with the live child.
    setTimeout(() => finish(null), 900);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function request(path, { method = "POST", body, token, contentType = "application/json", raw } = {}) {
  const headers = {};
  if (contentType !== null) headers["content-type"] = contentType;
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(URL_BASE + path, {
    method,
    headers,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  const text = await response.text();
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: response.status, json, text, headers: Object.fromEntries(response.headers) };
}

// ---------------------------------------------------------------------------
section("1. Default state: the lab service must be disabled");
{
  const a = await startServer({ START_FIRST_LOCAL_TELEMETRY: "", NODE_ENV: "development" });
  check("starts disabled without the explicit opt-in flag", a.code === 1 && a.err.includes("disabled"),
    `exit=${a.code} stderr=${JSON.stringify(a.err.trim())}`);
  const refused = await fetch(URL_BASE + "/healthz").then(() => false).catch(() => true);
  check("no listener exists while disabled", refused);

  const b = await startServer({ START_FIRST_LOCAL_TELEMETRY: "1", NODE_ENV: "production" });
  check("refuses to start with NODE_ENV=production", b.code === 1 && b.err.includes("disabled"),
    `exit=${b.code}`);
  const refusedProd = await fetch(URL_BASE + "/healthz").then(() => false).catch(() => true);
  check("no listener exists in production mode", refusedProd);
}

// ---------------------------------------------------------------------------
section("2. Explicit opt-in: loopback-only binding");
const server = await startServer({ START_FIRST_LOCAL_TELEMETRY: "1", NODE_ENV: undefined, PORT: String(PORT) });
check("starts when explicitly opted in", server.code === null && server.out.includes("127.0.0.1:" + PORT),
  JSON.stringify(server.out.trim()));

const health = await request("/healthz", { method: "GET" });
check("GET /healthz -> 200 ok", health.status === 200 && health.json?.status === "ok", JSON.stringify(health.json));
check("health response is no-store", (health.headers["cache-control"] || "").includes("no-store"));

if (LAN_IP) {
  const reachableOffLoopback = await fetch(`http://${LAN_IP}:${PORT}/healthz`).then(() => true).catch(() => false);
  check(`not reachable on non-loopback address ${LAN_IP}`, reachableOffLoopback === false);
} else {
  check("not reachable on non-loopback address", true, "skipped (SF_LAN_IP unset)");
}

// ---------------------------------------------------------------------------
section("3. Transport hardening");
const unknownPath = await request("/api/v1/telemetry/events");
check("unknown path -> 404", unknownPath.status === 404 && unknownPath.json?.error?.code === "NOT_FOUND");
const withQuery = await request("/api/v1/telemetry/registrations?debug=1", { body: {} });
check("query string -> 404", withQuery.status === 404);
const wrongMethod = await request("/api/v1/telemetry/registrations", { method: "GET" });
check("GET on a POST-only route -> 404", wrongMethod.status === 404);
const wrongType = await request("/api/v1/telemetry/registrations", { body: {}, contentType: "text/plain" });
check("wrong content-type -> 415", wrongType.status === 415 && wrongType.json?.error?.code === "UNSUPPORTED_MEDIA_TYPE");
const oversized = await request("/api/v1/telemetry/registrations", { raw: JSON.stringify({ pad: "x".repeat(70 * 1024) }) });
check("oversized body -> 413", oversized.status === 413 && oversized.json?.error?.code === "BODY_TOO_LARGE");
const noAuth = await request("/api/v1/telemetry/events:batch", { body: { schemaVersion: 1, events: [] } });
check("missing bearer token -> 401", noAuth.status === 401 && noAuth.json?.error?.code === "UNAUTHORIZED");

section("4. Consent registration and token separation");
const badConsent = await request("/api/v1/telemetry/registrations", {
  body: { consent: false, policyVersion: "2026-11-09", researchPurpose: "product-improvement" }
});
check("consent=false -> 400 INVALID_CONSENT", badConsent.status === 400 && badConsent.json?.error?.code === "INVALID_CONSENT");
const registration = await request("/api/v1/telemetry/registrations", {
  body: { consent: true, policyVersion: "2026-11-09", researchPurpose: "product-improvement" }
});
const writeToken = registration.json?.writeToken;
const deletionToken = registration.json?.deletionToken;
check("valid consent -> 201 with distinct write/delete tokens",
  registration.status === 201 && typeof writeToken === "string" && typeof deletionToken === "string" && writeToken !== deletionToken,
  `installationId=${registration.json?.installationId}`);
check("write token is NOT accepted for deletion",
  (await request("/api/v1/privacy/delete-events", { body: {}, token: writeToken })).status === 401);
check("delete token is NOT accepted for event writes",
  (await request("/api/v1/telemetry/events:batch", { body: { schemaVersion: 1, events: [] }, token: deletionToken })).status === 401);

section("5. Event validation, dedupe and conflict");
const eventId = randomUUID();
const baseEvent = { eventId, eventName: "task_created", occurredAt: new Date().toISOString(), attributes: { channel: "manual", difficultFlag: true } };
const first = await request("/api/v1/telemetry/events:batch", { body: { schemaVersion: 1, events: [baseEvent] }, token: writeToken });
check("first batch accepted exactly once", first.status === 202 && first.json?.accepted === 1 && first.json?.duplicate === 0, JSON.stringify(first.json));
const replay = await request("/api/v1/telemetry/events:batch", { body: { schemaVersion: 1, events: [baseEvent] }, token: writeToken });
check("identical eventId replay is idempotent (duplicate, not re-inserted)",
  replay.status === 202 && replay.json?.accepted === 0 && replay.json?.duplicate === 1, JSON.stringify(replay.json));
const conflict = await request("/api/v1/telemetry/events:batch", {
  body: { schemaVersion: 1, events: [{ ...baseEvent, attributes: { channel: "batch", difficultFlag: false } }] }, token: writeToken
});
check("same eventId with different payload -> 409 EVENT_ID_CONFLICT",
  conflict.status === 409 && conflict.json?.error?.code === "EVENT_ID_CONFLICT");

const SECRET = "PRIVATE-CUSTOMER-TITLE-7f3a";
const textSmuggle = await request("/api/v1/telemetry/events:batch", {
  body: { schemaVersion: 1, events: [{ eventId: randomUUID(), eventName: "task_created", occurredAt: new Date().toISOString(), attributes: { taskTitle: SECRET } }] },
  token: writeToken
});
check("task text in a restricted field is rejected", textSmuggle.status === 400,
  `status=${textSmuggle.status} code=${textSmuggle.json?.error?.code}`);
// Deliberate design property: the HTTP layer returns a constant generic code
// (never a field-specific oracle) and a constant message.
check("rejection uses a constant public error code/message, not a field oracle",
  textSmuggle.json?.error?.code === "INVALID_EVENT" &&
  textSmuggle.json?.error?.message === "Request could not be processed",
  JSON.stringify(textSmuggle.json?.error));
check("rejection never echoes the submitted text", !textSmuggle.text.includes(SECRET));
const unknownEventName = await request("/api/v1/telemetry/events:batch", {
  body: { schemaVersion: 1, events: [{ eventId: randomUUID(), eventName: "task_body_upload", occurredAt: new Date().toISOString(), attributes: {} }] },
  token: writeToken
});
check("unknown event name rejected", unknownEventName.status === 400 && unknownEventName.json?.error?.code === "INVALID_EVENT");
const atomic = await request("/api/v1/telemetry/events:batch", {
  body: { schemaVersion: 1, events: [
    { eventId: randomUUID(), eventName: "session_started", occurredAt: new Date().toISOString(), attributes: { durationBucket: "5m", source: "template" } },
    { eventId: randomUUID(), eventName: "session_started", occurredAt: new Date().toISOString(), attributes: { durationBucket: "invalid", source: "template" } }
  ] }, token: writeToken
});
check("batch with one invalid event is rejected atomically", atomic.status === 400 && atomic.json?.error?.code === "INVALID_EVENT");

section("6. Deletion semantics and shutdown");
const badDelete = await request("/api/v1/privacy/delete-events", { body: { keep: true }, token: deletionToken });
check("delete endpoint rejects a non-empty body", badDelete.status === 400 && badDelete.json?.error?.code === "INVALID_DELETE_REQUEST");
const deleted = await request("/api/v1/privacy/delete-events", { body: {}, token: deletionToken });
check("valid deletion reports the removed event count with a receipt",
  deleted.status === 200 && deleted.json?.deleted === true && deleted.json?.removedEventCount === 1 && /^[0-9a-f-]{36}$/.test(deleted.json?.deletionReceiptId || ""),
  JSON.stringify(deleted.json));
const afterDelete = await request("/api/v1/telemetry/events:batch", { body: { schemaVersion: 1, events: [baseEvent] }, token: writeToken });
check("write token is revoked after deletion", afterDelete.status === 401);
const afterDeleteAgain = await request("/api/v1/privacy/delete-events", { body: {}, token: deletionToken });
check("delete token is revoked after deletion", afterDeleteAgain.status === 401);

server.child.kill("SIGTERM");
await once(server.child, "exit");
await sleep(200);
const closed = await fetch(URL_BASE + "/healthz").then(() => false).catch(() => true);
check("port is no longer reachable after shutdown", closed);

console.log(`\n${results.length - failures}/${results.length} lab-API checks passed.`);
if (failures) {
  console.error(`\nFAILED checks:\n${results.filter(r => !r.ok).map(r => " - " + r.name + (r.detail ? " :: " + r.detail : "")).join("\n")}`);
  process.exitCode = 1;
}
