import type { Item } from "../../types";

/**
 * 上下文用量统计（输入栏环形指示器用）。
 *
 * ⚠️ 说明：项目内核未暴露会话级「真实上下文 token」查询命令，此处为**前端估算**：
 * - usedTokens：会话内全部文本（用户/助手/思考/工具/通知 + 正在流式内容）按字符数 ≈/4 折算；
 * - contextWindow：按当前模型查表取近似窗口上限（官方口径随版本变动，仅作 UI 估算）；
 * - turns：用户消息条数（一轮一问一答）。
 * 该数据仅用于用量可视化与提醒，不代表精确计费/真实 prompt 长度。
 */
export interface ContextStats {
  /** 已用 token（估算） */
  usedTokens: number;
  /** 模型上下文窗口上限（估算） */
  contextWindow: number;
  /** 当前会话轮次（用户消息数） */
  turns: number;
}

/** 模型 → 上下文窗口近似值（tokens）。不在表内的模型回落 DEFAULT_CONTEXT_WINDOW。 */
const MODEL_CONTEXT_WINDOW: Record<string, number> = {
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  // DeepSeek
  "deepseek-v4-pro": 128_000,
  "deepseek-v4": 128_000,
  "deepseek-v4-flash": 128_000,
  "deepseek-chat": 64_000,
  "deepseek-reasoner": 64_000,
  // 千问
  "qwen3-max": 32_000,
  "qwen3-plus": 131_072,
  "qwen3-turbo": 131_072,
  // 智谱
  "glm-5": 128_000,
  "glm-5-air": 128_000,
  "glm-4-plus": 128_000,
  // 月之暗面
  "kimi-k2": 256_000,
  "kimi-k2-turbo": 256_000,
  // MiniMax
  "MiniMax-M2": 200_000,
  "MiniMax-Text-01": 200_000,
};

/** 未知/自定义模型的兜底窗口。 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 按模型取上下文窗口上限。 */
export function contextWindowForModel(model?: string): number {
  return (model && MODEL_CONTEXT_WINDOW[model]) || DEFAULT_CONTEXT_WINDOW;
}

/** 粗略 token 估算：中英混合约 4 字符/token。 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 按字符总量折算 token（流式内容与条目文本合计后的统一入口）。 */
function estimateTokensOfChars(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * 从当前会话条目估算上下文用量。
 * @param items          会话时间轴条目
 * @param streamingText  正在流式的正文（未落 item）
 * @param reasoningStream 正在流式的思考内容（未落 item）
 * @param model          当前模型（决定窗口上限）
 */
export function estimateContextStats(
  items: Item[],
  streamingText: string,
  reasoningStream: string,
  model?: string,
): ContextStats {
  let chars = streamingText.length + reasoningStream.length;
  let turns = 0;
  for (const it of items) {
    switch (it.kind) {
      case "user":
        chars += it.text.length;
        turns += 1;
        break;
      case "assistant":
        chars += (it.text?.length ?? 0) + (it.reasoning?.length ?? 0);
        break;
      case "thinking":
        chars += it.content?.length ?? 0;
        break;
      case "tool":
        chars += (it.args?.length ?? 0) + (it.result?.length ?? 0);
        break;
      case "notice":
        chars += it.text.length;
        break;
      default:
        // approval / plan / question / waiting / connector：不计入（占位性内容）
        break;
    }
  }
  return {
    usedTokens: estimateTokensOfChars(chars),
    contextWindow: contextWindowForModel(model),
    turns,
  };
}

/** 友好数字：≥1000 显示 k（1 位小数），否则原样。 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
