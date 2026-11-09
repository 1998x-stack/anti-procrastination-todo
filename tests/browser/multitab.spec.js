// Multi-tab behaviour with two real pages sharing one IndexedDB origin.
//
// README claims "Concurrent IndexedDB readwrite transactions prevent duplicate
// running sessions; BroadcastChannel only prompts other tabs to refresh."
// These tests verify that claim with two real documents, not two in-page stores.
import { test, expect } from "@playwright/test";

test("two real tabs cannot both start a session for the same origin", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await a.goto("/");
  await b.goto("/");

  // Tab A prepares a step and starts a session.
  await a.getByLabel("今天最难开始的是什么？").fill("多标签任务");
  await a.locator("#capture-form button[type=submit]").click();
  await a.locator("#step-form button[type=submit]").click();
  await a.getByRole("button", { name: "开始这一小步" }).click();
  await expect(a.getByText("进行中", { exact: true })).toBeVisible();

  // Tab B has been refreshed by BroadcastChannel, so it must not be able to
  // start a competing session.
  const secondStartRejected = await b.evaluate(async () => {
    const domain = await import("/code/domain/core.js");
    const { IndexedStateStore } = await import("/code/persistence/store.js");
    const repo = new IndexedStateStore();
    const before = await repo.read();
    const task = before.tasks.find(t => t.id === before.activeTaskId);
    try {
      await repo.transact(s => {
        domain.focusTask(s, task.id, Date.now());
        domain.startSession(s, {
          id: crypto.randomUUID(), taskId: task.id, stepId: task.currentStepId, minutes: 2, now: Date.now()
        });
      }, crypto.randomUUID());
      repo.close();
      return "accepted";
    } catch (error) {
      repo.close();
      return error.message;
    }
  });
  expect(secondStartRejected).not.toBe("accepted");

  const counts = await b.evaluate(async () => {
    const { IndexedStateStore } = await import("/code/persistence/store.js");
    const repo = new IndexedStateStore();
    const s = await repo.read();
    repo.close();
    return { sessions: s.sessions.length, running: s.sessions.filter(x => x.status === "running").length };
  });
  expect(counts).toEqual({ sessions: 1, running: 1 });
});

test("typing in one tab keeps focus, caret and text when another tab writes", async ({ context }) => {
  const typing = await context.newPage();
  const other = await context.newPage();
  await typing.goto("/");
  await other.goto("/");

  const input = typing.getByLabel("今天最难开始的是什么？");
  await input.fill("我正在输入的任务标题");
  await input.focus();
  await typing.evaluate(() => {
    const el = document.querySelector("#capture-input");
    el.setSelectionRange(3, 3);
  });

  // Another tab creates a task → BroadcastChannel prompts this tab to refresh.
  await other.getByLabel("今天最难开始的是什么？").fill("另一个标签写入的任务");
  await other.locator("#capture-form button[type=submit]").click();
  await expect(other.getByText("现在先看这一件事")).toBeVisible();

  // Wait until this tab has definitely processed the remote change.
  await expect(typing.getByText("另一个标签写入的任务")).toBeVisible();

  const after = await typing.evaluate(() => {
    const el = document.querySelector("#capture-input");
    return {
      activeId: document.activeElement?.id || document.activeElement?.tagName,
      value: el?.value ?? null,
      caret: el && document.activeElement === el ? el.selectionStart : null
    };
  });
  expect(after.value).toBe("我正在输入的任务标题");
  // A refresh caused by another tab must not steal focus or the caret from a
  // user who is actively typing.
  expect(after.activeId).toBe("capture-input");
  expect(after.caret).toBe(3);
});
