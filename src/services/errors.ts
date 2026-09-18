/**
 * 统一错误解析层（V5.1 接口契约落点）
 *
 * 后端 `AgentError` 实现 Serialize → Tauri 2 会把 `Result<_, AgentError>`
 * 命令的错误以 **JSON 对象** `{ code, message }` 返回（而非字符串）：
 *   - code    稳定错误码（SESSION_NOT_FOUND / LLM_TIMEOUT / ... / UNKNOWN）
 *   - message 中文友好文案（后端 user_message() 已生成）
 *
 * 旧式 `Result<_, String>` 命令（尚未迁移的 90 个）错误是 Tauri 包装字符串
 * `Error invoking remote method 'xxx': <原始信息>`——本层兜底剥离前缀，
 * code 归 UNKNOWN，保留原始信息。
 */

export interface StructuredError {
  code: string;
  message: string;
}

/** 前端可程序化判断的错误码大类（按前缀）。 */
export type ErrorClass =
  | "param" // E_PARAM_* / 参数、请求体
  | "auth" // E_AUTH_* / 未配置、未授权（API Key 缺失）
  | "conflict" // E_CONFLICT_* / 版本、状态冲突
  | "notfound" // E_NOTFOUND_* / 目标不存在
  | "system" // E_SYSTEM_* / 内部、存储、引擎
  | "llm" // LLM_* / AI 服务（可重试）
  | "unknown";

/** 把任意 Tauri invoke 抛出的错误解析为结构化 {code, message}。 */
export function toStructuredError(e: unknown): StructuredError {
  // 1) 后端已结构化：{ code, message }
  if (e && typeof e === "object") {
    const obj = e as Record<string, unknown>;
    if (typeof obj.code === "string" && typeof obj.message === "string") {
      return { code: obj.code, message: obj.message };
    }
    // 兼容 { error_code, message }（历史形态）
    if (typeof obj.error_code === "string" && typeof obj.message === "string") {
      return { code: obj.error_code, message: obj.message };
    }
  }
  // 2) 旧式 Tauri String：`Error invoking remote method 'cmd': msg`
  const raw = String(e);
  const stripped = raw.replace(
    /^Error invoking remote method '[^']+':\s*/,
    "",
  );
  return { code: "UNKNOWN", message: stripped || raw };
}

/** 错误分类（前端据此决定展示方式 / 是否重试）。 */
export function classifyError(code: string): ErrorClass {
  if (code.startsWith("E_PARAM")) return "param";
  if (code.startsWith("E_AUTH")) return "auth";
  if (code.startsWith("E_CONFLICT")) return "conflict";
  if (code.startsWith("E_NOTFOUND")) return "notfound";
  if (code.startsWith("E_SYSTEM") || code === "STORAGE_ERROR") return "system";
  if (code.startsWith("LLM_")) return "llm";
  return "unknown";
}

/**
 * 用户友好错误文案。
 * - 后端 message 已是中文 → 直接展示
 * - 已知关键错误码 → 覆盖为更贴合的引导文案
 */
export function friendlyError(e: unknown): string {
  const { code, message } = toStructuredError(e);
  switch (code) {
    case "CONFIG_ERROR":
      return "配置错误，请到设置中检查 API Key 与模型配置";
    case "LLM_RATE_LIMIT":
      return "请求过于频繁，请稍后重试";
    case "LLM_TIMEOUT":
      return "AI 服务响应超时，请重试";
    case "LLM_NETWORK":
      return "网络异常，无法连接 AI 服务，请检查网络";
    case "LLM_ERROR":
      return "AI 服务返回错误，请稍后重试或更换模型";
    case "STORAGE_ERROR":
      return "数据存储异常，操作未能完成";
    default:
      return message || "操作失败，请重试";
  }
}

/** 日志专用：结构化输出（脱敏、紧凑）。 */
export function describeError(e: unknown): string {
  const { code, message } = toStructuredError(e);
  return `[${code}] ${message}`;
}
