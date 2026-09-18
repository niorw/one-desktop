import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  Item,
  ToolItem,
  ThinkingItem,
  WaitingItem,
  AssistantItem,
  PendingApproval,
  ThinkDensity,
} from "../../types";
import { buildNodeTree } from "../../hooks/agentState";
import { Icons } from "../common/Icons";
import { ApprovalCard } from "./ApprovalCard";
import { MessageActions } from "./MessageActions";
import { applyVisibility, type ItemDecision } from "../../hooks/visibilityPolicy";

// 天气工具结构化渲染与 answer 行剥离工具——独立成 ./weatherReport.tsx，
// 否则 React Fast Refresh 拒热更整个模块（"stripMarkdownTables export is incompatible"）。
import { stripMarkdownTables } from "./weatherReport";
// 过程流行渲染部件（StreamLine/StepDetail/纯函数）——自本文件拆出。
import {
  formatDuration,
  livePhaseLabel,
  isPendingStep,
  StreamLine,
  type DecideFn,
} from "./ProcessPanelParts";


/**
 * 父组件未传 `elapsed` 时，依据 items 自带时间戳（ts）推导整轮耗时：取首尾事件时间差。
 * items 无 ts（旧链路）时返回 undefined，由调用方回落到既有的 live 计时或空。
 */
function deriveElapsed(items: Item[]): string | undefined {
  const times = items
    .map((i) => (i as { ts?: number }).ts)
    .filter((t): t is number => typeof t === "number" && !Number.isNaN(t));
  if (times.length < 2) return undefined;
  const span = Math.max(...times) - Math.min(...times);
  if (span <= 0) return undefined;
  return formatDuration(Math.round(span / 1000));
}

interface ProcessPanelProps {
  items: Item[];
  live?: boolean;
  streamingText?: string;
  reasoningStream?: string;
  pendingApproval?: PendingApproval | null;
  onDecide?: DecideFn;
  /** 用户思考层密度偏好（collapsed/peek/expanded）。缺省按 collapsed 处理。 */
  density?: ThinkDensity;
  /** Turn elapsed time formatted as "Xm Xs" or "Xs". */
  elapsed?: string;
  /** 本轮是否以整轮 Error 事件结束（notice 层的错误，非单工具失败）。 */
  hasTurnError?: boolean;
  /** 最终答案已开始输出（streamMode=answer）：过程流应立即收起，只留「查看过程」。 */
  answering?: boolean;
  /** 权限模式：full_access 时自动批准，不渲染审批卡。 */
  permissionMode?: string;
  /**
   * 回放态（非实时生成，如重新进入历史会话）：done 回合的「查看过程」默认展开，
   * 观察行/深度思考直接可见，还原「原样」；当前会话正在跑/刚跑完的回合不传此值，
   * 仍走 live/收起逻辑，不破坏实时折叠 declutter。
   */
  replay?: boolean;
  /**
   * R8：本回合 run 收尾产物/变更入口（仅 done 态可见）。
   * 由 MessageList 在「本回合最终答案助理项带 runId」时构造并传入；
   * 这里仅做容器转发，不感知内容。tool turn 的答案渲染在 .pp-answer-zone 内，
   * 入口放在答案上方，以对齐「答案气泡上方挂入口」的统一契约（与 no-tool turn 的
   * AnswerBubble 上方一致）。
   */
  runArtifactsEntry?: React.ReactNode;
  /**
   * 重新生成回调（仅本回合真正的最后一轮生效，参见 MessageList 的 isLastAnswer 推导）。
   * 传入后 .pp-answer-zone 末尾会渲染 MessageActions 组件，与 AnswerBubble 共享
   * 复制/赞/踩/重新生成行为，保证「无工具轮气泡」与「有工具轮 done 态总结」两处
   * 答案出口的操作栏完全一致。
   */
  onRegenerate?: () => void;
  /** 是否为本回合最后一轮（决定是否显示「重新生成」按钮），与 MessageList 对齐。 */
  isLastAnswer?: boolean;
  /**
   * 本轮累计 token 消耗（live 状态有意义，done 隐藏）。
   * 数据源：useAgent 按 Token/Thinking streaming 文本粗估累加，Done 时用真实 token_usage
   * 收口。仅当前回合（isLastTurn）传入，避免历史回合上叠加数字。
   * 0 = 本轮尚未开始或无消耗，不渲染。
   */
  runTokenUsage?: number;
}


/** 过程流里可渲染的条目：思考 / 工具 / 等待 / 观察（narration）。 */
type ProcessItem = ThinkingItem | ToolItem | WaitingItem | AssistantItem;

/**

/** Phase 4 / G7：过程流节点超过该阈值即分片（只渲染尾部窗口）。 */
const SHARD_THRESHOLD = 60;
/** Phase 4 / G7：尾部窗口大小（live 自动滚底，更早节点不可见，视觉无损）。 */
const SHARD_WINDOW = 200;

/**
 * 把本轮累计 token 渲染为紧凑数字。
 *   < 1000  → "842"
 *   ≥ 1000  → "6.42"（即 k tokens，对齐用户参考截图样式）
 * Done 后真实 token_usage 收口，估算误差在最后一刻被消除。
 */
function formatTokenUsage(n: number): string {
  if (!n || n <= 0) return "0";
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(2);
}

function keyFor(item: ProcessItem, idx: number): string {
  if (item.kind === "thinking") return `think-${item.id}`;
  if (item.kind === "tool") return `tool-${item.id}`;
  // 观察条目优先用自带 id；历史回放的 assistant 没有 id，才退回下标。
  if (item.kind === "assistant") return item.id ? `obs-${item.id}` : `obs-${idx}`;
  return `wait-${item.id}`;
}

// ══════════════════════════════════════════════
//  ProcessPanel — 无卡片过程流
// ══════════════════════════════════════════════
//
// 设计原则（用户 2026-08-09 硬指令）：
//   · 不用卡片、不用气泡、不用彩色边框——层次靠缩进、竖线、字重、留白。
//   · 每个过程步骤是一行小字 + 类型图标，按时间顺序向下排列。
//   · 每个工具行可点开看「调用参数 / 执行结果」，展开区靠左侧竖线缩进。
//   · 执行中（live）：固定高度滑动窗口，新行从底部顶入，自动滚动。
//   · 完成后（done）：整段过程默认收起，只留「已完成 · 查看过程」。

export const ProcessPanel: React.FC<ProcessPanelProps> = ({
  items,
  live,
  reasoningStream,
  pendingApproval,
  onDecide,
  elapsed,
  density = "collapsed",
  hasTurnError,
  answering,
  permissionMode,
  replay,
  runArtifactsEntry,
  onRegenerate,
  isLastAnswer,
  runTokenUsage,
}) => {
  const streamRef = useRef<HTMLDivElement>(null);
  // 回放态（replay）默认展开「查看过程」，让观察行/深度思考直接可见；
  // 实时/当前会话不传 replay，保持默认收起（declutter）。
  const [expanded, setExpanded] = useState<boolean>(replay ?? false);

  // 切换会话（replay 翻转）时同步展开态，避免 React 复用同 key 节点导致
  // 旧回合的展开态残留到新会话（历史会话应默认展开，当前会话应默认收起）。
  useEffect(() => {
    setExpanded(replay ?? false);
  }, [replay]);
  // Phase 4 / G7：长会话分片 —— 默认只渲染尾部窗口，用户可「显示全部」。
  const [showAll, setShowAll] = useState(false);

  const tools = items.filter((i): i is ToolItem => i.kind === "tool");

  // 当所有工具都已落库（done/error）且已出现**最终答案**文字时，
  // 即使父组件的 live 标志还没切过来，也视为实际已完成，自动进入 done 折叠态。
  // 注意排除 narration —— 半路的观察不代表回合结束，否则面板会提前折叠。
  const allToolsSettled =
    tools.length > 0 && tools.every((t) => t.status !== "running" && t.status !== "pending");
  // 工具级失败和整轮 Error 都属于失败态：失败时必须保留完整轨迹，不能被完成态
  // 的总开关折叠，否则用户看不到具体失败的调用与输出。
  const hasToolError = tools.some((t) => t.status === "error" || t.isError);
  const hasAnyError = hasToolError || !!hasTurnError;
  const hasFinalAnswer = items.some(
    (i) =>
      i.kind === "assistant" &&
      !(i as AssistantItem).narration &&
      !!(i as AssistantItem).text
  );
  // 纯推理轮（无工具）：thinking 已落库 + 已出终答即视为 done。此前 allToolsSettled
  // 要求 tools.length>0，使纯推理轮 done 态 effectivelyDone 恒为 false → 过程流永不
  // 收起，「深度思考」折叠头裸挂在 chat 主答案区（用户现象）。与圆桌/工具轮一视同仁收起。
  const isPureReasoning = tools.length === 0 && hasFinalAnswer;
  const effectivelyDone = (allToolsSettled || isPureReasoning) && hasFinalAnswer;
  // 折叠只看「回合级生命周期」(live ↔ done)，与「打字机阶段」(answering 只是一次回合里
  // 的其中一个 phase) 正交——两者混在一起会导致 live↔done 频繁切换、肉眼闪烁
  // （用户 2026-08-17 反馈：LLM 开始写终答不代表回合结束，不该收起）。
  // 因此 answering 一律不参与折叠决策：只要 live 仍为 true（不管处于思考/工具/答题哪个 phase）
  // 就保持展开；只在「真正不在 live + effectivelyDone + 无错」时收起为「已完成 · 查看过程」。
  //   · 出错时不收起：工具失败或 hasTurnError 的回合保持展开，用户能直接看到哪里出错；
  //   · 工具执行中 / 思考中 / 答题中自然不收起（live 仍为 true）。
  const isRunning = !!live && !effectivelyDone && !answering && !hasAnyError;
  /** UI 是否应折叠为「已完成/已出错 · 查看过程」入口：仅回合真正结束（!live）才收起。 */
  const shouldCollapse = !hasAnyError && !live && effectivelyDone;

  // ── 数据层 → 节点树（Phase 3 / G2·G4）：先把扁平 items 派生为带 parentId 的
  // AgentNode 树（同一份数据派生，视图层不再反向推断结构），再交给策略层裁决。 ──
  const treeItems = buildNodeTree(items);
  const decisions: ItemDecision[] = applyVisibility(treeItems, {
    // 用户主动点击「查看过程」展开后，强制显示被 density 隐藏的内部工具/观察，
    // 但 thinking 行的折叠档位仍由用户 density 决定（默认 collapsed 保持折叠头）。
    density,
    mode: shouldCollapse ? "done" : "live",
    expandedView: expanded,
  });

  // 观察（narration）也进过程流：模型在两次工具之间说的话属于「观察」环节，
  // 必须与思考、执行按时间顺序交替呈现（2026-08-10 用户硬指令）。
  // 兼容旧版 reasoningStream：还没有 live thinking item 时，把它作为一行思考显示。
  const legacyThinking: ItemDecision | null =
    reasoningStream &&
    // 已有（哪怕刚收到 ThinkingEnd、已封存的）思考条目就由时间轴本身渲染。
    // 旧逻辑只要找不到 live 条目便追加 legacy 副本，导致首段思考结束时短暂
    // 出现一个重复的「深度思考」框，随后 ToolCall 清空 reasoningStream 又闪退。
    decisions.every((d) => d.item.kind !== "thinking")
      ? {
          item: {
            kind: "thinking",
            id: "legacy-reasoning",
            content: reasoningStream,
            live: true,
          } as ThinkingItem,
          visible: true,
          visibility: "visible",
          render: "full",
        }
      : null;

  const displayDecisions: ItemDecision[] = [
    ...decisions.filter((d) => d.visible),
    ...(legacyThinking ? [legacyThinking] : []),
  ];

  // 深度思考去重：若主推理（th_main）段落与某个逐工具意图（th_*）内容完全相同，
  // 说明模型把 intent 复述进了 reasoning_content，不是真正的 CoT 推理。
  // 这类重复段落若标为「深度思考」会混淆用户，故隐藏，由意图行承担展示。
  const duplicateMainIds = useMemo(() => {
    const intentTexts = new Set<string>();
    const mainItems = new Map<string, string>();
    for (const d of displayDecisions) {
      if (d.item.kind !== "thinking") continue;
      const t = d.item as ThinkingItem;
      const normalized = t.content.trim().replace(/\s+/g, " ");
      if (!normalized) continue;
      if (t.thoughtId?.startsWith("th_main")) {
        if (!t.live) mainItems.set(t.id, normalized);
      } else {
        intentTexts.add(normalized);
      }
    }
    const dup = new Set<string>();
    for (const [id, text] of mainItems) {
      if (intentTexts.has(text)) dup.add(id);
    }
    return dup;
  }, [displayDecisions]);

  const renderDecisions: ItemDecision[] = useMemo(
    () =>
      displayDecisions.filter((d) => {
        if (d.item.kind !== "thinking") return true;
        const t = d.item as ThinkingItem;
        return !(t.thoughtId?.startsWith("th_main") && duplicateMainIds.has(t.id));
      }),
    [displayDecisions, duplicateMainIds]
  );

  // ── Phase 4 / G7：长会话分片 ──
  // 节点数 > 阈值时，默认只渲染尾部 SHARD_WINDOW 条（live 自动滚底，更早节点
  // 本来不可见；done 展开态同样以「最近过程」为默认，防数百步拖垮整列布局）。
  // 用户点「显示全部」才全量渲染——那是显式选择，接受对应成本。
  const shardable = renderDecisions.length > SHARD_THRESHOLD;
  const shownDecisions: ItemDecision[] =
    shardable && !showAll ? renderDecisions.slice(-SHARD_WINDOW) : renderDecisions;
  const hiddenCount = shardable ? renderDecisions.length - shownDecisions.length : 0;

  // 实时态下，waiting 项由底部 pp-live-footer 统一承载，避免双 spinner 竞争。
  const liveShownDecisions = isRunning
    ? shownDecisions.filter((d) => d.item.kind !== "waiting")
    : shownDecisions;
  const footerLabel = useMemo(
    () => livePhaseLabel(items, pendingApproval),
    [items, pendingApproval]
  );

  /** 分片提示条（位于过程流顶部；showAll 时反过来提供「回到最新」）。 */
  const shardHeader =
    shardable && (hiddenCount > 0 || showAll) ? (
      <button
        type="button"
        className="pp-shard"
        onClick={() => setShowAll((v) => !v)}
        aria-expanded={showAll}
      >
        {showAll ? "回到最新视图" : `↑ 更早的 ${hiddenCount} 条已折叠 · 显示全部`}
      </button>
    ) : null;

  // 执行中自动滚底，让滑动窗口始终展示最新步骤。
  useEffect(() => {
    if (isRunning && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [renderDecisions, reasoningStream, isRunning]);

  // 只要本轮有过程条目（含被策略折叠的内部工具），就保留容器/入口；
  // 真正没有任何过程时才退出。避免「只含内部工具 + collapsed」的回合，
  // done 态因 displayDecisions 为空而整片消失，用户连「查看过程」都点不开。
  if (items.length === 0 && !pendingApproval) return null;

  // ── Mode A-mini: 纯推理回合（无工具调用）默认只显示一行「思考中」极小提示，
  // 不铺开整块过程流（避免无工具行撑场时孤零零一块大框）。模型一旦开始答或调工具，
  // pureReasoningLive 立即为假，回到完整 Mode A / Mode B。复用既有 .pp-live-footer
  // （含停止按钮 + shimmer），不引入新结构。 ──
  const hasTool = items.some((it) => it.kind === "tool");
  const pureReasoningLive =
    !!live && !answering && !hasAnyError && !hasTool && !pendingApproval;
  if (pureReasoningLive) {
    return (
      <div className="process-panel process-panel--live process-panel--thinking">
        <div className="pp-live-footer" role="status" aria-live="polite">
          <span className="pp-live-footer-text">模型思考中…</span>
          {runTokenUsage && runTokenUsage > 0 && (
            <span className="pp-live-footer-tokens" aria-label="本轮累计消耗 token">
              <Icons.Diamond size={11} />
              <span>{formatTokenUsage(runTokenUsage)}</span>
            </span>
          )}
        </div>
      </div>
    );
  }

  // ── Mode A: 展开（运行中 / 出错 / 等待）— 滑动窗口，全部平铺 ──
  // 不再仅靠 isRunning 判断：出错时 isRunning=false 但仍需展开（不应折叠）。
  if (!shouldCollapse) {
    return (
      <div className="process-panel process-panel--live">
        <div className="pp-stream" ref={streamRef}>
          {shardHeader}
          {liveShownDecisions.map((d, idx) => (
            <StreamLine
              key={keyFor(d.item as ProcessItem, idx)}
              item={d.item}
              live
              pending={pendingApproval}
              onDecide={onDecide}
              decision={d}
              permissionMode={permissionMode}
            />
          ))}
          {isRunning && (
            <div className="pp-live-footer" role="status" aria-live="polite">
              <span key={footerLabel} className="pp-live-footer-text">{footerLabel}</span>
              {runTokenUsage && runTokenUsage > 0 && (
                <span className="pp-live-footer-tokens" aria-label="本轮累计消耗 token">
                  <Icons.Diamond size={11} />
                  <span>{formatTokenUsage(runTokenUsage)}</span>
                </span>
              )}
            </div>
          )}
        </div>
        {pendingApproval &&
          !tools.some((t) => isPendingStep(t, pendingApproval)) &&
          permissionMode !== "full_access" && (
            <div className="pp-detail pp-detail--approval">
              <ApprovalCard
                approval={pendingApproval}
                onDecide={onDecide ?? (() => {})}
                compact
              />
            </div>
          )}
      </div>
    );
  }

  // ── Mode B: done — 收起过程，保留最终总结 ──
  // 最终总结是用户需要立即阅读的结果；思考/工具轨迹才是可收起的审计信息。
  // 只抽取时间线中的最后一个非 narration assistant 条目，避免把工具轮中途的
  // 阶段性总结误提升为最终结果而打乱原始过程顺序。
  const hasError = hasAnyError;
  const statusText = hasError ? "已出错" : "已完成";
  // 耗时：优先用父级实时计时（当前轮）；缺失时按 items 时间戳推导（历史/回放回合）。
  const shownElapsed = elapsed || deriveElapsed(items);
  const finalSummary = [...renderDecisions]
    .reverse()
    .find((d) => d.item.kind === "assistant" && !(d.item as AssistantItem).narration);
  const trailShown = shownDecisions.filter((d) => d !== finalSummary);
  const summaryShown = finalSummary && shownDecisions.includes(finalSummary) ? finalSummary : null;

  return (
    <div className="process-panel process-panel--done">
      {trailShown.length > 0 ? (
        <button
          type="button"
          className="pp-done-head"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={`${statusText}${shownElapsed ? `，耗时 ${shownElapsed}` : ""}，${expanded ? "收起" : "展开"}过程`}
        >
          <span className={"pp-status" + (hasError ? " is-error" : "")}>
            {statusText}
            {shownElapsed ? ` · ${shownElapsed}` : ""}
          </span>
          <span className="pp-done-caret" aria-hidden>
            <Icons.ChevronRight size={14} />
          </span>
        </button>
      ) : (
        <span className={"pp-status" + (hasError ? " is-error" : "")}>
          {statusText}
          {shownElapsed ? ` · ${shownElapsed}` : ""}
        </span>
      )}
      {expanded && (
        <div className="pp-list">
          {shardHeader}
          {trailShown.map((d, idx) => (
            <StreamLine
              key={keyFor(d.item as ProcessItem, idx)}
              item={d.item}
              live={false}
              decision={d}
              permissionMode={permissionMode}
            />
          ))}
        </div>
      )}
      {summaryShown && (
        <div className="pp-answer-zone">
          {/* R8：tool turn 的最终答案也挂「查看所有产物 / 变更」入口（与 no-tool turn 的
              AnswerBubble 上方一致）——入口仅 done 态渲染，live 态（答案还在流）不显示。 */}
          {runArtifactsEntry}
          <StreamLine
            key={keyFor(summaryShown.item as ProcessItem, shownDecisions.indexOf(summaryShown))}
            item={summaryShown.item}
            live={false}
            decision={summaryShown}
            permissionMode={permissionMode}
          />
          {/* 答案尾部操作栏（共享 MessageActions）：与 AnswerBubble 视觉/行为一致。
              复制源取 cleanText，保证所见即所得（已被剥离的天气表/半残 markdown 表不会
              因复制而回灌）。仅文本非空时渲染，避免对空答案误挂交互。 */}
          {(summaryShown.item as AssistantItem).text.trim().length > 0 && (
            <MessageActions
              text={stripMarkdownTables((summaryShown.item as AssistantItem).text).cleanText}
              onRegenerate={onRegenerate}
              showRegenerate={isLastAnswer}
            />
          )}
        </div>
      )}
    </div>
  );
};

