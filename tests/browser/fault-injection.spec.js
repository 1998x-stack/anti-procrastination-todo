// Fault-injection and duplicate-input tests in a real browser.
//
// docs/TESTING.md lists "QuotaExceededError, aborted transaction, versionchange
// blocked, abrupt device shutdown" as an unverified manual gate. These tests
// close part of that gap with synthetic faults only.
import { test, expect } from "@playwright/test";

const readState = page => page.evaluate(async () => {
  const { IndexedStateStore } = await import("/code/persistence/store.js");
  const repo = new IndexedStateStore();
  const snapshot = await repo.read();
  repo.close();
  return { tasks: snapshot.tasks.length, revision: snapshot.revision, titles: snapshot.tasks.map(t => t.title) };
});

test("a failing IndexedDB write is reported as failure and is never shown as saved", async ({ page }) => {
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    window.__failNextPut = false;
    IDBObjectStore.prototype.put = function patchedPut(...args) {
      if (window.__failNextPut) {
        window.__failNextPut = false;
        throw new DOMException("Storage quota exceeded (injected)", "QuotaExceededError");
      }
      return original.apply(this, args);
    };
  });
  await page.goto("/");
  await page.evaluate(() => { window.__failNextPut = true; });

  await page.getByLabel("今天最难开始的是什么？").fill("写入失败注入任务");
  await page.locator("#capture-form button[type=submit]").click();

  // The user must see an explicit failure, not a success screen.
  await expect(page.getByText("刚才的操作还没有保存")).toBeVisible();
  await expect(page.getByText("现在先看这一件事")).toHaveCount(0);
  await expect(page.locator("#capture-input")).toHaveValue("写入失败注入任务");

  // Nothing may have been committed.
  expect(await readState(page)).toMatchObject({ tasks: 0, revision: 0 });
  await page.reload();
  await expect(page.getByText("你的待开始清单 · 0")).toBeVisible();
});

test("a retry after a failed write succeeds and commits exactly once", async ({ page }) => {
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    window.__failNextPut = false;
    IDBObjectStore.prototype.put = function patchedPut(...args) {
      if (window.__failNextPut) {
        window.__failNextPut = false;
        throw new DOMException("Storage quota exceeded (injected)", "QuotaExceededError");
      }
      return original.apply(this, args);
    };
  });
  await page.goto("/");
  await page.evaluate(() => { window.__failNextPut = true; });
  await page.getByLabel("今天最难开始的是什么？").fill("重试任务");
  await page.locator("#capture-form button[type=submit]").click();
  await expect(page.getByText("刚才的操作还没有保存")).toBeVisible();

  // Same user intent, second attempt: must succeed exactly once.
  await page.locator("#capture-form button[type=submit]").click();
  await expect(page.getByText("现在先看这一件事")).toBeVisible();
  expect(await readState(page)).toMatchObject({ tasks: 1, titles: ["重试任务"] });
});

test("an aborted transaction leaves the previous snapshot intact", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("今天最难开始的是什么？").fill("第一件任务");
  await page.locator("#capture-form button[type=submit]").click();
  await expect(page.getByText("现在先看这一件事")).toBeVisible();
  await page.getByRole("button", { name: "← 返回" }).click();

  const before = await readState(page);
  expect(before.tasks).toBe(1);

  // Abort every subsequent readwrite transaction at the IDB level.
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function patchedPut(...args) {
      const request = original.apply(this, args);
      queueMicrotask(() => { try { this.transaction.abort(); } catch { /* already finished */ } });
      return request;
    };
  });
  await page.getByLabel("今天最难开始的是什么？").fill("应当被中止的任务");
  await page.locator("#capture-form button[type=submit]").click();
  await expect(page.getByText("刚才的操作还没有保存")).toBeVisible();
  expect(await readState(page)).toMatchObject({ tasks: 1, titles: ["第一件任务"] });
});

test("a duplicate submit of one intent creates one task and no false failure", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("今天最难开始的是什么？").fill("只应创建一次的任务");

  // Two synchronous submissions of the same user intent. Implicit submission
  // (Enter) and requestSubmit() fire the submit event even while the submit
  // button is disabled, so this is a real double-submit path, not a synthetic one.
  await page.evaluate(() => {
    const form = document.querySelector("#capture-form");
    form.requestSubmit();
    form.requestSubmit();
  });

  await expect(page.getByText("现在先看这一件事")).toBeVisible();
  await expect(page.locator(".notice.error")).toHaveCount(0);
  await page.getByRole("button", { name: "← 返回" }).click();
  const state = await readState(page);
  expect(state.tasks, `titles=${JSON.stringify(state.titles)}`).toBe(1);
  expect(state.revision).toBe(1);
});
