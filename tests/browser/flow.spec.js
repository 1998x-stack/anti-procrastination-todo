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
