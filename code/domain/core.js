/**
 * Start-First domain model. Pure, deterministic mutations on a draft state.
 * Every caller MUST persist these mutations atomically before acknowledging success.
 */
export const BLOCKERS = ["too_big", "unclear", "perfectionism", "low_energy", "distraction", "skipped"];
export const OUTCOMES = ["step_done", "partial", "not_started", "task_done"];
export const DURATIONS = [2, 5, 10];

export function emptyState() {
  return {
    schemaVersion: 1,
    revision: 0,
    tasks: [],
    steps: [],
    sessions: [],
    batches: [],
    activeTaskId: null,
    activeSessionId: null,
    appliedCommands: [],
    telemetryEnabled: false
  };
}

export function ensure(condition, code) {
  if (!condition) throw new Error(code);
}

export function characters(value) {
  return [...String(value)].length;
}

export function cleanText(value) {
  return String(value ?? "").trim();
}

export function validateTaskText(title, note = "") {
  const text = cleanText(title);
  ensure(characters(text) >= 1 && characters(text) <= 200, "INVALID_TITLE");
  ensure(characters(String(note)) <= 1000, "INVALID_NOTE");
  return text;
}

export function parseBulk(text) {
  const lines = String(text).split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  ensure(lines.length > 0 && lines.length <= 20, "INVALID_IMPORT_COUNT");
  lines.forEach(line => validateTaskText(line));
  return lines;
}

export function taskById(state, id) {
  const task = state.tasks.find(item => item.id === id);
  ensure(Boolean(task), "TASK_NOT_FOUND");
  return task;
}

export function stepById(state, id) {
  const step = state.steps.find(item => item.id === id);
  ensure(Boolean(step), "STEP_NOT_FOUND");
  return step;
}

export function sessionById(state, id) {
  const session = state.sessions.find(item => item.id === id);
  ensure(Boolean(session), "SESSION_NOT_FOUND");
  return session;
}

export function createTask(state, { id, title, note = "", now }) {
  ensure(id && !state.tasks.some(item => item.id === id), "DUPLICATE_ID");
  ensure(Number.isFinite(now), "INVALID_TIME");
  const task = {
    id, title: validateTaskText(title, note), note: String(note),
    status: "inbox", blocker: "skipped",
    currentStepId: null, createdAt: now, updatedAt: now
  };
  state.tasks.unshift(task);
  return task;
}

export function importTasks(state, { lines, ids, batchId, now }) {
  ensure(Array.isArray(lines) && lines.length > 0 && lines.length <= 20, "INVALID_IMPORT_COUNT");
  ensure(ids.length === lines.length && new Set(ids).size === ids.length, "INVALID_IMPORT_IDS");
  ensure(!state.batches.some(b => b.id === batchId), "DUPLICATE_BATCH");
  const made = lines.map((line, i) => createTask(state, { id: ids[i], title: line, now }));
  state.batches.push({ id: batchId, taskIds: made.map(x => x.id), createdAt: now });
  return made;
}

/** Edit task with an optimistic version guard; no silent cross-tab overwrite. */
export function editTask(state, taskId, { title, note, expectedUpdatedAt, now }) {
  const task = taskById(state, taskId);
  ensure(task.updatedAt === expectedUpdatedAt, "STALE_TASK_EDIT");
  ensure(task.status !== "archived" && task.status !== "done", "TASK_NOT_AVAILABLE");
  task.title = validateTaskText(title, note ?? task.note);
  if (note !== undefined) task.note = String(note);
  task.updatedAt = Math.max(now, task.updatedAt + 1);
  return task;
}

/** Undo a recent bulk import only if none of its tasks has begun a session. */
export function undoImport(state, batchId, now) {
  const batch = state.batches.find(item => item.id === batchId);
  ensure(Boolean(batch) && !batch.undoneAt, "BATCH_NOT_FOUND");
  const ids = new Set(batch.taskIds);
  ensure(!state.sessions.some(session => ids.has(session.taskId)), "BATCH_HAS_SESSIONS");
  ensure(!state.steps.some(step => ids.has(step.taskId)), "BATCH_HAS_STEPS");
  state.tasks = state.tasks.filter(task => !ids.has(task.id));
  if (state.activeTaskId && ids.has(state.activeTaskId)) state.activeTaskId = null;
  batch.undoneAt = now;
  return batch;
}

export function focusTask(state, taskId, now) {
  ensure(!state.activeSessionId, "SESSION_NEEDS_REVIEW");
  const selected = taskById(state, taskId);
  ensure(selected.status !== "done" && selected.status !== "archived", "TASK_NOT_AVAILABLE");
  for (const task of state.tasks) {
    if (task.status === "active" && task.id !== taskId) task.status = "inbox";
  }
  selected.status = "active";
  selected.updatedAt = now;
  state.activeTaskId = taskId;
  return selected;
}

export function setBlocker(state, taskId, blocker, now) {
  ensure(BLOCKERS.includes(blocker), "INVALID_BLOCKER");
  const task = taskById(state, taskId);
  ensure(task.status === "active", "TASK_NOT_ACTIVE");
  task.blocker = blocker;
  task.updatedAt = now;
  return task;
}

export function confirmStep(state, { id, taskId, text, source = "manual", templateId = null, now }) {
  const task = taskById(state, taskId);
  ensure(task.status === "active" && state.activeTaskId === taskId, "TASK_NOT_ACTIVE");
  ensure(!state.activeSessionId, "SESSION_NEEDS_REVIEW");
  const content = cleanText(text);
  ensure(characters(content) >= 1 && characters(content) <= 160, "INVALID_STEP");
  ensure(!state.steps.some(step => step.id === id), "DUPLICATE_ID");
  if (task.currentStepId) {
    const prior = stepById(state, task.currentStepId);
    if (prior.status === "ready") prior.status = "carried_forward";
  }
  const revision = state.steps.filter(step => step.taskId === taskId).length + 1;
  const step = { id, taskId, text: content, status: "ready", revision, source, templateId, confirmedAt: now };
  state.steps.push(step);
  task.currentStepId = id;
  task.updatedAt = now;
  return step;
}

export function startSession(state, { id, taskId, stepId, minutes, now }) {
  ensure(DURATIONS.includes(minutes), "INVALID_DURATION");
  ensure(!state.activeSessionId && !state.sessions.some(s => s.status === "running" || s.status === "paused" || (s.status === "ended" && s.outcomePending)), "SESSION_ALREADY_ACTIVE");
  ensure(!state.sessions.some(s => s.id === id), "DUPLICATE_ID");
  const task = taskById(state, taskId);
  const step = stepById(state, stepId);
  ensure(task.status === "active" && state.activeTaskId === taskId, "TASK_NOT_ACTIVE");
  ensure(step.taskId === taskId && task.currentStepId === stepId, "WRONG_STEP");
  ensure(step.status === "ready" || step.status === "attempted", "STEP_NOT_READY");
  const session = {
    id, taskId, stepId, status: "running", targetMs: minutes * 60_000,
    activeMs: 0, startedAt: now, endedAt: null,
    outcome: null, outcomePending: false, interrupted: false
  };
  state.sessions.push(session);
  state.activeSessionId = id;
  return session;
}

function addActiveMs(session, delta) {
  ensure(Number.isFinite(delta) && delta >= 0 && delta <= 86_400_000, "INVALID_ELAPSED");
  session.activeMs += Math.round(delta);
}

export function checkpointSession(state, id, delta) {
  const session = sessionById(state, id);
  ensure(session.status === "running", "SESSION_NOT_RUNNING");
  addActiveMs(session, delta);
  return session;
}

export function pauseSession(state, id, delta) {
  const session = checkpointSession(state, id, delta);
  session.status = "paused";
  return session;
}

export function resumeSession(state, id) {
  const session = sessionById(state, id);
  ensure(session.status === "paused", "SESSION_NOT_PAUSED");
  session.status = "running";
  session.interrupted = false;
  return session;
}

export function interruptSession(state, id) {
  const session = sessionById(state, id);
  if (session.status === "running") {
    session.status = "paused";
    session.interrupted = true;
  }
  return session;
}

export function endSession(state, id, delta, now) {
  const session = sessionById(state, id);
  ensure(session.status === "running" || session.status === "paused", "SESSION_NOT_OPEN");
  if (session.status === "running") addActiveMs(session, delta);
  session.status = "ended";
  session.endedAt = now;
  session.outcomePending = true;
  return session;
}

export function recordOutcome(state, id, outcome, now) {
  ensure(OUTCOMES.includes(outcome), "INVALID_OUTCOME");
  const session = sessionById(state, id);
  ensure(session.status === "ended", "SESSION_NOT_ENDED");
  const step = stepById(state, session.stepId);
  const task = taskById(state, session.taskId);
  session.outcome = outcome;
  session.outcomePending = false;
  session.outcomeRecordedAt = now;
  if (outcome === "step_done" || outcome === "task_done") step.status = "completed";
  else if (step.status !== "completed") step.status = "attempted";
  if (outcome === "task_done") {
    task.status = "done";
    if (state.activeTaskId === task.id) state.activeTaskId = null;
  }
  if (state.activeSessionId === id) state.activeSessionId = null;
  return session;
}

export function archiveTask(state, taskId, now) {
  ensure(!state.activeSessionId, "SESSION_NEEDS_REVIEW");
  const task = taskById(state, taskId);
  task.status = "archived";
  task.updatedAt = now;
  if (state.activeTaskId === taskId) state.activeTaskId = null;
  return task;
}
