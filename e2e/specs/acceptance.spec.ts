/**
 * §9 最小可痛验证清单 — E2E 回归固化（docs/design/thinking-visualization-audit.md §9）
 *
 * 六条验收 → 本文件五条（第 6 条「导出物不含 USER.md 画像」已在 Rust 端实现并由
 * `commands/redact.rs` + `commands/insight.rs` 单测锁定，见下）。
 *
 *  1. [tools3]     同一回合连调 3 次 run_command → 三条结果回填对应行（G1 call_id 配对）
 *  2. [two-think]  一轮内两段独立思考 → 渲染为两个思考段（G5 ThinkingEnd 分段）
 *  3. [cot-5k]     超长 CoT 行钳制 + [many-steps] 长会话分片（Phase 4 / G7 结构性验证）
 *  4. 切会话再切回 → 已落库时间轴（工具行/结果配对/观察/答案）与切走前一致（G1 seq 派生）
 *  5. [narration]  最后一个工具后先观察再答 → 观察进 ProcessPanel、答案进气泡（narration）
 *  6. [file-edit]  WorkBuddy 风格行动叙述：文件工具行渲染「可点击文件名 + +N −M」diff 统计
 *  7. 导出脱敏     Rust 单测覆盖（commands/redact.rs 8 条 + insight.rs 3 条），E2E 不重复
 *
 * 已知边界（G2 现状）：思考段不单独落库（reasoning_content 挂 assistant 消息），
 * 回放后思考行不重建——验收 4 只断言已落库部分，思考行缺失属已知缺口。
 */
import { test, expect } from "@playwright/test";
import { installTauriMock } from "../helpers/tauriMock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // 思考层密度设为 expanded：本清单验收「行内容正确」而非「折叠头」交互，
    // 用 expanded 避免额外点击思考头（collapsed 密度下会渲染为「深度思考 >」头）。
    localStorage.setItem("mock_setting_thinking_density", "expanded");
  });
  await page.addInitScript(installTauriMock);
  await page.goto("/");
});

/** 输入并等待回合完成（答案气泡出现 = Done 已落地）。 */
async function sendAndWaitAnswer(page: import("@playwright/test").Page, prompt: string) {
  const input = page.locator("textarea");
  await expect(input).toBeVisible({ timeout: 8000 });
  await input.fill(prompt);
  await input.press("Enter");
  try {
    await expect(page.locator(".message-bubble.assistant").first()).toBeVisible({ timeout: 10000 });
  } catch (e) {
    // 诊断 dump：失败时输出页面关键状态
    const dump = await page.evaluate(() => ({
      rootChildren: document.getElementById("root")?.children.length,
      bubbleTypes: Array.from(document.querySelectorAll(".message-bubble")).map((el) => el.className),
      turnCount: document.querySelectorAll(".assistant-turn").length,
      toggleText: document.querySelector(".pp-toggle")?.textContent ?? null,
      bodyTail: document.body.innerText.slice(-200),
    }));
    console.error("[§9 dump]", JSON.stringify(dump));
    throw e;
  }
}

/** done 态默认折叠：展开过程流（点击「查看过程」）。 */
async function expandProcess(page: import("@playwright/test").Page) {
  const toggle = page.locator(".pp-toggle");
  await expect(toggle).toBeVisible({ timeout: 6000 });
  await toggle.click();
}

// ── TTFT 空窗占位：发送后、首个事件前占位必须可见 ──
// 回归：waiting 占位曾被 buildTurns 无工具轮剔除 → 发命令后聊天区空白好几秒
//（用户感知「没反应」）；修复后占位绕过剔除，长首 token 延迟期间有零延迟反馈。
// 两阶段过场：初始「思考中」→ ~400ms 后「等待模型响应」（spinner + 文案淡入）。
test("TTFT 空窗期占位可见（思考中 → 等待模型响应 两阶段过场）", async ({ page }) => {
  const input = page.locator("textarea");
  await expect(input).toBeVisible({ timeout: 8000 });
  await input.fill("[slow-start] 模拟长等待");
  await input.press("Enter");

  // 阶段一：提交后立即可见「思考中」（首事件延迟 800ms，此窗口内足够捕获）
  const waiting = page.locator(".pp-line--waiting").first();
  await expect(waiting).toBeVisible({ timeout: 700 });
  await expect(waiting).toContainText("思考中", { timeout: 700 });

  // 阶段二：~400ms 后过渡为「等待模型响应」
  await expect(waiting).toContainText("等待模型响应", { timeout: 1500 });

  // 首事件到达后占位移除、回合正常完成（thinking 行密度相关，不在此强约束）
  await expect(page.locator(".message-bubble.assistant")).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".pp-line--waiting")).toHaveCount(0, { timeout: 3000 });
});

// ── §9-1：同一回合连调 3 次 run_command → 三条结果回填对应行 ──
test("§9-1 三次 run_command 结果按 call_id 回填对应行", async ({ page }) => {
  await sendAndWaitAnswer(page, "[tools3] 连续执行三个命令");
  await expandProcess(page);

  // 3 个工具行（同一工具名 run_command 调 3 次）
  const toolLines = page.locator(".pp-line--tool");
  await expect(toolLines).toHaveCount(3, { timeout: 6000 });

  // 逐个点开查看执行结果
  for (let i = 0; i < 3; i++) {
    await toolLines.nth(i).locator(".pp-row").click();
  }
  const texts = await page.locator(".term-output").allTextContents();
  // 行序 = 事件序（run-1 → run-2 → run-3），结果必须一一对应；
  // 若名字反查错配，三行会全部命中最后一条结果（全 three）。
  expect(texts.length).toBe(3);
  expect(texts[0]).toContain("输出：one");
  expect(texts[1]).toContain("输出：two");
  expect(texts[2]).toContain("输出：three");
});

// ── §9-2：一轮内模型吐两段独立思考 → 渲染为两个思考段 ──
test("§9-2 一轮内两段思考渲染为两个思考段（非粘连）", async ({ page }) => {
  await sendAndWaitAnswer(page, "[two-think] 分两段思考");
  await expandProcess(page);

  // 两个独立思考行（G5：ThinkingEnd 关段；粘连会变成 1 行）
  const thinkLines = page.locator(".pp-line--thinking");
  const thinkCount = await thinkLines.count();
  if (thinkCount !== 2) {
    console.error("[§9-2 think dump]", JSON.stringify(await thinkLines.allTextContents()));
  }
  await expect(thinkLines).toHaveCount(2, { timeout: 6000 });
  const t0 = (await thinkLines.nth(0).textContent()) ?? "";
  const t1 = (await thinkLines.nth(1).textContent()) ?? "";
  expect(t0).toContain("第一段思考");
  expect(t1).toContain("第二段思考");
});

// ── §9-3a：超长 CoT（5k 字）→ 思考框可滚动（替代原行钳制 + 展开全部）──
test("§9-3a 超长 CoT 包进可滚动思考框（内容完整不截断）", async ({ page }) => {
  await sendAndWaitAnswer(page, "[cot-5k] 超长思考");
  await expandProcess(page);

  // 深度思考内容包进 .pp-cot-box（最大高度 + 框内滚动），不丢字。
  const box = page.locator(".pp-line--thinking .pp-cot-box");
  await expect(box).toHaveCount(1, { timeout: 6000 });
  const text = (await page.locator(".pp-line--thinking .pp-text--think").textContent()) ?? "";
  expect(text.length).toBeGreaterThan(3000);
});

// ── §9-3b：长会话（205 工具步）→ 分片提示条（Phase 4 / G7）──
test("§9-3b 长会话过程流分片（尾部窗口 + 显示全部）", async ({ page }) => {
  await sendAndWaitAnswer(page, "[many-steps] 205 步长流程");
  await expandProcess(page);

  const shard = page.locator(".pp-shard");
  await expect(shard).toBeVisible({ timeout: 6000 });
  const shardText = (await shard.textContent()) ?? "";
  expect(shardText).toContain("已折叠");
  expect(shardText).toContain("显示全部");
});

// ── §9-4：跑到一半切会话再切回 → 已落库时间轴与切走前一致 ──
test("§9-4 切会话再切回：已落库时间轴（工具行/结果/观察/答案）一致", async ({ page }) => {
  // s1：跑一个工具回合
  await sendAndWaitAnswer(page, "[tools3] 会话A的任务");
  await expandProcess(page);
  await expect(page.locator(".pp-line--tool")).toHaveCount(3, { timeout: 6000 });

  // 新建 s2（点击顶部「新建任务」导航）并跑另一轮
  await page.locator(".sidebar-nav-item[data-nav=\"chat\"]").click();
  await sendAndWaitAnswer(page, "[two-think] 会话B的思考");

  // 切回 s1：点「非当前 active」的会话（当前 active=s2，另一个必是 s1）。
  // 不用 nth 定位——sessions 顺序受 loadSessions 刷新影响（mock append 顺序
  // [s1, s2] vs 前端 prepend [s2, s1]），按 active 态定位与顺序无关。
  const items = page.locator(".session-item");
  await expect(items).toHaveCount(2, { timeout: 6000 });
  await page.locator(".session-item:not(.active)").first().click();

  // 回放自 get_messages：3 工具行 + 结果配对 + 观察 + 答案
  await expandProcess(page);
  const toolLines = page.locator(".pp-line--tool");
  await expect(toolLines).toHaveCount(3, { timeout: 8000 });
  for (let i = 0; i < 3; i++) {
    await toolLines.nth(i).locator(".pp-row").click();
  }
  const texts = await page.locator(".term-output").allTextContents();
  expect(texts.length).toBe(3);
  expect(texts[0]).toContain("one");
  expect(texts[1]).toContain("two");
  expect(texts[2]).toContain("three");

  // 观察行在过程流（回放时 markNarrations 按位置推断：工具间 assistant 文字 = 观察）
  const observe = page.locator(".pp-text--observe");
  await expect(observe.first()).toBeVisible({ timeout: 6000 });
  expect(((await observe.first().textContent()) ?? "")).toContain("第一个命令执行成功");

  // 答案气泡在（未被观察挤占）
  await expect(page.locator(".message-bubble.assistant").first()).toContainText("全部完成", { timeout: 6000 });
});

// ── §9-5：最后一个工具后先观察再答 → 观察进过程、答案进气泡 ──
test("§9-5 工具后观察进 ProcessPanel，答案进气泡（不判反）", async ({ page }) => {
  await sendAndWaitAnswer(page, "[narration] 观察后回答");
  await expandProcess(page);

  // 观察行（「17/18 断言通过」）在过程流里
  const observe = page.locator(".pp-text--observe");
  await expect(observe.first()).toBeVisible({ timeout: 6000 });
  const observeText = (await observe.first().textContent()) ?? "";
  expect(observeText).toContain("17/18");

  // 答案气泡不含观察文本（观察未被提升成答案）
  const answer = page.locator(".message-bubble.assistant").first();
  const answerText = (await answer.textContent()) ?? "";
  expect(answerText).toContain("修复完成");
  expect(answerText).not.toContain("17/18");
});

// ── §9-6：文件工具行 → WorkBuddy 风格「动作 + 可点击文件名 + diff 统计」──
// 复制 WorkBuddy 设计逻辑：编辑类工具行显示「编辑 ProcessPanel.tsx」，文件名是可点击
// 链接（点击用系统默认程序打开），done 态带改动行数「+3 −2」。回归：humanize 重构后
// edit_file 曾落入通用兜底渲染成丑陋的「edit_file path=...」，且缺失可点击链接与 diff。
test("§9-6 文件工具行：可点击文件名 + diff 统计（WorkBuddy 风格）", async ({ page }) => {
  await sendAndWaitAnswer(page, "[file-edit] 编辑文件");
  await expandProcess(page);

  // 工具行渲染可点击文件名链接（a11y：role=link + 键盘可达 + title 含完整路径）
  const link = page.locator(".pp-file-link");
  await expect(link).toBeVisible({ timeout: 6000 });
  expect((await link.textContent()) ?? "").toContain("ProcessPanel.tsx");
  const title = (await link.getAttribute("title")) ?? "";
  expect(title).toContain("src/components/ProcessPanel.tsx");

  // done 态文件写入带 diff 统计：新增 3 行、移除 2 行
  await expect(page.locator(".pp-diff-add")).toHaveText("+3", { timeout: 6000 });
  await expect(page.locator(".pp-diff-del")).toHaveText("−2", { timeout: 6000 });
});
