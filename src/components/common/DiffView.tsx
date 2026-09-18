/**
 * DiffView — 共享行级 diff 组件（ADR-021 §8.1 / Cursor 展示形态）。
 * 用 LCS 对 before/after 内容做行级对比，红删绿增（双通道：+/− 符号 + 着色）。
 * 退化边界（ADR-021 §10）：大文件 / 二进制 / 历史行（after 缺失）。
 * 群级 ChangesetPanel 后续亦复用本组件，逻辑不重复。
 *
 * 2026-08-15：增加 Codex 风格折叠——连续未修改行只保留变更块前后的上下文，
 * 中间折叠为 "N unmodified lines"，并显示 before/after 行号。
 */
import React, { useMemo } from "react";

export type DiffType = "ctx" | "add" | "del" | "fold";
export interface DiffLine {
  type: DiffType;
  text: string;
  /** 折叠块内被折叠的原始上下文行数。 */
  folded?: number;
}

export interface DiffSummary {
  add: number;
  del: number;
  /** 近似替换块数 = min(add, del)（Grok 风格 ~M）。 */
  mod: number;
}

export interface DiffViewProps {
  /** 写盘前内容（null = 新建文件 / 二进制 / 历史行）。 */
  before: string | null;
  /** 写盘后内容（null = 二进制 / 历史行无快照）。 */
  after: string | null;
  /** caller 已判定过大，直接走退化。 */
  large?: boolean;
}

const MAX_LINES = 2000;
const MAX_BYTES = 500 * 1024;
const FOLD_CONTEXT = 3;
const MIN_FOLD = 3;

function splitLines(s: string): string[] {
  return s.split("\n");
}

/** 经典 LCS（行级），扁平 Int32Array 全量 DP（受 MAX_LINES 守护，防 O(n·m) 内存爆炸）。 */
function lcsLines(b: string[], a: string[]): DiffLine[] {
  const n = b.length;
  const m = a.length;
  const W = m + 1;
  const dp = new Int32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] =
        b[i] === a[j]
          ? dp[(i + 1) * W + (j + 1)] + 1
          : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (b[i] === a[j]) {
      out.push({ type: "ctx", text: b[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) {
      out.push({ type: "del", text: b[i] });
      i++;
    } else {
      out.push({ type: "add", text: a[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: b[i++] });
  while (j < m) out.push({ type: "add", text: a[j++] });
  return out;
}

export function summarize(lines: DiffLine[]): DiffSummary {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.type === "add") add++;
    else if (l.type === "del") del++;
  }
  return { add, del, mod: Math.min(add, del) };
}

/** 把连续未修改行折叠，只在每个变更块前后保留 FOLD_CONTEXT 行上下文。 */
function foldContext(lines: DiffLine[]): DiffLine[] {
  // 找到所有变更行索引
  const changeIdxs: number[] = [];
  lines.forEach((l, i) => {
    if (l.type === "add" || l.type === "del") changeIdxs.push(i);
  });
  if (changeIdxs.length === 0) return lines;

  const keep = new Set<number>();
  // 保留文件首尾少量上下文，让阅读有锚点
  for (let i = 0; i < Math.min(FOLD_CONTEXT, lines.length); i++) keep.add(i);
  for (let i = Math.max(0, lines.length - FOLD_CONTEXT); i < lines.length; i++) keep.add(i);

  changeIdxs.forEach((idx) => {
    for (let i = Math.max(0, idx - FOLD_CONTEXT); i <= Math.min(lines.length - 1, idx + FOLD_CONTEXT); i++) {
      keep.add(i);
    }
  });

  const out: DiffLine[] = [];
  let foldStart = -1;
  let foldCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      if (foldCount >= MIN_FOLD) {
        out.push({ type: "fold", text: `${foldCount} unmodified lines`, folded: foldCount });
      } else if (foldCount > 0) {
        for (let k = foldStart; k < foldStart + foldCount; k++) out.push(lines[k]);
      }
      foldCount = 0;
      foldStart = -1;
      out.push(lines[i]);
    } else {
      if (foldStart === -1) foldStart = i;
      foldCount++;
    }
  }
  if (foldCount >= MIN_FOLD) {
    out.push({ type: "fold", text: `${foldCount} unmodified lines`, folded: foldCount });
  } else if (foldCount > 0) {
    for (let k = foldStart; k < foldStart + foldCount; k++) out.push(lines[k]);
  }
  return out;
}

export function DiffView({ before, after, large }: DiffViewProps) {
  const { lines, note } = useMemo(() => {
    // 退化边界
    if (large) return { lines: null as DiffLine[] | null, note: "文件过大，请在编辑器中查看。" };
    if (before === null && after === null)
      return { lines: null, note: "二进制文件，不支持 diff。" };
    if (before !== null && after === null)
      return { lines: null, note: "升级前数据无改动后快照，无法生成 diff。" };
    const b = splitLines(before ?? "");
    const a = splitLines(after ?? "");
    if (b.length > MAX_LINES || a.length > MAX_LINES || before!.length > MAX_BYTES || after!.length > MAX_BYTES)
      return { lines: null, note: "文件过大，请在编辑器中查看。" };
    const raw = lcsLines(b, a);
    const folded = foldContext(raw);
    return { lines: folded, note: null as string | null };
  }, [before, after, large]);

  const rendered = useMemo(() => {
    if (!lines) return null;
    // 重建 before/after 行号：按原始 diff 语义遍历 folded 后的行
    let beforeLine = 0;
    let afterLine = 0;
    return lines.map((l, i) => {
      let oldNum: number | null = null;
      let newNum: number | null = null;
      if (l.type === "ctx") {
        beforeLine++;
        afterLine++;
        oldNum = beforeLine;
        newNum = afterLine;
      } else if (l.type === "del") {
        beforeLine++;
        oldNum = beforeLine;
      } else if (l.type === "add") {
        afterLine++;
        newNum = afterLine;
      }
      return { ...l, oldNum, newNum, key: i };
    });
  }, [lines]);

  if (note) {
    return <div className="run-cs-binary-note">{note}</div>;
  }
  if (!lines || lines.length === 0) {
    return <div className="run-cs-binary-note">内容相同，无差异。</div>;
  }
  const { add, del, mod } = summarize(lines);
  return (
    <div className="run-cs-diff">
      <div className="run-cs-diff-summary" aria-hidden="true">
        <span>共 {lines.length} 行改动</span>
        <span className="run-cs-sum add">+{add}</span>
        <span className="run-cs-sum mod">~{mod}</span>
        <span className="run-cs-sum del">−{del}</span>
      </div>
      <div className="run-cs-code" tabIndex={0} role="region" aria-label="diff">
        <div className="run-cs-code-head" aria-hidden="true">
          <span className="run-cs-gutter run-cs-gutter-sign">±</span>
          <span className="run-cs-gutter run-cs-gutter-old">old</span>
          <span className="run-cs-gutter run-cs-gutter-new">new</span>
          <span className="run-cs-line-content" />
        </div>
        {rendered?.map((l) => {
          if (l.type === "fold") {
            return (
              <div key={`fold-${l.key}`} className="run-cs-line fold">
                <span className="run-cs-gutter run-cs-gutter-sign" aria-hidden="true">⋯</span>
                <span className="run-cs-gutter run-cs-gutter-old" />
                <span className="run-cs-gutter run-cs-gutter-new" />
                <span className="run-cs-line-content run-cs-fold-text">{l.folded} unmodified lines</span>
              </div>
            );
          }
          const sign = l.type === "add" ? "+" : l.type === "del" ? "−" : " ";
          return (
            <div key={`line-${l.key}`} className={`run-cs-line ${l.type}`}>
              <span className="run-cs-gutter run-cs-gutter-sign" aria-hidden="true">{sign}</span>
              <span className="run-cs-gutter run-cs-gutter-old">{l.oldNum ?? ""}</span>
              <span className="run-cs-gutter run-cs-gutter-new">{l.newNum ?? ""}</span>
              <span className="run-cs-line-content">{l.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default DiffView;
