import { test, expect } from "@playwright/test";
// Playwright transpiles TS imports → 直接单测前端错误解析层（无需 vitest 基建）
import {
  toStructuredError,
  classifyError,
  friendlyError,
} from "../../src/services/errors";

// ── 解析层单测（纯逻辑，无 DOM）：V5.1 接口契约前端侧 ──

test("结构化错误对象 {code, message} 直接透传", () => {
  const r = toStructuredError({ code: "LLM_TIMEOUT", message: "AI 服务响应超时" });
  expect(r).toEqual({ code: "LLM_TIMEOUT", message: "AI 服务响应超时" });
});

test("历史形态 {error_code, message} 兼容", () => {
  const r = toStructuredError({ error_code: "STORAGE_ERROR", message: "DB down" });
  expect(r.code).toBe("STORAGE_ERROR");
});

test("旧式 Tauri 包装字符串剥离前缀", () => {
  const r = toStructuredError(
    "Error invoking remote method 'create_group': name is required",
  );
  expect(r.code).toBe("UNKNOWN");
  expect(r.message).toBe("name is required");
});

test("裸字符串透传为 UNKNOWN", () => {
  const r = toStructuredError("该群还没有运行记录");
  expect(r.code).toBe("UNKNOWN");
  expect(r.message).toBe("该群还没有运行记录");
});

test("未知类型兜底", () => {
  expect(toStructuredError(undefined).code).toBe("UNKNOWN");
  expect(toStructuredError(null).message.length).toBeGreaterThan(0);
});

test("错误分类", () => {
  expect(classifyError("E_PARAM_INVALID")).toBe("param");
  expect(classifyError("E_AUTH_NOT_CONFIGURED")).toBe("auth");
  expect(classifyError("E_CONFLICT_STATE")).toBe("conflict");
  expect(classifyError("E_NOTFOUND_TARGET")).toBe("notfound");
  expect(classifyError("E_SYSTEM_INTERNAL")).toBe("system");
  expect(classifyError("STORAGE_ERROR")).toBe("system");
  expect(classifyError("LLM_TIMEOUT")).toBe("llm");
  expect(classifyError("UNKNOWN")).toBe("unknown");
});

test("友好文案映射", () => {
  expect(
    friendlyError({ code: "LLM_RATE_LIMIT", message: "x" }),
  ).toContain("稍后重试");
  expect(friendlyError({ code: "CONFIG_ERROR", message: "x" })).toContain("设置");
  expect(
    friendlyError(
      "Error invoking remote method 'group_blackboard_set': 版本冲突：期望版本 0，当前已是版本 1",
    ),
  ).toContain("版本冲突");
});

test("前端防呆：空名时创建按钮不可点（后端错误不可达 = 健康架构）", async ({
  page,
}) => {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
  await page.locator(".splash-screen").waitFor({ state: "detached", timeout: 9000 });
  await page.waitForFunction(() => {
    const s = document.querySelector<HTMLElement>(".sidebar");
    return !!s && s.getBoundingClientRect().width > 200;
  });
  // 与 visual.spec openGroups 同款前置：切群协作模式
  await page.locator(".sidebar-nav-item[data-nav=\"group\"]").click();
  await expect(page.locator(".groups-page")).toBeVisible();
  await page.locator(".sidebar-create-btn").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // 空名（owner 有默认 presets[0]）→ 提交 disabled（前端第一道防呆，后端错误不可达）
  // 主 CTA 文案为「创建协作群」（Apple HIG 要求动词短语，不用泛化的「确定」）
  await expect(dialog.getByRole("button", { name: "创建协作群" })).toBeDisabled();
  // 输入名字后 → enabled（前端校验通过，才轮到后端）
  await dialog.locator("#cg-name").fill("测试群");
  await expect(dialog.getByRole("button", { name: "创建协作群" })).toBeEnabled();
});

import { installTauriMock } from "../helpers/tauriMock";
