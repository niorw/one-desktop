// ══════════════════════════════════════════════
//  ProcessPanelParts — 过程流行渲染部件（自 ProcessPanel 拆出）
//  StreamLine / StepDetail / ArgsView / ResultView / 纯函数。
//  拆分动机：ProcessPanel.tsx 单文件 1000+ 行，渲染细节与主组件状态混杂。
//  设计纪律：部件只消费 props，不触碰 ProcessPanel 内部状态。
// ══════════════════════════════════════════════

import React, { memo, useEffect, useRef, useState } from "react";
import type {
  Item,
  ToolItem,
  ThinkingItem,
  WaitingItem,
  AssistantItem,
  PendingApproval,
} from "../../types";
import { humanizeActionParts, parseDiffStat, parseWrittenPath } from "../../utils/humanize";
import { usePreview } from "../artifacts/PreviewProvider";
import { openInDefaultApp } from "../../utils/openFile";
import { Icons } from "../common/Icons";
import { LocalPathText, Markdown } from "../../utils/markdown";
import { ApprovalCard } from "./ApprovalCard";
import { stripMarkdownTables, WeatherReportView, tryParseWeatherPayload } from "./weatherReport";
import type { ItemDecision, Visibility } from "../../hooks/visibilityPolicy";

/** 四态审批决策回调（A-4）：accept | edit | respond | ignore。 */
export type DecideFn = (
  action: "accept" | "edit" | "respond" | "ignore",
  args?: unknown,
  feedback?: string
) => void;

/** 把秒数格式化为 "Xm Xs"（≥60s）或 "Xs"。 */
export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s}s`;
}
// ══════════════════════════════════════════════
//  工具类型 → 图标
// ══════════════════════════════════════════════

function toolIcon(name: string): React.FC<{ size?: number }> {
  const lower = name.toLowerCase();
  if (lower.includes("shell") || lower.includes("command") || lower.includes("bash"))
    return Icons.ProcessCommand;
  if (lower.includes("write") || lower.includes("create_file") || lower.includes("edit"))
    return Icons.ProcessEdit;
  if (lower.includes("read"))
    return Icons.ProcessDocument;
  if (lower.includes("grep") || lower.includes("search"))
    return Icons.ProcessSearch;
  if (lower.includes("list") || lower.includes("dir") || lower.includes("glob"))
    return Icons.ProcessFolder;
  // 兜底：通用「已调用」工具行一律用命令终端，表达「模型执行了一次调用」
  return Icons.ProcessCommand;
}

/**
 * 工具行「类型化前缀」标签（方案 A：grep/read/think 各一套视觉语）。
 * 已完成/失败/待批态用过去时的类别词（已读取/已搜索/已修改…），让每行一眼可扫读
 * 「这步干了什么」；运行中态不返回标签，由 renderActionText 回落到「正在 X…」动词。
 * 克制中性灰，不引入彩色（与 Apple 设计纪律、.pp-icon 中性一致）。
 */
function toolTypeTag(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("read")) return "已读取";
  if (lower.includes("write") || lower.includes("create_file") || lower.includes("edit"))
    return "已修改";
  if (lower.includes("delete")) return "已删除";
  if (lower.includes("list") || lower.includes("dir")) return "已列出";
  if (lower.includes("glob")) return "已查找";
  if (lower.includes("grep")) return "已搜索";
  if (lower.includes("shell") || lower.includes("command") || lower.includes("bash"))
    return "已执行";
  if (lower.includes("web_search")) return "已搜索网页";
  if (lower.includes("web_fetch")) return "已获取";
  if (lower.includes("send_message")) return "已发送";
  return "已调用";
}

/**
 * WorkBuddy 风格行动叙述（2026-08-10）：动作 + 可点击文件名 + 附加上下文。
 * 文件类工具的 target 渲染为可点击链接（点击用系统默认程序打开文件，
 * stopPropagation 防止误触整行展开），非文件工具保持纯文本。
 */
function renderActionText(
  tool: ToolItem,
  prefix?: string,
  onFileLink?: (path: string) => void,
): React.ReactNode {
  const parts = humanizeActionParts(tool.name, tool.args, tool.status, tool.result);
  return (
    <>
      {/* 已完成/失败/待批：类型化前缀标签（已读取/已搜索…）；运行中：回落到「正在 X…」动词 */}
      {prefix ? (
        <span className="pp-type">{prefix}</span>
      ) : (
        <>{parts.verb}{" "}</>
      )}
      {parts.filePath ? (
        <span
          className="pp-file-link"
          role="link"
          tabIndex={0}
          title={`打开 ${parts.filePath}`}
          onClick={(e) => {
            e.stopPropagation();
            if (onFileLink) onFileLink(parts.filePath!);
            else void openInDefaultApp(parts.filePath!);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              if (onFileLink) onFileLink(parts.filePath!);
              else void openInDefaultApp(parts.filePath!);
            }
          }}
        >
          {parts.target}
        </span>
      ) : (
        parts.target
      )}
      {parts.detail || ""}
    </>
  );
}

function waitingLabel(label: string): string {
  switch (label) {
    case "thinking":
      return "思考中";
    case "model_response":
      return "等待模型响应";
    case "tool_execution":
      return "等待工具执行";
    case "approval":
      return "等待审批";
    default:
      return label;
  }
}

/** 实时态唯一底部状态文案：按优先级返回当前活跃阶段。 */
export function livePhaseLabel(
  items: Item[],
  pendingApproval?: PendingApproval | null
): string {
  if (pendingApproval) return "等待你的确认";
  const lastWaiting = items
    .filter((it): it is WaitingItem => it.kind === "waiting")
    .pop();
  if (lastWaiting) return waitingLabel(lastWaiting.label);
  const runningTools = items.filter(
    (it) => it.kind === "tool" && (it as ToolItem).status === "running"
  );
  if (runningTools.length > 1) return `正在并行执行 ${runningTools.length} 个工具`;
  if (runningTools.length === 1) return "正在执行";
  return "处理中";
}

/** Whether this running step is the one awaiting user approval. */
export function isPendingStep(tool: ToolItem, pending?: PendingApproval | null): boolean {
  return (
    !!pending &&
    tool.status === "running" &&
    tool.name === pending.tool_name &&
    tool.args === pending.tool_args
  );
}
// ══════════════════════════════════════════════
//  展开详情：参数 + 结果（无卡片，靠左侧竖线缩进）
// ══════════════════════════════════════════════

/** Pretty-print tool args: parse JSON, else show raw. */
function ArgsView({ args }: { args: string }) {
  let pretty = args;
  try {
    pretty = JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    /* keep raw */
  }
  return <pre className="code-block">{pretty}</pre>;
}

/** Truncatable long text (used for tool results). */
function Truncated({
  text,
  limit = 600,
  renderText,
}: {
  text: string;
  limit?: number;
  renderText?: (shown: string) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const tooLong = text.length > limit;
  const shown = !expanded && tooLong ? text.slice(0, limit) + "…" : text;
  return (
    <div>
      <pre className="result-text">{renderText ? renderText(shown) : shown}</pre>
      {tooLong && (
        <button type="button" className="expand-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "收起" : "展开全部"}
        </button>
      )}
    </div>
  );
}

/** Render a tool result differently based on tool type. */
function ResultView({ tool, onFileLink }: { tool: ToolItem; onFileLink: (path: string) => void }) {
  const name = tool.name.toLowerCase();
  if (tool.result === undefined) return null;

  // 天气工具走结构化专用渲染：tool.result 是 JSON 载荷（kind="weather_report"），
  // 前端用 WeatherReportView 组件按结构化数据绘制完整表格，绕开 LLM 转录
  // markdown 不可靠（实测推理模型不遵守 description 强约束，会自作主张造
  // "半残表格"——只剩天气/气温两行，温度/降水/日出日落用 `||` 拼出去）。
  // LLM 在 AnswerBubble 里只输出自然语言总结 + 出行建议，不再复述具体数据。
  if (name === "weather" || name === "get_weather") {
    const payload = tryParseWeatherPayload(tool.result);
    if (payload) return <WeatherReportView data={payload} />;
    // 解析失败（空字符串/旧链路 HTML/异常 JSON）→ 降级到原 pre 文本兜底，
    // 绝不静默吞错。前端 markdown 渲染链路读此路径的概率极低（载荷稳定）。
  }

  if (name.includes("shell") || name.includes("command") || name.includes("bash")) {
    return <pre className="term-output"><LocalPathText text={tool.result} onFileLink={onFileLink} /></pre>;
  }
  if (name.includes("read")) {
    let path = "";
    try {
      const a = JSON.parse(tool.args);
      path = String(a.path || a.file_path || "");
    } catch {
      /* no path */
    }
    return (
      <div className="file-result">
        <div className="file-result-head">
          <Icons.ReadFile size={PROCESS_ICON_SIZE} />
          <span>{path || "文件内容"}</span>
        </div>
        <Truncated text={tool.result} renderText={(text) => <LocalPathText text={text} onFileLink={onFileLink} />} />
      </div>
    );
  }
  return <Truncated text={tool.result} renderText={(text) => <LocalPathText text={text} onFileLink={onFileLink} />} />;
}

function StepDetail({ tool }: { tool: ToolItem }) {
  const { openPreview } = usePreview();
  return (
    <div className="pp-detail">
      <div className="step-detail-section">
        <div className="step-detail-label">调用参数</div>
        <ArgsView args={tool.args} />
      </div>
      {tool.result !== undefined && (
        <div className="step-detail-section">
          <div className={"step-detail-label " + (tool.isError ? "err" : "ok")}>
            {tool.isError ? "执行失败" : "执行结果"}
          </div>
          <ResultView tool={tool} onFileLink={(filePath) => openPreview({ filePath })} />
        </div>
      )}
    </div>
  );
}
// ══════════════════════════════════════════════
//  单行过程项
// ══════════════════════════════════════════════

interface LineProps {
  item: Item;
  live: boolean;
  pending?: PendingApproval | null;
  onDecide?: DecideFn;
  /** 策略层裁决（可见性/脱敏/收起），由 ProcessPanel 统一计算后下发。 */
  decision?: ItemDecision;
  /** 权限模式：full_access 时隐藏审批卡。 */
  permissionMode?: string;
}

export const StreamLine = memo(function StreamLine({ item, live, pending, onDecide, decision, permissionMode }: LineProps) {
  const { openPreview } = usePreview();
  const [open, setOpen] = useState(false);
  // 深度思考行在 done + collapsed 密度下可折叠；live 态自动展开，done 态自动收起。
  const [thinkingOpen, setThinkingOpen] = useState(decision?.render !== "collapsed");
  const [thinkingToggled, setThinkingToggled] = useState(false);
  const elapsedRef = useRef<HTMLSpanElement>(null);
  // shell 工具剩余倒计时（仅 running 且 isShell 时渲染 .pp-timeout）
  const timeoutRef = useRef<HTMLSpanElement>(null);
  // 深度思考长 CoT 内层框的 ref：每个 thinking 行各自持有，与外层 .pp-stream 的
  // streamRef 滑窗滚底解耦——两者独立 scrollTop，互不覆盖、互不抖动。
  const cotRef = useRef<HTMLSpanElement>(null);
  // 仅取 thinking 内容作为跟随 effect 的依赖（非 thinking 行恒为空串，不触发）。
  const thinkContent = item.kind === "thinking" ? (item as ThinkingItem).content : "";

  // 是否主推理段（th_main_*）且当前是否仍在流式（live=true）。
  // 用于「自动滚底」与「推理结束自动收起」两处，必须早于下方分支计算。
  const isMainReasoningLine =
    item.kind === "thinking" &&
    (item as ThinkingItem).thoughtId?.startsWith("th_main");
  const itemLive =
    item.kind === "thinking" ? (item as ThinkingItem).live : false;

  // 当策略层把思考行切到 collapsed（done + collapsed 密度）且用户未手动干预时，
  // 自动收起；live/expanded 密度则自动展开。
  useEffect(() => {
    if (!thinkingToggled) {
      setThinkingOpen(decision?.render !== "collapsed");
    }
  }, [decision?.render, thinkingToggled]);

  // 深度思考：live 阶段推理内容在 .pp-cot-box 内层框内实时流出，自动滚底跟随最新，
  // 长 CoT 不溢出外层过程流（内层框自身 overflow + max-height 已就位）。
  useEffect(() => {
    if (live && isMainReasoningLine && cotRef.current) {
      cotRef.current.scrollTop = cotRef.current.scrollHeight;
    }
  }, [thinkContent, live, isMainReasoningLine]);

  // 推理流结束（live 由 true→false，ThinkingEnd / 工具调用封段）→ 自动收起当前推理框。
  // 仅 live 态生效；replay / 历史回合不自动收起（由 density 折叠档位决定，避免回放时
  // 把已展开的过程又收掉）。
  useEffect(() => {
    if (live && isMainReasoningLine && !thinkingToggled && itemLive === false) {
      setThinkingOpen(false);
    }
  }, [itemLive, thinkingToggled, live, isMainReasoningLine]);

  const tool = item.kind === "tool" ? (item as ToolItem) : null;
  const running = tool?.status === "running";
  // 是否为内核带 30s 超时的 shell 类工具（run_shell / bash / cmd / command / terminal 等）
  const isShell = tool ? /shell|bash|cmd|command|terminal/i.test(tool.name) : false;
  const visibility: Visibility = decision?.visibility ?? "visible";

  // 运行中每秒刷新计时（直接写 DOM，避免整行重渲染）
  useEffect(() => {
    if (!live || !running) return;
    const start = Date.now();
    const id = setInterval(() => {
      const sec = Math.floor((Date.now() - start) / 1000);
      if (elapsedRef.current) {
        elapsedRef.current.textContent = sec + "s";
      }
      if (isShell && timeoutRef.current) {
        const remaining = Math.max(0, SHELL_TIMEOUT_SECS - sec);
        timeoutRef.current.textContent = `剩 ${remaining}s 自动终止`;
        // 最后 5s 视为 imminent，转 signal 去饱和色提示即将被强制 kill
        timeoutRef.current.classList.toggle("is-imminent", remaining <= 5);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [live, running, isShell]);

  // 深度思考：live 阶段思考内容在 .pp-cot-box 局部框内流出（限制高度 + 内层自动
  // 跟随最新，见上方 effect），不撑爆过程流；结束时由 ProcessPanel 整体折叠收起。
  if (item.kind === "thinking") {
    const t = item as ThinkingItem;
    // 区分「主推理」与「逐工具意图」（G5 thoughtId 命名约定）：
    //   th_main_{iter} → 真正的深度思考（CoT 推理链）
    //   th_{call_id}  → 行为描述/执行意图（"读取 X 了解 Y"），不是推理
    const isMainReasoning = (t.thoughtId ?? "").startsWith("th_main");

    // 脱敏（G3）：策略层已把敏感内容替换为占位符，这里仅加语义样式。
    if (visibility === "redacted") {
      return (
        <div className="pp-line pp-line--thinking pp-line--redacted" title="内容已脱敏">
            <span className="pp-icon">
            <Icons.ProcessReasoning size={PROCESS_ICON_SIZE} />
          </span>
          <span className="pp-text pp-text--redacted">{decision?.redactedText}</span>
        </div>
      );
    }
    // 密度=peek：截断预览（策略层已裁决 render:"preview"）。
    if (decision?.render === "preview") {
      const preview = t.content.length > 80 ? t.content.slice(0, 80) + "…" : t.content;
      return (
        <div className="pp-line pp-line--thinking" title="思考已折叠（密度=peek）">
            <span className="pp-icon">
            <Icons.ProcessReasoning size={PROCESS_ICON_SIZE} />
          </span>
          <span className="pp-text pp-text--think pp-text--preview">{preview}</span>
        </div>
      );
    }
    // ── 意图行（逐工具行为描述，非推理）── 轻量前缀行，始终可见（不参与折叠头）
    //     空内容不渲染，避免出现「只有图标」的幽灵行。
    //     必须排在「折叠头」分支之前：否则 collapsed 密度下意图行会被误折叠成
    //     「深度思考 >」头，点开后才露出无按钮的意图文本行，无法再收回。
    if (!isMainReasoning) {
      if (!t.content.trim()) return null;
      return (
        <div className="pp-line pp-line--intent" title="执行意图">
          <span className="pp-icon" aria-hidden>
            <Icons.Summarize size={PROCESS_ICON_SIZE} />
          </span>
          <span className="pp-text pp-text--intent">{t.content}</span>
        </div>
      );
    }

    // 深度思考内容统一包进可滚动框（.pp-cot-box）：live 实时流出、done 落库均同款，
    // 长 CoT 在框内滚动不撑爆布局（替代原 line-clamp +「展开全部」）。与用户「深度
    // 思考加框」诉求一致；所有密度下顶部「深度思考」折叠头均可点击收起/展开，
    // 默认展开（done + collapsed 密度且用户未干预时由下方 effect 自动收起）。
    const toggleThinking = () => {
      setThinkingOpen((v) => !v);
      setThinkingToggled(true);
    };

    if (!thinkingOpen) {
      return (
        <div className="pp-line pp-line--thinking pp-line--thinking-collapsed">
          <button
            type="button"
            className="pp-row pp-row--thinking"
            onClick={toggleThinking}
            aria-expanded={false}
          >
            <span className="pp-icon">
              <Icons.ProcessReasoning size={PROCESS_ICON_SIZE} />
            </span>
            <span className="pp-text pp-text--think">深度思考</span>
            <span className="pp-caret" aria-hidden>
              <Icons.ChevronRight size={10} />
            </span>
          </button>
        </div>
      );
    }

    // ── 主推理（th_main）── 无框轻量风格：折叠头 + Markdown 内容块 ──
    //     顶部「深度思考」始终可点收起/展开（所有密度通用）。
    return (
      <div className="pp-line pp-line--thinking">
        <div
          className="pp-row pp-row--thinking pp-cot-header"
          onClick={toggleThinking}
          role="button"
          tabIndex={0}
          aria-expanded={true}
        >
            <span className="pp-icon">
            <Icons.ProcessReasoning size={PROCESS_ICON_SIZE} />
          </span>
          <span className="pp-text pp-text--think pp-cot-title">深度思考</span>
          <span className="pp-caret" aria-hidden>
            <Icons.ChevronRight size={10} />
          </span>
        </div>
        <span className="pp-text pp-text--think pp-cot-box" ref={cotRef}>
          <Markdown onFileLink={(p) => openPreview({ filePath: p })}>{t.content}</Markdown>
        </span>
      </div>
    );
  }

  // ── 答案 / 观察（所有 assistant 文本行）──
  //    工具轮之间的阶段性总结或观察（narration）抽不到 AnswerBubble，只能在这里原样
  //    呈现为完整 Markdown 块——不钳制、不预览、不折叠，作为过程流中自然的一段文本
  //    直接显示（用户 2026-08-15 指令：观察不应折叠后单独成块）。
  //    回合末尾的终答会被 MessageList 抽去 AnswerBubble，不会到这里重复渲染。
  if (item.kind === "assistant") {
    const a = item as AssistantItem;
    if (!a.text.trim()) return null;
    if (visibility === "redacted") {
      return (
        <div className="pp-line pp-line--answer pp-line--redacted" title="内容已脱敏">
          <span className="pp-text pp-text--redacted">{decision?.redactedText}</span>
        </div>
      );
    }
    // 天气类答案：剥离 LLM 自造的半残 markdown 表（含 `||` 拼装行），
    // 完整表已在上方工具结果行 (ResultView) 渲染，这里只留自然语言口述。
    const { cleanText } = stripMarkdownTables(a.text);
    return (
      <div className="pp-line pp-line--answer">
        <span className="pp-text pp-text--answer">
          <Markdown onFileLink={(p) => openPreview({ filePath: p })}>{cleanText}</Markdown>
        </span>
      </div>
    );
  }

  if (item.kind === "waiting") {
    const w = item as WaitingItem;
    return (
      <div className="pp-line pp-line--waiting">
        {/* key=label：两阶段切换（思考中 → 等待模型响应）时重建节点，触发淡入动效；
            去掉 spinner，改用文字 shimmer 表示活跃状态。 */}
        <span key={w.label} className="pp-text waiting-text">{waitingLabel(w.label)}</span>
      </div>
    );
  }

  if (!tool) return null;

  const failed = tool.isError || tool.status === "error";
  const done = tool.status === "done";
  const ToolIcon = toolIcon(tool.name);
  const lower = tool.name.toLowerCase();
  const ioCls = /write|create_file|edit/.test(lower)
    ? " io-write"
    : /read|grep|search/.test(lower)
    ? " io-read"
    : "";
  const isFileWrite = /^(write_file|create_file|edit_file)$/i.test(tool.name);
  const diffStat = done && isFileWrite ? parseDiffStat(tool.result) : null;
  // 写盘工具产出的文件绝对路径：渲染为可点击 chip，点开通用预览。
  const writtenPath = done && isFileWrite ? parseWrittenPath(tool.result) : null;
  const showApproval = isPendingStep(tool, pending);

  const statusCls = failed
    ? " is-error"
    : running
    ? " is-running"
    : done
    ? " is-done"
    : " is-pending";

  const redactedCls = visibility === "redacted" ? " is-redacted" : "";

  return (
    <div className={"pp-line pp-line--tool" + statusCls + redactedCls}>
      {/*
       * 这里不能用 button 包住整行：写文件后的文件 chip 本身也是一个 button，
       * 嵌套 button 会让浏览器自动修正 DOM，导致点击文件时偶发触发展开详情。
       * 用可访问的 role=button 行承载「展开详情」，让内层文件操作保持独立。
       */}
      <div
        role="button"
        tabIndex={0}
        className={"pp-row" + (open ? " open" : "")}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <span className={"pp-icon" + ioCls}>
          {failed ? (
            <Icons.Cross size={PROCESS_ICON_SIZE} />
          ) : running ? (
            <span className="pp-spinner" aria-hidden />
          ) : (
            <ToolIcon size={PROCESS_ICON_SIZE} />
          )}
        </span>
        <span className="pp-text">{renderActionText(tool, running ? undefined : toolTypeTag(tool.name), (p) => openPreview({ filePath: p }))}</span>
        {writtenPath && (
          <button
            type="button"
            className="pp-file-chip"
            title={writtenPath}
            onClick={(e) => {
              e.stopPropagation();
              openPreview({ filePath: writtenPath });
            }}
          >
            <Icons.FileText size={12} />
            <span className="pp-file-chip-name">{writtenPath.split(/[\\/]/).pop()}</span>
          </button>
        )}
        {visibility === "redacted" && (
          <span className="pp-redacted-badge" title={decision?.redactedText}>
            已脱敏
          </span>
        )}
        {running && isShell && <span className="pp-timeout" ref={timeoutRef} />}
        {running && !isShell && <span className="pp-elapsed" ref={elapsedRef} />}
        {diffStat && (
          <span
            className="pp-diff"
            aria-label={
              diffStat.removed > 0
                ? `改动 +${diffStat.added} 行，移除 ${diffStat.removed} 行`
                : `新增 ${diffStat.added} 行`
            }
          >
            <span className="pp-diff-add">+{diffStat.added}</span>
            {diffStat.removed > 0 && <span className="pp-diff-del">−{diffStat.removed}</span>}
          </span>
        )}
        <span className="pp-caret" aria-hidden>
          <Icons.ChevronRight size={10} />
        </span>
      </div>

      {showApproval && pending && permissionMode !== "full_access" && (
        <div className="pp-detail pp-detail--approval">
          <ApprovalCard approval={pending} onDecide={onDecide ?? (() => {})} compact />
        </div>
      )}

      {open && <StepDetail tool={tool} />}
    </div>
  );
});
/**
 * 过程流图标统一尺寸（Apple 风格：图标大小一致，靠形状/字重区分层级）。
 * 思考/观察/等待/工具行图标 16px（与 14px 文字视觉等高；stroke 图标需略大于文字像素值才不显小）。
 * ChevronRight 是装饰性展开箭头（10px）除外。
 */
const PROCESS_ICON_SIZE = 16;
// shell 工具（run_shell 等）内核 wall-clock 超时；前端倒计时与其对齐，
// 让「自动终止」机制可见（与 src-tauri/src/agent/tools/shell.rs 的 SHELL_TIMEOUT_SECS=30 同步）。
const SHELL_TIMEOUT_SECS = 30;
