import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Sidebar } from "./components/layout/Sidebar";
import { TopBar } from "./components/layout/TopBar";
import { CommandPalette } from "./components/layout/CommandPalette";
import type { NavKey } from "./components/layout/Sidebar";
import { ChatArea, type ChatAreaHandle } from "./components/chat/ChatArea";
import { UpgradeModal } from "./components/chat/UpgradeModal";
import { EventDrawer } from "./components/chat/EventDrawer";
import { TaskDrawer } from "./components/chat/TaskDrawer";
import { SettingsPage } from "./components/settings/SettingsPage";
import { ScheduledTasksPage } from "./components/tasks/ScheduledTasksPage";
import { KanbanPage } from "./components/kanban/KanbanPage";
import { CalendarPage } from "./components/calendar/CalendarPage";
import { InspirationPage } from "./components/inspiration/InspirationPage";
import { DevToolsPage } from "./components/tools/DevToolsPage";
import { GroupsPage } from "./components/groups/GroupsPage";
import { SplashScreen } from "./components/common/SplashScreen";
import { useSessions } from "./hooks/useSessions";
import { useAgent } from "./hooks/useAgent";
import { useSettings, MODEL_TO_PROVIDER } from "./hooks/useSettings";
import { useTheme } from "./hooks/useTheme";
import { applyGlassEffect, loadGlassLevel } from "./services/glass";
import { I18nProvider, useI18n } from "./i18n/I18nProvider";
import { PreviewProvider, usePreview } from "./components/artifacts/PreviewProvider";
import { ArtifactPreview } from "./components/artifacts/ArtifactPreview";
import * as tauri from "./services/tauri";
import { restoreWindowSize, trackWindowSize } from "./services/windowSize";
import { pickFolder, createWorkspaceWithPath } from "./services/workspace";
import type { PermissionMode } from "./types";

function Workbench() {
  const {
    sessions,
    activeSessionId,
    loading,
    createSession,
    deleteSession,
    selectSession,
    loadSessions,
    focusWorkspace,
    workspaces,
    activeWorkspaceId,
    loadWorkspaces,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
  } = useSessions();

  const chatAreaRef = useRef<ChatAreaHandle>(null);

  // 打开文件夹 → 关联/创建工作区：选目录、以目录名建工作区、初始化 .one-desktop、刷新并切换。
  const handleOpenFolder = useCallback(async () => {
    const dir = await pickFolder();
    if (!dir) return;
    const name = dir.split(/[\\/]/).filter(Boolean).pop() || "默认工作区";
    try {
      const ws = await createWorkspaceWithPath(name, dir);
      await loadWorkspaces();      // 刷新下拉列表
      focusWorkspace(ws.id);       // 仅切换工作区；session 与 .one-desktop/ 初始化延迟到发送消息时
    } catch (e) {
      console.error("[Workbench] 创建关联工作区失败:", e);
    }
  }, [loadWorkspaces, focusWorkspace]);

  const [permissionMode, setPermissionMode] = useState<PermissionMode>("full_access");

  const {
    items,
    isStreaming,
    streamingText,
    reasoningStream,
    error,
    sendMessage,
    cancel,
    clearError,
    pendingApproval,
    decide,
    approvalQueue,
    regenerate,
    queuedItems,
    queueCount,
    removeFromQueue,
    editQueueItem,
    moveQueueUp,
    getElapsed,
    todos,
    pendingProposal,
    resolveProposal,
  } = useAgent(activeSessionId, permissionMode);

  const { settings, showModal, setShowModal, saveSettings } = useSettings();
  // 设置弹窗打开时定位的标签页（输入框「管理模型」→ model，其余 → general）。
  const [modalTab, setModalTab] = useState<"general" | "model">("general");
  const { theme, setTheme, toggleTheme } = useTheme();
  const { t } = useI18n();

  // 预览右栏：全局状态源在 PreviewProvider；此处仅消费并在 flex 布局内渲染（推开对话）。
  const { previewReq, closePreview, setDefaultSessionId } = usePreview();

  // R8-Plus：chat 会话切换时同步 Provider 默认 sessionId，让 openPreview({ filePath })
  // 自动附加 sessionId（用于 LLM 幻觉路径的 basename 兜底）。
  useEffect(() => {
    setDefaultSessionId(activeSessionId);
  }, [activeSessionId, setDefaultSessionId]);

  // P1-3：首屏动态建议——取最近会话标题，没有则回退到静态建议。
  const welcomeSuggestions = useMemo(() => {
    const recent = sessions
      .filter((s) => s.title && s.title.trim())
      .slice(0, 3)
      .map((s) => s.title.trim());
    return recent.length > 0
      ? recent
      : [
          t("dashboard.suggest.packageJson"),
          t("dashboard.suggest.port"),
          t("dashboard.suggest.rename"),
          t("dashboard.suggest.listFiles"),
        ];
  }, [sessions, t]);

  const handleCreateSession = useCallback(
    async (wsId?: string | null) => {
      await createSession(wsId ?? null);
      setActiveNav("chat");
      // 新会话渲染完成后光标自动聚焦输入框（含 Dashboard 首屏——Dashboard 内部也持有
      // InputBarHandle）。setTimeout 0 等 React 完成当前渲染再聚焦，避免抢在挂载前。
      setTimeout(() => chatAreaRef.current?.focus(), 0);
    },
    [createSession],
  );

  const handleCreateWorkspace = useCallback(
    async (name: string) => {
      const ws = await createWorkspace(name.trim());
      focusWorkspace(ws.id);
      setActiveNav("chat");
    },
    [createWorkspace, focusWorkspace],
  );

  const handleRenameWorkspace = useCallback(
    (wsId: string, name: string) => renameWorkspace(wsId, name),
    [renameWorkspace],
  );

  const handleDeleteWorkspace = useCallback(
    (wsId: string, moveToDefault: boolean) => deleteWorkspace(wsId, moveToDefault),
    [deleteWorkspace],
  );

  useEffect(() => {
    let cancelled = false;
    loadGlassLevel().then((lvl) => {
      if (!cancelled) applyGlassEffect(lvl);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const [activeNav, setActiveNav] = useState<NavKey>("chat");
  const [groups, setGroups] = useState<import("./types").Group[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  // 设计审计 P0：⌘K 命令面板
  const [cmdOpen, setCmdOpen] = useState(false);
  // R7：单聊升级为群（预填弹窗）
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeSessionId, setUpgradeSessionId] = useState<string | null>(null);
  const [upgradePresets, setUpgradePresets] = useState<import("./types").AgentProfile[]>([]);

  const loadGroups = useCallback(async () => {
    try {
      const gs = await tauri.listGroups();
      setGroups(gs);
      // 不自动打开「最近的群」：仅当已有显式选中且仍有效时保持，否则进入卡片墙首页。
      setActiveGroupId((cur) => (cur && gs.some((g) => g.id === cur) ? cur : null));
    } catch {
      /* non-fatal */
    }
  }, []);

  // 新建圆桌（与 Sidebar 入口共用）：切到 group 导航 + 进入创建态
  const handleCreateGroup = useCallback(() => {
    setActiveNav("group");
    setActiveGroupId(null);
    setCreatingGroup(true);
  }, []);

  // 从导航栏进入「群协作」时重置选中：默认展示群总览卡片墙，不主动打开最近的群。
  // 从侧栏群列表点具体群仍走 onSelectGroup 单独选中，不受影响。
  const handleNavigate = useCallback((key: NavKey) => {
    if (key === "group") setActiveGroupId(null);
    setActiveNav(key);
  }, []);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 420;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("sidebar.collapsed") === "1"
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const v = Number(localStorage.getItem("sidebar.width"));
    return v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : 260;
  });
  const [sidebarResizing, setSidebarResizing] = useState(false);

  // 事件流抽屉（实时归一化 AgentEvent）
  const [eventDrawerOpen, setEventDrawerOpen] = useState(false);
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [taskCount, setTaskCount] = useState(0);

  // 两个抽屉互斥：打开其一则关闭另一个，避免右侧重叠
  const toggleEventDrawer = () => {
    setEventDrawerOpen((o) => {
      const next = !o;
      if (next) setTaskDrawerOpen(false);
      return next;
    });
  };
  const toggleTaskDrawer = () => {
    setTaskDrawerOpen((o) => {
      const next = !o;
      if (next) setEventDrawerOpen(false);
      return next;
    });
  };

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      localStorage.setItem("sidebar.collapsed", prev ? "0" : "1");
      return !prev;
    });
  }, []);

  // 键盘快捷键：Cmd/Ctrl + B 切换侧边栏
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  // 设计审计 P0：Cmd/Ctrl + K 唤起 / 关闭命令面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Cmd/Ctrl + , 打开设置
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setModalTab("general");
        setShowModal(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Cmd/Ctrl + N：依当前导航态新建（group → 圆桌，其余 → 会话）
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (activeNav === "group") {
          handleCreateGroup();
        } else {
          // Cmd+N 新建空会话：handleCreateSession 统一负责切 chat + 聚焦输入框。
          await handleCreateSession();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [activeNav, handleCreateGroup, handleCreateSession]);

  const startSidebarResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setSidebarResizing(true);
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      let latest = startWidth;

      const onMove = (ev: MouseEvent) => {
        latest = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + ev.clientX - startX));
        setSidebarWidth(latest);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setSidebarResizing(false);
        localStorage.setItem("sidebar.width", String(latest));
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sidebarWidth]
  );

  const prevItemsLen = useRef(items.length);
  useEffect(() => {
    if (!isStreaming && items.length > 0 && items.length > prevItemsLen.current) {
      loadSessions();
    }
    prevItemsLen.current = items.length;
  }, [items.length, isStreaming, loadSessions]);

  useEffect(() => {
    restoreWindowSize();
    trackWindowSize();
  }, []);

  const handleSendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;
      if (!activeSessionId) {
        // 无当前会话：在已选工作区下新建会话（会同步初始化该工作区 .one-desktop/）。
        const newSession = await createSession(activeWorkspaceId);
        if (!newSession) return;
        sendMessage(content, newSession.id);
        return;
      }
      sendMessage(content);
    },
    [activeSessionId, activeWorkspaceId, createSession, sendMessage]
  );

  const handlePermissionChange = useCallback(async (mode: PermissionMode) => {
    setPermissionMode(mode);
    // 完全访问 / 自动编辑 都走自动批准（后端目前是布尔开关，auto_edit 与 full_access 同效）。
    await tauri.setAutoApprove(mode === "full_access" || mode === "auto_edit");
  }, []);

  const handleModelChange = useCallback(async (model: string) => {
    // 优先从已配置供应商反查 provider（自定义/预设模型都能正确落库），
    // 回落静态映射，再回落当前 provider，保证向后兼容。
    const configured = settings.providers
      ?.flatMap((p) => p.models.map((m) => [m, p.provider] as const))
      .find(([m]) => m === model)?.[1];
    const provider = configured ?? MODEL_TO_PROVIDER[model] ?? settings.provider;
    await saveSettings({ ...settings, model, provider });
  }, [saveSettings, settings]);

  // R7：打开升级弹窗（FR7.1；先加载 Agent 预设供席位选择）。
  const handleOpenUpgrade = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      setUpgradePresets(await tauri.listAgentPresets());
    } catch {
      setUpgradePresets([]);
    }
    setUpgradeSessionId(activeSessionId);
    setUpgradeOpen(true);
  }, [activeSessionId]);

  // R7：升级确认 → 原地切到群视图（同一 session 上下文不丢）。
  const handleUpgradeConfirm = useCallback(
    (groupId: string) => {
      setUpgradeOpen(false);
      setUpgradeSessionId(null);
      setActiveGroupId(groupId);
      setActiveNav("group");
      void loadGroups();
    },
    [loadGroups]
  );

  // R7（FR7.3）：群折叠回单聊——找到该群对应的会话（session.group_id），
  // mode 置空后切回会话视图（群实体保留含产出物）。
  const handleFoldBack = useCallback(async () => {
    if (!activeGroupId) return;
    try {
      const all = await tauri.listSessions();
      const target = all.find((s) => s.group_id === activeGroupId);
      if (target) {
        await tauri.sessionFoldToChat(target.id);
        selectSession(target.id);
        setActiveNav("chat");
      }
    } catch (e) {
      console.error("[upgrade] fold back failed:", e);
    }
  }, [activeGroupId, selectSession]);

  return (
    <div className="app-layout">
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        activeNav={activeNav}
        onNavigate={handleNavigate}
        onSelectSession={(id) => {
          selectSession(id);
          setActiveNav("chat");
        }}
        onDeleteSession={deleteSession}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onCreateSessionInWorkspace={handleCreateSession}
        onCreateWorkspace={handleCreateWorkspace}
        onRenameWorkspace={handleRenameWorkspace}
        onDeleteWorkspace={handleDeleteWorkspace}
        groups={groups}
        activeGroupId={activeGroupId}
        onSelectGroup={(id) => {
          setActiveGroupId(id);
          setActiveNav("group");
        }}
        onCreateGroup={handleCreateGroup}
        onOpenSettings={() => { setModalTab("general"); setShowModal(true); }}
        theme={theme}
        onToggleTheme={toggleTheme}
        width={sidebarWidth}
        collapsed={sidebarCollapsed}
        resizing={sidebarResizing}
      />

      {!sidebarCollapsed && (
        <div
          className={`sidebar-resizer${sidebarResizing ? " active" : ""}`}
          onMouseDown={startSidebarResize}
          role="separator"
          aria-orientation="vertical"
        />
      )}

      <main className="main-content">
        <TopBar
          activeNav={activeNav}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          onOpenCommandPalette={() => setCmdOpen(true)}
          onToggleEventDrawer={toggleEventDrawer}
          eventDrawerOpen={eventDrawerOpen}
          onToggleTaskDrawer={toggleTaskDrawer}
          taskDrawerOpen={taskDrawerOpen}
          taskCount={taskCount}
        />
        <div className="main-scroll">
          {activeNav === "chat" && (
            <ChatArea
              ref={chatAreaRef}
              items={items}
              isStreaming={isStreaming}
              streamingText={streamingText}
              reasoningStream={reasoningStream}
              onSendMessage={handleSendMessage}
              hasActiveSession={activeSessionId !== null}
              sessionId={activeSessionId ?? undefined}
              model={settings.model}
              providers={settings.providers ?? []}
              pendingApproval={pendingApproval}
              onDecide={decide}
              onRegenerate={regenerate}
              onStop={cancel}
              queuedItems={queuedItems}
              onRemoveQueued={removeFromQueue}
              onEditQueued={editQueueItem}
              onMoveUpQueued={moveQueueUp}
              permissionMode={permissionMode}
              onPermissionChange={handlePermissionChange}
              onModelChange={handleModelChange}
              onUpgrade={() => void handleOpenUpgrade()}
              onOpenModelSettings={() => { setModalTab("model"); setShowModal(true); }}
              suggestions={welcomeSuggestions}
              onNewSession={() => void handleCreateSession(activeWorkspaceId)}
              elapsed={getElapsed()}
              todos={todos}
              pendingProposal={pendingProposal}
              onResolveProposal={resolveProposal}
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspaceId}
              onSwitchWorkspace={focusWorkspace}
              onOpenFolder={handleOpenFolder}
            />
          )}

          {activeNav === "group" && (
            <GroupsPage
              activeGroupId={activeGroupId}
              settings={settings}
              onGroupsChange={loadGroups}
              onActiveGroupChange={setActiveGroupId}
              creatingGroup={creatingGroup}
              onCreatingGroupChange={setCreatingGroup}
              onFoldBack={() => void handleFoldBack()}
            />
          )}

          {upgradeOpen && upgradeSessionId && (
            <UpgradeModal
              sessionId={upgradeSessionId}
              presets={upgradePresets}
              onClose={() => { setUpgradeOpen(false); setUpgradeSessionId(null); }}
              onConfirm={handleUpgradeConfirm}
            />
          )}

          {activeNav === "tasks" && (
            <ScheduledTasksPage />
          )}
          {activeNav === "kanban" && <KanbanPage />}
          {activeNav === "calendar" && <CalendarPage />}
          {activeNav === "inspiration" && <InspirationPage workspaceId={activeWorkspaceId} />}
          {activeNav === "tools" && <DevToolsPage />}

        <SettingsPage
          isOpen={showModal}
          onClose={() => setShowModal(false)}
          settings={settings}
          onSave={saveSettings}
          theme={theme}
          onSetTheme={setTheme}
          initialTab={modalTab}
        />
      </div>
    </main>

      {/* 实时归一化事件流抽屉（全局，与 nav 无关） */}
      <EventDrawer open={eventDrawerOpen} onClose={() => setEventDrawerOpen(false)} />
      <TaskDrawer
        open={taskDrawerOpen}
        onClose={() => setTaskDrawerOpen(false)}
        onActiveChange={setTaskCount}
      />

      {/* 文件/产出物预览：最右侧独立面板（flex 兄弟节点，推开对话，非遮罩浮层） */}
      {previewReq && (
        <ArtifactPreview
          deliverable={previewReq.deliverable}
          filePath={previewReq.filePath}
          sessionId={previewReq.sessionId}
          presetTraceRef={previewReq.traceRef}
          workers={previewReq.workers}
          resolveName={previewReq.resolveName}
          onClose={closePreview}
        />
      )}

      {/* 设计审计 P0：⌘K 命令面板（真实命令，非占位） */}
      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        sessions={sessions}
        onNavigate={setActiveNav}
        onCreateSession={() => {
          void handleCreateSession(activeWorkspaceId);
        }}
        onToggleTheme={toggleTheme}
        onOpenSettings={() => { setModalTab("general"); setShowModal(true); }}
        onSelectSession={(id) => {
          selectSession(id);
          setActiveNav("chat");
        }}
      />
    </div>
  );
}

export default function App() {
  const [showSplash, setShowSplash] = useState(true);

  return (
    <I18nProvider>
      <PreviewProvider>
        <Workbench />
        {showSplash && <SplashScreen onDone={() => setShowSplash(false)} />}
      </PreviewProvider>
    </I18nProvider>
  );
}
