/**
 * StreamGate — smart streaming text display strategy.
 *
 * Decides how to render streaming text based on context:
 * - hold: text is accumulating, not yet meaningful — show spinner only
 * - quiet: mid-turn tool activity happening — show in TurnGroup status line
 * - answer: substantial text or turn ended — show as full answer bubble
 * - none: no streaming content
 *
 * Inspired by openworker's streamGate approach.
 */

import type { Item } from "../types";

export type StreamMode = "none" | "hold" | "quiet" | "answer";

/** Word count threshold to promote from hold/quiet to answer */
const ANSWER_WORD_THRESHOLD = 25;

/**
 * Count Chinese characters as "words" (each char ≈ 1 word).
 * For mixed text, count Chinese chars + space-separated tokens.
 */
function countWords(text: string): number {
  const chinese = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const nonChinese = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, "");
  const tokens = nonChinese.trim().split(/\s+/).filter(Boolean).length;
  return chinese + tokens;
}

/**
 * Check if there are active tool calls among recent items.
 */
function hasActiveTools(items: Item[]): boolean {
  return items.some(
    (item) =>
      item.kind === "tool" &&
      (item.status === "running" || item.status === "pending")
  );
}

/**
 * Check if any tool activity happened in this turn.
 */
function hadToolActivity(items: Item[]): boolean {
  return items.some((item) => item.kind === "tool");
}

/**
 * Determine the current stream mode based on streaming text, items, and agent state.
 */
export function streamMode(
  streaming: string,
  items: Item[],
  running: boolean
): StreamMode {
  if (!streaming) return "none";

  const words = countWords(streaming);

  // If substantial text or agent stopped — show as answer
  if (words >= ANSWER_WORD_THRESHOLD || !running) {
    return "answer";
  }

  // If tool activity exists — quiet mode (show in TurnGroup header)
  if (hadToolActivity(items)) {
    return "quiet";
  }

  // Still early — hold (show spinner only)
  return "hold";
}

