import { useState, useCallback, useEffect, useRef } from "react";
import * as tauri from "../services/tauri";
import { subscribeToAgentEvents } from "../services/eventBus";
import type {
  Item,
  AgentEvent,
  PendingApproval,
  ThinkingItem,
  AssistantItem,
  TodoEntry,
  ProposalPayload,
} from "../types";
import {
  messagesToItems,
  traceToItems,
  createRunningToolItem,
  updateToolResult,
  createThinkingItem,
  createWaitingItem,
  removeWaitingItems,
  upsertThinking,
  sealThinking,
} from "./agentState";

/** ADR-022：排队消息（支持文本 + 图片附件）。 */
export interface QueuedMessage {
  id: string;
  text: string;
  images?: string[]; // base64 data URLs 或 blob URLs
}

export function useAgent(sessionId: string | null, permissionMode?: string) {
  const [items, setItems] = useState<Item[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [reasoningStream, setReasoningStream] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A-4（D9）：单槽改队列 —— 多 Worker 并发 Ask 不丢，队首为当前展示项。
  const [approvalQueue, setApprovalQueue] = useState<PendingApproval[]>([]);
  // 能力①：本回合待办清单。内核每次跃迁全量重推，这里直接覆盖（不做增量合并）。
  const [todos, setTodos] = useState<TodoEntry[]>([]);
  // 能力②：待人工确认的方案（单槽 —— 内核同一回合最多一个 Proposal 在飞）。
  const [pendingProposal, setPendingProposal] = useState<ProposalPayload | null>(null);

  // ── Chat 发送队列（ADR-022：流式回复中发来的消息入队，本轮结束后自动续发）──
  // pendingQueue 为真值源（ref，同步可读），queuedItems 仅用于渲染；
  // busyRef 同步镜像 isStreaming，避免 sendMessage 闭包捕获旧值 + Done 后自动续发的时序竞态。
  const pendingQueue = useRef<QueuedMessage[]>([]);
  // 队列消息自增 id（渲染体裸 let 每次渲染归零会导致同渲染多次入队 id 重复 → useRef）。
  const queueIdCounterRef = useRef(0);
  const [queuedItems, setQueuedItems] = useState<QueuedMessage[]>([]);
  const [queueCount, setQueueCount] = useState(0);
  const busyRef = useRef(false);
  // isStreaming / permissionMode 的 ref 镜像：事件订阅 effect 闭包按需读最新值，
  // 避免首次渲染快照导致的过期闭包（工具结果后等待占位、审批自动放行曾因此失效）。
  const streamingRef = useRef(false);
  const permissionModeRef = useRef(permissionMode);
  const setStreaming = useCallback((v: boolean) => {
    streamingRef.current = v;
    setIsStreaming(v);
  }, []);
  // 渲染期同步：订阅 effect 闭包经 ref 读最新权限模式（避免过期快照）。
  permissionModeRef.current = permissionMode;
  const sendMessageRef = useRef<(content: string, overrideSessionId?: string) => Promise<void> | void>(() => {});

  const streamingBuf = useRef("");
  const reasoningBuf = useRef("");
  // ── 本轮累计 token 消耗（实时 footer「已消耗 ◇ X.XX」显示）
  // 数据流：每个 Token/Thinking 事件按 streaming 文本长度粗估累加（DeepSeek 流式 usage 只
  // 在最后 chunk 携带，前端不直接拿到每个 token 的精确计数），Done 时若真实 token_usage
  // 更大则用真实值覆盖（多次 completion 场景：Done.token_usage 是最后一次 completion 的
  // 总数，本地估算已包含前几次，故取 max 避免回退）。单位 = token 数。
  const [runTokenUsage, setRunTokenUsage] = useState(0);
  const runTokenUsageRef = useRef(0);
  const bumpTokenEstimate = useCallback((text: string) => {
    if (!text) return;
    // 粗估：每 3 字符 ≈ 1 token（DeepSeek 中文/英文混合大致比例）。
    // 上限可接受：误差仅在 Done 前可见，Done 后会被真实值覆盖。
    const est = Math.ceil(text.length / 3);
    if (est <= 0) return;
    runTokenUsageRef.current += est;
    setRunTokenUsage(runTokenUsageRef.current);
  }, []);
  // 两阶段过场定时器：提交后展示「思考中」，~400ms 后过渡为「等待模型响应」。
  // 首个真实事件到达时由 removeWaitingItems 移除 waiting，定时器若尚未触发则自然失效（map 找不到 waiting 项，无副作用）。
  const waitingTimerRef = useRef<number | null>(null);
  /**
   * 分段思考缓冲（G5）：thought_id → 该段累积文本。
   *
   * 和 `reasoningBuf`（整轮累积、供 Done 时回填 AssistantItem.reasoning）职责不同：
   * 这里按段隔离，主推理 `th_main_{n}` 与逐工具意图 `th_{call_id}` 各自成段，
   * 不会互相污染内容。旧内核不带 thought_id 时全部落到 `th_legacy` 单段。
   */
  const thoughtBufs = useRef(new Map<string, string>());
  const lastUserMsg = useRef("");
  const turnStartTime = useRef<number | null>(null);
  // Coalesce per-token setState into one update per animation frame to avoid a
  // re-render storm on long streamed responses (hundreds of tokens → hundreds of
  // React renders). `streamRafRef` guards against scheduling duplicate frames.
  const streamRafRef = useRef<number | null>(null);
  /** 最近一次事件序号（G6）：流式 narration 创建时无可用的 event，借 ref 落稳定 id，弃用 Date.now()。 */
  const lastSeqRef = useRef<number | undefined>(undefined);
  // 流式心跳看门狗（fail-closed）：在飞轮次中超过此时间未收到任何 agent 事件，
  // 判定生成卡死 → 自动 cancel 并提示，避免「处理中」无限挂起。
  const HEARTBEAT_TIMEOUT_MS = 120_000;
  const heartbeatRef = useRef<number | null>(null);
  // 最新 cancel / 提示函数，每次渲染刷新，供事件订阅闭包安全引用（避免过期闭包）。
  const cancelRef = useRef<() => void>(() => {});
  const pushNoticeRef = useRef<(text: string) => void>(() => {});

  const syncQueue = () => {
    setQueuedItems([...pendingQueue.current]);
    setQueueCount(pendingQueue.current.length);
  };

  // 队首出队并发送（幂等：busy 时在飞轮次的 Done 会再次 pump，不会重复发送同一条）。
  const pumpQueue = useCallback(() => {
    if (busyRef.current) return; // 有轮次在飞，其 Done 会续 pump
    const head = pendingQueue.current.shift();
    if (!head) {
      setQueuedItems([]);
      setQueueCount(0);
      return;
    }
    syncQueue();
    sendMessageRef.current(head.text);
  }, []);

  // 用户主动移除某条排队消息（按索引）。
  const removeFromQueue = useCallback((index: number) => {
    pendingQueue.current = pendingQueue.current.filter((_, i) => i !== index);
    syncQueue();
  }, []);

  // 编辑某条排队消息的文本。
  const editQueueItem = useCallback((index: number, newText: string) => {
    if (index >= 0 && index < pendingQueue.current.length) {
      pendingQueue.current[index] = { ...pendingQueue.current[index], text: newText };
      syncQueue();
    }
  }, []);

  // 将某条排队消息上移一位（index > 0 时与前一项交换）。
  const moveQueueUp = useCallback((index: number) => {
    if (index <= 0) return;
    const arr = pendingQueue.current;
    [arr[index - 1], arr[index]] = [arr[index], arr[index - 1]];
    syncQueue();
  }, []);

  // ── Helpers ──

  const flushStreaming = (): string | null => {
    const text = streamingBuf.current.trim();
    if (!text) return null;
    const output = text;
    streamingBuf.current = "";
    setStreamingText("");
    return output;
  };

  const flushReasoning = (): string | null => {
    const text = reasoningBuf.current.trim();
    if (!text) return null;
    reasoningBuf.current = "";
    setReasoningStream("");
    return text;
  };

  const resetBuffers = () => {
    streamingBuf.current = "";
    reasoningBuf.current = "";
    thoughtBufs.current.clear();
    setStreamingText("");
    setReasoningStream("");
  };

  // 心跳计时器：每收到任意 agent 事件就重置；在飞轮次下若 HEARTBEAT_TIMEOUT_MS
  // 内无任何事件 → 触发 fail-closed（提示 + 取消）。
  const resetHeartbeat = useCallback(() => {
    if (heartbeatRef.current !== null) clearTimeout(heartbeatRef.current);
    if (!busyRef.current) return;
    heartbeatRef.current = window.setTimeout(() => {
      pushNoticeRef.current(
        `生成超时（超过 ${HEARTBEAT_TIMEOUT_MS / 1000}s 无新响应，已自动取消）`
      );
      cancelRef.current();
    }, HEARTBEAT_TIMEOUT_MS);
  }, []);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatRef.current !== null) {
      clearTimeout(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  // ── Load messages on session change ──

  useEffect(() => {
    if (!sessionId) {
      setItems([]);
      setApprovalQueue([]);
      setTodos([]);
      setPendingProposal(null);
      return;
    }

    let cancelled = false;
    // 分流/分层：优先走一等公民 `agent_trace` 确定性投影（thinking/intent/tool/observation/
    // answer 全为显式行，切换会话重建必完整，从构造上消除「查看过程」消失）。
    // 老库 session 无 trace 时 `get_trace` 内部已从 messages 回填并返回；极端情况下仍为空
    // 则回退 `messagesToItems`（决策#3：老 messages 表只读保留，兼容不炸）。
    tauri.getTrace(sessionId)
      .then(async (trace) => {
        if (cancelled) return;
        let next: Item[];
        if (trace.length > 0) {
          next = traceToItems(trace);
        } else {
          const msgs = await tauri.getMessages(sessionId);
          if (cancelled) return;
          next = messagesToItems(msgs);
        }
        // 发送中占位保护：items 里已有 waiting（「深度思考中…」= sendMessage 刚插入的
        // 零延迟占位）时不覆盖 —— 否则「新建会话 + 立即发送」路径下，本 effect 的
        // getMessages([]) 会清掉 user + waiting，TTFT 空窗期聊天区一片空白
        //（用户感知「发命令后没反应好几秒」；2026-08-10 定位的竞态）。
        setItems((prev) =>
          prev.some((it) => it.kind === "waiting") ? prev : next
        );
        // reconcile：重建历史后，向后端查询该 session 是否仍有 active run。
        // 若无（或查询失败），且本地未主动发起新发送（busyRef 守护「切会话瞬间发消息」的竞态），
        // 强制解除 streaming 锁定 —— 消除 HMR / 刷新 / 切会话失联导致的输入区卡死。
        try {
          const active = await tauri.hasActiveRun(sessionId);
          if (!active && !busyRef.current) {
            setStreaming(false);
          }
        } catch {
          // 查询失败不阻断：保持现状，交给后续事件自愈
        }
      })
      .catch((err) => console.error("[useAgent] load trace failed:", err));

    // 切换会话清空发送队列（避免跨会话串消息）。
    pendingQueue.current = [];
    setQueuedItems([]);
    busyRef.current = false;
    // 切会话：本轮 token 累计归零，避免上一会话的数字串味到新会话。
    runTokenUsageRef.current = 0;
    setRunTokenUsage(0);
    // 切换会话清空「重新生成」上下文：lastUserMsg 指向最后一条已发送消息，
    // 不复位会导致新会话点「重新生成」时重发上一个会话的消息。
    lastUserMsg.current = "";
    // 待办/方案属「本回合运行态」，不随历史消息回填 —— 换会话一律清空，避免串台。
    setTodos([]);
    setPendingProposal(null);

    return () => { cancelled = true; };
  }, [sessionId]);

  // ── Subscribe to agent events ──

  useEffect(() => {
    if (!sessionId) return;

    return subscribeToAgentEvents((event: AgentEvent) => {
      if (event.data.session_id !== sessionId) return;

      // 心跳看门狗：每个 agent 事件都重置计时（模型/工具/网络任一活跃都算未卡死）。
      resetHeartbeat();

      // ── Streaming coalescing helpers ──
      // Flush the accumulated streaming buffer into the items timeline at most once
      // per animation frame. Called on every Token, but duplicate frames are skipped
      // via streamRafRef so a long response yields ≤ ~60 renders/sec instead of one
      // per token.
      const flushLiveNarration = () => {
        streamRafRef.current = null;
        const text = streamingBuf.current;
        setStreamingText(text);
        setItems((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].kind === "assistant" && (prev[i] as any).isStreaming) {
              const updated = [...prev];
              updated[i] = { ...prev[i] as any, text };
              return updated;
            }
          }
          return [
            ...prev,
            { kind: "assistant" as const, id: `obs-${sessionId}-${lastSeqRef.current ?? "live"}`, text, isStreaming: true },
          ];
        });
      };

      const scheduleStreamFlush = () => {
        if (streamRafRef.current !== null) return;
        streamRafRef.current = requestAnimationFrame(flushLiveNarration);
      };

      // Cancel any pending frame so a deferred flush can't resurrect a live
      // narration item after the turn has advanced (ToolCall/Done/Error seal it
      // synchronously from the current buffer).
      const cancelStreamFlush = () => {
        if (streamRafRef.current !== null) {
          cancelAnimationFrame(streamRafRef.current);
          streamRafRef.current = null;
        }
      };

      switch (event.type) {
        case "Token": {
          if (event.data.seq != null) lastSeqRef.current = event.data.seq;
          streamingBuf.current += event.data.token;
          bumpTokenEstimate(event.data.token);
          scheduleStreamFlush();
          return;
        }

        case "Thinking": {
          // Thinking becomes a first-class timeline entry.
          // 两条缓冲各司其职：
          //   reasoningBuf  —— 整轮累积，Done 时回填 AssistantItem.reasoning（旧契约不动）；
          //   thoughtBufs   —— 按 thought_id 分段，驱动时间轴上的独立思考段（G5）。
          const tid = event.data.thought_id || "th_legacy";
          reasoningBuf.current += event.data.content;
          const segment = (thoughtBufs.current.get(tid) ?? "") + event.data.content;
          thoughtBufs.current.set(tid, segment);
          bumpTokenEstimate(event.data.content);
          thoughtBufs.current.set(tid, segment);

          setItems((prev) =>
            upsertThinking(
              removeWaitingItems(prev),
              sessionId,
              segment,
              event.data.thought_id
            )
          );
          // Keep reasoningStream for backward-compat with MessageList's no-tool turn path
          setReasoningStream(reasoningBuf.current);
          return;
        }

        case "ThinkingEnd": {
          // 段落显式闭合：这一段不再接收增量，后续 Thinking 会另起一段。
          // 没有它的话，主推理和下一步的逐工具意图会被粘进同一个气泡（G5）。
          thoughtBufs.current.delete(event.data.thought_id);
          setItems((prev) => sealThinking(prev, event.data.thought_id));
          return;
        }

        case "ToolCall": {
          // Cancel any in-flight coalesced stream flush — we seal narration here
          // synchronously from the current buffer, and a late frame would recreate it.
          cancelStreamFlush();

          // Flush any accumulated streaming text as narration
          const narText = streamingBuf.current.trim();
          const narReasoning = reasoningBuf.current.trim();

          streamingBuf.current = "";
          reasoningBuf.current = "";
          setStreamingText("");
          setReasoningStream("");

          setItems((prev) => {
            let next = removeWaitingItems(prev);

            // If there was live thinking, finalize it (live → false)
            next = next.map((item) =>
              item.kind === "thinking" && (item as ThinkingItem).live
                ? { ...item, live: false }
                : item
            );

            // Finalize any live narration item. Seal it WITH the current buffer text so
            // the last few coalesced tokens aren't lost when a pending frame was cancelled.
            //
            // 关键：工具轮之间的这段文字是「观察 + 下一步意图」，属于过程，
            // 不是最终答案 —— 打上 narration 标记，MessageList 才不会把它
            // 提升成答案气泡（2026-08-10 修复：观察被当成总输出的 bug）。
            let sealedNarration = false;
            next = next.flatMap((item) => {
              if (item.kind === "assistant" && (item as AssistantItem).isStreaming) {
                sealedNarration = true;
                // 空壳不留残行（模型本轮没吐自然语言，直接调了工具）
                if (!narText && !narReasoning) return [];
                return [
                  {
                    ...(item as AssistantItem),
                    isStreaming: false,
                    narration: true,
                    text: narText,
                    reasoning: narReasoning || undefined,
                  },
                ];
              }
              return [item];
            });

            // Edge case: if for some reason no live narration exists but we have text,
            // create a sealed one (safety net). 用 sealedNarration 而不是「存在任意
            // assistant」判断 —— 否则上一轮留下的观察会吞掉本轮的观察。
            if (narText && !sealedNarration) {
              next = [
                ...next,
                {
                  kind: "assistant" as const,
                  id: `obs-${event.data.call_id ?? (event.data.seq != null ? `s${event.data.seq}` : sessionId)}`,
                  text: narText,
                  reasoning: narReasoning || undefined,
                  narration: true,
                },
              ];
            }

            // Add running tool item
            return [
              ...next,
              createRunningToolItem(
                sessionId,
                event.data.tool_name,
                event.data.tool_args,
                event.data.call_id,
                event.data.seq
              ),
            ];
          });
          return;
        }

        case "ToolResult": {
          // A-4：工具结果到达时，若队列里有同名待审批（典型：超时 fail-closed
          // 拒绝后引擎回传拒绝结果），出队该项 —— 用户已手动应答的出队发生在其
          // decide() 时，这里不会误删（引擎串行执行，同名新审批必在其结果之后）。
          setApprovalQueue((prev) => {
            const idx = prev.findIndex((p) => p.tool_name === event.data.tool_name);
            if (idx === -1) return prev;
            return prev.filter((_, i) => i !== idx);
          });
          setItems((prev) => {
            let updated = updateToolResult(
              prev,
              event.data.tool_name,
              event.data.result,
              event.data.is_error,
              event.data.call_id
            );
            // After tool result, if we're still streaming (more iterations expected),
            // append a waiting item so user knows we're waiting for the model.
            // The next Thinking or ToolCall event will remove it.
            // 先清掉旧 waiting，保证同一时刻最多只有一条 waiting 占位。
            updated = removeWaitingItems(updated);
            if (streamingRef.current) {
              return [...updated, createWaitingItem("model_response", event.data.seq)];
            }
            return updated;
          });
          return;
        }

        case "Done": {
          setStreaming(false);
          clearHeartbeat();
          busyRef.current = false;

          // streamingBuf 在流式过程中实时累积 Token；若模型把结论放在
          // reasoning_content 导致 content/Token 为空，则回退到后端给的
          // final_response，避免工具执行成功后没有答案气泡。
          const finalText = (streamingBuf.current.trim() || event.data.final_response || "").trim();
          const finalReasoning = reasoningBuf.current.trim();

          streamingBuf.current = "";
          reasoningBuf.current = "";
          setStreamingText("");
          setReasoningStream("");
          cancelStreamFlush();

          // 用真实 token_usage 收口（仅当大于本地估算时 —— 单次 completion 场景 Done 数
          // 是权威，多次 completion 场景本地估算已含前几次，取 max 避免回退）。
          const finalUsage = (event.data as { token_usage?: number }).token_usage ?? 0;
          if (finalUsage > runTokenUsageRef.current) {
            runTokenUsageRef.current = finalUsage;
            setRunTokenUsage(finalUsage);
          }

          setItems((prev) => {
            let next = removeWaitingItems(prev);

            // Finalize any remaining live thinking
            next = next.map((item) =>
              item.kind === "thinking" && (item as ThinkingItem).live
                ? { ...item, live: false }
                : item
            );

            // Finalize any live narration item. Seal it WITH finalText so the last few
            // coalesced tokens aren't lost when a pending frame was cancelled.
            // 收尾这条是**最终答案**，显式清掉 narration 标记（它可能是上一轮
            // 留下的同一个 item 被复用）。
            next = next.flatMap((item) => {
              if (item.kind === "assistant" && (item as AssistantItem).isStreaming) {
                if (!finalText) return [];
                return [
                  {
                    ...(item as AssistantItem),
                    isStreaming: false,
                    narration: false,
                    text: finalText,
                    // reasoning 随答案携带：供 ProcessPanel 回放还原 CoT（纯推理轮无独立 thinking 行时由 buildTurns 提取）
                    reasoning: finalReasoning || (item as AssistantItem).reasoning,
                  },
                ];
              }
              return [item];
            });

            if (finalText) {
              // 有 thinking 行（实时 Thinking 事件已产生独立段）时不 push 冗余行——
              // 否则有工具轮里 reasoningBuf 已被 ToolCall 清空，finalReasoning 只剩
              // 最后一段，会与实时段重复（§9-2 验收暴露：两段思考渲染成三行）。
              // 纯思考轮兜底：无 thinking 行时才 push（供 buildTurns 提取 reasoning）。
              if (finalReasoning) {
                const hasThinking = next.some((it) => it.kind === "thinking");
                if (!hasThinking) {
                  next.push(createThinkingItem(sessionId, finalReasoning, false, undefined, lastSeqRef.current));
                }
              }
              // Only push if a真正的答案 item 还不存在。
              // 注意排除 narration：工具轮之间的观察也是 sealed assistant，
              // 若把它算作「已有答案」，真正的终答就会被丢掉，用户最后只看到
              // 半路的观察文字（2026-08-10 修复的核心）。
              const hasSealedAnswer = next.some(
                (it) =>
                  it.kind === "assistant" &&
                  !(it as AssistantItem).isStreaming &&
                  !(it as AssistantItem).narration
              );
              if (!hasSealedAnswer) {
                next.push({
                  kind: "assistant" as const,
                  id: `ans-${sessionId}-${lastSeqRef.current ?? "final"}`,
                  text: finalText,
                  // reasoning 随答案携带：供 ProcessPanel 回放还原 CoT
                  reasoning: finalReasoning || undefined,
                });
              }
            }

            // Safety: Done 表示本回合已结束，任何残留的 isStreaming 标记都应清除，
            // 避免 coalescing 竞态导致答案气泡继续显示 typing 指示器。
            next = next.map((item) =>
              item.kind === "assistant" && (item as AssistantItem).isStreaming
                ? { ...item, isStreaming: false }
                : item
            );

            return next;
          });
          // 本轮正常结束，自动续发队列中下一条（如有）。
          pumpQueue();
          return;
        }

        case "Error": {
          setError(event.data.message);
          busyRef.current = false;
          clearHeartbeat();
          cancelStreamFlush();

          const flushed = flushStreaming();
          flushReasoning();

          const notice = { kind: "notice" as const, tone: "error" as const, text: event.data.message, retriable: true };
          setItems((prev) => {
            let next = removeWaitingItems(prev);
            // Seal any live narration so it doesn't keep showing the typing cursor.
            next = next.map((item) =>
              item.kind === "assistant" && (item as any).isStreaming
                ? { ...item, isStreaming: false }
                : item
            );
            // If the current turn already has content (user/narration/tools),
            // a mid-stream error shouldn't promote partial text to "answer".
            // Discard partial text and append only the notice.
            const hasContent = next.some(it =>
              it.kind === "user" || it.kind === "tool" || it.kind === "thinking" ||
              (it.kind === "assistant" && (it.text || it.reasoning))
            );
            if (hasContent) {
              return [...next, notice];
            }
            return flushed
              ? [...next, { kind: "assistant" as const, text: flushed }, notice]
              : [...next, notice];
          });
          // 本轮问题通过 notice 体现（ProcessPanel 显示「已出错 · 查看过程」），
          // 不再用翻转 isStreaming 来强制收起/制造「收起→再展开」的闪烁。
          // 仅当队列已空（无解发后续回合）时，才释放 isStreaming 让输入区恢复可用；
          // 有排队消息时交给 pumpQueue 起新回合接管 isStreaming（sendMessage 自会置 true），
          // 此处不翻转，新回合直接 live，旧回合因不再是 lastTurn 自然落到「已出错」收起态。
          const queueEmpty = pendingQueue.current.length === 0;
          pumpQueue();
          if (queueEmpty) {
            setStreaming(false);
          }
          return;
        }

        case "ApprovalRequest": {
          // 群协作 Worker 审批（session_id 以 `rt:` 开头）由全局审批托盘接管，
          // 主会话审批才入此队列 —— 按前缀分流，避免双重处理。
          if (event.data.session_id.startsWith("rt:")) return;
          // 完全访问模式：自动批准，不入队、不弹卡
          if (permissionModeRef.current === "full_access") {
            tauri.decideApproval(event.data.approval_id, "accept").catch(() => {});
            return;
          }
          // A-4：入队（approval_id 为键，多并发不覆盖）。
          setApprovalQueue((prev) => [
            ...prev,
            {
              approval_id: event.data.approval_id,
              session_id: event.data.session_id,
              tool_name: event.data.tool_name,
              tool_args: event.data.tool_args,
              seat: event.data.seat ?? null,
              risk: event.data.risk,
            },
          ]);
          return;
        }

        case "TodoUpdate": {
          // 全量快照覆盖：内核在每次状态跃迁时重推整张清单，前端不做 diff 合并。
          setTodos(event.data.todos);
          return;
        }

        case "Proposal": {
          // 与审批同款分流：群协作 Worker（`rt:` 前缀）走全局托盘，主会话才进本地单槽。
          if (event.data.session_id.startsWith("rt:")) return;
          setPendingProposal({
            session_id: event.data.session_id,
            proposal_id: event.data.proposal_id,
            title: event.data.title,
            summary: event.data.summary,
            options: event.data.options,
            risk: event.data.risk,
            seat: null,
          });
          return;
        }

        case "RunArtifacts": {
          // R8：run 收尾下发的产物/变更汇入清单。挂到本回合「已封口的最终答案」助理项上，
          // 供 MessageList 在其上方渲染「查看所有产物 / 变更」入口。
          // 命中策略：从数组末尾往前找第一个「非流式、非观察」的 assistant —— 即当前回合答案。
          setItems((prev) => {
            let idx = -1;
            for (let i = prev.length - 1; i >= 0; i--) {
              const it = prev[i];
              if (
                it.kind === "assistant" &&
                !(it as AssistantItem).isStreaming &&
                !(it as AssistantItem).narration
              ) {
                idx = i;
                break;
              }
            }
            if (idx === -1) return prev;
            const target = prev[idx] as AssistantItem;
            const updated = [...prev];
            updated[idx] = {
              ...target,
              runId: event.data.run_id,
              artifacts: event.data.artifacts,
            };
            return updated;
          });
          return;
        }
      }
    });
  }, [sessionId]);

  // ── Actions ──

  const sendMessage = useCallback(
    async (content: string, overrideSessionId?: string) => {
      const sid = overrideSessionId || sessionId;
      if (!sid || !content.trim()) return;

      // R-steer + ADR-022：流式回复进行中 → 先试中途引导（下一个 LLM 步骤前
      // 合入，模型立即看到），未命中在跑循环才回落到排队（整轮结束后续发）。
      // 引导消息同样进消息流与历史（内核经事件日志落库，Model-Visible ⟺ Logged）。
      if (busyRef.current) {
        try {
          const steered = await tauri.steerAgent(sid, content.trim());
          if (steered) {
            setItems((prev) => [...prev, { kind: "user", text: content } as Item]);
            lastUserMsg.current = content.trim();
            return;
          }
        } catch {
          // steer 通道异常（如旧内核无此命令）→ 回落入队，不丢消息。
        }
        const qm: QueuedMessage = {
          id: `q-${++queueIdCounterRef.current}-${Date.now()}`,
          text: content.trim(),
        };
        pendingQueue.current = [...pendingQueue.current, qm];
        syncQueue();
        return;
      }

      setError(null);
      busyRef.current = true;
      setStreaming(true);
      resetBuffers();
      // 新回合开始：清掉上一回合的待办残影，等内核规划完再由 TodoUpdate 填回。
      setTodos([]);
      setPendingProposal(null);
      // 新一轮回答：本轮 token 消耗从 0 开始重新累计（footer「已消耗」按「本次回答」口径）。
      runTokenUsageRef.current = 0;
      setRunTokenUsage(0);
      lastUserMsg.current = content.trim();
      turnStartTime.current = Date.now();
      setItems((prev) => [
        ...prev,
        { kind: "user", text: content },
        // 零延迟占位：在后端首个事件（Thinking/ToolCall/Token）到达前消除空白感。
        // 第一个真实事件到达时由 removeWaitingItems 自动移除。
        // 两阶段过场：初始「思考中」，~400ms 后由下方定时器切到「等待模型响应」。
        createWaitingItem("thinking"),
      ]);

      // 两阶段过场：提交后短暂展示「思考中」，随后过渡为「等待模型响应」，
      // 直到首个真实事件到达由 removeWaitingItems 移除（spinner + 文案淡入动效）。
      if (waitingTimerRef.current) clearTimeout(waitingTimerRef.current);
      waitingTimerRef.current = window.setTimeout(() => {
        setItems((prev) =>
          prev.map((it) =>
            it.kind === "waiting" ? { ...it, label: "model_response" } : it
          )
        );
      }, 400);

      try {
        await tauri.sendMessage(sid, content);
      } catch (err) {
        console.error("[useAgent] send failed:", err);
        setError(`发送失败: ${err}`);
        busyRef.current = false;
        setStreaming(false);
      }
    },
    [sessionId]
  );

  const clearError = useCallback(() => setError(null), []);

  /** Format elapsed turn duration as "Xm Xs" (or "Xs" for < 60s). */
  const getElapsed = useCallback((): string => {
    if (!turnStartTime.current) return "";
    const sec = Math.floor((Date.now() - turnStartTime.current) / 1000);
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m${s}s`;
  }, []);

  // A-4：四态决策。应答队首审批（pendingApproval），成功后出队。
  const pendingApproval = approvalQueue[0] ?? null;
  const decide = useCallback(
    async (action: "accept" | "edit" | "respond" | "ignore", args?: unknown, feedback?: string) => {
      if (!pendingApproval) return;
      try {
        await tauri.decideApproval(pendingApproval.approval_id, action, args, feedback);
      } finally {
        setApprovalQueue((prev) => prev.slice(1));
      }
    },
    [pendingApproval]
  );

  const approve = useCallback(() => decide("accept"), [decide]);

  const reject = useCallback(() => decide("ignore"), [decide]);

  // 能力②：应答方案确认。先清 UI 单槽再等命令返回（乐观关闭），
  // 失败也不回滚 —— 内核 5 分钟超时兜底为 rejected，不会挂死。
  const resolveProposal = useCallback(
    async (decision: "selected" | "custom" | "rejected", optionId?: string, customText?: string) => {
      if (!pendingProposal) return;
      const id = pendingProposal.proposal_id;
      setPendingProposal(null);
      try {
        await tauri.decideProposal(id, decision, optionId, customText);
      } catch (err) {
        console.error("[useAgent] decideProposal failed:", err);
      }
    },
    [pendingProposal]
  );

  const regenerate = useCallback(async () => {
    if (!sessionId || !lastUserMsg.current || busyRef.current) return;
    await sendMessage(lastUserMsg.current);
  }, [sessionId, sendMessage]);

  const cancel = useCallback(async () => {
    if (!sessionId) return;
    await tauri.cancelAgent(sessionId);
    setStreaming(false);
    busyRef.current = false;
    // 主动停止后让队列续发（幂等：若引擎随后回 Done 会再次 pump，不会重复发送）。
    pumpQueue();
  }, [sessionId, pumpQueue]);

  // 心跳看门狗依赖的最新取消 / 提示函数（每次渲染刷新引用，供订阅闭包安全调用）。
  cancelRef.current = cancel;
  pushNoticeRef.current = (text: string) => {
    setItems((prev) => [
      ...prev,
      { kind: "notice" as const, tone: "error" as const, text, retriable: true },
    ]);
  };

  // 心跳看门狗随流状态启停：开始流式 → 启动；结束（Done/Error/主动取消）→ 清除。
  useEffect(() => {
    if (isStreaming) resetHeartbeat();
    else clearHeartbeat();
  }, [isStreaming, resetHeartbeat, clearHeartbeat]);

  // 始终指向最新 sendMessage，供事件订阅闭包（仅 [sessionId] 依赖）安全调用，避免自动续发时用旧闭包。
  sendMessageRef.current = sendMessage;

  return {
    items, isStreaming, streamingText, reasoningStream, error,
    sendMessage, cancel, clearError, pendingApproval, approve, reject, decide,
    approvalQueue, regenerate,
    queuedItems, queueCount, removeFromQueue, editQueueItem, moveQueueUp,
    getElapsed,
    // 本轮回答累计 token（实时 footer「已消耗 ◇ X.XX」用），Done 后保持显示直到下一轮开始。
    runTokenUsage,
    // 能力①待办清单 / 能力②方案确认
    todos, pendingProposal, resolveProposal,
  };
}
