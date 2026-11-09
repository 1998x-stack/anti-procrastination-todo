import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStateStore, createExport } from "../code/persistence/store.js";
import { createTask, focusTask, confirmStep, startSession } from "../code/domain/core.js";

test("atomic in-memory repository only commits valid mutations", async () => {
  const repo = new MemoryStateStore();
  const a = await repo.transact(s => { createTask(s,{id:"t1",title:"写报告",now:1}); }, "command-1");
  assert.equal(a.tasks.length, 1);
  assert.equal(a.revision, 1);
  await assert.rejects(repo.transact(s => { createTask(s,{id:"t2",title:"   ",now:2}); }, "bad"), /INVALID_TITLE/);
  const b = await repo.read();
  assert.equal(b.tasks.length, 1);
  assert.equal(b.revision, 1);
});

test("command idempotence avoids repeat task/session creation", async () => {
  const repo = new MemoryStateStore();
  await repo.transact(s => createTask(s,{id:"t1",title:"写报告",now:1}), "create");
  await repo.transact(s => createTask(s,{id:"t1",title:"写报告",now:1}), "create");
  await repo.transact(s => focusTask(s,"t1",2), "focus");
  await repo.transact(s => confirmStep(s,{id:"st1",taskId:"t1",text:"先写标题",now:3}), "step");
  await repo.transact(s => startSession(s,{id:"se1",taskId:"t1",stepId:"st1",minutes:5,now:4}), "session");
  await repo.transact(s => startSession(s,{id:"se1",taskId:"t1",stepId:"st1",minutes:5,now:4}), "session");
  const latest = await repo.read();
  assert.equal(latest.sessions.length, 1);
  assert.equal(latest.revision, 4);
});

test("export is complete but excludes telemetry and command ids", async () => {
  const repo = new MemoryStateStore();
  await repo.transact(s => createTask(s,{id:"t1",title:"private task",now:1}), "one");
  const json = createExport(await repo.read());
  const body = JSON.parse(json);
  assert.equal(body.tasks[0].title,"private task");
  assert.equal(body.sessions.length,0);
  assert.equal(body.schemaVersion,1);
  assert.equal(body.appliedCommands,undefined);
  assert.equal(body.telemetryEnabled,undefined);
});

test("deleteAll resets data without a cloud call", async () => {
  const repo = new MemoryStateStore();
  await repo.transact(s => createTask(s,{id:"t1",title:"task",now:1}), "one");
  await repo.deleteAll("wipe");
  assert.equal((await repo.read()).tasks.length,0);
});
