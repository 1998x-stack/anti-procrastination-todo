/**
 * A NON-PRODUCTION, in-memory research telemetry reference service.
 *
 * No task titles, task notes, Step texts, URLs, cookies or IP addresses are
 * accepted or stored. The actual MVP browser NEVER calls this service.
 * Replace the adapter with reviewed durable storage before any real deployment.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { validateEvent } from "./event-schema.js";

export const RESEARCH_POLICY_VERSION = "2026-11-09";
export const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TelemetryError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
function invalid(status, code) { throw new TelemetryError(status, code); }
function digest(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
function secret() { return randomBytes(32).toString("base64url"); }
function keysEqual(obj, allowed) {
  return obj !== null && typeof obj === "object" && !Array.isArray(obj) &&
    Object.keys(obj).every(key => allowed.includes(key));
}
function canonicalEvent(event) {
  return JSON.stringify({
    eventId: event.eventId,
    eventName: event.eventName,
    occurredAt: new Date(event.occurredAt).toISOString(),
    attributes: Object.fromEntries(Object.entries(event.attributes).sort(([a], [b]) => a.localeCompare(b)))
  });
}

export class MemoryTelemetryStore {
  constructor({
    clock = () => Date.now(),
    maxInstallations = 1000,
    maxEventsPerInstallation = 10000,
    retentionMs = EVENT_RETENTION_MS
  } = {}) {
    this.clock = clock;
    this.maxInstallations = maxInstallations;
    this.maxEventsPerInstallation = maxEventsPerInstallation;
    this.retentionMs = retentionMs;
    this.installations = new Map();
    this.writeIndex = new Map();
    this.deleteIndex = new Map();
    this.events = new Map();
  }

  /** Request claims consent, but a server cannot cryptographically prove the UI interaction. */
  register(request) {
    if (!keysEqual(request, ["consent", "policyVersion", "researchPurpose"]) ||
        request.consent !== true ||
        request.policyVersion !== RESEARCH_POLICY_VERSION ||
        request.researchPurpose !== "product-improvement") {
      invalid(400, "INVALID_CONSENT");
    }
    this.prune();
    if (this.installations.size >= this.maxInstallations) {
      invalid(429, "REGISTRATION_LIMIT");
    }
    const installationId = randomUUID();
    const writeToken = secret();
    const deletionToken = secret();
    const writeHash = digest(writeToken);
    const deleteHash = digest(deletionToken);
    const row = {
      installationId, policyVersion: RESEARCH_POLICY_VERSION,
      writeHash, deleteHash, createdAt: this.clock(), lastActivityAt: this.clock()
    };
    this.installations.set(installationId, row);
    this.writeIndex.set(writeHash, installationId);
    this.deleteIndex.set(deleteHash, installationId);
    this.events.set(installationId, new Map());
    return { installationId, writeToken, deletionToken, policyVersion: RESEARCH_POLICY_VERSION };
  }

  _authorize(token, kind) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      invalid(401, "UNAUTHORIZED");
    }
    const hash = digest(token);
    const id = (kind === "write" ? this.writeIndex : this.deleteIndex).get(hash);
    const row = id && this.installations.get(id);
    if (!row || (kind === "write" ? row.writeHash : row.deleteHash) !== hash) {
      invalid(401, "UNAUTHORIZED");
    }
    return row;
  }

  recordEvents(token, batch) {
    const row = this._authorize(token, "write");
    this.prune();
    if (!keysEqual(batch, ["schemaVersion", "events"]) ||
        batch.schemaVersion !== 1 ||
        !Array.isArray(batch.events) ||
        batch.events.length < 1 || batch.events.length > 30) {
      invalid(400, "INVALID_BATCH");
    }
    const now = this.clock();
    const existing = this.events.get(row.installationId);
    if (!existing) invalid(401, "UNAUTHORIZED");
    const incoming = new Map();
    let duplicate = 0;
    let toInsert = 0;

    // Validate and detect every collision before a single write (all-or-nothing).
    for (const raw of batch.events) {
      let event;
      try { event = validateEvent(raw); }
      catch { invalid(400, "INVALID_EVENT"); }
      if (!UUID.test(event.eventId)) invalid(400, "INVALID_EVENT_ID");
      const time = Date.parse(event.occurredAt);
      if (time > now + FUTURE_SKEW_MS || time < now - this.retentionMs) {
        invalid(400, "INVALID_EVENT_TIME");
      }
      const value = canonicalEvent(event);
      const prior = incoming.get(event.eventId) ?? existing.get(event.eventId)?.canonical;
      if (prior !== undefined) {
        if (prior !== value) invalid(409, "EVENT_ID_CONFLICT");
        duplicate++;
      } else {
        incoming.set(event.eventId, value);
        toInsert++;
      }
    }
    if (existing.size + toInsert > this.maxEventsPerInstallation) {
      invalid(429, "EVENT_LIMIT");
    }
    for (const [eventId, canonical] of incoming) {
      const event = JSON.parse(canonical);
      existing.set(eventId, { canonical, event, receivedAt: now });
    }
    row.lastActivityAt = now;
    return { accepted: toInsert, duplicate, rejected: 0 };
  }

  deleteEvents(token) {
    const row = this._authorize(token, "delete");
    const removed = this.events.get(row.installationId)?.size ?? 0;
    this.events.delete(row.installationId);
    this.installations.delete(row.installationId);
    this.writeIndex.delete(row.writeHash);
    this.deleteIndex.delete(row.deleteHash);
    return { deleted: true, removedEventCount: removed, deletionReceiptId: randomUUID() };
  }

  /** Proactive expiry for reference adapter; production needs durable scheduled TTL. */
  prune() {
    const now = this.clock();
    for (const [id, events] of this.events) {
      for (const [eventId, record] of events) {
        if (now - record.receivedAt >= this.retentionMs) events.delete(eventId);
      }
      const row = this.installations.get(id);
      if (row && now - row.lastActivityAt >= this.retentionMs) {
        this.events.delete(id);
        this.installations.delete(id);
        this.writeIndex.delete(row.writeHash);
        this.deleteIndex.delete(row.deleteHash);
      }
    }
  }

  /** Test-only aggregate; must not become a public per-installation endpoint. */
  testCounts() {
    return {
      installations: this.installations.size,
      events: [...this.events.values()].reduce((n, events) => n + events.size, 0)
    };
  }
}
