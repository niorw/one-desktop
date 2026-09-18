import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, ClipboardEvent as ReactClipboardEvent } from "react";
import type { Components } from "react-markdown";
import { useI18n } from "../../../i18n/I18nProvider";
import type { DictKey } from "../../../i18n/dict";
import * as groupCommands from "../../../services/groupCommands";
import { subscribeToRoundtable, subscribeToRoundtableSummary, subscribeToRoundtableToken } from "../../../services/eventBus";
import { Icons } from "../../common/Icons";
import { friendlyError } from "../../../services/errors";
import { Markdown } from "../../../utils/markdown";
import { PixelAvatar, workerColors } from "../../common/PixelAvatar";
import { AltsCompare } from "../../../features/insight/AltsCompare";
import type {
  RoundtableAlternative, RoundtableEvent, RoundtableMessage, RoundtableSummary,
  RoundtableSummaryEvent, RoundtableTokenEvent, Worker, WorkerMetric, Group,
} from "../../../types";
import { agentDisplayName } from "./helpers";
import { workerRole } from "./roles";
import { BroadcastConfirmModal, type BroadcastTarget } from "./BroadcastConfirmModal";
import { MessageRerunModal, type RerunMode } from "./MessageRerunModal";
import { usePreview } from "../../artifacts/PreviewProvider";
import { open } from "@tauri-apps/plugin-dialog";
import { importAttachment, savePasteAttachment } from "../../../services/attachment";
import {
  extractDroppedFiles,
  extractPastedImage,
  fileToBase64,
  formatBytes,
  isImageName,
  type PendingAttachment,
} from "../../../utils/attachments";
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** 渲染前兜底剥离「发言者名：」前缀（存量脏数据 + 跨客户端防御）。仅匹配该消息作者名前缀，不误伤正文。 */
function stripSpeakerPrefix(content: string, names: string[]): string {
  let s = content;
  for (let _ = 0; _ < 3; _++) {
    const trimmed = s.replace(/^\s+/, "");
    let hit: RegExp | null = null;
    for (const nm of names) {
      const nn = nm.replace(/\s+/g, "");
      if (!nn) continue;
      const re = new RegExp(`^@?${escapeRegExp(nn)}\\s*[:：]\\s*`);
      if (re.test(trimmed)) {
        hit = re;
        break;
      }
    }
    if (hit) {
      s = trimmed.replace(hit, "");
    } else {
      break;
    }
  }
  return s;
}

export function GroupRoundtable({
  groupId,
  group,
  workers,
  metricsByWorker,
  resolveName,
  t,
  onError,
}: {
  groupId: string;
  /** 当前群对象（含 kind）。用于按群性质决定 Markdown 展示强度。 */
  group?: Group | null;
  workers: Worker[];
  /** F5：广播成本预估用——各席位最近一轮实测 token。 */
  metricsByWorker?: Record<string, WorkerMetric>;
  resolveName: (ref: string) => string;
  t: (k: DictKey, v?: Record<string, string | number>) => string;
  onError: (msg: string) => void;
}) {
  const [messages, setMessages] = useState<RoundtableMessage[]>([]);
  // F-round-stream：圆桌流式 token 累积（key=worker_id，独立 map，不污染已落库 messages）。
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [summaries, setSummaries] = useState<RoundtableSummary[]>([]);
  // R6：竞速落选方案（按 trigger_seq 关联到该轮 owner 广播消息）。
  const [alternatives, setAlternatives] = useState<RoundtableAlternative[]>([]);
  const [pickedAltIds, setPickedAltIds] = useState<Set<number>>(new Set());
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionIdx, setMentionIdx] = useState(0);
  const mentionItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // 待发送附件：本地路径 + 名称 + 大小（路径用于后端落库与点击打开）。
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // 拖拽文件到输入框时的高亮态（微信式「松手发送」提示）。
  const [dragOver, setDragOver] = useState(false);
  // F5：等待二次确认的广播（非 null 时弹成本确认框）。
  const [pendingBroadcast, setPendingBroadcast] = useState<{ content: string; paths: string[] } | null>(null);
  // IX-7：待确认的分叉/重跑（非 null 时弹表单）。
  const [rerunTarget, setRerunTarget] = useState<{ mode: RerunMode; msg: RoundtableMessage } | null>(null);
  const [rerunSubmitting, setRerunSubmitting] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<number>(0);
  const { locale } = useI18n();

  // 同名 Worker（基于同一 Agent 画像）在群里会出现多个，给每个分配稳定的「名字 #N」，
  // 便于区分是谁的回复、也便于在 @ 选择器里选对人。序号按 agent_ref 出现次序分配。
  const workerLabelById = useMemo(() => {
    const byRef = new Map<string, number>();
    const map = new Map<string, string>();
    for (const w of workers) {
      const base = agentDisplayName(w, resolveName, t);
      const n = (byRef.get(w.agent_ref) ?? 0) + 1;
      byRef.set(w.agent_ref, n);
      map.set(w.id, n > 1 ? `${base} #${n}` : base);
    }
    return map;
  }, [workers, resolveName, t]);

  // 可被 @ 的 Worker（排除能力席位）+ 全员选项，建立 名字↔id 映射，供解析与渲染复用。
  const mentionTargets = useMemo(() => {
    const allLabel = t("groups.roundtable.mentionAll").replace(/^@/, "");
    return [
      { id: "__all__", name: allLabel },
      ...workers
        .filter((w) => w.seat_type !== "Capability")
        .map((w) => ({
          id: w.id,
          name: workerLabelById.get(w.id) ?? agentDisplayName(w, resolveName, t),
        })),
    ];
  }, [workers, resolveName, t, workerLabelById]);
  const idToName = useMemo(() => {
    const m = new Map<string, string>();
    for (const tgt of mentionTargets) m.set(tgt.id, tgt.name);
    return m;
  }, [mentionTargets]);

  // 群成员头像：消息必须落到「群成员」这一稳定身份（worker_id → 群内 workers 列表的 w.id），
  // 而非消息自身可能为空、或为显示名的 worker_id/author 字段。这样同一成员的所有回答共用一个
  // 头像（与右侧成员列表 PixelAvatar seed={w.id} 完全一致），连续回答也保持一致。
  const workerById = useMemo(() => {
    const m = new Map<string, Worker>();
    for (const w of workers) m.set(w.id, w);
    return m;
  }, [workers]);
  const workerByKey = useMemo(() => {
    const m = new Map<string, Worker>();
    for (const w of workers) {
      m.set(w.id, w);
      m.set(w.agent_ref, w);
      const dn = agentDisplayName(w, resolveName, t);
      if (dn) m.set(dn, w);
    }
    return m;
  }, [workers, resolveName, t]);
  const memberSeedOf = useCallback(
    (m: RoundtableMessage): string => {
      if (m.worker_id && workerById.has(m.worker_id)) return m.worker_id;
      const w = workerByKey.get(m.author);
      if (w) return w.id;
      return m.worker_id || m.author;
    },
    [workerById, workerByKey],
  );

  // 微信化：群消息正文内联高亮 @（蓝字），复用 .rt-mention-token。
  // worker_id → capabilities 映射（用于按 Agent 名/能力派生「身份+职责」）。
  const capsById = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const w of workers) m.set(w.id, w.capabilities);
    return m;
  }, [workers]);

  const mentionRegex = useMemo(() => {
    const names = mentionTargets
      .map((t) => t.name)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (names.length === 0) return null;
    const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`@(${esc.join("|")})`, "g");
  }, [mentionTargets]);

  const renderWithMentions = (children: ReactNode): ReactNode => {
    if (!mentionRegex) return children;
    const re = new RegExp(mentionRegex); // 复制以重置 lastIndex，避免跨调用污染
    const walk = (node: ReactNode, keyBase: string): ReactNode => {
      if (typeof node === "string") {
        const parts = node.split(re);
        const out: ReactNode[] = [];
        let k = 0;
        for (let i = 0; i < parts.length; i++) {
          if (i % 2 === 1) {
            out.push(
              <span key={`${keyBase}-m${k}`} className="rt-mention-token">
                {parts[i]}
              </span>,
            );
          } else if (parts[i]) {
            out.push(<span key={`${keyBase}-t${k}`}>{parts[i]}</span>);
          }
          k++;
        }
        return out;
      }
      if (Array.isArray(node)) {
        return node.map((c, i) => (
          <Fragment key={`${keyBase}-${i}`}>{walk(c, `${keyBase}-${i}`)}</Fragment>
        ));
      }
      return node;
    };
    return walk(children, "mn");
  };

  const mentionComponents: Components = {
    p: ({ children }) => <p>{renderWithMentions(children)}</p>,
    li: ({ children }) => <li>{renderWithMentions(children)}</li>,
  };

  useEffect(() => {
    // 初始即按 min-height 渲染，避免 rows 默认值造成高度不足。
    requestAnimationFrame(resizeInput);
  }, []);

  // 从草稿文本中解析 `@名字` → 被 @ 的 worker id（长名字优先，避免前缀误匹配）。
  const parseMentions = (text: string): string[] => {
    const ids = new Set<string>();
    const sorted = [...mentionTargets].sort((a, b) => b.name.length - a.name.length);
    for (const { id, name } of sorted) {
      if (name && text.includes(`@${name}`)) ids.add(id);
    }
    return [...ids];
  };

  const loadMessages = useCallback(async (gid: string) => {
    try {
      setMessages(await groupCommands.groupListMessages(gid));
    } catch {
      /* non-fatal */
    }
  }, []);

  const loadAlternatives = useCallback(async (gid: string) => {
    try {
      setAlternatives(await groupCommands.groupListAlternatives(gid));
    } catch {
      /* non-fatal */
    }
  }, []);

  // R6：竞速轮触发消息（owner 广播）seq → 该轮落选方案列表（升序）。
  const altBySeq = useMemo(() => {
    const m = new Map<number, RoundtableAlternative[]>();
    for (const alt of alternatives) {
      const list = m.get(alt.trigger_seq) ?? [];
      list.push(alt);
      m.set(alt.trigger_seq, list);
    }
    return m;
  }, [alternatives]);

  // R6 FR6.2：改选落选方案 → 后端落 system 消息标记（后续 Worker 种子经
  // find_before 自然包含该方案）。
  const handlePickAlternative = useCallback(
    async (alt: RoundtableAlternative) => {
      try {
        await groupCommands.groupPickAlternative(groupId, alt.id);
        setPickedAltIds((prev) => new Set(prev).add(alt.id));
      } catch (e) {
        onError(`改选失败: ${e}`);
      }
    },
    [groupId, onError]
  );

  // IX-7：确认分叉/重跑 —— 后端落一条 system 审计标注并扇出，Worker 回贴仍走事件流。
  const handleRerunConfirm = useCallback(
    async (workerId: string | null, prompt: string | null) => {
      if (!rerunTarget) return;
      setRerunSubmitting(true);
      try {
        await groupCommands.groupRerunFromMessage(
          groupId,
          rerunTarget.msg.seq,
          rerunTarget.mode,
          workerId,
          prompt,
        );
        setRerunTarget(null);
      } catch (e) {
        onError(`${t(`groups.rerun.${rerunTarget.mode}.title` as DictKey)}失败: ${e}`);
      } finally {
        setRerunSubmitting(false);
      }
    },
    [groupId, rerunTarget, onError, t],
  );

  const loadSummaries = useCallback(async (gid: string) => {
    try {
      setSummaries(await groupCommands.groupListSummaries(gid));
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    if (groupId) {
      loadMessages(groupId);
      loadSummaries(groupId);
      loadAlternatives(groupId);
    } else {
      setMessages([]);
      setSummaries([]);
      setAlternatives([]);
    }
  }, [groupId, loadMessages, loadSummaries, loadAlternatives]);

  useEffect(() => {
    if (!groupId) return;
    const unsub = subscribeToRoundtable((ev: RoundtableEvent) => {
      if (ev.group_id !== groupId) return;
      // 终稿到达：丢弃该 Worker 的半成品流式气泡（F-round-stream）。
      if (ev.message.worker_id) {
        setStreaming((prev) => {
          if (!(ev.message.worker_id in prev)) return prev;
          const next = { ...prev };
          delete next[ev.message.worker_id];
          return next;
        });
      }
      setMessages((prev) => {
        if (prev.some((m) => m.seq === ev.message.seq)) return prev;
        return [...prev, ev.message];
      });
    });
    return unsub;
  }, [groupId]);

  // F-round-stream：订阅圆桌流式 token，累积到 streaming map（key=worker_id）；
  // 与 chat 的 agent:token 并行，互不影响。aborted 丢弃落选/取消 Worker 的半成品。
  useEffect(() => {
    if (!groupId) return;
    const unsub = subscribeToRoundtableToken((ev: RoundtableTokenEvent) => {
      if (ev.group_id !== groupId) return;
      if (!ev.worker_id) return;
      if (ev.aborted) {
        setStreaming((prev) => {
          if (!(ev.worker_id in prev)) return prev;
          const next = { ...prev };
          delete next[ev.worker_id];
          return next;
        });
        return;
      }
      setStreaming((prev) => ({
        ...prev,
        [ev.worker_id]: (prev[ev.worker_id] ?? "") + ev.token,
      }));
    });
    return unsub;
  }, [groupId]);

  useEffect(() => {
    if (!groupId) return;
    const unsub = subscribeToRoundtableSummary((ev: RoundtableSummaryEvent) => {
      if (ev.group_id !== groupId) return;
      setSummaries((prev) => {
        if (prev.some((s) => s.id === ev.summary.id)) return prev;
        return [...prev, ev.summary];
      });
    });
    return unsub;
  }, [groupId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  // 根据内容自动撑高 textarea，最高 160px（避免对话框过高）。
  const resizeInput = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const openMentionPicker = () => {
    const el = inputRef.current;
    cursorRef.current = el?.selectionStart ?? draft.length;
    setMentionIdx(0);
    setMentionOpen(true);
    el?.focus();
  };

  const insertMention = (name: string) => {
    const pos = cursorRef.current;
    const before = draft.slice(0, pos);
    const after = draft.slice(pos);
    // Dedup: if user already typed "@" right before the cursor, drop it so we
    // don't end up with "@@name" after the picker resolves.
    const cleanBefore = before.endsWith("@") ? before.slice(0, -1) : before;
    const next = `${cleanBefore}@${name} ${after}`;
    const insertAt = cleanBefore.length + 1 /* "@" */ + name.length + 1 /* " " */;
    setDraft(next);
    setMentionOpen(false);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(insertAt, insertAt);
      resizeInput();
    });
  };

  // 点击外部关闭 @ 选择器。
  useEffect(() => {
    if (!mentionOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!pickerRef.current?.contains(target) && !inputRef.current?.contains(target)) {
        setMentionOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [mentionOpen]);

  // 高亮项变化时滚动到可视区（上下键选择不会丢出弹层）。
  useEffect(() => {
    if (!mentionOpen) return;
    const el = mentionItemRefs.current[mentionIdx];
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [mentionIdx, mentionOpen]);

  // 成员列表变化时高亮索引越界保护。
  useEffect(() => {
    if (mentionIdx >= mentionTargets.length && mentionTargets.length > 0) {
      setMentionIdx(mentionTargets.length - 1);
    }
  }, [mentionTargets.length, mentionIdx]);

  /** F5：广播命中的席位（排除能力席位与离线席位）+ 各自最近一轮实测 token。 */
  const broadcastTargets = useMemo<BroadcastTarget[]>(
    () =>
      workers
        .filter((w) => w.seat_type !== "Capability" && w.status !== "Offline")
        .map((w) => ({
          id: w.id,
          name: workerLabelById.get(w.id) ?? agentDisplayName(w, resolveName, t),
          lastTokens: metricsByWorker?.[w.id]?.last_total_tokens,
        })),
    [workers, metricsByWorker, workerLabelById, resolveName, t],
  );

  /** 真正发出（广播路径由确认弹窗调用）。 */
  const doSend = useCallback(
    async (content: string, mentions: string[], paths: string[]) => {
      setSending(true);
      try {
        if (mentions.includes("__all__")) {
          await groupCommands.groupRoundtableBroadcast(groupId, content, paths);
        } else {
          await groupCommands.groupPostMessage(groupId, content, mentions, paths);
        }
        setDraft("");
        setAttachments([]);
        setPendingBroadcast(null);
        if (inputRef.current) inputRef.current.style.height = "auto";
      } catch (e) {
        onError(friendlyError(e));
      } finally {
        setSending(false);
      }
    },
    [groupId, onError],
  );

  const send = async () => {
    const content = draft.trim();
    if (!content || !groupId || sending) return;
    const mentions = parseMentions(content);
    const paths = attachments.map((a) => a.path);
    // F5：@全员 = 一次点燃 N 个 LLM 回合，先弹二次确认摊开成本，避免误触。
    if (mentions.includes("__all__")) {
      setPendingBroadcast({ content, paths });
      return;
    }
    await doSend(content, mentions, paths);
  };

  // ── 附件：选择 / 粘贴 / 拖拽，统一落盘 `~/.one-desktop/attachments/`（上传约定路径）──

  // 选择：系统文件对话框 → import_attachment 复制到附件目录（File.path 在 Tauri v2
  // 不可靠，dialog.open 返回真实路径）。
  const pickFiles = async () => {
    try {
      const picked = await open({ multiple: true });
      const paths = (Array.isArray(picked) ? picked : picked ? [picked] : []).filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      );
      for (const p of paths) {
        try {
          const imported = await importAttachment(p);
          setAttachments((prev) =>
            prev.some((a) => a.path === imported.path)
              ? prev
              : [...prev, { path: imported.path, name: imported.path.split(/[\\/]/).pop() ?? "附件", size: imported.size }],
          );
        } catch (err) {
          onError(friendlyError(err));
        }
      }
    } catch (err) {
      onError(friendlyError(err));
    }
  };

  // 粘贴：从剪贴板提取图片 → base64 落盘 → 追加附件（截图直接可发）。
  const onPaste = async (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const img = extractPastedImage(e.clipboardData);
    if (!img) return; // 无图片：走默认粘贴文本
    e.preventDefault();
    try {
      const dataUrl = await fileToBase64(img);
      const name = img.name && img.name.trim() ? img.name.trim() : "粘贴图片.png";
      const path = await savePasteAttachment(dataUrl, name);
      setAttachments((prev) => [
        ...prev,
        { path, name, size: img.size },
      ]);
    } catch (err) {
      onError(friendlyError(err));
    }
  };

  // 拖拽：拖进来的文件无磁盘路径（webkit File 无 .path），转 base64 统一落盘附件目录。
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = extractDroppedFiles(e.dataTransfer);
    for (const f of files) {
      try {
        const dataUrl = await fileToBase64(f);
        const name = f.name && f.name.trim() ? f.name.trim() : "拖拽文件";
        const path = await savePasteAttachment(dataUrl, name);
        setAttachments((prev) =>
          prev.some((a) => a.path === path)
            ? prev
            : [...prev, { path, name, size: f.size }],
        );
      } catch (err) {
        onError(friendlyError(err));
      }
    }
  };

  const removeAttachment = (path: string) =>
    setAttachments((prev) => prev.filter((a) => a.path !== path));

  // 点击附件：走全局 ArtifactPreview 内嵌预览（代码高亮/图片/Markdown）。
  const { openPreview } = usePreview();
  const openAttachment = (path: string) => {
    openPreview({ filePath: path });
  };

  const summarize = async () => {
    if (!groupId || summarizing) return;
    setSummarizing(true);
    try {
      const summary = await groupCommands.groupRoundtableSummarize(groupId);
      setSummaries((prev) => {
        if (prev.some((s) => s.id === summary.id)) return prev;
        return [...prev, summary];
      });
    } catch (e) {
      onError(friendlyError(e));
    } finally {
      setSummarizing(false);
    }
  };

  const fmtTime = (ms: number) =>
    new Date(ms).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <div className="roundtable">
      <div
        className="roundtable-log"
        ref={logRef}
        tabIndex={0}
        role="log"
        aria-label={t("groups.roundtable.logAria")}
      >
        {summaries.length > 0 && (
          <div className="rt-summaries">
            {summaries.map((s) => (
              <div key={s.id} className="rt-summary">
                <div className="rt-summary-head">
                  <span className="rt-summary-title">
                    {t("groups.roundtable.summary.title")}
                  </span>
                  <span className="rt-summary-meta">
                    {t("groups.roundtable.summary.meta", { count: s.message_count })}
                  </span>
                </div>
                <div className="rt-summary-content"><Markdown>{s.content}</Markdown></div>
              </div>
            ))}
          </div>
        )}
        {messages.length === 0 ? (
          <div className="groups-empty">{t("groups.roundtable.empty")}</div>
        ) : (
            messages.map((m, i) => {
              // 成员稳定身份：worker_id → 群内 w.id（与成员列表同源）；worker_id 为空时按 author 反查成员。
              const seed = memberSeedOf(m);
              const displayName =
                m.author_kind === "owner"
                  ? t("groups.roundtable.author.owner")
                  : workerLabelById.get(seed) ?? resolveName(m.author);
              // R6：竞速轮触发消息（owner 广播 @全员）下方挂备选方案入口。
              const roundAlts =
                m.author_kind === "owner" ? altBySeq.get(m.seq) : undefined;
              // 头像绑定「群成员」稳定身份：seed = 该成员在群内的 w.id（与成员列表 PixelAvatar 同源），
              // 连续回答 / 历史脏数据（worker_id 为空）都落到同一头像，绝不跳变。
              const avatarSeed = seed;
              const wcolor = workerColors(seed);
              // 存量兜底：剥离该消息作者自加的「名字：」前缀（后端落库前已剥离新数据，此处防御历史脏数据）。
              const speakerCandidates = [displayName, resolveName(m.author)].filter(
                (v): v is string => typeof v === "string" && v.trim().length > 0,
              );
              const cleanContent = stripSpeakerPrefix(m.content, speakerCandidates);

              // 发言分组：同 author_kind + 同成员（seed）连续消息合并为一组，仅首条带署名头。
              const isSystem = m.author_kind === "system";
              const authorKey = isSystem
                ? `sys:${m.seq}`
                : `${m.author_kind}:${seed}`;
              const prev = i > 0 ? messages[i - 1] : null;
              const prevKey = prev
                ? prev.author_kind === "system"
                  ? `sys:${prev.seq}`
                  : `${prev.author_kind}:${memberSeedOf(prev)}`
                : null;
              const isGroupStart = i === 0 || prevKey !== authorKey;
              const caps = capsById.get(seed) ?? [];
              const role = workerRole(displayName, caps, t);
              const liveStatus =
                workers.find((x) => x.id === seed)?.status === "Busy" ? "busy" : "idle";
            return (
            <Fragment key={m.seq}>
            {m.author_kind === "system" ? (
              <div className="rt-system-msg">
                <span className="rt-system-text">{m.content}</span>
              </div>
            ) : (
            <div
              className={`rt-msg rt-row rt-${m.author_kind}${isGroupStart ? "" : " rt-continued"}`}
              style={
                m.author_kind === "worker"
                  ? ({ "--w-acc": wcolor.light, "--w-acc-dark": wcolor.dark } as CSSProperties)
                  : undefined
              }
            >
              <span className="rt-avatar-col" aria-hidden="true">
                {m.author_kind === "owner" ? (
                  <Icons.User size={18} />
                ) : (
                  <PixelAvatar seed={avatarSeed} size={36} />
                )}
              </span>
              <div className={`rt-bubble rt-bubble-${m.author_kind}`}>
                {isGroupStart ? (
                  <div className="rt-bubble-meta">
                    <span className="rt-author">{displayName}</span>
                    <span className="rt-author-role">
                      <span className="rt-role-name">{role.role}</span>
                      <span className="rt-role-sep">·</span>
                      <span className="rt-role-duty">{role.duty}</span>
                    </span>
                    {m.author_kind === "worker" && (
                      <span
                        className={`rt-status-dot rt-status-${liveStatus}`}
                        title={liveStatus === "busy" ? t("groups.member.busy") : t("groups.member.idle")}
                      />
                    )}
                    <span className="rt-time">{fmtTime(m.created_at)}</span>
                  </div>
                ) : (
                  <span className="rt-time rt-time-continued">{fmtTime(m.created_at)}</span>
                )}
                <div className="rt-content">
                  {/* 聊天型群降级 Markdown（无标题/列表/表格/代码），其余类型保留全量渲染。 */}
                  <Markdown components={mentionComponents} restricted={group?.kind === "Chat"}>
                    {cleanContent}
                  </Markdown>
                </div>
                {(m.attachments ?? []).length > 0 && (
                  <div className="rt-msg-attachments">
                    {(m.attachments ?? []).map((p) => (
                      <button
                        key={p}
                        className="rt-attach-link"
                        type="button"
                        onClick={() => void openAttachment(p)}
                        title={p}
                      >
                        <Icons.Paperclip size={13} />
                        <span className="rt-attach-fname">{p.split(/[\\/]/).pop()}</span>
                      </button>
                    ))}
                  </div>
                )}
                <span className="rt-msg-actions">
                  {m.author_kind === "worker" && (
                    <button
                      type="button"
                      className="rt-msg-action"
                      onClick={() => setRerunTarget({ mode: "rerun", msg: m })}
                      title={t("groups.rerun.rerun.tip")}
                    >
                      <Icons.Refresh size={12} />
                      {t("groups.rerun.rerun.action")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="rt-msg-action"
                    onClick={() => setRerunTarget({ mode: "fork", msg: m })}
                    title={t("groups.rerun.fork.tip")}
                  >
                    <Icons.Network size={12} />
                    {t("groups.rerun.fork.action")}
                  </button>
                </span>
              </div>
            </div>
            )}
            {roundAlts && roundAlts.length > 0 && (
              <AltsCompare
                alts={roundAlts}
                resolveWorkerName={(wid) =>
                  workerLabelById.get(wid) ?? resolveName(wid)
                }
                onPick={handlePickAlternative}
                pickedIds={pickedAltIds}
              />
            )}
            </Fragment>
            );
          })
        )}
        {Object.keys(streaming).length > 0 &&
          Object.entries(streaming).map(([wid, text]) => {
            const seed = wid;
            const label = workerLabelById.get(wid) ?? resolveName(wid);
            const wcolor = workerColors(seed);
            const caps = capsById.get(seed) ?? [];
            const role = workerRole(label, caps, t);
            const clean = stripSpeakerPrefix(text, [label, resolveName(wid)]);
            return (
              <div
                key={`stream-${wid}`}
                className="rt-msg rt-row rt-worker rt-streaming"
                style={{ "--w-acc": wcolor.light, "--w-acc-dark": wcolor.dark } as CSSProperties}
              >
                <span className="rt-avatar-col" aria-hidden="true">
                  <PixelAvatar seed={seed} size={36} />
                </span>
                <div className="rt-bubble rt-bubble-worker">
                  <div className="rt-bubble-meta">
                    <span className="rt-author">{label}</span>
                    <span className="rt-author-role">
                      <span className="rt-role-name">{role.role}</span>
                      <span className="rt-role-sep">·</span>
                      <span className="rt-role-duty">{role.duty}</span>
                    </span>
                  </div>
                  <div className="rt-content rt-streaming-content">
                    {clean}
                    <span className="rt-stream-cursor" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
      </div>

      <div
        className={`roundtable-composer${dragOver ? " rt-composer-dragover" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
        }}
        onDrop={onDrop}
      >
        {dragOver && (
          <div className="rt-drop-overlay">
            <Icons.Paperclip size={22} />
            <span>{t("groups.roundtable.dropHint")}</span>
          </div>
        )}
        {mentionOpen && (
          <div
            className="rt-mention-picker"
            ref={pickerRef}
            role="listbox"
            aria-label={t("groups.roundtable.mentionPickerTitle")}
          >
            <div className="rt-picker-head">
              {t("groups.roundtable.mentionPickerTitle")}
            </div>
            <div className="rt-picker-list">
              {mentionTargets.map((tgt, i) => (
                <button
                  key={tgt.id}
                  ref={(el) => { mentionItemRefs.current[i] = el; }}
                  className={`rt-picker-item${i === mentionIdx ? " rt-picker-item-active" : ""}`}
                  type="button"
                  role="option"
                  aria-selected={i === mentionIdx}
                  onClick={() => insertMention(tgt.name)}
                  onMouseEnter={() => setMentionIdx(i)}
                >
                  <span className="rt-picker-avatar">
                    {tgt.id === "__all__" ? "@" : (tgt.name.slice(0, 1) || "W")}
                  </span>
                  <span className="rt-picker-name">@{tgt.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <textarea
          ref={inputRef}
          className="rt-input"
          value={draft}
          placeholder={t("groups.roundtable.placeholder")}
          onPaste={(e) => void onPaste(e)}
          onChange={(e) => {
            setDraft(e.target.value);
            requestAnimationFrame(resizeInput);
            const sel = e.target.selectionStart ?? e.target.value.length;
            const prev = sel > 1 ? e.target.value[sel - 2] : " ";
            if (
              sel > 0 &&
              e.target.value[sel - 1] === "@" &&
              (sel === 1 || prev === " " || prev === "\n")
            ) {
              cursorRef.current = sel;
              setMentionIdx(0);
              setMentionOpen(true);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && mentionOpen) {
              e.preventDefault();
              setMentionOpen(false);
              return;
            }
            if (mentionOpen && mentionTargets.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIdx((i) => (i + 1) % mentionTargets.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIdx((i) => (i - 1 + mentionTargets.length) % mentionTargets.length);
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                insertMention(mentionTargets[mentionIdx].name);
                return;
              }
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
        />
        {attachments.length > 0 && (
          <div className="rt-attachments">
            {attachments.map((a) => (
              <span className="rt-attach-chip" key={a.path} title={a.path}>
                {isImageName(a.name) ? <Icons.Image size={13} /> : <Icons.FileText size={13} />}
                <span className="rt-attach-name">{a.name}</span>
                <span className="rt-attach-size">{formatBytes(a.size)}</span>
                <button
                  className="rt-attach-x"
                  type="button"
                  onClick={() => removeAttachment(a.path)}
                  aria-label={t("groups.roundtable.attachRemove")}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="rt-toolbar">
          <div className="rt-tools">
            <button
              className="rt-icon-btn"
              type="button"
              onClick={() => void pickFiles()}
              title={t("groups.roundtable.attachTitle")}
            >
              <Icons.Paperclip />
            </button>
            <button
              className="rt-icon-btn"
              type="button"
              onClick={openMentionPicker}
              title={t("groups.roundtable.mentionTitle")}
            >
              <Icons.AtSign />
            </button>
            <button
              className="rt-icon-btn rt-summarize-btn"
              type="button"
              onClick={() => void summarize()}
              disabled={summarizing || messages.length < 2}
              title={messages.length < 2 ? t("groups.roundtable.summary.disabledHint") : t("groups.roundtable.summary.action")}
            >
              <Icons.Summarize />
            </button>
          </div>
          <button
            className="rt-send-fab"
            type="button"
            onClick={() => void send()}
            disabled={(!draft.trim() && attachments.length === 0) || sending}
            aria-label={t("groups.roundtable.send")}
          >
            <Icons.Send />
          </button>
        </div>
      </div>

      {pendingBroadcast && (
        <BroadcastConfirmModal
          targets={broadcastTargets}
          sending={sending}
          onCancel={() => setPendingBroadcast(null)}
          onConfirm={() =>
            void doSend(pendingBroadcast.content, ["__all__"], pendingBroadcast.paths)
          }
          t={t}
        />
      )}

      {/* IX-7：任意消息分叉 / 重跑 */}
      {rerunTarget && (
        <MessageRerunModal
          mode={rerunTarget.mode}
          message={rerunTarget.msg}
          seats={mentionTargets.filter((s) => s.id !== "__all__")}
          defaultWorkerId={rerunTarget.msg.worker_id || undefined}
          submitting={rerunSubmitting}
          onCancel={() => setRerunTarget(null)}
          onConfirm={(wid, prompt) => void handleRerunConfirm(wid, prompt)}
          t={t}
        />
      )}
    </div>
  );
}

// ── Dispatch tab ──
