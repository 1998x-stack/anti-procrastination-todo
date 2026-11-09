/**
 * Validate persistent domain snapshots before a transaction is acknowledged.
 * An unsupported/corrupt schema must fail closed rather than silently reset.
 */
function assert(condition, code) {
  if (!condition) throw new Error(code);
}
function uniqueIds(rows, kind) {
  const ids = new Set();
  for (const row of rows) {
    assert(row && typeof row.id === "string" && row.id.length > 0, "INVALID_" + kind + "_ID");
    assert(!ids.has(row.id), "DUPLICATE_" + kind + "_ID");
    ids.add(row.id);
  }
}
export function validateSnapshot(s) {
  assert(s && typeof s === "object" && !Array.isArray(s), "INVALID_SNAPSHOT");
  assert(s.schemaVersion === 1, "UNSUPPORTED_SCHEMA");
  assert(Number.isSafeInteger(s.revision) && s.revision >= 0, "INVALID_REVISION");
  for (const key of ["tasks", "steps", "sessions", "batches", "appliedCommands"]) {
    assert(Array.isArray(s[key]), "INVALID_" + key.toUpperCase());
  }
  assert(s.appliedCommands.length <= 512, "COMMAND_HISTORY_LIMIT");
  assert(new Set(s.appliedCommands).size === s.appliedCommands.length, "DUPLICATE_COMMAND");
  assert(s.appliedCommands.every(id => typeof id === "string" && id.length > 0), "INVALID_COMMAND");
  uniqueIds(s.tasks, "TASK");
  uniqueIds(s.steps, "STEP");
  uniqueIds(s.sessions, "SESSION");
  const tasks = new Map(s.tasks.map(t => [t.id, t]));
  const steps = new Map(s.steps.map(t => [t.id, t]));
  const sessions = new Map(s.sessions.map(t => [t.id, t]));
  const activeTasks = s.tasks.filter(t => t.status === "active");
  assert(activeTasks.length <= 1, "MULTIPLE_ACTIVE_TASKS");
  if (s.activeTaskId === null) assert(activeTasks.length === 0, "ORPHAN_ACTIVE_TASK");
  else assert(activeTasks.length === 1 && activeTasks[0].id === s.activeTaskId, "MISMATCH_ACTIVE_TASK");
  for (const task of s.tasks) {
    assert(["inbox", "active", "done", "archived"].includes(task.status), "INVALID_TASK_STATUS");
    assert(typeof task.title === "string" && [...task.title].length >= 1 && [...task.title].length <= 200, "INVALID_TASK_TEXT");
    assert(typeof task.note === "string" && [...task.note].length <= 1000, "INVALID_TASK_NOTE");
    if (task.currentStepId !== null) {
      const step = steps.get(task.currentStepId);
      assert(step && step.taskId === task.id, "MISMATCH_TASK_STEP");
    }
  }
  for (const step of s.steps) {
    assert(tasks.has(step.taskId), "ORPHAN_STEP");
    assert(typeof step.text === "string" && [...step.text].length >= 1 && [...step.text].length <= 160, "INVALID_STEP_TEXT");
    assert(["ready", "attempted", "completed", "carried_forward"].includes(step.status), "INVALID_STEP_STATUS");
  }
  const open = s.sessions.filter(x => x.status === "running" || x.status === "paused" || x.outcomePending === true);
  assert(open.length <= 1, "MULTIPLE_OPEN_SESSIONS");
  if (s.activeSessionId === null) assert(open.length === 0, "ORPHAN_OPEN_SESSION");
  else assert(open.length === 1 && open[0].id === s.activeSessionId, "MISMATCH_ACTIVE_SESSION");
  for (const session of s.sessions) {
    assert(tasks.has(session.taskId), "ORPHAN_SESSION_TASK");
    assert(steps.has(session.stepId) && steps.get(session.stepId).taskId === session.taskId, "MISMATCH_SESSION_STEP");
    assert(["running", "paused", "ended"].includes(session.status), "INVALID_SESSION_STATUS");
    assert(Number.isFinite(session.activeMs) && session.activeMs >= 0, "INVALID_ACTIVE_TIME");
    assert(Number.isFinite(session.targetMs) && [120_000, 300_000, 600_000].includes(session.targetMs), "INVALID_TARGET_TIME");
    if (session.status === "ended" && session.outcomePending) {
      assert(session.outcome === null, "PENDING_OUTCOME_CONFLICT");
    }
  }
  return s;
}
