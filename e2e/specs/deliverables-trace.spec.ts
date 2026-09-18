import { test, expect } from "@playwright/test";
import { installTauriMock } from "../helpers/tauriMock";

// P1 溯源跳转回归（ADR-025 / docs/design/deliverable-preview-arch.md）。
//
// 防范的历史 bug：E2E mock 的 get_trace 曾返回 kind="think"/"tool" 与字段 text，
// 与真实后端 TraceDto 规范（user/thinking/intent/tool_call/tool_result/answer/...）
// 及前端 traceToItems 的 switch 完全对不上 —— 轨迹被全部丢弃、渲染成空壳，
// 且无任何测试覆盖，长期假阳性。本用例锁定「溯源下钻必须渲染出非空轨迹」。
//
// 走真实 React 组件 + 注入式 Tauri mock：群产出物 → 预览 → 查看产生轨迹 → 轨迹抽屉。

async function openGroupDeliverables(page: import("@playwright/test").Page) {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
  await page.locator(".splash-screen").waitFor({ state: "detached", timeout: 9000 });

  // 进群导航
  await page.locator('.sidebar-nav-item[data-nav="group"]').click();
  await expect(page.locator(".sidebar-groups")).toBeVisible({ timeout: 4000 });
  await page.locator(".sidebar-group-item", { hasText: "竞品分析群" }).click();

  // 切到「产出物一览」视图（默认是 chat）
  await page.locator('button.btn-icon[aria-label="产出物一览"]').click();
  const deliv = page.locator(".deliverables");
  await expect(deliv).toBeVisible({ timeout: 4000 });
  await expect(page.locator(".deliv-row.deliv-item").first()).toBeVisible({ timeout: 4000 });
}

test("reply 产出物溯源：下钻抽屉渲染非空轨迹（思考/工具/答案）", async ({ page }) => {
  await openGroupDeliverables(page);

  // 选 reply 类产出物（带 roundtable 溯源）
  const replyRow = page.locator(".deliv-row.deliv-item", { hasText: "研究员回复" });
  await expect(replyRow).toBeVisible();
  await replyRow.click();

  // 预览抽屉打开
  const preview = page.locator(".artifact-dock");
  await expect(preview).toBeVisible({ timeout: 4000 });

  // 侧栏出现「查看产生轨迹」入口
  const traceBtn = preview.locator(".artifact-trace-btn");
  await expect(traceBtn).toBeVisible();
  await expect(traceBtn).toContainText("查看产生轨迹");

  await traceBtn.click();

  // 轨迹抽屉打开（replay 态 ProcessPanel）
  const drawer = page.locator(".artifact-trace-drawer");
  await expect(drawer).toBeVisible({ timeout: 4000 });
  const panel = drawer.locator(".process-panel");
  await expect(panel).toBeVisible({ timeout: 4000 });

  // 关键回归：轨迹内容必须非空 —— 至少渲染出答案行（answer → .pp-line--answer）
  const answerLine = drawer.locator(".pp-line--answer").first();
  await expect(answerLine).toBeVisible({ timeout: 6000 });
  const answerText = (await answerLine.textContent()) ?? "";
  expect(answerText).toContain("竞品分析初稿");

  // 且工具调用项也应回放出来（tool_call → ToolItem，经 call_id 配对 tool_result）
  await expect(drawer.locator(".pp-line--tool").first()).toBeVisible({ timeout: 4000 });
  const toolText = (await drawer.locator(".pp-line--tool").first().textContent()) ?? "";
  expect(toolText).toContain("竞品对比");

  // 抽屉标题应展示 source 标签与 session key
  await expect(drawer.locator(".drawer-sub")).toContainText("rt:g_demo:w1");
});

test("task_output 产出物溯源：run 类同样可下钻渲染非空轨迹", async ({ page }) => {
  await openGroupDeliverables(page);

  const taskRow = page.locator(".deliv-row.deliv-item", { hasText: "每日竞品价格快照" });
  await expect(taskRow).toBeVisible();
  await taskRow.click();

  const preview = page.locator(".artifact-dock");
  await expect(preview).toBeVisible({ timeout: 4000 });
  const traceBtn = preview.locator(".artifact-trace-btn");
  await expect(traceBtn).toBeVisible();
  await traceBtn.click();

  const drawer = page.locator(".artifact-trace-drawer");
  await expect(drawer).toBeVisible({ timeout: 4000 });
  await expect(drawer.locator(".process-panel")).toBeVisible({ timeout: 4000 });
  // run 溯源也应渲染出非空答案
  await expect(drawer.locator(".pp-line--answer").first()).toBeVisible({ timeout: 6000 });
  // source 标签展示为任务执行 + worker run session key
  await expect(drawer.locator(".drawer-sub")).toContainText("g_demo:w2");
});

test("溯源抽屉内按 Escape 仅关闭轨迹抽屉，不连外层预览一起关", async ({ page }) => {
  await openGroupDeliverables(page);
  await page.locator(".deliv-row.deliv-item", { hasText: "研究员回复" }).click();
  const preview = page.locator(".artifact-dock");
  await expect(preview).toBeVisible({ timeout: 4000 });
  await preview.locator(".artifact-trace-btn").click();
  const drawer = page.locator(".artifact-trace-drawer");
  await expect(drawer).toBeVisible({ timeout: 4000 });

  // 仅关内层：预览仍在
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0, { timeout: 4000 });
  await expect(preview).toBeVisible({ timeout: 4000 });

  // 再按一次才关外层预览
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0, { timeout: 4000 });
});
