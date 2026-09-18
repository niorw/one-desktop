/**
 * Pure state transformations for the Agent items array.
 * Separated from useAgent hook for testability and clarity.
 */

import type { Item, Message, ToolItem, ThinkingItem, WaitingItem, AssistantItem, AgentNode, TraceRow } from "../types";

/**
 * 这行消息「是什么」（G2）。
 *
 * 新库由内核落库时固化 `item_kind`；老库为空则退回 `role`。之所以不直接一直用
 * `role`：role 是 LLM 协议概念（assistant 既可能是答案也可能是 tool_call），
 * item_kind 是**展示语义**，两者未来会分叉，这里先把读取口径收敛到一处。
 */
function kindOf(msg: Message): string {
  return msg.item_kind || msg.role;
}

/** Convert database messages to UI items */
/**
 * 把后端时间字段解析为 epoch ms（number）。
 * - 纯数字：< 1e12 视为秒、否则视为毫秒；
 * - 字符串：优先按 ISO/RFC3339 解析（Date.parse），失败回落 undefined。
 * 用于把 TraceRow/Message 的时间戳带进 UI Item，供 ProcessPanel 计算回合耗时。
 */
export function toEpochMs(s?: string | number | null): number | undefined {
  if (s == null) return undefined;
  if (typeof s === "number") return s < 1e12 ? s * 1000 : s;
  const trimmed = s.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(trimmed);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * R8：把落库的 `artifacts`（JSON 数组字符串）解析为本回合写入文件清单。
 * 解析失败 / 空值回落 undefined，调用方据此决定是否渲染「查看所有产物」入口。
 */
function parseArtifacts(raw?: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : undefined;
  } catch {
    return undefined;
  }
}

export function messagesToItems(messages: Message[]): Item[] {
  // 第一遍：索引工具结果。
  //
  // 优先按 call_id 精确配对——按 tool_name 索引会在「同一工具被调多次」时
  // 全部命中最后一条结果（读同一批文件、连续 grep 都会踩到）。老行没有
  // call_id，只能退回 name 索引，行为与改动前一致，不引入回归。
  const resultByCallId = new Map<string, string>();
  const resultByName = new Map<string, string>();
  for (const msg of messages) {
    if (kindOf(msg) === "tool") {
      if (msg.call_id) resultByCallId.set(msg.call_id, msg.content);
      if (msg.tool_name) resultByName.set(msg.tool_name, msg.content);
    }
  }

  const items: Item[] = [];
  // 主推理序号：与 traceToItems 一致，给无 call_id 的主推理补 th_main_* 身份，
  // 否则回放时被 ProcessPanel 误判为意图行（compass+纯文本），丢失「深度思考」框。
  let mainSeq = 0;
  for (const msg of messages) {
    switch (kindOf(msg)) {
      case "user":
        items.push({ kind: "user", text: msg.content, ts: toEpochMs(msg.created_at) });
        break;

      case "assistant": {
        if (msg.tool_name) {
          // 逐工具意图思考（th_{call_id}）落库在带 tool_name 的 assistant 行的
          // reasoning_content —— 历史重建必须拆回独立 thinking item，紧邻其工具之前，
          // 与实时链路顺序一致（思考→执行→观察）。否则「查看过程」里占多数的
          // 逐工具思考全部丢失，只剩工具骨架，切换会话后过程流残缺/入口不稳。
          if (msg.reasoning_content) {
            items.push({
              kind: "thinking",
              id: msg.call_id ? `think-th-${msg.call_id}` : `think-${msg.id}`,
              content: msg.reasoning_content,
              live: false,
              seq: msg.seq,
              ts: toEpochMs(msg.created_at),
            });
          }
          const result = msg.call_id
            ? resultByCallId.get(msg.call_id)
            : resultByName.get(msg.tool_name);
          const isErr = (msg.tool_result ?? "").includes("Error");
          items.push({
            kind: "tool",
            // call_id 是跨重启稳定的身份；缺失时回落到行 id（同样稳定，只是无法配对）
            id: msg.call_id ? `tool-${msg.call_id}` : `tool-${msg.id}`,
            name: msg.tool_name,
            args: msg.tool_args || "{}",
            status: "done" as const,
            result,
            isError: isErr,
            callId: msg.call_id ?? undefined,
            seq: msg.seq,
            ts: toEpochMs(msg.created_at),
          });
        } else {
          // 推理内容（reasoning_content）落库时挂在与最终答案同一行，历史重建必须
          // 拆回「独立 thinking item + 答案 assistant」——与实时链路的统一渲染契约
          // 一致（thinking 进 ProcessPanel 的「查看过程」，不进答案气泡）。否则重建后
          // groupItems 被 buildTurns 抽空 → 切回会话时「查看过程」入口消失。
          // 主推理（无 tool_name）补 th_main_* 身份，恢复「深度思考」框（与实时 th_main_{iter} 一致）。
          if (msg.reasoning_content) {
            mainSeq += 1;
            items.push({
              kind: "thinking",
              id: `think-th_main_${mainSeq}`,
              content: msg.reasoning_content,
              live: false,
              seq: msg.seq,
              thoughtId: `th_main_${mainSeq}`,
              ts: toEpochMs(msg.created_at),
            });
          }
          items.push({
            kind: "assistant",
            text: msg.content,
            reasoning: undefined,
            ts: toEpochMs(msg.created_at),
            // R8：本回合运行 id + 写入文件清单，供答案气泡上方渲染「查看所有产物/变更」入口。
            runId: msg.run_id ?? undefined,
            artifacts: parseArtifacts(msg.artifacts),
          });
        }
        break;
      }
      // tool role messages are embedded into corresponding assistant tool_call items
    }
  }

  return markNarrations(items);
}

/**
 * 分流/分层：把一等公民 `agent_trace` 行确定性投影为 UI `Item[]`。
 *
 * 与 `messagesToItems` 的根本区别：思考/意图/工具调用/工具结果/观察/答案都是**显式行**，
 * 这里只做 1:1 装配（按 `call_id` 配对 tool_call↔tool_result，thinking/observation 直接成项），
 * 不再靠「超载列 + 启发式反推」。因此切换会话重建出的 `items` 必定完整——
 * 只要该轮发生过过程，`groupItems` 必非空，「查看过程」入口从构造上不再消失。
 *
 * 老库（无 trace）不进此函数：useAgent 在 `get_trace` 返回空时回退 `messagesToItems`。
 */
export function traceToItems(trace: TraceRow[]): Item[] {
  // 第一遍：用 call_id 精确配对 tool_result（行已显式，无需模糊/同名回退）。
  const resultByCallId = new Map<string, { result: string; isError: boolean }>();
  for (const t of trace) {
    if (t.kind === "tool_result" && t.call_id) {
      const text = t.result ?? t.content ?? "";
      resultByCallId.set(t.call_id, {
        result: text,
        isError: t.is_error ?? text.includes("Error"),
      });
    }
  }

  const items: Item[] = [];
  // 主推理序号：trace 的 `thinking`（主推理/CoT）行落库时无 call_id，回放时必须补
  // `th_main_*` 身份，否则 ProcessPanel 会把它当成意图行（compass + 纯文本）渲染，
  // 丢失「深度思考」框与 Markdown 排版——与实时链路（th_main_{iter}）不一致，
  // 切换会话重建后过程流降级成全意图行。这里按出现顺序派生稳定序号。
  let mainSeq = 0;
  for (const t of trace) {
    switch (t.kind) {
      case "user":
        items.push({ kind: "user", text: t.content ?? "", ts: t.started_at ?? toEpochMs(t.created_at) });
        break;

      case "thinking": {
        // 主推理（CoT，对应实时 th_main_{iter}）：补 th_main_* 身份，恢复「深度思考」框。
        if (t.reasoning) {
          mainSeq += 1;
          items.push({
            kind: "thinking",
            id: `think-th_main_${mainSeq}`,
            content: t.reasoning,
            live: false,
            seq: t.seq,
            thoughtId: `th_main_${mainSeq}`,
            ts: t.started_at ?? toEpochMs(t.created_at),
          } as ThinkingItem);
        }
        break;
      }

      case "intent":
        // 逐工具意图（intent，thought_id=`th_{call_id}`）各自成项。
        if (t.reasoning) {
          items.push({
            kind: "thinking",
            id: `think-${t.call_id ?? t.id}`,
            content: t.reasoning,
            live: false,
            seq: t.seq,
            thoughtId: t.call_id ? `th_${t.call_id}` : undefined,
            ts: t.started_at ?? toEpochMs(t.created_at),
          } as ThinkingItem);
        }
        break;

      case "tool_call": {
        const pr = t.call_id ? resultByCallId.get(t.call_id) : undefined;
        items.push({
          kind: "tool",
          id: `tool-${t.call_id ?? t.id}`,
          name: t.name ?? "",
          args: t.args ?? "{}",
          status: "done" as const,
          result: pr?.result,
          isError: pr?.isError ?? false,
          callId: t.call_id ?? undefined,
          seq: t.seq,
          ts: t.started_at ?? toEpochMs(t.created_at),
        } as ToolItem);
        break;
      }

      // tool_result 已通过 call_id 配对进其 tool_call，不单独成项。
      case "tool_result":
        break;

      case "answer":
        items.push({ kind: "assistant", text: t.content ?? "", ts: t.started_at ?? toEpochMs(t.created_at) });
        break;

      // 工具轮间观察 = 过程（narration），不提升为答案气泡（与 messagesToItems 语义一致）。
      case "observation":
        items.push({ kind: "assistant", text: t.content ?? "", narration: true, ts: t.started_at ?? toEpochMs(t.created_at) } as AssistantItem);
        break;

      case "notice":
        items.push({ kind: "notice", tone: "error", text: t.content ?? "", retriable: true });
        break;
    }
  }

  return items;
}

/**
 * 历史回放时补齐 narration 标记。
 *
 * 实时链路由 useAgent 在 ToolCall 事件里打标，但从 DB 重建时这个信息不在
 * 表结构里，只能按位置推断：**同一个 user 轮内，位于最后一个工具调用之前的
 * assistant 文字，一定是「观察 / 下一步意图」，不可能是最终答案**（真正的
 * 终答只会出现在所有工具跑完之后）。
 *
 * 不这么做的话，重开历史会话时中间那段观察（例：「语法 ✓，17/18 断言通过」）
 * 又会被 MessageList 提升成答案气泡 —— 也就是 2026-08-10 修的那个 bug。
 */
function markNarrations(items: Item[]): Item[] {
  const out = [...items];
  let segStart = 0;

  const markSegment = (start: number, end: number) => {
    let lastToolIdx = -1;
    for (let i = start; i < end; i++) {
      if (out[i].kind === "tool") lastToolIdx = i;
    }
    if (lastToolIdx < 0) return; // 纯问答轮，没有工具 → 不存在观察
    for (let i = start; i < lastToolIdx; i++) {
      const it = out[i];
      if (it.kind === "assistant") {
        out[i] = { ...(it as AssistantItem), narration: true };
      }
    }
  };

  for (let i = 0; i < out.length; i++) {
    if (out[i].kind === "user") {
      markSegment(segStart, i);
      segStart = i + 1;
    }
  }
  markSegment(segStart, out.length);

  return out;
}

/**
 * Create a new running tool item.
 *
 * 有 `callId` 时用它做 React key —— `Date.now()` 在同一毫秒内并发发起多个工具
 * 会撞 id，React 复用错节点导致结果串行；call_id 由内核保证唯一。
 */
export function createRunningToolItem(
  sessionId: string,
  name: string,
  args: string,
  callId?: string,
  seq?: number
): ToolItem {
  return {
    kind: "tool",
    id: callId ? `tool-${callId}` : `tool-${sessionId}-${name}-${seq ?? Date.now()}`,
    name,
    args,
    status: "running",
    callId,
    seq,
  };
}

/**
 * 回填工具结果。
 *
 * 匹配优先级：`callId` 精确命中 > 同名最后一个 running > 同名最后一个。
 * 并发多工具时只有 call_id 靠得住——按名字倒查会把先返回的结果贴到后发起的
 * 那一个上（G1 要解决的核心错配）。
 */
export function updateToolResult(
  items: Item[],
  toolName: string,
  result: string,
  isError: boolean,
  callId?: string
): Item[] {
  const patch = (i: number): Item[] => {
    const updated = [...items];
    updated[i] = {
      ...(items[i] as ToolItem),
      status: (isError ? "error" : "done") as ToolItem["status"],
      result,
      isError,
    };
    return updated;
  };

  if (callId) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "tool" && it.callId === callId) return patch(i);
    }
    // call_id 没命中（极少见：事件乱序或历史 item 无 id）时不直接返回，
    // 继续走名字回退，宁可近似也别让结果彻底丢失。
  }

  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool" && it.name === toolName && it.status === "running") return patch(i);
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool" && it.name === toolName) return patch(i);
  }
  return items; // No matching tool found
}

/** Create a thinking item (first-class timeline entry for reasoning). */
export function createThinkingItem(
  sessionId: string,
  content: string,
  live = false,
  thoughtId?: string,
  seq?: number
): ThinkingItem {
  return {
    kind: "thinking",
    id: thoughtId ? `think-${thoughtId}` : `think-${sessionId}-${seq ?? Date.now()}`,
    content,
    live,
    thoughtId,
    seq,
  };
}

/**
 * 按段落追加思考内容（G5）。
 *
 * 有 `thoughtId` 时严格按段落归位：同段追加、异段新建。这是「两段独立思考被
 * 粘成一坨」的根治手段——此前只认「最后一个 live 段」，主推理和逐工具意图会
 * 落进同一个气泡。无 id（旧内核）时保持原行为。
 *
 * `content` 是该段的**全量累积文本**，不是增量——调用方持有分段缓冲区。
 */
export function upsertThinking(
  items: Item[],
  sessionId: string,
  content: string,
  thoughtId?: string
): Item[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== "thinking") continue;
    const hit = thoughtId ? it.thoughtId === thoughtId : it.live;
    if (hit) {
      const updated = [...items];
      updated[i] = { ...it, content, live: true };
      return updated;
    }
    // 有 id 时不能因为撞见别的 thinking 就停——中间可能隔着已封存的段落。
    if (!thoughtId && it.live) break;
  }
  return [...items, createThinkingItem(sessionId, content, true, thoughtId)];
}

/**
 * 封存思考段（收到 `ThinkingEnd`）。
 *
 * 指定 `thoughtId` 只封那一段；不指定则封所有 live 段（Done/Error 收尾用）。
 */
export function sealThinking(items: Item[], thoughtId?: string): Item[] {
  let touched = false;
  const next = items.map((it) => {
    if (it.kind !== "thinking" || !it.live) return it;
    if (thoughtId && it.thoughtId !== thoughtId) return it;
    touched = true;
    return { ...it, live: false };
  });
  return touched ? next : items;
}

/** Create a waiting-state item (shown between events). */
export function createWaitingItem(label: string, seq?: number): WaitingItem {
  return {
    kind: "waiting",
    id: `wait-${seq ?? Date.now()}`,
    label,
    seq,
  };
}

/** Remove all waiting items from the items array before appending real content.
 *  工具结果后追加的 waiting 是「当前在等待模型响应」的瞬态占位；一旦新的真实事件
 *  （Thinking / ToolCall / Done / Error）到达，所有 waiting 都应被清掉，否则多工具
 *  连续返回时中间会残留多个「等待模型响应」spinner，甚至回合结束后仍挂在过程流里。
 */
export function removeWaitingItems(items: Item[]): Item[] {
  return items.filter((it) => it.kind !== "waiting");
}

/**
 * Split a completed turn's items into the final answer and the process trail.
 *
 * `resultItem` = the LAST `assistant` item (the model's final answer). Everything
 * before it becomes `processItems` (thinking / tool / waiting / intermediate
 * narration) shown inside the collapsible detail region.
 *
 * Centralized here so both the live timeline and the collapsed summary render the
 * same split, instead of re-implementing the "last assistant" scan in two places.
 */
export function splitTurnResult(items: Item[]): {
  processItems: Item[];
  resultItem: AssistantItem | null;
} {
  let lastAssistantIdx = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  const resultItem = lastAssistantIdx >= 0 ? (items[lastAssistantIdx] as AssistantItem) : null;
  const processItems = lastAssistantIdx >= 0 ? items.slice(0, lastAssistantIdx) : items;
  return { processItems, resultItem };
}

/**
 * 节点树派生（Phase 3 / G2·G4）。输入扁平 `Item` 序列（已含 seq/call_id/thought_id，
 * 由 Phase 1 身份补全保证），输出**保持原序**的 `AgentNode[]`，并为每个节点算出
 * `parentId`（嵌套）与 `children`（派生层级）。视图层只消费此树，不再按位置启发式反推结构。
 *
 * 嵌套规则（与内核「思考→工具→子思考」一致）：
 *   · ThinkingItem → 成为后续工具/观察的父（主推理或逐工具意图 `th_{call_id}`）；
 *   · ToolItem 有 call_id 且存在 `thoughtId="th_{call_id}"` 的意图段 → 优先挂到该段下，
 *     否则挂到最近一条思考段下；
 *   · narration 观察 → 挂到最近一条工具（它在观察上一步结果），否则最近思考；
 *   · 最终答案（非 narration）/user/notice 等 → 不进过程树嵌套，parentId 留空。
 * 历史数据无 seq 时回落数组下标，保证回放不炸；启发式从「唯一手段」降级为「兼容兜底」。
 */
export function buildNodeTree(items: Item[]): AgentNode[] {
  const nodes: AgentNode[] = items.map((it, i) => {
    const base = it as Item & { seq?: number; id?: string };
    return {
      ...it,
      seq: base.seq ?? i,
      id: base.id ?? `${it.kind}-${base.seq ?? i}`,
      parentId: undefined,
      children: [] as AgentNode[],
    } as AgentNode;
  });

  const intentIdxByThought = new Map<string, number>(); // thoughtId -> node index
  let lastThoughtIdx = -1;
  let lastToolIdx = -1;
  const idOf = (idx: number): string | undefined => (nodes[idx] as { id?: string }).id;

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === "thinking") {
      const tid = (n as ThinkingItem).thoughtId;
      if (tid) intentIdxByThought.set(tid, i);
      lastThoughtIdx = i;
    } else if (n.kind === "tool") {
      const cid = (n as ToolItem).callId;
      const intentIdx = cid ? intentIdxByThought.get(`th_${cid}`) : undefined;
      n.parentId =
        intentIdx !== undefined
          ? idOf(intentIdx)
          : lastThoughtIdx >= 0
          ? idOf(lastThoughtIdx)
          : undefined;
      lastToolIdx = i;
    } else if (n.kind === "assistant") {
      const a = n as AssistantItem;
      if (a.narration) {
        // 观察：挂到最近工具（观察上一步结果），否则最近思考
        n.parentId =
          lastToolIdx >= 0
            ? idOf(lastToolIdx)
            : lastThoughtIdx >= 0
            ? idOf(lastThoughtIdx)
            : undefined;
      }
      // 最终答案（非 narration）不进过程树嵌套
    }
  }

  // 构建 children 列表（派生层级，供未来嵌套渲染；不影响扁平时间轴渲染）
  for (const n of nodes) {
    if (n.parentId) {
      const parent = nodes.find((p) => (p as { id?: string }).id === n.parentId);
      if (parent && parent !== n) parent.children.push(n);
    }
  }

  return nodes;
}
