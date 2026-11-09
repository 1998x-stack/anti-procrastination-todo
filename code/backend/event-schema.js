/**
 * Opt-in research event schema shared with the LOCAL-ONLY reference HTTP API.
 * The user-facing MVP never calls this API; no deployed collection exists.
 */
export const EVENT_FIELDS = Object.freeze({
  task_created: ["channel", "difficultFlag"],
  blocker_selected: ["blocker"],
  blocker_skipped: ["sourcePage"],
  step_suggested: ["templateId", "templateVersion"],
  step_confirmed: ["source", "editedFlag"],
  session_started: ["durationBucket", "source"],
  session_paused: ["activeMsBucket"],
  session_resumed: ["activeMsBucket"],
  session_ended: ["confirmedActiveBucket", "estimatedTime", "outcome"],
  outcome_recorded: ["outcome", "retryPlanFlag"],
  retry_started: ["priorOutcome"],
  export_requested: ["exportEntityCountsBucket"],
  local_data_deleted: ["deletedBucket"]
});

const RESTRICTED = /(?:title|note|text|email|name|url|stack|location|address)/i;

// Names alone are insufficient: an allowed string field must not carry raw task text.
const VALID = {
  channel: ["manual", "batch"],
  difficultFlag: [true, false],
  blocker: ["too_big", "unclear", "perfectionism", "low_energy", "distraction", "skipped"],
  sourcePage: ["capture", "focus", "inbox"],
  source: ["template", "manual"],
  editedFlag: [true, false],
  durationBucket: ["2m", "5m", "10m"],
  activeMsBucket: ["0-59s", "60-119s", "120-299s", "300-599s", "600+s"],
  confirmedActiveBucket: ["0-59s", "60-119s", "120-299s", "300-599s", "600+s"],
  outcome: ["step_done", "partial", "not_started", "task_done"],
  priorOutcome: ["step_done", "partial", "not_started", "task_done"],
  retryPlanFlag: [true, false],
  estimatedTime: [true, false],
  exportEntityCountsBucket: ["0", "1-9", "10-99", "100+"],
  deletedBucket: ["0", "1-9", "10-99", "100+"]
};
function validValue(key, value) {
  if (Object.hasOwn(VALID, key)) return VALID[key].includes(value);
  if (key === "templateId") return typeof value === "string" && /^[a-z_]+:[a-z]+:\d{1,3}$/.test(value);
  if (key === "templateVersion") return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
  return false;
}

export function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("INVALID_EVENT");
  const allowed = Object.hasOwn(EVENT_FIELDS, event.eventName) ? EVENT_FIELDS[event.eventName] : null;
  if (!Array.isArray(allowed)) throw new Error("INVALID_EVENT_NAME");
  if (typeof event.eventId !== "string" || event.eventId.length > 80 || !event.eventId) throw new Error("INVALID_EVENT_ID");
  const props = event.attributes === undefined ? {} : event.attributes;
  if (!props || typeof props !== "object" || Array.isArray(props)) throw new Error("INVALID_EVENT_ATTRIBUTES");
  for (const [key, value] of Object.entries(props)) {
    if (!allowed.includes(key) || RESTRICTED.test(key)) throw new Error("FORBIDDEN_EVENT_FIELD");
    if (typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string") throw new Error("INVALID_EVENT_VALUE");
    if (typeof value === "string" && value.length > 80) throw new Error("INVALID_EVENT_VALUE");
    if (!validValue(key, value)) throw new Error("INVALID_EVENT_VALUE");
  }
  const forbidden = Object.keys(event).filter(k => !["eventId", "eventName", "occurredAt", "attributes"].includes(k));
  if (forbidden.length) throw new Error("FORBIDDEN_EVENT_FIELD");
  if (typeof event.occurredAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(event.occurredAt) ||
      Number.isNaN(Date.parse(event.occurredAt))) throw new Error("INVALID_EVENT_TIME");
  return { ...event, attributes: { ...props } };
}
