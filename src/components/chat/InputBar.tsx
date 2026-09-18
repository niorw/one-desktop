import { useState, useRef, useCallback, useEffect, useMemo, forwardRef, useImperativeHandle, KeyboardEvent, type ReactNode, type ClipboardEvent as ReactClipboardEvent } from "react";

export interface InputBarHandle {
  /** 聚焦到主输入框 textarea。 */
  focus: () => void;
}
import { Icons } from "../common/Icons";
import { useI18n } from "../../i18n/I18nProvider";
import type { DictKey } from "../../i18n/dict";
import type { QueuedMessage } from "../../hooks/useAgent";
import { MODEL_OPTIONS, DEFAULT_MODEL, PROVIDERS } from "../../hooks/useSettings";
import type { Workspace } from "../../services/workspace";
import type { PermissionMode, ProviderId, ModelProviderConfig } from "../../types";
import { ContextRing } from "./ContextRing";
import type { ContextStats } from "./contextStats";
import { listWorkspaceFiles, listSkills, listSessions } from "../../services/chatCommands";
import type { Session } from "../../types";
import { savePasteAttachment, importAttachment } from "../../services/attachment";
import { open } from "@tauri-apps/plugin-dialog";
import {
  buildAttachmentSuffix,
  extractDroppedFiles,
  extractPastedImage,
  fileToBase64,
  formatBytes,
  isImageName,
  splitAttachmentLines,
  type PendingAttachment,
} from "../../utils/attachments";

interface ModelOption {
  value: string;
  label: string;
}

interface PermissionOption {
  mode: PermissionMode;
  labelKey: DictKey;
  descKey: DictKey;
  icon: ReactNode;
}

const PERMISSION_OPTIONS: PermissionOption[] = [
  { mode: "ask_approval", labelKey: "permission.ask_approval", descKey: "permission.ask_approval.desc", icon: <Icons.Hand size={14} /> },
  { mode: "auto_edit", labelKey: "permission.auto_edit", descKey: "permission.auto_edit.desc", icon: <Icons.Shield size={14} /> },
  { mode: "plan_execute", labelKey: "permission.plan_execute", descKey: "permission.plan_execute.desc", icon: <Icons.Calendar size={14} /> },
  { mode: "full_access", labelKey: "permission.full_access", descKey: "permission.full_access.desc", icon: <Icons.ShieldAlert size={14} /> },
];

type TriggerKind = "@" | "/" | "$" | "#";

interface TriggerItem {
  id: string;
  label: string;
  desc?: string;
  icon?: ReactNode;
}

interface TriggerState {
  kind: TriggerKind;
  query: string;        // 触发字符后的已输入文本（用于过滤）
  start: number;        // 触发字符在 value 中的位置（含触发符本身）
  top: number;          // 弹层绝对定位 top（相对 input-main）
  items: TriggerItem[];
  activeIndex: number;
}

const slashCommands = (t: (k: DictKey) => string): TriggerItem[] => [
  { id: "new", label: t("input.slash.new"), desc: t("input.slash.newDesc"), icon: <Icons.Plus size={14} /> },
  { id: "clear", label: t("input.slash.clear"), desc: t("input.slash.clearDesc"), icon: <Icons.Trash2 size={14} /> },
  { id: "help", label: t("input.slash.help"), desc: t("input.slash.helpDesc"), icon: <Icons.Info size={14} /> },
];

interface InputBarProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  model?: string;
  onModelChange?: (model: string) => void;
  onStop?: () => void;
  permissionMode?: PermissionMode;
  onPermissionChange?: (mode: PermissionMode) => void;
  /** R7：单聊升级为协作群入口（有活跃会话时可点）。 */
  onUpgrade?: () => void;
  /** ADR-022：内嵌排队消息列表（截图样式）。 */
  queuedItems?: QueuedMessage[];
  onRemoveQueued?: (index: number) => void;
  onEditQueued?: (index: number, newText: string) => void;
  onMoveUpQueued?: (index: number) => void;
  /** 截图式底部工作空间选择器。 */
  workspaces?: Workspace[];
  activeWorkspaceId?: string;
  onWorkspaceChange?: (id: string) => void;
  /** 打开文件夹 → 关联/创建工作区（App 层实现，持有刷新+切换）。 */
  onOpenFolder?: () => void;
  /** 上下文用量（估算值）；缺省/全零时环形控件显示灰色空态。 */
  contextStats?: ContextStats | null;
  /** 打开模型设置（下拉“管理模型”用）。 */
  onOpenModelSettings?: () => void;
  /** 已配置的供应商列表——仅展示其中配置过的模型，未配置的不显示。 */
  providers?: ModelProviderConfig[];
  /** 会话已开始：为 true 时隐藏顶部默认工作区上下文卡片。 */
  hasActiveSession?: boolean;
}

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar({
  onSend, disabled, isStreaming, model, onModelChange,
  onStop, permissionMode, onPermissionChange, onUpgrade,
  queuedItems = [], onRemoveQueued, onEditQueued, onMoveUpQueued,
  workspaces = [], activeWorkspaceId, onWorkspaceChange, onOpenFolder,
  contextStats, onOpenModelSettings, hasActiveSession, providers = [],
}, ref) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [permOpen, setPermOpen] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);
  const [wsQuery, setWsQuery] = useState("");
  const workspaceChipRef = useRef<HTMLButtonElement>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  /** 当前激活工作区对象 */
  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );
  /** 当前激活工作区的目录路径（仅关联了目录的工作区才有 path）。 */
  const activeWorkspacePath = activeWorkspace?.path ?? null;
  const activeWorkspaceBase = activeWorkspacePath
    ? activeWorkspacePath.split(/[\\/]/).filter(Boolean).pop() || activeWorkspacePath
    : null;
  /** 无选中工作区时，显示最近使用的工作区目录名（fallback） */
  const recentWorkspaceBase = useMemo(() => {
    if (activeWorkspaceId) return null; // 有选中工作区就不用最近工作区
    const withPath = workspaces
      .filter((w) => w.path)
      .sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
    const p = withPath[0]?.path;
    return p ? p.split(/[\\/]/).filter(Boolean).pop() || p : null;
  }, [workspaces, activeWorkspaceId]);
  /** 勾选用的有效工作区 ID：始终以实际选中为准 */
  const effectiveWorkspaceId = activeWorkspaceId || "";
  /** 底部标签显示：有路径显示路径basename，无路径显示工作区名，都没则显示最近工作区 */
  const workspaceLabel = activeWorkspaceBase || activeWorkspace?.name || recentWorkspaceBase || t("workspace.select");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const triggerPopRef = useRef<HTMLDivElement>(null);
  // 待发送附件：本地路径 + 名称 + 大小（发送时以 `[附件] path` 文本协议拼进消息）。
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const [trigger, setTrigger] = useState<TriggerState | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<TriggerItem[]>([]);
  const [skills, setSkills] = useState<TriggerItem[]>([]);
  // 全部会话（模型面板「用过的模型」+「# 关联对话」共用同一个数据源）
  const [allSessions, setAllSessions] = useState<Session[]>([]);

  const sessionsTriggerItems = useMemo<TriggerItem[]>(
    () => allSessions.map((s) => ({
      id: s.id,
      label: s.title || "未命名会话",
      desc: `${s.model} · ${new Date(s.updated_at).toLocaleDateString()}`,
    })),
    [allSessions],
  );

  useImperativeHandle(ref, () => ({
    focus: () => {
      textareaRef.current?.focus();
    },
  }), []);

  useEffect(() => {
    if (!modelOpen && !permOpen && !wsOpen) return;
    const close = () => { setModelOpen(false); setPermOpen(false); setWsOpen(false); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [modelOpen, permOpen, wsOpen]);

  useEffect(() => {
    if (editingIndex !== null && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingIndex]);

  useEffect(() => {
    if (trigger?.kind === "@" && workspaceFiles.length === 0) {
      (async () => {
        try {
          const files = await listWorkspaceFiles(activeWorkspaceId);
          setWorkspaceFiles(files.map((f) => ({
            id: f.path,
            label: f.name,
            desc: f.is_dir ? t("input.folder") : t("input.file"),
            icon: f.is_dir ? <Icons.Folder size={14} /> : <Icons.FileText size={14} />,
          })));
        } catch {}
      })();
    }
  }, [trigger?.kind, activeWorkspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (trigger?.kind === "$" && skills.length === 0) {
      (async () => {
        try {
          const list = await listSkills();
          setSkills(list.map((s) => ({
            id: s.id || s.name,
            label: s.name,
            desc: s.description?.slice(0, 60),
          })));
        } catch {}
      })();
    }
  }, [trigger?.kind]);

  useEffect(() => {
    if (trigger?.kind === "#" && sessionsTriggerItems.length === 0) {
      // 会话列表已在 mount 阶段加载；若 allSessions 为空则兜底再拉一次
      // （极少发生：mount 期间用户清空数据库）。
      (async () => {
        try {
          const list = await listSessions();
          setAllSessions(list);
        } catch {}
      })();
    }
  }, [trigger?.kind, sessionsTriggerItems.length]);

  // mount 拉一次会话列表——同时驱动「# 关联对话」弹层和「模型面板右栏」
  // （按 session 出现过的 model 过滤，未用过的预设模型不展示）。
  useEffect(() => {
    (async () => {
      try {
        const list = await listSessions();
        setAllSessions(list);
      } catch {}
    })();
  }, []);

  // ADR-022：流式回复中，输入框有内容 → 入队发送（排队）；输入框为空 → 停止生成（中断）。
  const hasQueueIntent = isStreaming && value.trim().length > 0;

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    const suffix = buildAttachmentSuffix(attachments.map((a) => a.path));
    // 附件以 `[附件] path` 文本协议拼进消息：模型可见路径（可调 read 读取），
    // 渲染端解析剥离展示为附件卡片。仅附件无正文时也允许发送。
    const full = suffix
      ? trimmed
        ? `${trimmed}${suffix}`
        : suffix.trimStart()
      : trimmed;
    if (isStreaming) {
      if (full) {
        onSend(full); // 入队（useAgent 在 busy 时自动排队）
        setValue("");
        setAttachments([]);
        if (textareaRef.current) textareaRef.current.style.height = "auto";
      } else if (onStop) {
        onStop();
      }
      return;
    }
    if (!full || disabled) return;
    onSend(full);
    setValue("");
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, attachments, disabled, isStreaming, onSend, onStop]);

  // 选择：系统文件对话框 → import_attachment 复制到附件目录
  // （Tauri v2 的 File.path 不可靠，dialog.open 返回真实路径）。
  const pickFiles = useCallback(async () => {
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
        } catch {
          // 单个文件导入失败：跳过该文件（大小/类型校验不过），不阻塞其余。
        }
      }
    } catch {
      // 用户取消对话框或对话框异常：静默。
    }
  }, []);

  const onPaste = useCallback(
    async (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
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
      } catch {
        // 落盘失败：静默降级为普通粘贴（不阻塞输入）。
      }
    },
    [],
  );

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
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
        } catch {
          // 单个文件落盘失败：跳过。
        }
      }
    },
    [],
  );

  const removeAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 修复方向键插入方块(tofu)：部分 macOS 中文输入法（搜狗/微信/QQ 拼音等）在组字状态下
    // 按方向键选词时,会把 IME 内部的 PUA 字符或控制字符写入 textarea,无字形则渲染成方块。
    // 组字中方向键交给 IME 处理：阻止默认,不进 textarea。
    if (
      e.nativeEvent.isComposing &&
      (e.key === "ArrowLeft" || e.key === "ArrowRight" ||
       e.key === "ArrowUp" || e.key === "ArrowDown")
    ) {
      e.preventDefault();
      return;
    }

    if (trigger) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setTrigger((prev) => prev ? { ...prev, activeIndex: Math.min(prev.activeIndex + 1, (prev.items.length || 1) - 1) } : null);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setTrigger((prev) => prev ? { ...prev, activeIndex: Math.max(prev.activeIndex - 1, 0) } : null);
        return;
      }
      if (e.key === "Enter") {
        if (e.nativeEvent.isComposing) return; // 输入法组字中：回车确认候选字，不选中
        e.preventDefault();
        const item = trigger.items[trigger.activeIndex];
        if (item) applyTriggerItem(item);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setTrigger(null);
        return;
      }
      // Backspace 在触发符位置时关闭弹层
      if (e.key === "Backspace") {
        const el = textareaRef.current;
        if (el && el.selectionStart === trigger.start + 1) {
          setTrigger(null);
        }
        // 不 return——让默认删除行为继续
      }
    }

    if (e.key === "Enter") {
      // 输入法组字中（isComposing）或刚结束组字的合成回车（keyCode 229）：
      // 回车用于确认候选字，不应发送，避免中文/日文等输入时误发。
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      // ⌘/Ctrl+Enter 发送；无修饰且非 Shift 也发送（Shift+Enter 换行）
      if (e.metaKey || e.ctrlKey || !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    }
  };

  /**
   * 兜底清洗：剥离所有「无字形」的字符类别 + 替换字符 + 对象替换字符。
   * 包括 \p{Cc}(控制)、\p{Cf}(格式)、\p{Co}(私用区)、\p{Cn}(未分配/非字符)，
   * 以及显式列出的 U+FFFC（对象替换）、U+FFFD（替换字符）。
   * 合法空白 (\n/\r/\t) 与所有可字形化的字符（CJK/emoji/Latin/标点 等）保留。
   * 这是最激进的防线：IME bug / Tauri-WKWebView 异常 / 复制粘贴坏字一律兜得住。
   */
  const sanitizeInput = useCallback((raw: string): string => {
    return raw.replace(
      /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u{FFFC}\u{FFFD}]/gu,
      "",
    );
  }, []);

  // 修复 textarea 已落库的脏字符：每次 value 变化后,如果 sanitize 真删了东西,
  // 把 DOM 与 React state 同步收敛,确保后续 onChange 一致。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (el.value === value) return;
    const cursor = el.selectionStart;
    el.value = value;
    try { el.setSelectionRange(cursor, cursor); } catch {}
  }, [value]);

  const detectTrigger = useCallback((text: string, cursorPos: number): TriggerState | null => {
    if (!textareaRef.current) return null;
    const beforeCursor = text.slice(0, cursorPos);

    // 匹配：行首或空格后的触发字符 + 可选查询文本
    const match = beforeCursor.match(/(\s|^)([@/$#])([\w\u4e00-\u9fff]*)$/);
    if (!match) return null;

    const kind = match[2] as TriggerKind;
    const query = match[3] || "";
    const start = match.index! + 1; // 跳过开头的空白（如有）

    // / 命令用静态列表；其他用动态数据源
    let items: TriggerItem[];
    switch (kind) {
      case "/": items = slashCommands(t); break;
      case "@": items = workspaceFiles; break;
      case "$": items = skills; break;
      case "#": items = sessionsTriggerItems; break;
    }

    const filtered = query
      ? items.filter((it) => it.label.toLowerCase().includes(query.toLowerCase()))
      : items;

    if (filtered.length === 0 && query) return null; // 有查询但无结果 → 不弹

    // 计算弹层位置：textarea 底部对齐
    const textareaEl = textareaRef.current;
    const rect = textareaEl.getBoundingClientRect();

    return { kind, query, start, top: rect.height, items: filtered, activeIndex: 0 };
  }, [workspaceFiles, skills, sessionsTriggerItems]);

  const applyTriggerItem = useCallback((item: TriggerItem) => {
    if (!trigger || !textareaRef.current) return;
    const { start, kind } = trigger;
    const el = textareaRef.current;
    const cursorPos = el.selectionStart;
    const before = value.slice(0, start);
    const after = value.slice(cursorPos);

    let insertText: string;
    switch (kind) {
      case "@": insertText = `${item.label} `; break;
      case "/": insertText = `${item.label} `; break;
      case "$": insertText = `${item.label} `; break;
      case "#": insertText = `[${item.label}] `; break;   // # 用方括号包裹会话名
    }

    const next = before + insertText + after;
    setValue(next);
    const newPos = before.length + insertText.length;
    setTrigger(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(newPos, newPos);
      handleInput();
    });
  }, [trigger, value]);

  useEffect(() => {
    if (!trigger) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!triggerPopRef.current?.contains(target) && !textareaRef.current?.contains(target)) {
        setTrigger(null);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [trigger]);

  const handleInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  };

  const startEdit = useCallback((index: number) => {
    setEditingIndex(index);
    setEditValue(queuedItems[index]?.text ?? "");
  }, [queuedItems]);

  const commitEdit = useCallback(() => {
    if (editingIndex !== null && onEditQueued) {
      onEditQueued(editingIndex, editValue);
    }
    setEditingIndex(null);
    setEditValue("");
  }, [editingIndex, editValue, onEditQueued]);

  const cancelEdit = useCallback(() => {
    setEditingIndex(null);
    setEditValue("");
  }, []);

  const handleEditKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (e.nativeEvent.isComposing) return; // 输入法组字中：回车确认候选字，不提交
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  const activePermission = PERMISSION_OPTIONS.find((o) => o.mode === permissionMode) ?? PERMISSION_OPTIONS[0];

  // 工作空间过滤（按名称）
  const filteredWorkspaces = workspaces.filter((w) =>
    w.name.toLowerCase().includes(wsQuery.trim().toLowerCase())
  );

  // 模型名在各供应商之间天然唯一（千问/Qwen 与 DeepSeek 不会有同名 model），
  // 只露 model 名，与右栏子面板、Settings 选项对齐。

  // ── 输入框模型选择器：仅展示设置中已配置的模型 ──
  // 按供应商家族聚合（同名家族的多个配置合并其模型），仅保留有模型的家族。
  const configuredFamilies = useMemo(() => {
    const byFamily = new Map<ProviderId, { provider: ProviderId; label: string; models: string[] }>();
    for (const p of providers) {
      if (!p.models || p.models.length === 0) continue;
      const fam = p.provider;
      let entry = byFamily.get(fam);
      if (!entry) {
        entry = {
          provider: fam,
          label: p.name || PROVIDERS.find((x) => x.value === fam)?.label || fam,
          models: [],
        };
        byFamily.set(fam, entry);
      }
      for (const m of p.models) {
        if (!entry.models.includes(m)) entry.models.push(m);
      }
    }
    return Array.from(byFamily.values());
  }, [providers]);

  // model 值 → 展示 label（优先预设 label，落在自定义则原样显示）
  const modelLabelMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of providers) {
      const presetLabels = new Map((MODEL_OPTIONS[p.provider] ?? []).map((m) => [m.value, m.label]));
      for (const m of p.models) {
        map[m] = presetLabels.get(m) ?? m;
      }
    }
    return map;
  }, [providers]);

  // model 值 → 所属供应商家族（用于高亮当前家族、反查 provider）
  const modelToProvider = useMemo(() => {
    const map: Record<string, ProviderId> = {};
    for (const p of providers) {
      for (const m of p.models) map[m] = p.provider;
    }
    return map;
  }, [providers]);

  // 当前选中模型所属家族
  const currentFamily = model ? (modelToProvider[model] ?? null) : null;

  const currentModelLabel = model ? (modelLabelMap[model] ?? model) : DEFAULT_MODEL;

  // 工作区下拉浮层（与「完全访问」权限选择器一致的弹出样式：内联绝对定位 + .model-dropdown 卡片）
  const workspaceDropdown = (
    <div
      className="model-dropdown workspace-dropdown"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="workspace-search">
        <Icons.Search size={14} />
        <input
          type="text"
          placeholder={t("input.searchWorkspace")}
          value={wsQuery}
          onChange={(e) => setWsQuery(e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
      <div className="workspace-list">
        {filteredWorkspaces.map((ws) => (
          <div
            key={ws.id}
            className={`model-option ${effectiveWorkspaceId === ws.id ? "selected" : ""}`}
            onClick={() => { onWorkspaceChange?.(ws.id); setWsOpen(false); setWsQuery(""); }}
          >
            <span className="workspace-option-name">
              <Icons.Folder size={14} />
              {ws.name}
            </span>
            {effectiveWorkspaceId === ws.id && <span className="model-check">✓</span>}
          </div>
        ))}
        {filteredWorkspaces.length === 0 && (
          <div className="workspace-empty">{t("input.noWorkspace")}</div>
        )}
      </div>
      <div className="model-dropdown-divider" />
      <div className="model-option workspace-action" onClick={() => { onOpenFolder?.(); setWsOpen(false); }}>
        <Icons.Plus size={14} />
        <span>{t("input.selectWorkspace")}</span>
      </div>
    </div>
  );

  return (
    <div className="chat-input-outer">
      {onWorkspaceChange && !hasActiveSession && (
        <div className="input-context-card">
          <div className="workspace-selector-wrap">
            <button
              ref={workspaceChipRef}
              className="context-chip workspace-chip"
              onClick={(e) => { e.stopPropagation(); setWsOpen((o) => !o); }}
              aria-label={activeWorkspacePath || workspaceLabel}
              title={activeWorkspacePath || workspaceLabel}
            >
              <Icons.Folder size={13} />
              <span className="context-chip-label">{workspaceLabel}</span>
              <Icons.ChevronDown size={12} className="context-chip-caret" />
            </button>
            {wsOpen && workspaceDropdown}
          </div>
        </div>
      )}

      <div
        className={`chat-input-wrapper input-bar-fused${dragOver ? " chat-input-dragover" : ""}`}
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
          <div className="chat-drop-overlay">
            <Icons.Paperclip size={20} />
            <span>{t("input.dropAttach")}</span>
          </div>
        )}
        {queuedItems.length > 0 && (
          <div className="queue-list" role="list" aria-label={t("chat.queue.ariaLabel")}>
            {queuedItems.map((item, i) => (
              <div className="queue-item" key={item.id} role="listitem">
                {/* 拖拽手柄 */}
                <span className="queue-item-grip" aria-hidden>
                  <Icons.GripVertical size={14} />
                </span>

                {/* 内容区：文本或编辑框 */}
                {editingIndex === i ? (
                  <input
                    ref={editInputRef}
                    className="queue-item-edit"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={handleEditKeyDown}
                    onBlur={commitEdit}
                    aria-label={t("chat.queue.edit")}
                  />
                ) : (
                  <>
                    <span
                      className="queue-item-text"
                      onClick={() => startEdit(i)}
                      title={item.text}
                    >
                      {(() => {
                        const { body } = splitAttachmentLines(item.text);
                        return body || (item.text.includes("[附件]") ? t("input.attachment") : item.text);
                      })()}
                    </span>
                    {/* 图片缩略图 */}
                    {item.images && item.images.length > 0 && (
                      <span className="queue-item-images">
                        {item.images.slice(0, 3).map((src: string, imgIdx: number) => (
                          <img
                            key={imgIdx}
                            src={src}
                            alt=""
                            className="queue-item-img-thumb"
                          />
                        ))}
                        {item.images.length > 3 && (
                          <span className="queue-item-img-more">
                            +{item.images.length - 3}
                          </span>
                        )}
                      </span>
                    )}
                  </>
                )}

                {/* 操作按钮组 */}
                <span className="queue-item-actions">
                  <button
                    className="queue-action-btn"
                    onClick={() => onMoveUpQueued?.(i)}
                    disabled={i === 0}
                    title={t("chat.queue.moveUp")}
                    aria-label={t("chat.queue.moveUp")}
                  >
                    <Icons.ArrowUp size={14} />
                  </button>
                  <button
                    className="queue-action-btn"
                    onClick={() => startEdit(i)}
                    title={t("chat.queue.edit")}
                    aria-label={t("chat.queue.edit")}
                  >
                    <Icons.Edit size={14} />
                  </button>
                  <button
                    className="queue-action-btn queue-action-delete"
                    onClick={() => onRemoveQueued?.(i)}
                    title={t("chat.queue.delete")}
                    aria-label={t("chat.queue.delete")}
                  >
                    <Icons.Trash2 size={14} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="input-main">
          <div className="input-area">
            <textarea
              ref={textareaRef}
              value={value}
              onPaste={(e) => void onPaste(e)}
              onChange={(e) => {
                // 兜底清洗：剥离 PUA / 零宽 / 控制字符,避免 IME bug 等场景渲染出 tofu 方块。
                const raw = e.target.value;
                const v = sanitizeInput(raw);
                if (v !== raw) {
                  // 真实清洗发生：把清洗后的值写回 DOM,React 也会用 value=v 接管。
                  e.target.value = v;
                }
                setValue(v);
                handleInput();
                // 触发器检测
                const t = detectTrigger(v, e.target.selectionStart);
                setTrigger(t);
              }}
              onKeyDown={handleKeyDown}
              placeholder={t("dashboard.placeholder")}
              disabled={disabled && !isStreaming}
              // 关闭浏览器/系统层的拼写与自动更正,避免在 IME 组字中偷偷改改输入。
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              rows={1}
            />
          </div>

          {trigger && (
            <div className="trigger-pop" ref={triggerPopRef} style={{ top: trigger.top }}>
              <div className="trigger-pop-header">
                <span className="trigger-pop-kind">{trigger.kind}</span>
                <span className="trigger-pop-query">
                  {trigger.kind === "@" && "提及文件"}
                  {trigger.kind === "/" && "命令"}
                  {trigger.kind === "$" && "使用技能"}
                  {trigger.kind === "#" && "关联对话"}
                </span>
              </div>
              <div className="trigger-pop-list">
                {trigger.items.length === 0 ? (
                  <div className="trigger-pop-empty">
                    {trigger.kind === "@" && "工作区未关联目录，请在工具栏选择工作区"}
                    {trigger.kind === "/" && "无匹配命令"}
                    {trigger.kind === "$" && "加载中…或无已安装技能"}
                    {trigger.kind === "#" && "暂无历史会话"}
                  </div>
                ) : trigger.items.map((item, idx) => (
                  <div
                    key={item.id + item.label}
                    className={`trigger-item ${idx === trigger.activeIndex ? "active" : ""}`}
                    onClick={() => applyTriggerItem(item)}
                    onMouseEnter={() => setTrigger((p) => p ? { ...p, activeIndex: idx } : null)}
                  >
                    {item.icon && <span className="trigger-item-icon">{item.icon}</span>}
                    <span className="trigger-item-label">{item.label}</span>
                    {item.desc && <span className="trigger-item-desc">{item.desc}</span>}
                  </div>
                ))}
              </div>
              <div className="trigger-pop-footer">
                ↑↓ 导航 · Enter 选择 · Esc 关闭
              </div>
            </div>
          )}
        </div>

        {attachments.length > 0 && (
          <div className="chat-attachments">
            {attachments.map((a) => (
              <span className="chat-attach-chip" key={a.path} title={a.path}>
                {isImageName(a.name) ? <Icons.Image size={13} /> : <Icons.FileText size={13} />}
                <span className="chat-attach-name">{a.name}</span>
                <span className="chat-attach-size">{formatBytes(a.size)}</span>
                <button
                  className="chat-attach-x"
                  type="button"
                  onClick={() => removeAttachment(a.path)}
                  aria-label={t("input.removeAttach")}
                >
                  <Icons.Close size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="input-toolbar">
          <div className="toolbar-left">
            <button
              className="attach-btn"
              onClick={() => void pickFiles()}
              title={t("dashboard.upload")}
              aria-label={t("dashboard.upload")}
            >
              <Icons.Plus size={16} />
            </button>

            {onPermissionChange && (
              <div className="footer-selector-wrap permission-selector-wrap">
                <button
                  className={`footer-selector permission-selector mode-${permissionMode}`}
                  data-mode={permissionMode}
                  onClick={(e) => { e.stopPropagation(); setPermOpen((o) => !o); }}
                  aria-label={t(activePermission.labelKey)}
                  title={t(activePermission.descKey)}
                >
                  <span className="perm-trigger-icon">{activePermission.icon}</span>
                  <span>{t(activePermission.labelKey)}</span>
                </button>
                {permOpen && (
                  <div className="model-dropdown permission-dropdown" onClick={(e) => e.stopPropagation()}>
                    {PERMISSION_OPTIONS.map((opt) => (
                      <div
                        key={opt.mode}
                        className={`model-option permission-option ${permissionMode === opt.mode ? "selected" : ""}`}
                        onClick={() => { onPermissionChange(opt.mode); setPermOpen(false); }}
                      >
                        <span className="perm-opt-icon">{opt.icon}</span>
                        <div className="perm-opt-text">
                          <div className="perm-opt-label">{t(opt.labelKey)}</div>
                          <div className="perm-opt-desc">{t(opt.descKey)}</div>
                        </div>
                        {permissionMode === opt.mode && <Icons.Check size={12} className="model-check" />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="toolbar-right">
            <ContextRing stats={contextStats} />

            <div className="model-selector-native">
              <button
                className="model-trigger"
                onClick={(e) => { e.stopPropagation(); setModelOpen((o) => !o); }}
              >
                <span className="model-label">{currentModelLabel}</span>
              </button>
              {modelOpen && (
                <div className="model-dropdown model-flyout" onClick={(e) => e.stopPropagation()}>
                  {configuredFamilies.length === 0 ? (
                    <div className="model-flyout-empty">{t("input.noConfiguredModels")}</div>
                  ) : (
                    <div className="model-flyout-scroll">
                      {configuredFamilies.map((fam) => (
                        <div key={fam.provider} className="model-flyout-section">
                          <div
                            className={`model-flyout-section-title ${currentFamily === fam.provider ? "current" : ""}`}
                          >
                            {fam.label}
                          </div>
                          {fam.models.map((m) => (
                            <div
                              key={m}
                              className={`model-option ${model === m ? "selected" : ""}`}
                              onClick={() => { onModelChange?.(m); setModelOpen(false); }}
                            >
                              <span className="model-option-value">{modelLabelMap[m] ?? m}</span>
                              {model === m && <Icons.Check size={12} className="model-check" />}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                  {onOpenModelSettings && (
                    <>
                      <div className="model-dropdown-divider" />
                      <div
                        className="model-option model-option-manage"
                        onClick={() => { onOpenModelSettings(); setModelOpen(false); }}
                      >
                        <Icons.Sliders size={14} />
                        <span>{t("input.manageModels")}</span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            <button
              className={`send-btn ${isStreaming ? (hasQueueIntent ? "queue-mode" : "stop-mode") : ""}`}
              onClick={handleSend}
              title={isStreaming ? (hasQueueIntent ? "排队发送（回复完成后自动发送）" : "停止生成") : "发送消息 (Enter)"}
              aria-label={isStreaming ? (hasQueueIntent ? "排队发送" : "停止生成") : "发送消息"}
            >
              {isStreaming ? (
                hasQueueIntent ? (
                  <Icons.ListDir size={16} />
                ) : (
                  <svg viewBox="0 0 18 18" fill="none" width="18" height="18">
                    <rect x="4" y="4" width="10" height="10" rx="2" fill="currentColor"/>
                  </svg>
                )
              ) : (
                <Icons.Send size={16} />
              )}
              {queuedItems.length > 0 && (
                <span className="queue-badge" aria-hidden>{queuedItems.length}</span>
              )}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
});
