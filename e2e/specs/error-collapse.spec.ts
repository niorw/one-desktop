/**
 * 验证「思考/执行过程中整轮报错会立即收起」。
 *
 * 复现用户现象：模型执行到一半（思考+工具都正常渲染），一旦整轮被 Error 事件
 * 中断，过程流立即从展开的 running 态收起为 done 折叠态（「已出错 · 查看过程」）。
 *
 * 关键链路：
 *   useAgent「Error」处理器 → setIsStreaming(false) → MessageList live=false
 *   → ProcessPanel isRunning=false → done 折叠态（expanded 默认 false）。
 *
 * 反向对照：单工具失败（ToolResult.is_error）不会翻 isStreaming，面板保持展开。
 *
 * 通过注入式 Tauri mock 的 send_message 回放 Thinking+ToolCall+ToolResult+Error
 * 事件流驱动真实 React 组件。
 */
import { test, expect } from "@playwright/test";
import { installTauriMock } from "../helpers/tauriMock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
});

test("整轮执行中途报错：过程流立即收起为「已出错 · 查看过程」", async ({ page }) => {
  const input = page.locator("textarea");
  await expect(input).toBeVisible({ timeout: 8000 });

  await input.fill("触发 [mid-error] 整轮中断");
  await input.press("Enter");

  // 执行中：过程流以 running（展开）态渲染 —— 工具行已可见，证明未提前收起。
  const toolLine = page.locator(".process-panel .pp-line--tool").first();
  await expect(toolLine).toBeVisible({ timeout: 6000 });
  await expect(page.locator(".process-panel--live")).toBeVisible({ timeout: 6000 });

  // Error 事件到达后：立即切到 done 折叠态，且状态标记为「已出错」。
  await expect(page.locator(".process-panel--done")).toBeVisible({ timeout: 6000 });
  const status = page.locator(".process-panel--done .pp-status.is-error");
  await expect(status).toContainText("已出错");

  // 默认折叠：入口按钮显示「查看过程」（而非「收起过程」）。
  const toggle = page.locator(".process-panel--done .pp-toggle");
  await expect(toggle).toHaveText("查看过程");

  // 同时出现错误通知横幅。
  await expect(page.locator(".notice-banner.error")).toBeVisible({ timeout: 6000 });

  // 内容未丢：点「查看过程」可重新展开看到失败的那个工具行。
  await toggle.click();
  const failedLine = page.locator(".process-panel--done .pp-line--tool.is-error").first();
  await expect(failedLine).toBeVisible({ timeout: 6000 });
});
