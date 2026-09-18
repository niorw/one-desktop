import { test, expect } from "@playwright/test";
import { installTauriMock } from "../helpers/tauriMock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
});

async function openGroups(page: import("@playwright/test").Page) {
  await page.locator(".sidebar-nav-item[data-nav=\"group\"]").click();
  await expect(page.locator(".groups-page")).toBeVisible();
}

test("建群：填表提交后新群出现在侧栏列表", async ({ page }) => {
  await openGroups(page);
  await page.getByRole("button", { name: "新建群" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await page.locator(".modal-wide input").nth(0).fill("测试群A");
  await page.locator(".modal-wide input").nth(1).fill("端到端验证用群");
  await page.locator(".modal-wide select").first().selectOption({ label: "Researcher" });
  await page.locator(".modal-actions .btn-primary").click();

  await expect(page.locator(".sidebar-group-item", { hasText: "测试群A" })).toBeVisible();
});

test("派活闭环：提交批次 → 后端完成 → 待验收 → 群主验收", async ({ page }) => {
  await openGroups(page);
  await page.locator(".sidebar-group-item", { hasText: "竞品分析群" }).click();
  await expect(page.locator(".group-detail")).toBeVisible();

  // 右侧群信息面板「派发任务」进入 dispatch 视图（v4 已无独立「派活」tab）
  await page.getByRole("button", { name: "派发任务" }).click();
  await expect(page.locator(".group-dispatch")).toBeVisible();

  // 添加子任务行 + 填描述
  await page.getByRole("button", { name: "添加子任务" }).click();
  await page.locator(".dispatch-desc").fill("撰写竞品对比报告");
  await page.getByRole("button", { name: "并行派发" }).click();

  // 回到对话视图，mock 后端 400ms 后 emit batch_completed → 顶部待验收条
  await expect(page.locator(".rt-strip")).toBeVisible();
  await expect(page.locator(".rt-await-banner")).toBeVisible({ timeout: 5000 });

  // 群主验收
  await page.locator(".rt-await-actions .btn-primary").click();
  await expect(page.locator(".rt-await-banner")).toHaveCount(0, { timeout: 5000 });
});

test("圆桌摘要：点击总结后摘要卡片出现", async ({ page }) => {
  await openGroups(page);
  await page.locator(".sidebar-group-item", { hasText: "竞品分析群" }).click();
  await expect(page.locator(".group-detail")).toBeVisible();

  // v4 主区即圆桌对话流，常驻可见（已无「圆桌」文字 tab）
  await expect(page.locator(".roundtable")).toBeVisible();

  // seeded demo group has >=2 messages, so summarize is enabled
  await page.locator(".rt-summarize-btn").click();
  await expect(page.locator(".rt-summary").last()).toBeVisible({ timeout: 5000 });
});

test("添加能力席位：声明能力后侧栏出现虚线席位卡", async ({ page }) => {
  await openGroups(page);
  await page.locator(".sidebar-group-item", { hasText: "竞品分析群" }).click();
  await expect(page.locator(".group-info-panel")).toBeVisible();

  const before = await page.locator(".info-member").count();

  await page.locator(".info-add-seat").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // 切到「能力席位」类型，仅声明能力、不绑预设
  await dialog.getByRole("button", { name: "能力席位" }).click();
  await dialog.locator("#cap-input").fill("search, summarize");
  await dialog.getByRole("button", { name: "确定" }).click();

  // 虚线能力席位卡出现，席位总数 +1
  await expect(page.locator(".info-member.is-cap")).toBeVisible();
  await expect(page.locator(".info-member")).toHaveCount(before + 1);
});

test("席位离线/上线：抽屉内切换状态", async ({ page }) => {
  await openGroups(page);
  await page.locator(".sidebar-group-item", { hasText: "竞品分析群" }).click();
  await expect(page.locator(".group-info-panel")).toBeVisible();

  // 第一个席位（Idle 的 w1）开详情抽屉
  await page.locator(".info-member").first().click();
  const drawer = page.locator(".drawer");
  await expect(drawer).toBeVisible();

  // 设为离线 → 状态变「离线」，按钮变「上线」
  await drawer.getByRole("button", { name: "设为离线" }).click();
  await expect(drawer.getByText("离线")).toBeVisible();

  // 再上线 → 状态回「空闲」
  await drawer.getByRole("button", { name: "上线" }).click();
  await expect(drawer.getByText("空闲")).toBeVisible();
});

test("移除席位：确认后抽屉关闭且席位减少", async ({ page }) => {
  await openGroups(page);
  await page.locator(".sidebar-group-item", { hasText: "竞品分析群" }).click();
  await expect(page.locator(".group-info-panel")).toBeVisible();

  const before = await page.locator(".info-member").count();

  await page.locator(".info-member").first().click();
  const drawer = page.locator(".drawer");
  await expect(drawer).toBeVisible();

  // remove 走 window.confirm，需接受对话框
  page.on("dialog", (d) => d.accept());
  await drawer.getByRole("button", { name: "移除席位" }).click();

  await expect(drawer).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator(".info-member")).toHaveCount(before - 1);
});
