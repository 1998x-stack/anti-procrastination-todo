// Tab visibility, unload and timer honesty.
//
// README/TESTING claim: "Tab visibility changes pause verified foreground time"
// and "time in another app is not treated as verified work". docs/TESTING.md
// lists "Long sessions, sleep/wake, system clock edits and switching into
// external work apps" as unverified. These tests cover the deterministic part.
import { test, expect } from "@playwright/test";

/** Simulate a real tab-away/return using a single visibilitychange per transition. */
async function setHidden(page, hidden) {
  await page.evaluate(flag => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => flag });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}
const readSession = page => page.evaluate(async () => {
  const { IndexedStateStore } = await import("/code/persistence/store.js");
  const repo = new IndexedStateStore();
  const s = await repo.read();
  repo.close();
  return {
    sessions: s.sessions.length,
    status: s.sessions[0]?.status ?? null,
    activeMs: s.sessions[0]?.activeMs ?? null,
    outcome: s.sessions[0]?.outcome ?? null,
    revision: s.revision
  };
});

async function startSession(page) {
  await page.goto("/");
  await page.getByLabel("今天最难开始的是什么？").fill("计时诚实验证");
  await page.locator("#capture-form button[type=submit]").click();
  await page.locator("#step-form button[type=submit]").click();
  await page.getByRole("button", { name: "开始这一小步" }).click();
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
}

test("pausing and then immediately leaving the tab reports no false failure", async ({ page }) => {
  await startSession(page);

  // The exact user sequence: click 暂停, then switch away before the write settles.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.querySelector('button[data-action="pause"]').click();
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(600);

  // Return to the tab: the pause must have succeeded and no error may be shown.
  await setHidden(page, false);
  await expect(page.locator(".notice.error")).toHaveCount(0);
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
  const session = await readSession(page);
  expect(session).toMatchObject({ sessions: 1, status: "paused", outcome: null });
});

test("time spent in a hidden tab is not counted as verified foreground time", async ({ page }) => {
  await startSession(page);
  await page.waitForTimeout(400);
  const beforeHide = (await readSession(page)).activeMs;

  await setHidden(page, true);
  await page.waitForTimeout(1500);            // real wall-clock time passes while "away"
  await setHidden(page, false);
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible();

  const after = await readSession(page);
  expect(after.status).toBe("paused");
  // The 1.5s away must not have been added to verified active time.
  expect(after.activeMs - beforeHide).toBeLessThan(600);
});

test("a visibility change during a run pauses exactly once and adds no second session", async ({ page }) => {
  await startSession(page);
  await setHidden(page, true);
  await page.waitForTimeout(300);
  await setHidden(page, true);                // duplicate event must be harmless
  await page.waitForTimeout(200);
  await setHidden(page, false);
  await expect(page.locator(".notice.error")).toHaveCount(0);
  expect(await readSession(page)).toMatchObject({ sessions: 1, status: "paused" });
});

test("ending a paused session still reaches the review screen and records an outcome", async ({ page }) => {
  await startSession(page);
  await page.getByRole("button", { name: "暂停一下" }).click();
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "结束并回顾" }).click();
  await expect(page.getByText("刚才这一小步")).toBeVisible();
  await page.getByRole("button", { name: "第一小步完成了" }).click();
  await expect(page.getByText("正在聚焦")).toBeVisible();
  const session = await readSession(page);
  expect(session).toMatchObject({ sessions: 1, status: "ended", outcome: "step_done" });
});

test("a running session is paused (not guessed) when the page is reloaded", async ({ page }) => {
  await startSession(page);
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
  await expect(page.getByText("上次的会话已安全暂停")).toBeVisible();
  const session = await readSession(page);
  expect(session.sessions).toBe(1);
  expect(session.status).toBe("paused");
  expect(session.activeMs).toBeLessThan(1500);
});
