import { test, expect } from "@playwright/test";

test("not-started review proposes a smaller retry without committing it or finishing task", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("今天最难开始的是什么？").fill("写年度报告");
  await page.locator("#capture-form button[type=submit]").click();
  await page.getByRole("button", { name: "事情太大" }).click();
  await expect(page.getByRole("button", { name: "事情太大" })).toHaveAttribute("aria-pressed", "true");
  const first = await page.locator("#step-input").inputValue();
  await page.locator("#step-form button[type=submit]").click();
  await page.getByRole("button", { name: "开始这一小步" }).click();
  await page.getByRole("button", { name: "结束并回顾" }).click();
  await page.getByRole("button", { name: "还是没能开始" }).click();
  const smaller = await page.locator("#step-input").inputValue();
  expect(smaller).not.toEqual(first);
  await expect(page.getByText("这次尝试已经记录")).toBeVisible();

  const before = await page.evaluate(async () => {
    const { IndexedStateStore } = await import("/code/persistence/store.js");
    const repo = new IndexedStateStore(); const s = await repo.read(); repo.close();
    return { taskDone:s.tasks.some(t=>t.status==="done"), steps:s.steps.length, sessions:s.sessions.length };
  });
  expect(before).toEqual({ taskDone:false, steps:1, sessions:1 });

  await page.locator("#step-form button[type=submit]").click();
  const after = await page.evaluate(async () => {
    const { IndexedStateStore } = await import("/code/persistence/store.js");
    const repo = new IndexedStateStore(); const s = await repo.read(); repo.close();
    return {
      taskDone:s.tasks.some(t=>t.status==="done"),
      steps:s.steps.length,
      sessions:s.sessions.length,
      preservedStepText:s.steps[0].text,
      retryStepText:s.steps[1].text,
      retrySource:s.steps[1].source,
      retryTemplateId:s.steps[1].templateId
    };
  });
  expect(after.taskDone).toBe(false);
  expect(after.steps).toBe(2);
  expect(after.sessions).toBe(1);
  expect(after.preservedStepText).toEqual(first);
  expect(after.retryStepText).toEqual(smaller);
  expect(after.retrySource).toBe("template");
  expect(after.retryTemplateId).toMatch(/^retry:generic:/);
});

test("partial review offers an editable continuation, without duplicate sessions", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("今天最难开始的是什么？").fill("准备面试");
  await page.locator("#capture-form button[type=submit]").click();
  await page.locator("#step-form button[type=submit]").click();
  await page.getByRole("button", { name: "开始这一小步" }).click();
  await page.getByRole("button", { name: "结束并回顾" }).click();
  await page.getByRole("button", { name: "做了一部分" }).click();
  await expect(page.locator("#step-input")).toHaveValue("写下刚才进行到哪里，再选一个更小的下一步");
  const sessionCount = await page.evaluate(async () => {
    const { IndexedStateStore } = await import("/code/persistence/store.js");
    const repo = new IndexedStateStore(); const data = await repo.read(); repo.close();
    return data.sessions.length;
  });
  expect(sessionCount).toBe(1);
});
