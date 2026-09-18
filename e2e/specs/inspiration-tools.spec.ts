import { test, expect } from "@playwright/test";
import { installTauriMock } from "../helpers/tauriMock";

// 侧栏新增「灵感」与「工具箱」，并移除「待办」(收件箱) 入口
test("灵感/工具箱 已加入侧栏，待办(收件箱) 已移除", async ({ page }) => {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
  await page.locator(".splash-screen").waitFor({ state: "detached", timeout: 9000 });
  await page.waitForFunction(() => {
    const s = document.querySelector<HTMLElement>(".sidebar");
    return !!s && s.getBoundingClientRect().width > 200;
  });

  // 删除：原「待办」收件箱入口应不存在
  await expect(page.locator(".sidebar-nav-item", { hasText: "待办" })).toHaveCount(0);
  // 新增：灵感 / 工具箱 入口各一个
  await expect(page.locator(".sidebar-nav-item", { hasText: "灵感" })).toHaveCount(1);
  await expect(page.locator(".sidebar-nav-item", { hasText: "工具箱" })).toHaveCount(1);
});

// 灵感页：渲染 + ⌘↵ 快速保存 + #标签筛选
test("灵感页：记录保存与标签筛选", async ({ page }) => {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
  await page.locator(".splash-screen").waitFor({ state: "detached", timeout: 9000 });

  await page.locator(".sidebar-nav-item", { hasText: "灵感" }).click();
  await expect(page.locator(".insp-page")).toBeVisible();
  // 种子数据应已渲染出时间线卡片
  await expect(page.locator(".insp-card").first()).toBeVisible();

  // 输入并 ⌘↵ 保存（flomo 式核心交互）
  const marker = "#e2e灵感校验";
  await page.locator(".insp-input").fill(`${marker} 这是一条端到端写入的灵感`);
  await page.keyboard.press("Meta+Enter");

  // 新卡片出现，且包含标记文本
  const newCard = page.locator(".insp-card", { hasText: marker });
  await expect(newCard).toHaveCount(1);

  // 标签角标被自动识别 → 点击筛选，列表收敛到仅该标签
  const chip = page.locator(".insp-tag-chip", { hasText: marker.replace("#", "") });
  await expect(chip).toHaveCount(1);
  await chip.click();
  await expect(page.locator(".insp-card")).toHaveCount(1);
  // 取消筛选
  await page.locator(".insp-tag-chip", { hasText: "全部" }).click();
});

// 工具箱页：渲染 + JSON 格式化 + 切换标签
test("工具箱页：JSON 格式化与标签切换", async ({ page }) => {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
  await page.locator(".splash-screen").waitFor({ state: "detached", timeout: 9000 });

  await page.locator(".sidebar-nav-item", { hasText: "工具箱" }).click();
  await expect(page.locator(".tools-page")).toBeVisible();

  // 默认 JSON 标签激活
  await expect(page.getByRole("tab", { name: "JSON 格式化" })).toHaveAttribute("aria-selected", "true");

  // 输入压缩 JSON → 格式化
  await page.locator(".tool-area").first().fill('{"name":"one","ok":true}');
  await page.getByRole("button", { name: "格式化" }).click();
  await expect(page.locator(".tool-out").first()).toContainText('"name": "one"');

  // 切换到 URL 编解码标签
  await page.getByRole("tab", { name: "URL 编解码" }).click();
  await expect(page.getByRole("tab", { name: "URL 编解码" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".tool-area").first()).toBeVisible();
});
