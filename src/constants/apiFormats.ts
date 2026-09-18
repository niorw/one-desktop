// ── 模型供应 API 端点格式（与参考图下拉列表一致，2026-09-02 立） ──
//
// 参考图（Cherry Studio）下拉包含 3 项协议端点：
//   · Anthropic Messages (/v1/messages)
//   · Chat Completions (/chat/completions)
//   · Responses (/responses)
//
// 当前后端仅消费 Chat Completions 一种格式（ReasoningDialect 决定请求路由）；
// 这里新增的 `apiFormat` 是**纯前端 UI 字段**，用于展示用户所选端点，
// 后端暂不读取。后端路由能力后续扩展时再接上。
//
// ────────────────────────────────────────────────────────────────────────────

export type ApiFormat = "anthropic-messages" | "chat-completions" | "responses";

export const DEFAULT_API_FORMAT: ApiFormat = "chat-completions";

/** 端点格式 → 端点 URL 后缀（与后端 consume 路径对齐时使用）。 */
export const API_FORMAT_ENDPOINT: Record<ApiFormat, string> = {
  "anthropic-messages": "/v1/messages",
  "chat-completions": "/chat/completions",
  responses: "/responses",
};
