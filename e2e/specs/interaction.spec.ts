/**
 * 交互层移植回归（WorkBuddy demo → OneDesktop）：
 *   B. 实时事件流抽屉（EventDrawer）：顶栏按钮开关，抽屉显隐正确
 *
 * 事件抽屉订阅生产通道 `onedesktop-event`（归一化），mock 只发 `agent-event`，
 * 故仅验证 UI 开关契约；真实事件在真机已验证。
 */
import { test, expect } from "@playwright/test";
import { installTauriMock } from "../helpers/tauriMock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
});

/** 输入并等待回合完成（答案气泡出现 = Done 已落地）。 */
async function sendAndWaitAnswer(page: import("@playwright/test").Page, prompt: string) {
  const input = page.locator("textarea");
  await expect(input).toBeVisible({ timeout: 8000 });
  await input.fill(prompt);
  await input.press("Enter");
  await expect(page.locator(".message-bubble.assistant").first()).toBeVisible({ timeout: 10000 });
}

// ── B. 事件流抽屉开关 ──
test("事件流抽屉可开关", async ({ page }) => {
  const btn = page.locator('button[aria-label="事件流"]');
  const drawer = page.locator(".event-drawer");

  await expect(btn).toBeVisible({ timeout: 6000 });

  // 初始关闭
  await expect(drawer).not.toHaveClass(/open/);

  // 打开
  await btn.click();
  await expect(drawer).toHaveClass(/open/, { timeout: 3000 });

  // 关闭
  await btn.click();
  await expect(drawer).not.toHaveClass(/open/, { timeout: 3000 });
});

// ── 内部工具回合：collapsed 密度下「查看过程」入口不消失 ──
// 回归 2026-08-11：done+collapsed 时内部工具被策略层隐藏，ProcessPanel 不应
// 因 displayDecisions 为空而整片消失；本轮确实执行过过程，应保留「已完成 · 查看过程」。
test("仅内部工具的回合完成后仍显示查看过程入口", async ({ page }) => {
  await sendAndWaitAnswer(page, "触发 [internal-tools]");
  const doneHead = page.locator(".process-panel--done .pp-done-head");
  await expect(doneHead).toBeVisible({ timeout: 6000 });
  await expect(doneHead).toContainText("已完成");

  const toggle = page.locator(".pp-toggle");
  await expect(toggle).toBeVisible({ timeout: 3000 });

  // 展开后内部工具行应出现
  await toggle.click();
  await expect(page.locator(".pp-line--tool")).toHaveCount(2, { timeout: 3000 });
});

// ── 快捷键：Cmd/Ctrl + N 新建空会话后输入框自动聚焦 ──
test("Cmd+N 新建会话后输入框自动聚焦", async ({ page }) => {
  const input = page.locator("textarea");
  await expect(input).toBeVisible({ timeout: 8000 });
  // 初始未聚焦
  await expect(input).not.toBeFocused();

  // 通过 JS 派发避免 Playwright 键盘触发浏览器默认新建窗口
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", metaKey: true, bubbles: true, cancelable: true }));
  });

  // 新建空会话后应自动聚焦到输入框
  await expect(input).toBeFocused({ timeout: 3000 });
});
