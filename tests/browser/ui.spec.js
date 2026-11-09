import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

test("Calm Focus desktop workspace has a clear hero, next action and no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByText("从一件小事")).toBeVisible();
  await expect(page.getByLabel("今天最难开始的是什么？")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "使用方法与隐私" })).toBeVisible();
  const metrics = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    template: getComputedStyle(document.querySelector(".workspace-grid")).gridTemplateColumns,
    firstFieldHeight: document.querySelector("#capture-input").getBoundingClientRect().height
  }));
  expect(metrics.overflow).toBe(false);
  expect(metrics.template.split(" ").length).toBe(2);
  expect(metrics.firstFieldHeight).toBeGreaterThanOrEqual(48);
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-home-desktop.png", fullPage: true });
});

test("320px and 375px mobile layouts keep the primary CTA reachable and avoid horizontal scrolling", async ({ page }) => {
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await expect(page.getByLabel("今天最难开始的是什么？")).toBeVisible();
    await expect(page.locator("#capture-form button[type=submit]")).toBeVisible();
    const metrics = await page.evaluate(() => {
      const box = document.querySelector("#capture-form button[type=submit]").getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        ctaWidth: box.width,
        ctaLeft: box.left,
        ctaRight: box.right
      };
    });
    expect(metrics.overflow).toBe(false);
    expect(metrics.ctaWidth).toBeGreaterThanOrEqual(150);
    expect(metrics.ctaLeft).toBeGreaterThanOrEqual(0);
    expect(metrics.ctaRight).toBeLessThanOrEqual(width);
    if (width === 375) {
      await mkdir("artifacts", { recursive: true });
      await page.screenshot({ path: "artifacts/ui-home-mobile.png", fullPage: true });
    }
  }
});

test("blocker cards remain selectable, edited step is preserved and live counter updates", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("今天最难开始的是什么？").fill("准备下周报告");
  await page.locator("#capture-form button[type=submit]").click();
  await expect(page.getByRole("navigation", { name: "任务启动进度" })).toBeVisible();
  const blocker = page.getByRole("button", { name: "事情太大" });
  await blocker.click();
  await expect(blocker).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("建议的第一小步（可以随意修改）").fill("只写开头一行");
  await expect(page.locator("#step-count")).toHaveText("6 / 160");
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-first-step.png", fullPage: true });
  await page.getByRole("button", { name: "用这一小步，继续" }).click();
  await expect(page.getByText("只写开头一行")).toBeVisible();
});

test("timer keeps actions prominent and hidden clock removes visible numbers", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("今天最难开始的是什么？").fill("回复一封邮件");
  await page.locator("#capture-form button[type=submit]").click();
  await page.locator("#step-form button[type=submit]").click();
  await page.getByRole("button", { name: "开始这一小步" }).click();
  await expect(page.locator("#timer-circle")).toBeVisible();
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-timer.png", fullPage: true });
  await page.getByRole("button", { name: "隐藏计时" }).click();
  await expect(page.locator("#timer-number")).toHaveText("···");
  await page.getByRole("button", { name: "暂停一下" }).click();
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
});

test("dark theme can be toggled without losing local task state", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("今天最难开始的是什么？").fill("准备教学材料");
  await page.locator("#capture-form button[type=submit]").click();
  await page.getByRole("button", { name: "打开设置" }).click();
  const toggle = page.getByRole("button", { name: /切换为(明亮|深色)模式/ });
  await expect(toggle).toBeVisible();
  const before = await page.locator("html").getAttribute("data-theme");
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", before === "dark" ? "light" : "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", before === "dark" ? "light" : "dark");
  await page.getByRole("button", { name: "打开设置" }).click();
  await page.getByRole("button", { name: "← 返回" }).click();
  await expect(page.getByText("准备教学材料")).toBeVisible();
});

test("review choices remain independently labeled and do not silently finish the parent task", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("今天最难开始的是什么？").fill("写论文开题");
  await page.locator("#capture-form button[type=submit]").click();
  await page.locator("#step-form button[type=submit]").click();
  await page.getByRole("button", { name: "开始这一小步" }).click();
  await page.getByRole("button", { name: "结束并回顾" }).click();
  await expect(page.getByRole("button", { name: "第一小步完成了" })).toBeVisible();
  await expect(page.getByRole("button", { name: "整件任务已经完成" })).toBeVisible();
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-review.png", fullPage: true });
  await page.getByRole("button", { name: "第一小步完成了" }).click();
  await expect(page.getByText("正在聚焦")).toBeVisible();
});
