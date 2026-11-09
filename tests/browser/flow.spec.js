import { test, expect } from "@playwright/test";

test("capture → blocker → editable step → session → gentle recovery", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("从一件小事")).toBeVisible();
  await page.getByLabel("今天最难开始的是什么？").fill("回复客户邮件");
  await page.getByRole("button",{name:"帮我开始",exact:false}).first().click();
  await expect(page.getByText("现在先看这一件事")).toBeVisible();
  await page.getByRole("button",{name:"担心做错"}).click();
  await page.getByLabel("建议的第一小步（可以随意修改）").fill("先写两句话，不发送");
  await page.getByRole("button",{name:"用这一小步，继续"}).click();
  await expect(page.getByText("只做这一小步就好")).toBeVisible();
  await page.getByRole("button",{name:"2 分钟"}).click();
  await page.getByRole("button",{name:"开始这一小步"}).click();
  await expect(page.getByText("进行中",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"暂停一下"}).click();
  await expect(page.getByText("已暂停",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"结束并回顾"}).click();
  await expect(page.getByText("刚才这一小步")).toBeVisible();
  await page.getByRole("button",{name:"做了一部分"}).click();
  await expect(page.getByText("现在先看这一件事")).toBeVisible();
  await page.reload();
  await expect(page.getByText("回复客户邮件")).toBeVisible();
});

test("refresh of a running session is safe and does not auto-complete", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("今天最难开始的是什么？").fill("写报告");
  await page.locator("#capture-form button[type=submit]").click();
  await page.locator("#step-form button[type=submit]").click();
  await page.getByRole("button",{name:"开始这一小步"}).click();
  await expect(page.getByText("进行中",{exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByText("已暂停",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"结束并回顾"}).click();
  await page.getByRole("button",{name:"第一小步完成了"}).click();
  await expect(page.getByText("正在聚焦")).toBeVisible();
});

test("bulk import previews each row and export downloads JSON", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button",{name:"从其他清单粘贴"}).click();
  await page.getByLabel("粘贴纯文本").fill("准备面试\n\n复习单词\n准备面试");
  await page.getByRole("button",{name:"预览任务"}).click();
  await expect(page.getByText("确认要导入的 3 件任务")).toBeVisible();
  await page.getByRole("button",{name:"确认导入"}).click();
  await expect(page.getByText("你的待开始清单 · 3")).toBeVisible();
  await page.getByRole("button",{name:"打开设置"}).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button",{name:"导出 JSON"}).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^start-first-export-/);
});

test("app never sends task body to external services", async ({ page }) => {
  const requests=[];
  page.on("request", request => requests.push(request.url()));
  await page.goto("/");
  await page.getByLabel("今天最难开始的是什么？").fill("CONFIDENTIAL-CUSTOMER-NAME-123");
  await page.locator("#capture-form button[type=submit]").click();
  await expect(page.getByText("CONFIDENTIAL-CUSTOMER-NAME-123")).toBeVisible();
  expect(requests.some(url=>url.includes("CONFIDENTIAL-CUSTOMER-NAME-123"))).toBe(false);
  expect(requests.every(url=>url.startsWith("http://127.0.0.1:4173/"))).toBe(true);
});


test("concurrent starts from independent IndexedDB clients create one running session", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("今天最难开始的是什么？").fill("准备演讲");
  await page.locator("#capture-form button[type=submit]").click();
  await page.locator("#step-form button[type=submit]").click();
  const result = await page.evaluate(async () => {
    const { IndexedStateStore } = await import("/code/persistence/store.js");
    const { startSession } = await import("/code/domain/core.js");
    const a=new IndexedStateStore(), b=new IndexedStateStore();
    const before=await a.read();
    const task=before.tasks.find(t=>t.id===before.activeTaskId);
    const cmd=(id) => s => { startSession(s,{id,taskId:task.id,stepId:task.currentStepId,minutes:5,now:Date.now()}); };
    const results=await Promise.allSettled([
      a.transact(cmd("race-a"),"race-a"),
      b.transact(cmd("race-b"),"race-b")
    ]);
    const latest=await a.read();
    a.close(); b.close();
    return {
      successful:results.filter(x=>x.status==="fulfilled").length,
      running:latest.sessions.filter(x=>x.status==="running").length,
      sessions:latest.sessions.length
    };
  });
  expect(result).toEqual({ successful:1, running:1, sessions:1 });
});

test("task HTML is rendered as text instead of executable markup", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("今天最难开始的是什么？").fill('<img src=x onerror="window.__attacked=1">');
  await page.locator("#capture-form button[type=submit]").click();
  await expect(page.getByText('<img src=x onerror="window.__attacked=1">')).toBeVisible();
  expect(await page.locator("img").count()).toBe(0);
  expect(await page.evaluate(() => window.__attacked)).toBeUndefined();
});

test("local data deletion removes persisted tasks after reload", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("今天最难开始的是什么？").fill("一次性测试任务");
  await page.locator("#capture-form button[type=submit]").click();
  await page.getByRole("button",{name:"打开设置"}).click();
  page.once("dialog", async dialog => { await dialog.accept(); });
  await page.getByRole("button",{name:"删除此设备全部数据"}).click();
  await expect(page.getByText("本地数据已删除")).toBeVisible();
  await page.reload();
  await expect(page.getByText("你的待开始清单 · 0")).toBeVisible();
});

test("task capture and first-step confirmation work without network after initial load", async ({ page, context }) => {
  await page.goto("/");
  await context.setOffline(true);
  await page.getByLabel("今天最难开始的是什么？").fill("整理一份材料");
  await page.locator("#capture-form button[type=submit]").click();
  await page.locator("#step-form button[type=submit]").click();
  await expect(page.getByText("只做这一小步就好")).toBeVisible();
  await context.setOffline(false);
});
