import { useEffect, useRef, useMemo, memo, type ReactNode } from "react";
import type { Item, ToolItem, AssistantItem, PermissionMode } from "../../types";
import { ProcessPanel } from "./ProcessPanel";
import { MessageActions } from "./MessageActions";
import { ThinkingDots } from "../common/ThinkingDots";
import { useI18n } from "../../i18n/I18nProvider";
import { Markdown, SegmentedMarkdown } from "../../utils/markdown";
import { SquareLogo } from "../common/SquareLogo";
import { streamMode } from "../../utils/streamGate";
import { useSettings } from "../../hooks/useSettings";
import { usePreview } from "../artifacts/PreviewProvider";
import { RunArtifactsEntry } from "./RunArtifactsEntry";
import { Icons } from "../common/Icons";
import { splitAttachmentLines } from "../../utils/attachments";

// ── Turn grouping (matching openworker's flush logic) ──

interface Turn {
  userText?: string;
  turnItems: Item[];       // tools + narrations (for TurnGroup)
  answerItem?: AssistantItem; // trailing assistant (rendered as bubble outside)
  notices: Item[];          // notices after the turn
}

function buildTurns(items: Item[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn = { turnItems: [], notices: [] };

  /**
   * turn 收尾：思考（thinking）是回合核心内容，**任何回合都保留** —— 无论有工具
   * 还是纯推理，统一交给 ProcessPanel 的「查看过程」渲染，不再区分对待。
   * （此前纯推理轮剔除 thinking、改由 AnswerBubble 的 ThinkingLayer 渲染，导致
   * 与 ProcessPanel 视觉割裂 + 切换 session 时 ThinkingLayer 状态错乱「串味」；
   * 现统一收口到 ProcessPanel。）
   *
   * **waiting 占位（「深度思考中…」）不剔除**：它是 sendMessage 后、首个事件
   * （Thinking/ToolCall/Token）到达前的零延迟占位，必须绕过剔除才能在 TTFT
   * 空窗期可见（此前被剔 → 发命令后聊天区空白好几秒，用户感知「没反应」）。
   * 占位与 thinking 天然互斥：waiting 在首个事件时被 removeWaitingItems 移除，
   * 此时 thinking 才出现，不会同屏冲突。
   */
  const finishTurn = (t: Turn): Turn => t;

  for (const item of items) {
    if (item.kind === "user") {
      if (current.turnItems.length > 0 || current.userText) turns.push(finishTurn(current));
      current = { userText: item.text, turnItems: [], notices: [] };
    } else if (
      item.kind === "tool" ||
      item.kind === "assistant" ||
      // Phase 1-4：思考/等待是一等公民时间轴条目，进 turnItems 交给 ProcessPanel
      // （此前 buildTurns 丢弃 thinking → 有工具轮里思考行从未渲染，§9-2 E2E 暴露）。
      item.kind === "thinking" ||
      item.kind === "waiting"
    ) {
      current.turnItems.push(item);
    } else if (item.kind === "notice" || item.kind === "connector") {
      current.notices.push(item);
    }
  }
  if (current.userText || current.turnItems.length > 0) turns.push(finishTurn(current));

  // For each turn, extract the trailing assistant item(s) as the "answer"
  // Same logic as openworker: when turn has non-assistant items, keep the last
  // assistant as narration/status (don't pop), otherwise pop trailing assistants.
  for (const turn of turns) {
    const hasTools = turn.turnItems.some(it => it.kind === "tool");
    if (hasTools) {
      // Keep trailing assistants inside TurnGroup (they're narrations)
      // For the LIVE (last) turn, we'll handle separately
    } else {
      // No tools: pop trailing assistants, but DON'T discard the real answer text.
      // Done handler may push two assistant items for a pure-thinking turn:
      //   { text: "", reasoning }  (thinking narration) + { text: finalText } (answer)
      // The original `while` popped ALL of them and let the last (empty-text
      // thinking narration) overwrite answerItem, dropping the answer → blank bubble.
      // Fix: collect them, merge earlier reasoning into the final answer's
      // `reasoning`, and keep that answer's text intact.
      const trailing: AssistantItem[] = [];
      while (turn.turnItems.length > 0 && turn.turnItems[turn.turnItems.length - 1].kind === "assistant") {
        trailing.push(turn.turnItems.pop() as AssistantItem);
      }
      if (trailing.length > 0) {
        // pop() drains from the END, so the FIRST item popped (trailing[0])
        // is the last assistant in the array = the real answer (has text).
        // Earlier-popped ones (trailing[1..]) are thinking narrations (text empty,
        // reasoning set) and must be merged into the answer's `reasoning`.
        const answer = trailing[0];
        const mergedReasoning = trailing
          .slice(1)
          .map((t) => t.reasoning || "")
          .join("\n\n")
          .trim();
        turn.answerItem = mergedReasoning
          ? { ...answer, reasoning: mergedReasoning }
          : answer;
      }
    }
  }

  return turns;
}

// ���─ AnswerBubble ──

/**
 * 用户消息气泡：剥离 `[附件] path` 文本协议块，正文 + 附件卡片（点击走全局预览）。
 * 纯展示增量，不触碰流式/事件链路。
 */
const UserMessageBubble = memo(function UserMessageBubble({ text }: { text: string }) {
  const { openPreview } = usePreview();
  const { body, paths } = useMemo(() => splitAttachmentLines(text), [text]);
  if (!body && paths.length === 0) return null;
  return (
    <div className="message-row user group-start">
      <div className="message-bubble user">
        {body && <span>{body}</span>}
        {paths.length > 0 && (
          <div className="chat-msg-attachments">
            {paths.map((p) => (
              <button
                key={p}
                type="button"
                className="chat-msg-attach"
                onClick={() => openPreview({ filePath: p })}
                title={p}
              >
                <Icons.Paperclip size={12} />
                <span className="chat-msg-attach-name">{p.split(/[\\/]/).pop()}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

const AnswerBubble = memo(function AnswerBubble({
  item, onRegenerate, isLastAnswer, isStreaming,
}: {
  item: AssistantItem;
  onRegenerate?: () => void;
  isLastAnswer?: boolean;
  isStreaming?: boolean;
}) {
  const { openPreview } = usePreview();

  return (
    <div className="message-row assistant group-start">
      <div className="message-bubble assistant">
        {item.text.trim().length > 0 && (
          <Markdown onFileLink={(p) => openPreview({ filePath: p })}>{item.text}</Markdown>
        )}
        {item.isStreaming && isStreaming && <ThinkingDots />}
        {/* 流式期间的答案未定型：不展示操作栏，避免对半截文本复制/点赞/重生成。
            视觉/行为与 done 态 .pp-answer-zone 完全对齐（共享 MessageActions 组件）。 */}
        {!item.isStreaming && (
          <MessageActions
            text={item.text}
            onRegenerate={onRegenerate}
            showRegenerate={isLastAnswer}
          />
        )}
      </div>
    </div>
  );
});

// ── MessageList ──

interface MessageListProps {
  items: Item[];
  isStreaming: boolean;
  streamingText: string;
  reasoningStream: string;
  /** 本轮累计 token 消耗（实时 footer「已消耗 ◇ X.XX」用），透传给 ProcessPanel。 */
  runTokenUsage?: number;
  onRegenerate?: () => void;
  pendingApproval?: import("../../types").PendingApproval | null;
  onDecide?: (action: "accept" | "edit" | "respond" | "ignore", args?: unknown, feedback?: string) => void;
  /** 运行中点停止 → 调用方应触发 cancel_agent 中断当前回合。 */
  onStop?: () => void;
  onPromptSuggestion?: (text: string) => void;
  /** P1-3：动态建议（近期会话标题等），未传则用兜底静态建议。 */
  suggestions?: string[];
  /** P1-3：首屏主 CTA「开始新对话」。 */
  onNewSession?: () => void;
  /** Turn elapsed time formatted as "Xm Xs" or "Xs". */
  elapsed?: string;
  /** 运行凭证 chip 用：当前权限模式（全自动/需审批/计划执行）。 */
  permissionMode?: PermissionMode;
}

export function MessageList({
  items, isStreaming, streamingText, reasoningStream, runTokenUsage, onRegenerate,
  pendingApproval, onDecide, onStop, onPromptSuggestion,
  suggestions,
  onNewSession,
  elapsed,
  permissionMode,
}: MessageListProps) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items, streamingText]);

  const turns = useMemo(() => buildTurns(items), [items]);
  const mode = useMemo(() => streamMode(streamingText, items, isStreaming), [streamingText, items, isStreaming]);

  // 首屏空状态已迁移到 ChatArea 的 EmptyComposer，这里不再渲染内容。
  if (items.length === 0 && !streamingText && !reasoningStream) {
    return <div className="message-list" />;
  }

  return (
    <div className="message-list" role="log" aria-label="对话记录" aria-live="polite">
      {turns.map((turn, ti) => {
        const isLastTurn = ti === turns.length - 1;

        // For the live (last) turn, extract trailing assistants as answers only when turn ends
        // (matching openworker: keepTrailing when live && hasTools)
        const hasTools = turn.turnItems.some(it => it.kind === "tool");
        const turnIds = turn.turnItems;
        // buildTurns() has ALREADY extracted trailing assistants into turn.answerItem
        // for no-tool turns. Always start from that value — re-popping the (now empty)
        // turnItems would yield undefined and make the answer bubble vanish once
        // streaming finishes (the "bubble disappears after completion" bug).
        let groupItems = turnIds;
        let answerItem: AssistantItem | undefined = turn.answerItem;

        // R8：tool turn 的最终答案停留在 groupItems 内（由 ProcessPanel 渲染为「过程流
        // 内的自然最后一段」），原 AnswerBubble 分支不命中——这里从 groupItems 中找出
        // 「runId 非空」的那条助理项，把 RunArtifactsEntry 构造成 ReactNode 透传给
        // ProcessPanel、挂在 .pp-answer-zone 答案上方，与 no-tool turn 的 AnswerBubble
        // 上方路径对齐。命中策略：从末尾往前找第一个非流式、非观察的 assistant。
        let toolTurnArtifactsEntry: ReactNode = null;
        if (hasTools && !answerItem) {
          for (let i = groupItems.length - 1; i >= 0; i--) {
            const it = groupItems[i];
            if (
              it.kind === "assistant" &&
              !(it as AssistantItem).isStreaming &&
              !(it as AssistantItem).narration &&
              (it as AssistantItem).runId
            ) {
              const ans = it as AssistantItem;
              toolTurnArtifactsEntry = (
                <RunArtifactsEntry runId={ans.runId!} artifacts={ans.artifacts} />
              );
              break;
            }
          }
        }

        if (isLastTurn && isStreaming && hasTools) {
          // Live tool turn: the answer isn't final yet — keep trailing assistants
          // as narrations inside ProcessPanel; AnswerBubble renders only when done.
          answerItem = undefined;
        } else if (hasTools && !answerItem) {
          // 工具轮答案不再抽到 AnswerBubble（2026-08-13 用户指令：消除「思考轨迹 + 答案卡片」双层割裂，
          // 对齐 WorkBuddy「一段连续文本流」）。答案保留在 groupItems 中，由 ProcessPanel 的
          // .pp-line--answer 分支渲染为思维流的自然最后一段（完整 Markdown、无框轻量）。
          // narration 行（观察行）因 narration=true 不会被此分支匹配，安全留在 ProcessPanel 内。
        }
        // No-tool turns (live or finished, last or historical): use turn.answerItem
        // directly — buildTurns already prepared it. 流式期间 answerItem 是 live assistant
        //（isStreaming=true），AnswerBubble 依此隐藏操作栏（见 AnswerBubble 的 `!item.isStreaming`），
        // 避免半截文本带着「总结交互」（复制/重新生成/赞）出现。

        // 无工具轮未必就是结束（用户随后可能再发消息、可能重新生成）：总结交互
        // （重新生成）只挂在本回合真正结束的最后一轮 —— 最后一轮 + 未流式 + 无错误。
        // 历史回合（非最后一轮）降级为只读气泡：保留复制/赞，去掉重新生成。
        const hasTurnError = turn.notices.some(
          (n) => n.kind === "notice" && n.tone === "error"
        );
        const isLastAnswer = isLastTurn && !isStreaming && !hasTurnError;

        // Assistant identity header: appears right after the user message, BEFORE any
        // thinking/tool content. Shows who is responding (avatar + name), matching the
        // "user msg → OneDesktop identity → interleaved narrative" pattern the user wants.
        const showIdentity =
          groupItems.length > 0 ||
          !!answerItem ||
          (isLastTurn && (isStreaming || !!streamingText || !!reasoningStream));

        return (
          <div key={`turn-${ti}`} className="turn-wrapper">
            {turn.userText && (
              <UserMessageBubble text={turn.userText} />
            )}

            {/* OneDesktop identity — appears the moment the user sends, before thinking */}
            {showIdentity && (
              <div className="assistant-identity">
                <SquareLogo className="assistant-avatar" />
                <span className="assistant-name">OneDesktop</span>
              </div>
            )}

            {/* ProcessPanel: unified thinking + tools, auto-collapse when done */}
            {/* 渲染守卫：纯数据驱动——该 turn 重建后含过程条目（思考/执行/观察）即显示。
                过程流完整性由 messagesToItems 保证，不再依赖跨会话串味的 hadProcessRef 补丁。 */}
            {groupItems.length > 0 && (
              <ProcessPanel
                items={groupItems}
                live={isLastTurn && isStreaming}
                streamingText={isLastTurn && mode === "quiet" ? streamingText : undefined}
                reasoningStream={isLastTurn && turnIds.length === 0 ? reasoningStream : undefined}
                pendingApproval={pendingApproval}
                onDecide={onDecide}
                elapsed={elapsed}
                density={settings.thinkingDensity}
                hasTurnError={turn.notices.some((n) => n.kind === "notice" && n.tone === "error")}
                answering={isLastTurn && mode === "answer"}
                permissionMode={permissionMode}
                // 历史回合默认展开供回放；刚结束的当前回合则按 ProcessPanel 的完成态
                // 默认收起轨迹、保留最终总结，避免结束后整段过程继续占据阅读区。
                replay={!isLastTurn && !isStreaming}
                // R8：tool turn 的产物/变更入口（在 .pp-answer-zone 答案上方）；no-tool turn
                // 走下面 AnswerBubble 上方的同一组件，保持「入口一律挂在答案上」的统一契约。
                runArtifactsEntry={toolTurnArtifactsEntry}
                // 「重新生成」只挂在本回合真正的最后一轮（isLastAnswer）。
                // 与 AnswerBubble 的 onRegenerate 透传策略完全一致。
                onRegenerate={isLastAnswer ? onRegenerate : undefined}
                isLastAnswer={isLastAnswer}
                // 本轮累计 token：实时 footer「已消耗 ◇ X.XX」显示（仅 live 轮有意义，历史轮不传）。
                runTokenUsage={isLastTurn ? runTokenUsage : undefined}
              />
            )}

            {/* Answer bubble OUTSIDE TurnGroup, matching openworker.
                The assistant-identity header now lives at turn level (above), so no duplicate here.
                推理统一由 ProcessPanel「查看过程」呈现，AnswerBubble 只渲染最终答案。
                无工具轮未必就是结束：历史回合的 answer 同样渲染为只读气泡，
                但「重新生成」只挂在本回合真正的最后一轮（isLastAnswer）。 */}
            {answerItem && (
              <div className="assistant-turn">
                {/* R8：本回合有 run_id 时，在答案气泡上方渲染「查看所有产物 / 变更」入口。 */}
                {answerItem.runId && (
                  <RunArtifactsEntry runId={answerItem.runId} artifacts={answerItem.artifacts} />
                )}
                <AnswerBubble
                  item={answerItem}
                  onRegenerate={isLastAnswer ? onRegenerate : undefined}
                  isLastAnswer={isLastAnswer}
                  isStreaming={isStreaming}
                />
              </div>
            )}

            {/* Live streaming answer — ONLY for no-tool turns.
                When tools exist (groupItems.length > 0), ProcessPanel owns all rendering
                including narration + cursor; showing a separate bubble here would create
                duplicate cursors and content. */}
            {isLastTurn && mode === "answer" && !answerItem && groupItems.length === 0 && (
              <div className="message-row assistant group-start">
                <div className="message-bubble assistant">
                  {/* Phase 4 / G7：流式分段解析 —— 已闭合段 memo 化不重渲染，
                      只有活跃尾段每帧解析，消除长回答连喷下的 CLS 与掉帧。 */}
                  <SegmentedMarkdown>{streamingText}</SegmentedMarkdown>
                  <span className="stream-cursor" aria-hidden="true">▍</span>
                </div>
              </div>
            )}

            {/* Notices */}
            {turn.notices.map((notice, ni) => {
              if (notice.kind !== "notice") return null;
              const n = notice as Extract<Item, { kind: "notice" }>;
              return (
                <div key={`notice-${ni}`} className={`notice-banner ${n.tone}`}>
                  <span>{n.text}</span>
                  {n.retriable && isLastTurn && !isStreaming && onRegenerate && (
                    <button className="notice-retry-btn" onClick={onRegenerate}>重试</button>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
