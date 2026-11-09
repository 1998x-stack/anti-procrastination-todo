/**
 * Proposal-only allowlisted opt-in research events. No network client/server is
 * included in this MVP; this schema is for an explicitly consented future API.
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

export function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("INVALID_EVENT");
  const allowed = EVENT_FIELDS[event.eventName];
  if (!allowed) throw new Error("INVALID_EVENT_NAME");
  if (typeof event.eventId !== "string" || event.eventId.length > 80 || !event.eventId) throw new Error("INVALID_EVENT_ID");
  const props = event.attributes || {};
  if (typeof props !== "object" || Array.isArray(props)) throw new Error("INVALID_EVENT_ATTRIBUTES");
  for (const [key, value] of Object.entries(props)) {
    if (!allowed.includes(key) || RESTRICTED.test(key)) throw new Error("FORBIDDEN_EVENT_FIELD");
    if (typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string") throw new Error("INVALID_EVENT_VALUE");
    if (typeof value === "string" && value.length > 80) throw new Error("INVALID_EVENT_VALUE");
  }
  const forbidden = Object.keys(event).filter(k => !["eventId", "eventName", "occurredAt", "attributes"].includes(k));
  if (forbidden.length) throw new Error("FORBIDDEN_EVENT_FIELD");
  if (Number.isNaN(Date.parse(event.occurredAt))) throw new Error("INVALID_EVENT_TIME");
  return { ...event, attributes: { ...props } };
}
