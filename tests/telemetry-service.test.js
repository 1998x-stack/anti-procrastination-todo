import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  MemoryTelemetryStore, TelemetryError, RESEARCH_POLICY_VERSION,
  EVENT_RETENTION_MS
} from "../code/backend/telemetry-service.js";
import { createTelemetryServer } from "../code/backend/server.js";

const EPOCH = Date.parse("2026-11-09T12:00:00.000Z");
function consent() {
  return { consent: true, policyVersion: RESEARCH_POLICY_VERSION, researchPurpose: "product-improvement" };
}
function sampleEvent(time = EPOCH) {
  return {
    eventId: randomUUID(),
    eventName: "session_ended",
    occurredAt: new Date(time).toISOString(),
    attributes: { confirmedActiveBucket: "60-119s", estimatedTime: false, outcome: "partial" }
  };
}
function newStore(overrides = {}) {
  return new MemoryTelemetryStore({ clock: () => EPOCH, ...overrides });
}
function batch(events) { return { schemaVersion: 1, events }; }
function throwsCode(fn, code, status) {
  assert.throws(fn, error => error instanceof TelemetryError && error.code === code && error.status === status);
}

test("registration requires exact explicit opt-in fields and known policy", () => {
  const store = newStore();
  throwsCode(() => store.register({ consent: false, policyVersion: RESEARCH_POLICY_VERSION, researchPurpose: "product-improvement" }), "INVALID_CONSENT", 400);
  throwsCode(() => store.register({ ...consent(), taskTitle: "private!" }), "INVALID_CONSENT", 400);
  throwsCode(() => store.register({ ...consent(), policyVersion: "old" }), "INVALID_CONSENT", 400);
  const registration = store.register(consent());
  assert.match(registration.installationId, /^[a-f0-9-]{36}$/i);
  assert.equal(registration.writeToken.length, 43);
  assert.equal(registration.deletionToken.length, 43);
  assert.notEqual(registration.writeToken, registration.deletionToken);
  assert.equal(JSON.stringify([...store.installations.values()]).includes(registration.writeToken), false);
  assert.equal(JSON.stringify([...store.installations.values()]).includes(registration.deletionToken), false);
});

test("strictly validated events are stored once across identical retries", () => {
  const store = newStore();
  const id = store.register(consent());
  const e1 = sampleEvent();
  assert.deepEqual(store.recordEvents(id.writeToken, batch([e1])), { accepted: 1, duplicate: 0, rejected: 0 });
  assert.deepEqual(store.recordEvents(id.writeToken, batch([e1])), { accepted: 0, duplicate: 1, rejected: 0 });
  assert.deepEqual(store.testCounts(), { installations: 1, events: 1 });
  assert.equal(JSON.stringify([...store.events.values()]).includes("private text"), false);
});

test("same eventId with different outcome is a conflict and does not change record", () => {
  const store = newStore();
  const id = store.register(consent());
  const event = sampleEvent();
  store.recordEvents(id.writeToken, batch([event]));
  throwsCode(() => store.recordEvents(id.writeToken, batch([{ ...event, attributes: { ...event.attributes, outcome: "task_done" } }])), "EVENT_ID_CONFLICT", 409);
  assert.equal(store.testCounts().events, 1);
});

test("all-or-nothing batch rejects free text, arbitrary keys and malformed timestamps", () => {
  const store = newStore();
  const id = store.register(consent());
  const good = sampleEvent();
  const bad = { ...sampleEvent(), attributes: { title: "Private health details" } };
  throwsCode(() => store.recordEvents(id.writeToken, batch([good, bad])), "INVALID_EVENT", 400);
  assert.equal(store.testCounts().events, 0);
  throwsCode(() => store.recordEvents(id.writeToken, batch([good, { ...sampleEvent(), occurredAt: "yesterday" }])), "INVALID_EVENT", 400);
  assert.equal(store.testCounts().events, 0);
  throwsCode(() => store.recordEvents(id.writeToken, batch([{ ...sampleEvent(), eventId: "not-a-uuid" }])), "INVALID_EVENT_ID", 400);
});

test("batch limits reject empty, too many or unknown shapes", () => {
  const store = newStore();
  const id = store.register(consent());
  throwsCode(() => store.recordEvents(id.writeToken, batch([])), "INVALID_BATCH", 400);
  throwsCode(() => store.recordEvents(id.writeToken, batch(Array.from({ length: 31 }, () => sampleEvent()))), "INVALID_BATCH", 400);
  throwsCode(() => store.recordEvents(id.writeToken, { ...batch([sampleEvent()]), title: "private" }), "INVALID_BATCH", 400);
});

test("future-skew and event retention windows are validated", () => {
  const store = newStore();
  const id = store.register(consent());
  throwsCode(() => store.recordEvents(id.writeToken, batch([sampleEvent(EPOCH + 10 * 60_000)])), "INVALID_EVENT_TIME", 400);
  throwsCode(() => store.recordEvents(id.writeToken, batch([sampleEvent(EPOCH - EVENT_RETENTION_MS - 1000)])), "INVALID_EVENT_TIME", 400);
  assert.equal(store.testCounts().events, 0);
});

test("separate write and deletion tokens prevent cross-purpose use", () => {
  const store = newStore();
  const a = store.register(consent());
  const b = store.register(consent());
  throwsCode(() => store.recordEvents(a.deletionToken, batch([sampleEvent()])), "UNAUTHORIZED", 401);
  throwsCode(() => store.deleteEvents(a.writeToken), "UNAUTHORIZED", 401);
  throwsCode(() => store.recordEvents("invalid", batch([sampleEvent()])), "UNAUTHORIZED", 401);
  store.recordEvents(b.writeToken, batch([sampleEvent()]));
  assert.equal(store.testCounts().events, 1);
  store.deleteEvents(a.deletionToken);
  assert.equal(store.testCounts().events, 1);
  assert.equal(store.testCounts().installations, 1);
});

test("deletion revokes tokens and prevents resurrecting prior events", () => {
  const store = newStore();
  const id = store.register(consent());
  store.recordEvents(id.writeToken, batch([sampleEvent(), sampleEvent()]));
  const result = store.deleteEvents(id.deletionToken);
  assert.equal(result.deleted, true);
  assert.equal(result.removedEventCount, 2);
  assert.equal(store.testCounts().events, 0);
  throwsCode(() => store.recordEvents(id.writeToken, batch([sampleEvent()])), "UNAUTHORIZED", 401);
  throwsCode(() => store.deleteEvents(id.deletionToken), "UNAUTHORIZED", 401);
});

test("capacity guards return explicit rate errors without partial insertions", () => {
  const store = newStore({ maxInstallations: 1, maxEventsPerInstallation: 1 });
  const id = store.register(consent());
  throwsCode(() => store.register(consent()), "REGISTRATION_LIMIT", 429);
  throwsCode(() => store.recordEvents(id.writeToken, batch([sampleEvent(), sampleEvent()])), "EVENT_LIMIT", 429);
  assert.equal(store.testCounts().events, 0);
});

test("retention pruning expires raw events and inactive installation credentials", () => {
  let clock = EPOCH;
  const store = newStore({ clock: () => clock });
  const id = store.register(consent());
  store.recordEvents(id.writeToken, batch([sampleEvent()]));
  clock += EVENT_RETENTION_MS + 1;
  store.prune();
  assert.deepEqual(store.testCounts(), { installations: 0, events: 0 });
  throwsCode(() => store.deleteEvents(id.deletionToken), "UNAUTHORIZED", 401);
});

test("HTTP adapter exposes only known routes, nosniff/no-store and no CORS wildcard", async t => {
  const store = newStore();
  const server = createTelemetryServer({ store });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const post = (path, body, token, contentType = "application/json") => fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": contentType, ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });

  const health = await fetch(base + "/healthz");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.equal(health.headers.get("access-control-allow-origin"), null);

  const nope = await post("/api/v1/telemetry/registrations", { ...consent(), taskNote: "SECRET" });
  assert.equal(nope.status, 400);
  const noBody = JSON.stringify(await nope.json());
  assert.equal(noBody.includes("SECRET"), false);

  const registrationResp = await post("/api/v1/telemetry/registrations", consent());
  assert.equal(registrationResp.status, 201);
  const id = await registrationResp.json();
  assert.ok(id.writeToken && id.deletionToken);

  const invalidAuth = await post("/api/v1/telemetry/events:batch", batch([sampleEvent()]));
  assert.equal(invalidAuth.status, 401);
  const created = await post("/api/v1/telemetry/events:batch", batch([sampleEvent()]), id.writeToken);
  assert.equal(created.status, 202);
  assert.equal((await created.json()).accepted, 1);

  const tooBig = await post("/api/v1/telemetry/events:batch", JSON.stringify({ blob: "Z".repeat(70000) }), id.writeToken);
  assert.equal(tooBig.status, 413);
  assert.equal((await post("/api/v1/telemetry/registrations", "{nope")).status, 400);
  assert.equal((await post("/api/v1/telemetry/registrations", consent(), undefined, "text/plain")).status, 415);
  assert.equal((await fetch(base + "/api/v1/admin/metrics")).status, 404);
  assert.equal((await post("/api/v1/privacy/delete-events", { taskTitle: "PRIVATE" }, id.deletionToken)).status, 400);

  const deletion = await post("/api/v1/privacy/delete-events", {}, id.deletionToken);
  assert.equal(deletion.status, 200);
  assert.equal((await deletion.json()).deleted, true);
  assert.equal(store.testCounts().events, 0);
  assert.equal((await post("/api/v1/telemetry/events:batch", batch([sampleEvent()]), id.writeToken)).status, 401);
});
