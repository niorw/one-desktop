import { useEffect, useRef, useMemo, useState, forwardRef, useImperativeHandle } from "react";
import type { Item, PendingApproval, PermissionMode, TodoEntry, ProposalPayload, ModelProviderConfig } from "../../types";
import { MessageList } from "./MessageList";
import { InputBar, type InputBarHandle } from "./InputBar";
import { Dashboard } from "./Dashboard";
import { ApprovalCard } from "./ApprovalCard";
import { Icons } from "../common/Icons";
import { TodoListCard } from "./TodoListCard";
import { ProposalModal } from "./ProposalModal";
import type { Workspace } from "../../services/workspace";
import type { QueuedMessage } from "../../hooks/useAgent";
import type { Session } from "../../types";
import { estimateContextStats } from "./contextStats";

export interface ChatAreaHandle {
  /** 聚焦到当前挂载的输入框（Dashboard 或 MessageList 视图里的 InputBar）。 */
  focus: () => void;
}

interface ChatAreaProps {
  items: Item[];
  isStreaming: boolean;
  streamingText: string;
  reasoningStream: string;
  /** 本轮累计 token 消耗（实时 footer「已消耗 ◇ X.XX」用），0 = 无/未起算。 */
  runTokenUsage?: number;
  onSendMessage: (content: string) => void;
  hasActiveSession: boolean;
  /** ADR-021（chat 会话级）：当前会话 id，用于渲染「产出文件审阅」入口。 */
  sessionId?: string;
  model?: string;
  onModelChange?: (model: string) => void;
  pendingApproval: PendingApproval | null;
  onDecide: (action: "accept" | "edit" | "respond" | "ignore", args?: unknown, feedback?: string) => void;
  /** R7：单聊升级为协作群入口。 */
  onUpgrade?: () => void;
  permissionMode?: PermissionMode;
  onPermissionChange?: (mode: PermissionMode) => void;
  onRegenerate?: () => void;
  onStop?: () => void;
  /** 首屏动态建议（近期会话标题等）。 */
  suggestions?: string[];
  /** 从欢迎页直接开新会话（空态 CTA 复用）。 */
  onNewSession?: () => void;
  /** ADR-022：内嵌排队消息列表。 */
  queuedItems?: QueuedMessage[];
  onRemoveQueued?: (index: number) => void;
  onEditQueued?: (index: number, newText: string) => void;
  onMoveUpQueued?: (index: number) => void;
  /** Turn elapsed time formatted as "Xm Xs" or "Xs". */
  elapsed?: string;
  /** 能力①：本回合待办清单（内核 TodoUpdate 全量快照）。空数组不渲染。 */
  todos?: TodoEntry[];
  /** 能力②：待确认方案；非空时弹出阻塞式确认弹窗。 */
  pendingProposal?: ProposalPayload | null;
  onResolveProposal?: (
    decision: "selected" | "custom" | "rejected",
    optionId?: string,
    customText?: string,
  ) => void;
  /** 工作区上下文条（截图式顶部 pill）：聚焦工作区决定灵感/记忆/设置的资源共享边界。 */
  workspaces?: Workspace[];
  activeWorkspaceId?: string;
  onSwitchWorkspace?: (id: string) => void;
  /** 打开文件夹 → 关联/创建工作区（App 层实现）。 */
  onOpenFolder?: () => void;
  /** 打开模型设置（InputBar 下拉“管理模型”用）。 */
  onOpenModelSettings?: () => void;
  /** 已配置的供应商列表（驱动输入框模型选择器，仅展示配置过的模型）。 */
  providers?: ModelProviderConfig[];
}

export const ChatArea = forwardRef<ChatAreaHandle, ChatAreaProps>(function ChatArea({
  items, isStreaming, streamingText, reasoningStream, runTokenUsage,
  onSendMessage,
  hasActiveSession, model, onModelChange, pendingApproval, onDecide,
  onUpgrade,
  permissionMode, onPermissionChange, onRegenerate, onStop,
  suggestions, onNewSession,
  queuedItems = [], onRemoveQueued, onEditQueued, onMoveUpQueued,
  sessionId, elapsed,
  todos = [],   pendingProposal, onResolveProposal,
  workspaces = [], activeWorkspaceId, onSwitchWorkspace,
  onOpenFolder, onOpenModelSettings, providers = [],
}, ref) {
  const [todoExpanded, setTodoExpanded] = useState(true);
  const doneCount = todos.filter((tt) => tt.status === "done").length;
  const allDone = todos.length > 0 && doneCount === todos.length;
  const hasFailed = todos.some((tt) => tt.status === "failed");
  const pillState = hasFailed
    ? "failed"
    : allDone
      ? "done"
      : todos.some((tt) => tt.status === "active")
        ? "active"
        : "pending";
  // 新计划（todos 从空变非空）自动展开，让用户看到规划；用户可手动合并为浮标。
  const prevEmpty = useRef(true);
  useEffect(() => {
    if (todos.length > 0 && prevEmpty.current) setTodoExpanded(true);
    prevEmpty.current = todos.length === 0;
  }, [todos]);

  const inputRef = useRef<InputBarHandle>(null);
  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
  }), []);

  const isEmpty = items.length === 0 && !streamingText && !reasoningStream;

  // 上下文用量（前端估算：会话文本量/4 + 模型窗口查表），驱动输入栏环形指示器
  const contextStats = useMemo(
    () => estimateContextStats(items, streamingText, reasoningStream, model),
    [items, streamingText, reasoningStream, model],
  );

  const inputBar = (
    <InputBar
      ref={inputRef}
      onSend={onSendMessage}
      isStreaming={isStreaming}
      model={model}
      onModelChange={onModelChange}
      permissionMode={permissionMode}
      onPermissionChange={onPermissionChange}
      onStop={onStop}
      onUpgrade={hasActiveSession ? onUpgrade : undefined}
      queuedItems={queuedItems}
      onRemoveQueued={onRemoveQueued}
      onEditQueued={onEditQueued}
      onMoveUpQueued={onMoveUpQueued}
      workspaces={workspaces}
      activeWorkspaceId={activeWorkspaceId}
      onWorkspaceChange={onSwitchWorkspace}
      onOpenFolder={onOpenFolder}
      contextStats={contextStats}
      onOpenModelSettings={onOpenModelSettings}
      hasActiveSession={hasActiveSession}
      providers={providers}
    />
  );

  return (
    <div className="chat-area">
      {isEmpty ? (
        <>
          <Dashboard
            ref={inputRef}
            onSendMessage={onSendMessage}
            isStreaming={isStreaming}
            model={model}
            onModelChange={onModelChange}
            permissionMode={permissionMode}
            onPermissionChange={onPermissionChange}
            onStop={onStop}
            onUpgrade={hasActiveSession ? onUpgrade : undefined}
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            onSwitchWorkspace={onSwitchWorkspace}
            onOpenFolder={onOpenFolder}
            onOpenModelSettings={onOpenModelSettings}
            queuedItems={queuedItems}
            onRemoveQueued={onRemoveQueued}
            onEditQueued={onEditQueued}
            onMoveUpQueued={onMoveUpQueued}
            providers={providers}
          />
        </>
      ) : (
        <>
          <MessageList
            items={items}
            isStreaming={isStreaming}
            streamingText={streamingText}
            reasoningStream={reasoningStream}
            runTokenUsage={runTokenUsage}
            onRegenerate={onRegenerate}
            pendingApproval={pendingApproval}
            onDecide={onDecide}
            onStop={onStop}
            onPromptSuggestion={onSendMessage}
            suggestions={suggestions}
            onNewSession={onNewSession}
            elapsed={elapsed}
            permissionMode={permissionMode}
          />
          {inputBar}
        </>
      )}
      {todos.length > 0 && (
        <div className={`todo-fab${todoExpanded ? " is-expanded" : " is-collapsed"}`}>
          {todoExpanded ? (
            <>
              <div className="todo-fab-bar">
                <span className="todo-fab-label">执行计划</span>
                <span className="todo-fab-count">{doneCount}/{todos.length}</span>
                <button
                  type="button"
                  className="todo-fab-toggle"
                  onClick={() => setTodoExpanded(false)}
                  aria-label="收起计划浮窗"
                  title="收起"
                >
                  <Icons.ChevronRight size={12} />
                </button>
              </div>
              <TodoListCard todos={todos} defaultCollapsed={false} headerless />
            </>
          ) : (
            <button
              type="button"
              className="todo-fab-pill"
              onClick={() => setTodoExpanded(true)}
              aria-label="展开计划浮窗"
              title="展开计划"
            >
              <span className={`todo-fab-pill-dot dot-${pillState}`} />
              <span className="todo-fab-pill-count">{doneCount}/{todos.length}</span>
              <Icons.ChevronRight size={12} />
            </button>
          )}
        </div>
      )}
      {pendingProposal && onResolveProposal && (
        <ProposalModal proposal={pendingProposal} onResolve={onResolveProposal} />
      )}
    </div>
  );
});
