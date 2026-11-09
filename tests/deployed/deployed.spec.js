// Deployment verification against the real served origin (nginx + Docker).
//
// These tests exist because "the service started" is not "the service works":
// they check the served bytes, the enforced response headers, the secure-context
// requirements of IndexedDB/crypto.randomUUID, the real user flow against the
// deployed origin, and that lab-only/never-published paths stay unreachable.
import { test, expect } from "@playwright/test";

const ORIGIN = new URL(process.env.SF_URL || "http://127.0.0.1:8081").origin;
const ORIGIN_URL = new URL(ORIGIN);
// A plain-HTTP origin on a LAN hostname is NOT a secure context (localhost and
// https are). The suite must state which environment it actually verified
// instead of asserting the loopback assumption everywhere.
const IS_SECURE_ORIGIN = ORIGIN_URL.protocol === "https:" ||
  ["127.0.0.1", "localhost", "[::1]", "::1"].includes(ORIGIN_URL.hostname);

test("deployed origin storage works, with the secure-context requirement stated explicitly", async ({ page }) => {
  await page.goto("/");
  const probe = await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    return {
      isSecureContext: window.isSecureContext,
      hasRandomUUID: typeof crypto?.randomUUID === "function",
      hasGetRandomValues: typeof crypto?.getRandomValues === "function",
      hasIndexedDB: typeof indexedDB === "object",
      databaseNames: databases.map(d => d.name)
    };
  });
  expect(probe.isSecureContext, `origin ${ORIGIN} secure-context state`).toBe(IS_SECURE_ORIGIN);
  expect(probe.hasIndexedDB).toBe(true);
  expect(probe.databaseNames).toContain("start-first-local-v1");
  if (IS_SECURE_ORIGIN) {
    // Loopback/https: the platform API is available and used directly.
    expect(probe.hasRandomUUID).toBe(true);
  } else {
    // LAN over plain HTTP: crypto.randomUUID is unavailable by spec, so the app
    // must rely on the documented crypto.getRandomValues fallback and must not
    // fail silently. Task creation is asserted below to prove it is usable.
    expect(probe.hasRandomUUID).toBe(false);
    expect(probe.hasGetRandomValues).toBe(true);
    await page.getByLabel("今天最难开始的是什么？").fill("LAN origin 可用性检查");
    await page.locator("#capture-form button[type=submit]").click();
    await expect(page.getByText("现在先看这一件事")).toBeVisible();
    await expect(page.locator(".notice.error")).toHaveCount(0);
  }
});

test("deployed entry point loads with strict headers and zero external requests", async ({ page }) => {
  const requests = [];
  const failed = [];
  const consoleErrors = [];
  page.on("request", r => requests.push(r.url()));
  page.on("requestfailed", r => failed.push(`${r.url()} :: ${r.failure()?.errorText}`));
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", e => consoleErrors.push(`pageerror: ${e.message}`));

  const response = await page.goto("/");
  expect(response.status()).toBe(200);

  const headers = response.headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["content-security-policy"]).toContain("object-src 'none'");
  expect(headers["cache-control"]).toContain("no-store");

  await expect(page.getByText("从一件小事")).toBeVisible();
  await expect(page.locator("#app")).toHaveAttribute("data-screen", "inbox");

  // Every subresource must come from the deployed origin: no CDN, font or telemetry host.
  const external = requests.filter(url => !url.startsWith(ORIGIN) && !url.startsWith("data:") && !url.startsWith("blob:"));
  expect(external).toEqual([]);
  expect(failed).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("CSP is actually enforced: injected inline script cannot execute", async ({ page }) => {
  await page.goto("/");
  const executed = await page.evaluate(async () => {
    // Inline script execution must be blocked by script-src 'self'.
    const script = document.createElement("script");
    script.textContent = "window.__cspBypass = true;";
    document.body.append(script);
    await new Promise(resolve => setTimeout(resolve, 100));
    return window.__cspBypass === true;
  });
  expect(executed).toBe(false);
});

test("golden path works on the deployed origin and state survives a real reload", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("今天最难开始的是什么？").fill("回复客户邮件（deployed）");
  await page.locator("#capture-form button[type=submit]").click();

  // blocker
  await expect(page.getByText("现在先看这一件事")).toBeVisible();
  await page.getByRole("button", { name: "事情太大" }).click();
  await expect(page.getByRole("button", { name: "事情太大" })).toHaveAttribute("aria-pressed", "true");

  // editable first step (user-owned text must win over the template)
  await page.getByLabel("建议的第一小步（可以随意修改）").fill("只写下邮件的三个要点");
  await page.getByRole("button", { name: "用这一小步，继续" }).click();

  // session
  await expect(page.getByText("只做这一小步就好")).toBeVisible();
  await page.getByRole("button", { name: "2 分钟" }).click();
  await page.getByRole("button", { name: "开始这一小步" }).click();
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "暂停一下" }).click();
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "继续这一小步" }).click();
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();

  // refresh while running must recover as paused, never as a second session
  await page.reload();
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
  const afterReload = await page.evaluate(async () => {
    const { IndexedStateStore } = await import("/code/persistence/store.js");
    const repo = new IndexedStateStore();
    const s = await repo.read();
    repo.close();
    return { sessions: s.sessions.length, running: s.sessions.filter(x => x.status === "running").length };
  });
  expect(afterReload).toEqual({ sessions: 1, running: 0 });

  // finish + partial outcome → smaller retry step, task stays active
  await page.getByRole("button", { name: "结束并回顾" }).click();
  await page.getByRole("button", { name: "做了一部分" }).click();
  await expect(page.getByText("现在先看这一件事")).toBeVisible();
  await expect(page.locator("#step-input")).toHaveValue("写下刚才进行到哪里，再选一个更小的下一步");
  const persisted = await page.evaluate(async () => {
    const { IndexedStateStore } = await import("/code/persistence/store.js");
    const repo = new IndexedStateStore();
    const s = await repo.read();
    repo.close();
    const task = s.tasks[0];
    return {
      taskStatus: task.status,
      taskTitle: task.title,
      steps: s.steps.length,
      sessions: s.sessions.length,
      outcome: s.sessions[0].outcome,
      firstStepText: s.steps[0].text,
      activeMsIsNumber: Number.isFinite(s.sessions[0].activeMs)
    };
  });
  expect(persisted.taskStatus).toBe("active");
  expect(persisted.taskTitle).toBe("回复客户邮件（deployed）");
  expect(persisted.steps).toBe(1);
  expect(persisted.sessions).toBe(1);
  expect(persisted.outcome).toBe("partial");
  expect(persisted.firstStepText).toBe("只写下邮件的三个要点");
  expect(persisted.activeMsIsNumber).toBe(true);

  await page.reload();
  await expect(page.getByText("回复客户邮件（deployed）")).toBeVisible();
});

test("export downloads a JSON snapshot from the deployed origin", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("今天最难开始的是什么？").fill("导出验证任务");
  await page.locator("#capture-form button[type=submit]").click();
  await page.getByRole("button", { name: "打开设置" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^start-first-export-\d{4}-\d{2}-\d{2}\.json$/);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const snapshot = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  expect(snapshot.schemaVersion).toBe(1);
  expect(snapshot.tasks.some(t => t.title === "导出验证任务")).toBe(true);
});

test("deletion clears the deployed origin's IndexedDB and stays cleared after reload", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("今天最难开始的是什么？").fill("待删除任务");
  await page.locator("#capture-form button[type=submit]").click();
  await page.getByRole("button", { name: "打开设置" }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "删除此设备全部数据" }).click();
  await expect(page.getByText("本地数据已删除")).toBeVisible();
  await page.reload();
  await expect(page.getByText("你的待开始清单 · 0")).toBeVisible();
});

test("lab-only research API and non-runtime paths are NOT reachable on the deployed origin", async ({ request }) => {
  // The reference telemetry service must never be exposed by the static deployment.
  const registration = await request.post("/api/v1/telemetry/registrations", {
    data: { installationId: "x", protocolVersion: "1.0" },
    headers: { "content-type": "application/json" }
  });
  expect(registration.status()).toBe(404);

  const batch = await request.post("/api/v1/telemetry/events:batch", { data: [] });
  expect(batch.status()).toBe(404);

  for (const path of [
    "/code/backend/dev-server.js",
    "/code/backend/server.js",
    "/code/backend/telemetry-service.js",
    "/code/backend/schema.sql",
    "/tests/domain.test.js",
    "/package.json",
    "/deploy/deploy.sh"
  ]) {
    const response = await request.get(path);
    expect(response.status(), `expected ${path} to be unpublished`).toBe(404);
  }

  // Dotfiles are rejected by an explicit `location ~ /\. { deny all; }` rule (403),
  // which is stronger than a plain 404. Only assert they are never served.
  for (const dotpath of ["/.git/config", "/.gitignore", "/.env"]) {
    const response = await request.get(dotpath);
    expect([403, 404], `expected ${dotpath} to never be served`).toContain(response.status());
    expect(await response.text()).not.toContain("repositoryformatversion");
  }
});

test("a mistyped asset is a real 404, so a missing module can never become executable HTML", async ({ request }) => {
  const response = await request.get("/code/persistence/does-not-exist.js");
  expect(response.status()).toBe(404);
  expect(response.headers()["content-type"]).toContain("text/html"); // nginx error page, status is what matters
  expect(await response.text()).not.toContain("start-first");
});

test("health endpoint reports ok without touching the document root", async ({ request }) => {
  const response = await request.get("/healthz");
  expect(response.status()).toBe(200);
  expect((await response.text()).trim()).toBe("ok");
});
