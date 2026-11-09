import test from "node:test";
import assert from "node:assert/strict";
import { validateEvent } from "../code/backend/event-schema.js";

const sample = { eventId:"evt-1", eventName:"session_ended", occurredAt:"2026-11-09T02:00:00Z", attributes:{ confirmedActiveBucket:"60-119s", estimatedTime:false, outcome:"partial" } };

test("minimal allowlisted event is valid", () => {
  assert.equal(validateEvent(sample).eventName,"session_ended");
});

test("raw task text and uncontrolled payload fields are rejected", () => {
  assert.throws(()=>validateEvent({...sample,taskTitle:"private text"}),/FORBIDDEN_EVENT_FIELD/);
  assert.throws(()=>validateEvent({...sample,attributes:{title:"private text"}}),/FORBIDDEN_EVENT_FIELD/);
  assert.throws(()=>validateEvent({...sample,attributes:{outcome:"partial",arbitrary:"private"}}),/FORBIDDEN_EVENT_FIELD/);
});

test("unknown events and malformed attributes are rejected", () => {
  assert.throws(()=>validateEvent({...sample,eventName:"user_identified"}),/INVALID_EVENT_NAME/);
  assert.throws(()=>validateEvent({...sample,attributes:[]}),/INVALID_EVENT_ATTRIBUTES/);
  assert.throws(()=>validateEvent({...sample,eventId:""}),/INVALID_EVENT_ID/);
});

test("even an allowed attribute key cannot carry personal free text", () => {
  assert.throws(() => validateEvent({
    ...sample, attributes: { outcome: "private customer complaint" }
  }), /INVALID_EVENT_VALUE/);
  assert.throws(() => validateEvent({
    ...sample, attributes: { source: "contact alice@example.com" }
  }), /INVALID_EVENT_VALUE/);
  assert.throws(() => validateEvent({
    ...sample, attributes: { confirmedActiveBucket: "1 hour at home" }
  }), /INVALID_EVENT_VALUE/);
});
