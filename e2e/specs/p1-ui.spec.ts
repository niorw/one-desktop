import { test, expect } from "@playwright/test";
import { installTauriMock } from "../helpers/tauriMock";

// 设计审计 P1（四项落地验证）：
//  - P1-3 首屏 Dashboard 截图风格：问候 + 输入卡 + 快捷指令 + 智能体推荐 + 最近任务
//  - P1-2 InputBar 权限内联显示（完全访问 + Agent 模式开关）
//  - P1-4 设置页「快捷键」展示卡
// 模板严格对齐 command-palette.spec.ts（addInitScript + goto + splash detached）。

test("P1-3: 首屏 Dashboard 截图风格", async ({ page }) => {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
  await page.locator(".splash-screen").waitFor({ state: "detached", timeout: 9000 });
  await page.waitForSelector(".dashboard", { timeout: 9000 });

  const dash = page.locator(".dashboard");
  await expect(dash).toBeVisible();

  // 问候标题 + 副标题
  await expect(dash.locator(".dashboard-greeting")).toContainText("你好，Alex");
  await expect(dash.locator(".dashboard-subtitle")).toBeVisible();

  // 输入卡
  await expect(dash.locator(".chat-input-wrapper")).toBeVisible();
  await expect(dash.locator(".quick-chip")).toHaveCount(4);

  // 智能体推荐：4 张卡
  const agents = dash.locator(".agent-card");
  await expect(agents).toHaveCount(4);
  await expect(agents.filter({ hasText: "文档助手" })).toHaveCount(1);
  await expect(agents.filter({ hasText: "数据分析师" })).toHaveCount(1);

  // 最近任务：3 行
  await expect(dash.locator(".recent-item")).toHaveCount(3);
});

test("P1-2: InputBar 权限内联 + Agent 开关", async ({ page }) => {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
  await page.locator(".splash-screen").waitFor({ state: "detached", timeout: 9000 });
  await page.waitForSelector(".permission-trigger-inline", { timeout: 9000 });

  const trigger = page.locator(".permission-trigger-inline");
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText("完全访问");

  // 展开下拉：三项各带图标 + 语义标签
  await trigger.click();
  const opts = page.locator(".permission-option");
  await expect(opts).toHaveCount(3);
  await expect(opts.locator(".perm-opt-icon svg")).toHaveCount(3);
  await expect(page.locator(".permission-option .perm-opt-label").filter({ hasText: "自动执行" })).toHaveCount(1);
  await expect(page.locator(".permission-option .perm-opt-label").filter({ hasText: "先计划" })).toHaveCount(1);

  // Agent 模式开关默认开启
  await page.locator(".permission-option").first().click();
  await expect(page.locator(".agent-mode-toggle.on")).toBeVisible();
  await expect(page.locator(".agent-mode-toggle")).toContainText("开启");
});

test("P1-4: 设置页「快捷键」展示卡", async ({ page }) => {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
  await page.locator(".splash-screen").waitFor({ state: "detached", timeout: 9000 });
  await page.waitForSelector(".sidebar", { timeout: 9000 });

  // 命令面板打开设置
  await page.keyboard.press("Control+K");
  const palette = page.locator(".cmd-palette");
  await expect(palette).toBeVisible();
  await page.locator(".cmd-input").fill("设置");
  await page.locator(".cmd-list [role='option']").first().click();

  const modal = page.locator(".settings-modal");
  await expect(modal).toBeVisible();
  // 快捷键卡标题本地化
  await expect(modal).toContainText("快捷键");

  // 四行快捷键，⌘K / ⌘B 居首两行
  const rows = modal.locator(".shortcut-row");
  await expect(rows).toHaveCount(4);
  const keys = modal.locator(".shortcut-keys");
  await expect(keys).toHaveCount(4);
  await expect(keys.nth(0)).toContainText("⌘K");
  await expect(keys.nth(1)).toContainText("⌘B");
});
