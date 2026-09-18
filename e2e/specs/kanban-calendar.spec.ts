import { test, expect } from "@playwright/test";
import { installTauriMock } from "../helpers/tauriMock";

// 看板 + 日历：验证 mock 后端种子数据能正常渲染（UI/UX 审视的可见基础）。
// 模板对齐 command-palette.spec：addInitScript + goto + 等 splash 卸载。

async function openNav(page: import("@playwright/test").Page, label: string) {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
  await page.locator(".splash-screen").waitFor({ state: "detached", timeout: 9000 });
  await page.waitForFunction(() => {
    const s = document.querySelector<HTMLElement>(".sidebar");
    return !!s && s.getBoundingClientRect().width > 200;
  });
  await page.locator(".sidebar-nav-item", { hasText: label }).click();
}

test("Kanban: 5 列渲染、含种子任务、群徽章与依赖/卡死角标", async ({ page }) => {
  await openNav(page, "看板");

  const board = page.locator(".kanban");
  await expect(board).toBeVisible();

  // 5 个状态列（待办/进行中/已完成/失败/已取消）
  await expect(page.locator(".kanban-col")).toHaveCount(5);

  // 种子任务：g_demo 6 条 + 个人 3 条 = 9 张卡片
  await expect(page.locator(".kanban-card").first()).toBeVisible();
  const cards = await page.locator(".kanban-card").count();
  expect(cards).toBeGreaterThanOrEqual(9);

  // 群来源徽章（个人任务 / 竞品分析群）
  await expect(page.locator(".kanban-badge-group").first()).toBeVisible();

  // 依赖门角标：t_seo_2 等 t_seo_1（待办）→ 「等待依赖」
  await expect(page.locator(".kanban-flag.blocked").first()).toBeVisible();
  await expect(page.locator(".kanban-flag.blocked").first()).toContainText("等待依赖");

  // 卡死角标：t_draft_1 进行中但心跳过期 >60s → 「卡死」
  await expect(page.locator(".kanban-flag.stale").first()).toBeVisible();
  await expect(page.locator(".kanban-flag.stale").first()).toContainText("卡死");
});

test("Calendar: 月历有种子点、今日溢出 +N、过期点可辨识、选中面板有条目", async ({ page }) => {
  await openNav(page, "日历");

  const cal = page.locator(".calendar-page");
  await expect(cal).toBeVisible();

  // 今日单元格应有状态点；今日种子 4 条 → 渲染前 3 个 + 「+1」溢出
  const today = page.locator(".cal-cell--today");
  await expect(today).toBeVisible();
  await expect(today.locator(".cal-dot").first()).toBeVisible();
  await expect(today.locator(".cal-dot")).toHaveCount(3);
  await expect(today.locator(".cal-dot-more")).toHaveCount(1);

  // 「已过期」空心描边点（st_expired）在月历上可辨识
  await expect(page.locator(".cal-dot--expired").first()).toBeVisible();

  // 默认选中今日，右侧面板应有任务条目（>=4）
  await expect(page.locator(".calendar-task-item").first()).toBeVisible();
  const items = await page.locator(".calendar-task-item").count();
  expect(items).toBeGreaterThanOrEqual(4);
});
