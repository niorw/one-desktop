/**
 * 「⚡ 后台任务」抽屉（TaskDrawer）回归：
 *   A. 顶栏 ⚡ 按钮开关抽屉（open 类切换）
 *   B. 与「事件流」抽屉互斥：打开其一则另一关闭，避免右侧重叠
 *
 * 后台任务实时数据来自统一事件总线（agent run + 圆桌 task/worker），
 * 此 spec 仅验证 UI 开关契约与互斥；真实聚合在真机已验证。
 */
import { test, expect } from "@playwright/test";
import { installTauriMock } from "../helpers/tauriMock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
});

const taskBtn = (page: import("@playwright/test").Page) =>
  page.locator('button[aria-label="后台任务"]');
const eventBtn = (page: import("@playwright/test").Page) =>
  page.locator('button[aria-label="事件流"]');
const taskDrawer = (page: import("@playwright/test").Page) =>
  page.locator(".task-drawer");
const eventDrawer = (page: import("@playwright/test").Page) =>
  page.locator(".event-drawer");

test("后台任务抽屉可开关", async ({ page }) => {
  await expect(taskBtn(page)).toBeVisible({ timeout: 6000 });
  await expect(taskDrawer(page)).not.toHaveClass(/open/);

  await taskBtn(page).click();
  await expect(taskDrawer(page)).toHaveClass(/open/, { timeout: 3000 });

  await taskBtn(page).click();
  await expect(taskDrawer(page)).not.toHaveClass(/open/, { timeout: 3000 });
});

test("后台任务与事件流抽屉互斥", async ({ page }) => {
  // 先开事件流
  await eventBtn(page).click();
  await expect(eventDrawer(page)).toHaveClass(/open/, { timeout: 3000 });

  // 再开后任务 → 事件流应自动关闭
  await taskBtn(page).click();
  await expect(taskDrawer(page)).toHaveClass(/open/, { timeout: 3000 });
  await expect(eventDrawer(page)).not.toHaveClass(/open/);

  // 再开事件流 → 后任务应自动关闭
  await eventBtn(page).click();
  await expect(eventDrawer(page)).toHaveClass(/open/, { timeout: 3000 });
  await expect(taskDrawer(page)).not.toHaveClass(/open/);
});
