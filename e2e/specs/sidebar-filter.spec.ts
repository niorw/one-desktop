import { test, expect } from "@playwright/test";
import { installTauriMock } from "../helpers/tauriMock";

// ── 侧栏「任务」清单过滤群会话（Task #115）──
// 用户在侧边栏「任务」栏目（WorkspaceTree）下不应看到群会话信息；群会话只应在
// GroupList（群导航）呈现。本套件预置一条普通会话 + 一条 mode="group" 群会话，
// 验证任务清单过滤掉群会话、GroupList 仍正常呈现群。

test.beforeEach(async ({ page }) => {
  // 必须在 installTauriMock 之前埋标志（addInitScript 按注册顺序执行）。
  await page.addInitScript(() => {
    (window as any).__SEED_GROUP_SESSION__ = true;
  });
  await page.addInitScript(installTauriMock);
  await page.goto("/");
});

test("任务清单不展示群会话，普通会话正常展示", async ({ page }) => {
  // 「任务」工作区分区默认折叠，先展开再断言。
  const taskHeader = page.locator('.sidebar-ws-section-header--inline', { hasText: "任务" });
  if ((await taskHeader.getAttribute("aria-expanded")) === "false") {
    await taskHeader.click();
  }

  // 默认导航（非群）下，WorkspaceTree 渲染普通会话清单。
  const normal = page.locator(".session-item", { hasText: "需求梳理任务" });
  await expect(normal).toBeVisible({ timeout: 8000 });

  // mode="group" 的群会话不应出现在任务清单
  await expect(page.locator(".session-item", { hasText: "竞品分析群会话" })).toHaveCount(0);
});

test("群会话只出现在群导航（GroupList），不混入任务清单", async ({ page }) => {
  // 切到群导航：GroupList 呈现种子群「竞品分析群」
  await page.locator('.sidebar-nav-item[data-nav="group"]').click();
  const groupList = page.locator(".sidebar-groups");
  await expect(groupList).toBeVisible({ timeout: 4000 });
  await expect(page.locator(".sidebar-group-item", { hasText: "竞品分析群" })).toBeVisible({ timeout: 4000 });

  // 任务清单（此时已切到群视图，WorkspaceTree 不渲染）不存在群会话条目
  await expect(page.locator(".session-item", { hasText: "竞品分析群会话" })).toHaveCount(0);
});
