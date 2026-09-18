/**
 * 可见性策略层（G3 / Phase 2）—— 渲染与数据解耦的核心。
 *
 * 设计文档 `docs/design/thinking-visualization-audit.md` §6.3 三层分工：
 *   · 数据层：收事件 → 按 seq 写入 store，不做展示判断；
 *   · 策略层（本文件）：计算 visibility、脱敏、密度裁决 —— 不碰 DOM；
 *   · 视图层：订阅 store → 折叠、节流、Markdown 分段 —— 不反推语义。
 *
 * 此前「该不该显示 / 显示到什么粒度 / 是否脱敏」散落在 ProcessPanel 的内联
 * filter 与 useAgent 的启发式里。本模块把它们收口成**唯一纯函数入口**
 * `applyVisibility(items, ctx)`，组件只消费决策结果，不再自己判断。
 *
 * 零 React 依赖、纯函数、可单测 —— 与 `agentState.ts` 同一风格。
 */

import type {
  AssistantItem,
  Item,
  ThinkingItem,
  ThinkDensity,
  ToolItem,
} from "../types";

/** 渲染语义（与设计文档 §6.2 `NodeBase.visibility` 逐字对齐）。 */
export type Visibility = "visible" | "collapsed" | "devOnly" | "redacted";

/** 内容渲染档位（策略层对密度的具体裁决结果，视图层只做分派）。 */
export type RenderTier = "full" | "preview" | "collapsed" | "hidden";

/** 策略层输入上下文：用户偏好 + 运行时状态 + 用途。 */
export interface VisibilityContext {
  /** 用户思考层密度偏好（collapsed=精简 / peek=预览 / expanded=完整）。 */
  density: ThinkDensity;
  /** live=执行中（全展开）/ done=已完成（可收起）。 */
  mode: "live" | "done";
  /** 圆桌多 Agent 透明视图：忽略用户密度，强制全展示（多席位审计需要）。 */
  roundtable?: boolean;
  /** 导出用途（IX-14 回放导出）：redacted 条目直接剔除。 */
  forExport?: boolean;
  /** ProcessPanel 被用户主动展开：强制显示被 density 隐藏的内部工具/观察，
   *  但 thinking 行的折叠档位仍由 `density` 决定。 */
  expandedView?: boolean;
}

/** 单条裁决结果。 */
export interface ItemDecision {
  /** 决策后的条目（脱敏内容已就地替换）。 */
  item: Item;
  /** 是否进入渲染列表。false 时视图层直接跳过（导出场景剔除 redacted）。 */
  visible: boolean;
  /** 渲染语义（功能/审计含义，如内部工具/脱敏）。 */
  visibility: Visibility;
  /** 内容渲染档位：full=完整 / preview=截断预览 / collapsed=折叠头 / hidden=不渲染（已并入 visible:false）。 */
  render: RenderTier;
  /** redacted 时的占位文本（导出场景忽略，因为整条被剔除）。 */
  redactedText?: string;
}

// ──────────────────────────────────────────────
//  脱敏（G3 隐私核心）
// ──────────────────────────────────────────────
//
// 内核在 system prompt 里注入三块记忆（agent/tools/memory.rs::read_memory_block），
// 用 `<user_profile>` / `<project_memory>` / `<long_term_memory>` 标签包裹；模型在
// CoT 里复述这些内容会原样上屏，再经截图/导出外泄。策略层在渲染前把它们替换为占位符。

const SENSITIVE_BLOCK_RE: RegExp[] = [
  /<user_profile>[\s\S]*?<\/user_profile>/gi,
  /<project_memory>[\s\S]*?<\/project_memory>/gi,
  /<long_term_memory>[\s\S]*?<\/long_term_memory>/gi,
];

const REDACT_BLOCK = "〔已脱敏 · 个人记忆内容〕";
const REDACT_TOOL = "〔已脱敏 · 含敏感参数〕";

export interface RedactResult {
  redacted: boolean;
  text: string;
}

/** 把命中敏感块的内容替换为占位符。纯函数，不改入参。 */
export function redactSensitive(text: string): RedactResult {
  if (!text) return { redacted: false, text };
  let out = text;
  let redacted = false;
  for (const re of SENSITIVE_BLOCK_RE) {
    re.lastIndex = 0;
    if (re.test(out)) {
      redacted = true;
      out = out.replace(re, REDACT_BLOCK);
    }
  }
  return { redacted, text: out };
}

// ──────────────────────────────────────────────
//  内部工具识别（declutter）
// ──────────────────────────────────────────────
//
// 记忆读写、密钥、系统/内部工具等不面向用户审计，默认收起，避免过程流被
// 内部机制刷屏（与文档 §Phase 2「内部工具名 → collapsed」对齐）。

const INTERNAL_TOOL_RE =
  /^(read_memory|update_memory|memory|secrets|secret_|system_|internal_|list_agents|mcp_|sandbox_)/i;

function isInternalTool(name: string): boolean {
  return INTERNAL_TOOL_RE.test(name);
}

// ──────────────────────────────────────────────
//  单条裁决
// ──────────────────────────────────────────────

const REDACTED_KINDS = new Set(["thinking", "assistant", "tool"]);

function decide(item: Item, ctx: VisibilityContext): ItemDecision {
  // 圆桌透明视图：忽略用户密度，强制全展示、不收起。
  const density = ctx.roundtable ? "expanded" : ctx.density;
  const live = ctx.mode === "live";

  switch (item.kind) {
    case "thinking": {
      const t = item as ThinkingItem;
      const { redacted, text } = redactSensitive(t.content);
      if (redacted) {
        const redactedItem: ThinkingItem = { ...t, content: text };
        return {
          item: redactedItem,
          visible: ctx.forExport ? false : true,
          visibility: "redacted",
          render: "full",
          redactedText: REDACT_BLOCK,
        };
      }
      // 空白推理（模型未吐 reasoning / 纯空白占位）不渲染，杜绝空白行；
      // 统一由「查看过程」在存在真实 CoT 时才提供入口。
      if (!text.trim()) {
        return { item, visible: false, visibility: "visible", render: "hidden" };
      }
      // 推理是回合核心内容：即使 collapsed 密度、done 态也不能 hidden，否则纯推
      // 理回合（无工具）在「查看过程」里找不到入口、推理彻底不可见（用户现象：
      // 切换 session 后过程区整体消失）。统一保留可见性，由 ProcessPanel 以可折叠
      // 的「深度思考 >」头呈现；点击后展开完整 CoT，与有工具回合一视同仁。
      if (!live && density === "collapsed") {
        return { item, visible: true, visibility: "visible", render: "collapsed" };
      }
      const render = thinkRender(live, density);
      return { item, visible: render !== "hidden", visibility: "visible", render };
    }

    case "assistant": {
      const a = item as AssistantItem;
      // 非 narration 的 assistant = 最终答案 / 阶段性总结（answer 行）。
      // 回合末尾的终答由 MessageList 抽去 AnswerBubble；但位于工具轮之间的阶段性
      // 总结（非回合末尾）抽不到气泡，只能在这里原样呈现——否则回放时整段总结
      // 凭空消失（用户 2026-08-13 硬指令：最后总结的部分要原版原样，不能删减）。
      // 因此不再 hidden，统一以 full 可见；空白行仍按惯例不渲染。
      if (!a.narration) {
        const { redacted, text } = redactSensitive(a.text);
        if (redacted) {
          const redactedItem: AssistantItem = { ...a, text };
          return {
            item: redactedItem,
            visible: ctx.forExport ? false : true,
            visibility: "redacted",
            render: "full",
            redactedText: REDACT_BLOCK,
          };
        }
        if (!text.trim()) {
          return { item, visible: false, visibility: "visible", render: "hidden" };
        }
        return { item, visible: true, visibility: "visible", render: "full" };
      }
      const { redacted, text } = redactSensitive(a.text);
      if (redacted) {
        const redactedItem: AssistantItem = { ...a, text };
        return {
          item: redactedItem,
          visible: ctx.forExport ? false : true,
          visibility: "redacted",
          render: "full",
          redactedText: REDACT_BLOCK,
        };
      }
      // 用户主动展开「查看过程」时，被 collapsed 密度隐藏的观察行也强制以 full 可见。
      const render = thinkRender(live, density);
      if (render !== "hidden") {
        return { item, visible: true, visibility: "visible", render };
      }
      return { item, visible: !!ctx.expandedView, visibility: "visible", render: ctx.expandedView ? "full" : "hidden" };
    }

    case "tool": {
      const t = item as ToolItem;
      const argsR = redactSensitive(t.args);
      const resR = t.result !== undefined ? redactSensitive(t.result) : null;
      const redacted = argsR.redacted || !!resR?.redacted;
      const redactedItem: ToolItem = {
        ...t,
        args: argsR.text,
        result: resR ? resR.text : t.result,
      };
      if (redacted) {
        return {
          item: redactedItem,
          visible: ctx.forExport ? false : true,
          visibility: "redacted",
          render: "full",
          redactedText: REDACT_TOOL,
        };
      }
      const internal = isInternalTool(t.name);
      // 内部工具 + collapsed 密度：declutter，从过程流剔除（live 模式仍展示，便于观察）。
      // 用户主动展开「查看过程」时强制显示内部工具，方便审计。
      if (internal && !live && density === "collapsed" && !ctx.expandedView) {
        return { item: redactedItem, visible: false, visibility: "collapsed", render: "hidden" };
      }
      // 工具行本身可点开看详情，密度只决定 done 态是否默认展开（这里统一可见、靠点击展开）。
      return {
        item: redactedItem,
        visible: true,
        visibility: internal ? "collapsed" : "visible",
        render: "full",
      };
    }

    case "waiting":
      return { item, visible: true, visibility: "visible", render: "full" };

    default:
      // user / notice / approval / plan / question / connector 等不在过程流里，
      // 由调用方负责；策略层一律不渲染，避免双渲染。
      return { item, visible: false, visibility: "visible", render: "full" };
  }
}

/** 思考/观察行在 done 模式下的渲染档位（密度驱动）。 */
function thinkRender(live: boolean, density: ThinkDensity): RenderTier {
  if (live) return "full"; // 执行中始终全展开，方便实时观察
  // collapsed（默认）：done 态从过程流隐藏冗长 CoT/观察，只看工具轨迹；
  // peek：保留一行截断预览；expanded：完整展示。
  if (density === "expanded") return "full";
  if (density === "peek") return "preview";
  return "hidden";
}

// ──────────────────────────────────────────────
//  批量入口
// ──────────────────────────────────────────────

/**
 * 把扁平 items + 上下文 → 每条裁决。视图层先 `filter(d => d.visible)`，
 * 再按 `d.visibility` / `d.collapsed` 决定渲染形态，不再自己做判断。
 */
export function applyVisibility(items: Item[], ctx: VisibilityContext): ItemDecision[] {
  return items.map((it) => decide(it, ctx));
}

export { REDACTED_KINDS };
