import { test, expect } from "@playwright/test";
import { installTauriMock } from "../helpers/tauriMock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
});

/**
 * 验证「纯思考无工具」场景下思考过程是否正常渲染（非空白）。
 *
 * 统一渲染契约（2026-08-11）：无论有工具还是纯推理，CoT 一律走 ProcessPanel
 * 的「查看过程」风格 —— 不再有独立的 ThinkingLayer「模型思考过程」折叠头。
 * 因此纯推理回合的推理行是 `.pp-line--thinking`（ProcessPanel 时间轴一员），
 * done 态由 `.process-panel--done` 提供「查看过程」入口。
 *
 * 复现用户反馈：模型只思考不调用工具时，「思考过程」区域空白/串味成「模型思考过程」。
 * 修复点：
 *  1. MessageList 纯思考无工具时不再剔除 thinking item，统一交给 ProcessPanel；
 *  2. AnswerBubble 不再用 ThinkingLayer 渲染推理（消除切换 session 状态错乱）。
 *
 * 通过注入式 Tauri mock 的 send_message 回放 Thinking + Done 事件流驱动真实 React 组件。
 */
test("纯思考无工具：思考过程实时可见且内容非空", async ({ page }) => {
  const input = page.locator("textarea");
  await expect(input).toBeVisible({ timeout: 8000 });

  await input.fill("请只思考、不要调用工具地回答我一个问题");
  await input.press("Enter");

  // 思考阶段：ProcessPanel 的 thinking 行应出现（纯推理统一走「查看过程」风格）
  const thinkLine = page.locator(".pp-line--thinking").first();
  await expect(thinkLine).toBeVisible({ timeout: 6000 });

  // 等待流结束（Done → 助手回答气泡出现）
  await expect(page.locator(".message-bubble.assistant")).toBeVisible({ timeout: 6000 });

  // 关键回归断言：答案文本必须显示，不能因 buildTurns 的 while-pop 被丢弃
  const answerText = (await page.locator(".message-bubble.assistant").first().textContent()) ?? "";
  expect(answerText).toContain("验证完成");

  // done 态：ProcessPanel 提供「查看过程」入口（与有工具回合一视同仁）
  const panel = page.locator(".process-panel--done").first();
  await expect(panel).toBeVisible();
  const toggle = panel.locator(".pp-toggle");
  await expect(toggle).toHaveText("查看过程");

  // 展开后思考内容非空（验证不是空白框）：先点「查看过程」，再点思考头展开内容
  await toggle.click();
  await expect(panel.locator(".pp-list .pp-line--thinking").first()).toBeVisible();
  await panel.locator(".pp-line--thinking .pp-row--thinking").first().click();
  const text = (await panel.locator(".pp-line--thinking .pp-text--think").first().textContent()) ?? "";
  expect(text.trim().length).toBeGreaterThan(0);
});

/**
 * 反向验证：空白 reasoning 不应渲染思考块（避免空白框 bug 回归）。
 */
test("空白 reasoning 不渲染思考块", async ({ page }) => {
  const input = page.locator("textarea");
  await expect(input).toBeVisible({ timeout: 8000 });

  // content 含 [blank] 时 mock 回放空白 Thinking + Done
  await input.fill("触发 [blank] 空白思考");
  await input.press("Enter");

  // 整个流结束后，答案正常显示，且不应出现任何思考过程行
  // （ThinkingLayer 已移除；空白推理在策略层被拦截，ProcessPanel 也不出现空行）
  await expect(page.locator(".message-bubble.assistant")).toBeVisible({ timeout: 6000 });
  await expect(page.locator(".tb")).toHaveCount(0, { timeout: 6000 });
  await expect(page.locator(".pp-line--thinking")).toHaveCount(0, { timeout: 6000 });
});

/**
 * ⚠️ 2026-08-17 折叠语义变更：本测试描述的行为已撤销。
 *
 * 旧语义（2026-08-11）：`answering`（mode==="answer"）触发 `shouldCollapse` →
 * 答案一开始输出过程流即收起为「查看过程」（不等 Done）。
 * 问题：LLM 答题中仍 live，若中途切回工具(answering=false)→ 展开，再答→
 * 又折叠 → live↔done 反复切换，肉眼闪烁。
 *
 * 新语义：`shouldCollapse = !hasAnyError && !live && effectivelyDone`。answering 不再
 * 参与折叠决策，折叠只看「回合级生命周期」(live↔done)。答题期间过程流保持展开，
 * 仅回合真正结束 (!live + effectivelyDone) 才收起。故下方测试名/断言需复核——其
 * 验证的「答题即折叠」在当前实现中不再成立（改为「答题期间不折叠」）。
 */
test("答案开始输出时过程流立即收起（不等待 Done）", async ({ page }) => {
  const input = page.locator("textarea");
  await expect(input).toBeVisible({ timeout: 8000 });

  await input.fill("触发 [answer-collapse] 长回答");
  await input.press("Enter");

  // 思考阶段：live 展开，深度思考内容包在可滚动框里渲染
  const cotBox = page.locator(".process-panel--live .pp-cot-box");
  await expect(cotBox).toBeVisible({ timeout: 6000 });

  // 答案开始流式输出（live 答案气泡出现）——此时过程流应立即收起
  const liveAnswer = page.locator(".message-row.assistant .message-bubble.assistant");
  await expect(liveAnswer).toBeVisible({ timeout: 6000 });

  // 关键回归：答案输出期间，过程流已不是 live 展开态，而是 done 折叠态（「查看过程」）
  await expect(page.locator(".process-panel--live")).toHaveCount(0, { timeout: 6000 });
  await expect(page.locator(".process-panel--done")).toBeVisible({ timeout: 6000 });
  await expect(page.locator(".process-panel--done .pp-toggle")).toHaveText("查看过程");

  // 点开后仍能看到带框的深度思考内容（需先点思考头展开）
  await page.locator(".process-panel--done .pp-toggle").click();
  await page.locator(".process-panel--done .pp-line--thinking .pp-row--thinking").first().click();
  await expect(page.locator(".process-panel--done .pp-line--thinking .pp-cot-box")).toBeVisible({ timeout: 6000 });
});
