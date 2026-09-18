/**
 * 流式 Markdown 分段（Phase 4 / G7）— 纯函数、零 React 依赖。
 *
 * 问题：流式期间 `streamingText` 每帧都在变，`<Markdown>` 每帧全量重解析 +
 * 重布局 —— 5k token 长文连喷 30s 时这是 CLS 与掉帧的主源。
 *
 * 解法：把还在增长的长文本切成「已闭合段 + 活跃尾段」。
 * 已闭合段内容不再变化 → 渲染端 memo 化后**永不重渲染/重解析**；
 * 只有活跃尾段每帧解析，成本从 O(全量) 降到 O(尾段)。
 *
 * 闭合条件（全部满足才允许在此处切断，避免破坏结构语义）：
 *   1. 代码围栏计数平衡（奇数个 ``` 说明代码块未闭合，必须留在尾段）；
 *   2. 下一段不以列表项 / 表格行开头（跨段会碎成单元素列表/表头）；
 *   3. 尾段长度不超 MD_TAIL_CAP（超长代码块/表格兜底强制切断，防尾段无限膨胀）。
 *
 * 不变量：`[...closed, tail].join("\n\n") === text` —— 纯字符串分区，永不丢字。
 */

/** 低于该长度的文本不分段——一次解析足够便宜，省去结构割裂风险。 */
export const MD_SEG_MIN = 200;
/** 活跃尾段上限：超出后强制闭合最老的未闭段（接受一次性的结构重解析）。 */
export const MD_TAIL_CAP = 2000;

/** 下一段是否以列表项 / 表格行开头（这些结构跨段会碎）。 */
function isContinuationStart(s: string): boolean {
  return /^(?:[-*+]\s|\d+[.)]\s|\|)/.test(s.trimStart());
}

/** 流式分段：返回「已闭合段（可 memo）」+「活跃尾段（每帧重解析）」。 */
export function splitStreaming(text: string): { closed: string[]; tail: string } {
  const closed: string[] = [];
  if (text.length <= MD_SEG_MIN) return { closed, tail: text };

  const parts = text.split("\n\n");

  let open = ""; // 尚未闭合的累积段（可能跨多个 part，含未闭围栏）
  let fenceOpen = false;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = parts[i + 1];
    const fences = (part.match(/```/g) || []).length;
    if (fences % 2 === 1) fenceOpen = !fenceOpen;
    open = open ? open + "\n\n" + part : part;

    const canClose = !fenceOpen && !isContinuationStart(next);
    if (canClose) {
      closed.push(open);
      open = "";
    } else if (open.length > MD_TAIL_CAP) {
      // 兜底：围栏/表格持续过长时强制切断（接受一次短暂的结构重解析）
      closed.push(open);
      open = "";
      fenceOpen = false;
    }
  }

  let tail = open ? open + "\n\n" + parts[parts.length - 1] : parts[parts.length - 1];

  // 尾段超限兜底：巨代码块/单段落没有 \n\n 边界时，paragraph 切不动，
  // 尾段会无限膨胀 → 按「\n\n → \n → 放弃」三级优先级循环再切。
  // 注意：行级硬切会引入少量空白差异（可接受），优先保证尾段有界。
  while (tail.length > MD_TAIL_CAP) {
    const re = tail.lastIndexOf("\n\n", MD_TAIL_CAP);
    if (re > 0) {
      closed.push(tail.slice(0, re)); // 跳过 \n\n 分隔符，保持分区语义
      tail = tail.slice(re + 2);
      continue;
    }
    const cut = tail.lastIndexOf("\n", MD_TAIL_CAP);
    if (cut > 0) {
      closed.push(tail.slice(0, cut + 1)); // 含行尾换行
      tail = tail.slice(cut + 1);
      continue;
    }
    break; // 单行超长（无任何换行），无法再切
  }

  return { closed, tail };
}
