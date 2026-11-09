import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyState, createTask, importTasks, parseBulk, focusTask, setBlocker,
  confirmStep, startSession, pauseSession, resumeSession, checkpointSession,
  interruptSession, endSession, recordOutcome, archiveTask, editTask, undoImport
} from "../code/domain/core.js";

const base = () => {
  const state = emptyState();
  createTask(state, { id: "task1", title: "写报告", now: 100 });
  focusTask(state, "task1", 101);
  setBlocker(state, "task1", "too_big", 102);
  confirmStep(state, { id: "step1", taskId: "task1", text: "先写一个标题", source: "manual", now: 103 });
  return state;
};

test("empty state is local-first and anonymous by default", () => {
  const s = emptyState();
  assert.equal(s.telemetryEnabled, false);
  assert.equal(s.activeSessionId, null);
  assert.deepEqual(s.tasks, []);
});

test("task validation and bulk import preserve distinct duplicate titles", () => {
  const state = emptyState();
  assert.deepEqual(parseBulk(" 回邮件\n\n准备面试\n回邮件 "), ["回邮件", "准备面试", "回邮件"]);
  importTasks(state, { lines: ["回邮件", "回邮件"], ids: ["t1", "t2"], batchId: "batch1", now: 1 });
  assert.equal(state.tasks.length, 2);
  assert.notEqual(state.tasks[0].id, state.tasks[1].id);
  assert.throws(() => parseBulk("\n".repeat(3)), /INVALID_IMPORT_COUNT/);
  assert.throws(() => parseBulk(Array.from({length:21},()=> "事").join("\n")), /INVALID_IMPORT_COUNT/);
  assert.throws(() => createTask(state, { id:"bad", title:" ", now:2 }), /INVALID_TITLE/);
});

test("only one focused task; switching preserves steps", () => {
  const s = base();
  createTask(s, { id:"task2", title:"准备面试", now:105 });
  focusTask(s, "task2", 106);
  assert.equal(s.activeTaskId,"task2");
  assert.equal(s.tasks.find(x=>x.id==="task1").status,"inbox");
  assert.equal(s.steps[0].text,"先写一个标题");
});

test("confirmed step is immutable in history; next revision does not replace old step", () => {
  const s = base();
  confirmStep(s, { id:"step2", taskId:"task1", text:"先写三个小标题", now:105 });
  assert.equal(s.steps.length,2);
  assert.equal(s.steps.find(x=>x.id==="step1").status,"carried_forward");
  assert.equal(s.steps.find(x=>x.id==="step1").text,"先写一个标题");
  assert.equal(s.tasks[0].currentStepId,"step2");
});

test("session rejects duplicates and second concurrent start", () => {
  const s=base();
  startSession(s,{id:"session1",taskId:"task1",stepId:"step1",minutes:5,now:105});
  assert.throws(()=> startSession(s,{id:"session2",taskId:"task1",stepId:"step1",minutes:5,now:106}),/SESSION_ALREADY_ACTIVE/);
  assert.equal(s.sessions.length,1);
  assert.throws(()=> focusTask(s,"task1",107),/SESSION_NEEDS_REVIEW/);
});

test("paused time is not counted and ending needs explicit outcome", () => {
  const s=base();
  startSession(s,{id:"session1",taskId:"task1",stepId:"step1",minutes:2,now:200});
  checkpointSession(s,"session1",30_000);
  pauseSession(s,"session1",10_000);
  assert.equal(s.sessions[0].activeMs,40_000);
  resumeSession(s,"session1");
  endSession(s,"session1",22_000,300);
  assert.equal(s.sessions[0].activeMs,62_000);
  assert.equal(s.sessions[0].outcomePending,true);
  assert.equal(s.tasks[0].status,"active");
  assert.throws(()=> resumeSession(s,"session1"),/SESSION_NOT_PAUSED/);
});

test("interruption pauses instead of inventing background time", () => {
  const s=base();
  startSession(s,{id:"session1",taskId:"task1",stepId:"step1",minutes:5,now:200});
  checkpointSession(s,"session1",5_000);
  interruptSession(s,"session1");
  assert.equal(s.sessions[0].status,"paused");
  assert.equal(s.sessions[0].activeMs,5_000);
  assert.equal(s.sessions[0].interrupted,true);
});

test("step completion does not complete parent task", () => {
  const s=base();
  startSession(s,{id:"session1",taskId:"task1",stepId:"step1",minutes:2,now:200});
  endSession(s,"session1",70_000,300);
  recordOutcome(s,"session1","step_done",301);
  assert.equal(s.steps[0].status,"completed");
  assert.equal(s.tasks[0].status,"active");
  assert.equal(s.activeSessionId,null);
});

test("only task_done explicitly completes parent task", () => {
  const s=base();
  startSession(s,{id:"session1",taskId:"task1",stepId:"step1",minutes:5,now:200});
  endSession(s,"session1",10_000,300);
  recordOutcome(s,"session1","task_done",301);
  assert.equal(s.tasks[0].status,"done");
  assert.equal(s.activeTaskId,null);
});

test("not_started preserves action and supports new session after review", () => {
  const s=base();
  startSession(s,{id:"session1",taskId:"task1",stepId:"step1",minutes:5,now:200});
  endSession(s,"session1",0,300);
  recordOutcome(s,"session1","not_started",301);
  assert.equal(s.steps[0].status,"attempted");
  startSession(s,{id:"session2",taskId:"task1",stepId:"step1",minutes:2,now:302});
  assert.equal(s.sessions.length,2);
});

test("time deltas are validated and archival is distinct from completion", () => {
  const s=base();
  startSession(s,{id:"session1",taskId:"task1",stepId:"step1",minutes:5,now:200});
  assert.throws(()=>checkpointSession(s,"session1",-1),/INVALID_ELAPSED/);
  assert.throws(()=>checkpointSession(s,"session1",Infinity),/INVALID_ELAPSED/);
  endSession(s,"session1",0,301);
  recordOutcome(s,"session1","partial",302);
  archiveTask(s,"task1",303);
  assert.equal(s.tasks[0].status,"archived");
  assert.equal(s.steps[0].status,"attempted");
});


test("task edit checks optimistic version and preserves history", () => {
  const s=base();
  const before=s.tasks[0].updatedAt;
  editTask(s,"task1",{title:"更明确的任务标题",expectedUpdatedAt:before,now:103});
  assert.equal(s.tasks[0].title,"更明确的任务标题");
  assert.ok(s.tasks[0].updatedAt>before);
  assert.throws(() => editTask(s,"task1",{title:"过期修改",expectedUpdatedAt:before,now:110}), /STALE_TASK_EDIT/);
});

test("undo import removes only untouched batch tasks and never completed work", () => {
  const s=emptyState();
  importTasks(s,{lines:["整理桌面","写日报"],ids:["t1","t2"],batchId:"batch1",now:1});
  createTask(s,{id:"old",title:"原有任务",now:1});
  undoImport(s,"batch1",2);
  assert.deepEqual(s.tasks.map(x=>x.id),["old"]);
  assert.throws(()=>undoImport(s,"batch1",3),/BATCH_NOT_FOUND/);

  const other=emptyState();
  importTasks(other,{lines:["写日报"],ids:["t3"],batchId:"batch2",now:1});
  focusTask(other,"t3",2);
  confirmStep(other,{id:"step3",taskId:"t3",text:"写标题",now:3});
  assert.throws(()=>undoImport(other,"batch2",4),/BATCH_HAS_STEPS/);
});
