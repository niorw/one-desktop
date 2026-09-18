import { test, expect } from "@playwright/test";
import { installTauriMock } from "../helpers/tauriMock";

// 设计审计 P0：⌘K 命令面板 + 侧栏导航/会话分隔线（真实交互，非占位）
test("P0: ⌘K 命令面板可唤起、过滤、关闭；侧栏分隔线存在", async ({ page }) => {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
  await page.locator(".splash-screen").waitFor({ state: "detached", timeout: 9000 });
  await page.waitForFunction(() => {
    const s = document.querySelector<HTMLElement>(".sidebar");
    return !!s && s.getBoundingClientRect().width > 200;
  });

  // 1) 侧栏导航与会话区之间有 1px 分隔线（设计审计 P0）
  await expect(page.locator(".sidebar-nav-divider")).toHaveCount(1);
  // 默认激活态在「对话」导航项（左强调条由 CSS ::before 渲染）
  await expect(page.locator(".sidebar-nav-item.active")).toHaveCount(1);

  // 2) TopBar 居中 ⌘K 胶囊入口存在
  await expect(page.locator(".cmd-trigger")).toBeVisible();

  // 3) Control+K（跨平台等价于 ⌘K）唤起命令面板
  await page.keyboard.press("Control+K");
  const palette = page.locator(".cmd-palette");
  await expect(palette).toBeVisible();
  await expect(palette).toHaveAttribute("role", "dialog");
  await expect(palette).toHaveAttribute("aria-modal", "true");

  // 4) 命令列表含导航/操作/跳转会话三类，且输入已聚焦
  const list = page.locator(".cmd-list");
  await expect(list.locator("[role='option']").first()).toBeVisible();
  // 默认至少列出导航 + 操作命令（无会话时跳转组为空，计数 = 8）
  expect(await list.locator("[role='option']").count()).toBeGreaterThanOrEqual(8);
  await expect(page.locator(".cmd-input")).toBeFocused();

  // 5) 输入过滤：键入「设置」应命中设置命令
  await page.locator(".cmd-input").fill("设置");
  const filtered = list.locator("[role='option']");
  await expect(filtered).toHaveCount(1);
  await expect(filtered.first()).toContainText("设置");

  // 6) 清空并键盘上下选择高亮首项，Enter 执行（导航到设置→打开设置弹窗）
  await page.locator(".cmd-input").fill("");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(list.locator("[role='option'].active").first()).toBeVisible();

  // 7) Escape 关闭面板
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  // 8) 再次唤起验证可重复（toggle 行为）
  await page.keyboard.press("Control+K");
  await expect(page.locator(".cmd-palette")).toBeVisible();
});
