import { test, expect } from "@playwright/test";
import { installTauriMock } from "../helpers/tauriMock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
});

test("§compaction-1 压缩上下文中可取消，取消后输入框恢复", async ({ page }) => {
  const input = page.locator("textarea");
  await expect(input).toBeVisible({ timeout: 8000 });

  await input.fill("[compaction-slow] 测试压缩中断");
  await input.press("Enter");

  // 压缩思考行出现
  const thinking = page.locator(".pp-line--thinking").first();
  await expect(thinking).toBeVisible({ timeout: 3000 });
  await expect(thinking).toContainText("压缩上下文中");

  // 点击停止按钮（发送按钮在流式中会变成停止按钮）
  const stopBtn = page.locator("button[aria-label='停止生成']");
  await expect(stopBtn).toBeVisible({ timeout: 2000 });
  await stopBtn.click();

  // 取消后输入框应恢复可用、无答案气泡
  await expect(input).toBeEnabled({ timeout: 3000 });
  const bubbles = page.locator(".message-bubble.assistant");
  await expect(bubbles).toHaveCount(0);

  // 过程流应收成「已出错 · 查看过程」或类似完成态（不继续转圈）
  await expect(page.locator(".process-panel--done, .process-panel--error")).toBeVisible({ timeout: 3000 });
});

test("§compaction-2 取消后再次发送可继续本轮思考", async ({ page }) => {
  const input = page.locator("textarea");
  await expect(input).toBeVisible({ timeout: 8000 });

  // 第一次：触发压缩并取消
  await input.fill("[compaction-slow] 第一次");
  await input.press("Enter");
  await expect(page.locator(".pp-line--thinking")).toContainText("压缩上下文中", { timeout: 3000 });
  const stopBtn = page.locator("button[aria-label='停止生成']");
  await expect(stopBtn).toBeVisible({ timeout: 2000 });
  await stopBtn.click();
  await expect(input).toBeEnabled({ timeout: 3000 });

  // 第二次：正常提问，应能正常得到答案（不被上次取消阻塞）
  await input.fill("[slow-start] 继续");
  await input.press("Enter");

  const bubble = page.locator(".message-bubble.assistant").last();
  await expect(bubble).toBeVisible({ timeout: 6000 });
  await expect(bubble).toContainText("思考完成");
});
