import { test, expect, type Page } from "@playwright/test";
import { installTauriMock } from "../helpers/tauriMock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
  // 等开屏完全卸载（全屏 cover 图，1.5s 后淡出）：整页截图若拍到 splash 会全屏失配。
  await page.locator(".splash-screen").waitFor({ state: "detached", timeout: 5000 });
});

// 主题设置：驱动 React 状态（点击侧栏切换按钮）而非直接改 data-theme 属性。
// 直接改属性会被 React 挂载后的 passive effect 覆盖回默认 light（WebKit 在高并行负载下
// effect 可能延迟数百毫秒，曾致 chat dark 整页翻转）；走 React setTheme 后状态即落定，
// effect 只在 theme 变化时再写属性，不存在被覆盖回 light 的窗口。
async function setTheme(page: Page, theme: "light" | "dark") {
  const toggle = page.getByRole("button", { name: /切换主题|Toggle theme/ });
  for (let i = 0; i < 3; i++) {
    const current = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    if (current === theme) break;
    await toggle.click();
    await page.waitForTimeout(250); // 覆盖 220ms 主题过渡
  }
  // 点击后按钮残留 focus 环 + hover 背景（鼠标仍在按钮上），会被整页截图捕获
  // （chat 用例 0 容差，0.5% 差异即挂；groups 有 1.5% 容差所以一直没暴露）。
  await page.mouse.move(0, 0); // 移开鼠标，取消 :hover
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

async function openGroups(page: Page) {
  await page.locator(".sidebar-nav-item[data-nav=\"group\"]").click();
  await expect(page.locator(".groups-page")).toBeVisible();
}

// 等侧栏完成布局（宽度 >200px）再截图：侧栏挂载是异步的，若在挂载前截图，
// chat 区会占满全宽、空状态 hero 偏左（曾致 dark 基线截到"无侧栏"的中间态，与正常渲染 100% 不符）。
async function waitSidebarSettled(page: Page) {
  await page.waitForFunction(() => {
    const s = document.querySelector<HTMLElement>(".sidebar");
    return !!s && s.getBoundingClientRect().width > 200;
  });
}

test("visual: chat (light)", async ({ page }) => {
  await expect(page.locator(".chat-area")).toBeVisible();
  await waitSidebarSettled(page);
  await expect(page).toHaveScreenshot("chat-light.png");
});

test("visual: chat (dark)", async ({ page }) => {
  await setTheme(page, "dark");
  await waitSidebarSettled(page);
  await expect(page).toHaveScreenshot("chat-dark.png");
});

test("visual: groups overview (light)", async ({ page }) => {
  await openGroups(page);
  // select the seeded demo group so the detail panel has content
  await page.locator(".sidebar-group-item", { hasText: "竞品分析群" }).click();
  await expect(page.locator(".group-detail")).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await expect(page).toHaveScreenshot("groups-overview-light.png", {
    maxDiffPixelRatio: 0.015,
  });
});

test("visual: groups overview (dark)", async ({ page }) => {
  await setTheme(page, "dark");
  await openGroups(page);
  await page.locator(".sidebar-group-item", { hasText: "竞品分析群" }).click();
  await expect(page.locator(".group-detail")).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await expect(page).toHaveScreenshot("groups-overview-dark.png", {
    maxDiffPixelRatio: 0.015,
  });
});

test("visual: create-group dialog (light)", async ({ page }) => {
  await openGroups(page);
  await page.locator(".sidebar-create-btn").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveScreenshot("create-group-dialog-light.png");
});

test("visual: settings dialog (light)", async ({ page }) => {
  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveScreenshot("settings-dialog-light.png");
});

test("visual: extensibility page (light)", async ({ page }) => {
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "MCP 服务器" }).click();
  await expect(page.locator(".ext-page")).toBeVisible();
  // Blur focus to eliminate cross-run focus-ring variance (especially WebKit)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await expect(page).toHaveScreenshot("extensibility-light.png", {
    maxDiffPixelRatio: 0.015,
  });
});
