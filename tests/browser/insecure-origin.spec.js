// Non-secure-context behaviour.
//
// README says remote access must use HTTPS because secure-context APIs are
// required. A plain HTTP origin on a real hostname has no crypto.randomUUID and
// previously made task creation fail *silently* (unhandled TypeError, no notice).
// These tests pin the hardened behaviour: random ids still work through
// crypto.getRandomValues, and any remaining API failure is reported, never silent.
import { test, expect } from "@playwright/test";

const INSECURE_ORIGIN = "http://startfirst-insecure.test:4173";

// launchOptions must be declared at file scope (it forces its own worker).
test.use({
  baseURL: INSECURE_ORIGIN,
  launchOptions: { args: ["--host-resolver-rules=MAP startfirst-insecure.test 127.0.0.1"] }
});

test.describe("plain HTTP origin on a non-localhost hostname", () => {
  test("the origin really is an insecure context without crypto.randomUUID", async ({ page }) => {
    await page.goto("/");
    const probe = await page.evaluate(() => ({
      isSecureContext: window.isSecureContext,
      hasRandomUUID: typeof crypto.randomUUID === "function",
      hasGetRandomValues: typeof crypto.getRandomValues === "function"
    }));
    expect(probe.isSecureContext).toBe(false);
    expect(probe.hasRandomUUID).toBe(false);
    expect(probe.hasGetRandomValues).toBe(true);
  });

  test("task creation still works and is never a silent no-op", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto("/");
    await page.getByLabel("今天最难开始的是什么？").fill("非安全上下文任务");
    await page.locator("#capture-form button[type=submit]").click();

    await expect(page.getByText("现在先看这一件事")).toBeVisible();
    expect(pageErrors).toEqual([]);
    await page.getByRole("button", { name: "← 返回" }).click();
    await expect(page.getByText("非安全上下文任务")).toBeVisible();
  });

  test("a genuinely unavailable browser API is reported instead of failing silently", async ({ page }) => {
    await page.addInitScript(() => {
      // Simulate the worst case: no Web Crypto at all.
      Object.defineProperty(window, "crypto", { configurable: true, get: () => undefined });
    });
    await page.goto("/");
    await page.getByLabel("今天最难开始的是什么？").fill("缺少加密 API 的任务");
    await page.locator("#capture-form button[type=submit]").click();
    await expect(page.locator(".notice.error")).toBeVisible();
    await expect(page.getByText("操作没有完成", { exact: false })).toBeVisible();
    await expect(page.locator("#capture-input")).toHaveValue("缺少加密 API 的任务");
  });
});
