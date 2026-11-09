import test from "node:test";
import assert from "node:assert/strict";
import { validateSnapshot } from "../code/persistence/invariants.js";
import { MemoryStateStore } from "../code/persistence/store.js";
import { emptyState, createTask, focusTask, confirmStep, startSession } from "../code/domain/core.js";

const makeStarted = () => {
  const s=emptyState();
  createTask(s,{id:"task",title:"写报告",now:10});
  focusTask(s,"task",11);
  confirmStep(s,{id:"step",taskId:"task",text:"写一个标题",now:12});
  startSession(s,{id:"session",taskId:"task",stepId:"step",minutes:5,now:13});
  return s;
};
test("snapshot contract accepts all domain-produced valid states", () => {
  assert.equal(validateSnapshot(emptyState()).schemaVersion,1);
  assert.equal(validateSnapshot(makeStarted()).activeSessionId,"session");
});
test("snapshot rejects old versions instead of silently overwriting", async () => {
  const repo=new MemoryStateStore();
  repo.state = { ...emptyState(), schemaVersion: 99 };
  await assert.rejects(repo.read(),/UNSUPPORTED_SCHEMA/);
  await assert.rejects(repo.transact(s => createTask(s,{id:"task",title:"写报告",now:1}),"x"),/UNSUPPORTED_SCHEMA/);
  assert.equal(repo.state.schemaVersion,99);
});
test("snapshot fails on duplicate active tasks", () => {
  const s=makeStarted();
  s.tasks.push({ ...s.tasks[0],id:"other",status:"active" });
  assert.throws(() => validateSnapshot(s), /MULTIPLE_ACTIVE_TASKS/);
});
test("snapshot rejects dangling step and session references", () => {
  const s=makeStarted();
  s.sessions[0].stepId = "missing";
  assert.throws(() => validateSnapshot(s), /MISMATCH_SESSION_STEP/);
});
test("snapshot rejects contradictory active-session pointer", () => {
  const s=makeStarted();
  s.activeSessionId=null;
  assert.throws(() => validateSnapshot(s), /ORPHAN_OPEN_SESSION/);
});
test("snapshot rejects negative accumulated activity", () => {
  const s=makeStarted();
  s.sessions[0].activeMs=-100;
  assert.throws(() => validateSnapshot(s), /INVALID_ACTIVE_TIME/);
});
test("repository rejects async transactions and preserves prior state", async () => {
  const repo=new MemoryStateStore();
  await assert.rejects(repo.transact(async s => { s.tasks.push("will not persist"); },"async"),/ASYNC_MUTATION_NOT_ALLOWED/);
  const s=await repo.read();
  assert.equal(s.revision,0);
  assert.equal(s.tasks.length,0);
});
test("repository does not acknowledge a snapshot that fails its invariants", async () => {
  const repo=new MemoryStateStore();
  await assert.rejects(repo.transact(s => { s.activeTaskId="ghost"; },"bad"),/MISMATCH_ACTIVE_TASK|ORPHAN_ACTIVE_TASK/);
  assert.equal((await repo.read()).revision,0);
});
