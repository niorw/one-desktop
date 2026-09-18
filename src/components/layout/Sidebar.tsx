import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { SessionList } from "../session/SessionList";
import type { Session, Group } from "../../types";
import { DEFAULT_WORKSPACE_ID, type Workspace } from "../../services/workspace";
import type { DictKey } from "../../i18n/dict";
import { useI18n } from "../../i18n/I18nProvider";
import type { Theme } from "../../hooks/useTheme";
import { subscribeToWorkerStatus } from "../../services/eventBus";
import { getVersion } from "@tauri-apps/api/app";

export type NavKey = "chat" | "group" | "tasks" | "kanban" | "calendar" | "inspiration" | "tools";

interface SidebarProps {
  sessions: Session[];
  activeSessionId: string | null;
  activeNav: NavKey;
  onNavigate: (key: NavKey) => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  // 工作区（docs/design/workspace-design.md v2）：会话按工作区分组，资源共享/隔离边界。
  workspaces: Workspace[];
  activeWorkspaceId: string;
  onCreateSessionInWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: (name: string) => void;
  onRenameWorkspace: (workspaceId: string, name: string) => void;
  onDeleteWorkspace: (workspaceId: string, moveToDefault: boolean) => void;
  groups: Group[];
  activeGroupId: string | null;
  onSelectGroup: (id: string) => void;
  onCreateGroup: () => void;
  onOpenSettings: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  /** 当前侧栏是否折叠（折叠态宽度=0）。 */
  collapsed: boolean;
  /** Current sidebar width in px (used even while collapsed so re-expand restores it) */
  width: number;
  /** True while the user is dragging the resize handle (disables width transition) */
  resizing: boolean;
}

export function Sidebar({
  sessions,
  activeSessionId,
  activeNav,
  onNavigate,
  onSelectSession,
  onDeleteSession,
  workspaces,
  activeWorkspaceId,
  onCreateSessionInWorkspace,
  onCreateWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
  groups,
  activeGroupId,
  onSelectGroup,
  onCreateGroup,
  onOpenSettings,
  theme,
  onToggleTheme,
  collapsed,
  width,
  resizing,
}: SidebarProps) {
  const { t } = useI18n();

  // 实时追踪各群「执行中」的 Worker 数量（驱动侧边栏徽标）。
  const [busyWorkers, setBusyWorkers] = useState<Record<string, string>>({});
  useEffect(() => {
    const unsub = subscribeToWorkerStatus((ev) => {
      setBusyWorkers((prev) => {
        const next = { ...prev };
        if (ev.status === "Busy") next[ev.worker_id] = ev.group_id;
        else delete next[ev.worker_id];
        return next;
      });
    });
    return unsub;
  }, []);
  const busyByGroup = useMemo(() => {
    const m: Record<string, number> = {};
    for (const gid of Object.values(busyWorkers)) m[gid] = (m[gid] ?? 0) + 1;
    return m;
  }, [busyWorkers]);

  const style: CSSProperties = {
    width: collapsed ? 0 : width,
    // Inner content keeps the expanded width so collapse slides instead of squishing
    ["--sb-w" as string]: `${width}px`,
  };

  // 版本号：单一数据源，来自 tauri.conf.json（getVersion 读取）。避免散落硬编码。
  const [appVersion, setAppVersion] = useState<string>("");
  useEffect(() => {
    let alive = true;
    getVersion()
      .then((v) => {
        if (alive) setAppVersion(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <aside
      className={`sidebar${collapsed ? " collapsed" : ""}${resizing ? " resizing" : ""}`}
      style={style}
    >
      <div className="sidebar-inner">
        {/* Brand header: clears macOS traffic lights */}
        <div className="sidebar-brand" data-tauri-drag-region="deep" />

        {/* App name + version (below divider, above nav) */}
        <div className="sidebar-app-label">
          <span className="sidebar-app-name">OneDesktop</span>
          <span className="sidebar-app-version">v{appVersion}</span>
        </div>

        <nav className="sidebar-nav" aria-label={t("nav.mainNav")}>
          <SidebarNavItem
            active={activeNav === "chat"}
            onClick={() => {
              if (activeNav === "chat") {
                onCreateSessionInWorkspace(DEFAULT_WORKSPACE_ID);
              } else {
                onNavigate("chat");
              }
            }}
            icon={<ChatIcon />}
            label={t("nav.chat")}
            navKey="chat"
          />
          <SidebarNavItem
            active={activeNav === "group"}
            onClick={() => onNavigate("group")}
            icon={<GroupIcon />}
            label={t("nav.roundtable")}
            navKey="group"
          />
          <SidebarNavItem
            active={activeNav === "tasks"}
            onClick={() => onNavigate("tasks")}
            icon={<ClockIcon />}
            label={t("nav.tasks")}
            navKey="tasks"
          />
          <SidebarNavItem
            active={activeNav === "kanban"}
            onClick={() => onNavigate("kanban")}
            icon={<KanbanIcon />}
            label={t("nav.kanban")}
            navKey="kanban"
          />
          <SidebarNavItem
            active={activeNav === "calendar"}
            onClick={() => onNavigate("calendar")}
            icon={<CalendarIcon />}
            label={t("nav.calendar")}
            navKey="calendar"
          />
          <SidebarNavItem
            active={activeNav === "inspiration"}
            onClick={() => onNavigate("inspiration")}
            icon={<InspireIcon />}
            label={t("nav.inspiration")}
            navKey="inspiration"
          />
          <SidebarNavItem
            active={activeNav === "tools"}
            onClick={() => onNavigate("tools")}
            icon={<ToolsIcon />}
            label={t("nav.tools")}
            navKey="tools"
          />
        </nav>

        {/* 设计审计 P0：导航区与会话区之间的 1px 分隔线 */}
        <div className="sidebar-nav-divider" role="separator" aria-orientation="horizontal" />

        {/* Conversation list: always visible, independent of activeNav.
            chat → 会话清单；group → 群清单。两种模式并列，不再嵌套。 */}
        <div className="sidebar-conversation">
            {activeNav === "group" ? (
              <GroupList
                groups={groups}
                activeId={activeGroupId}
                busyByGroup={busyByGroup}
                onSelect={onSelectGroup}
                onCreate={onCreateGroup}
              />
            ) : (
              <WorkspaceTree
                workspaces={workspaces}
                sessions={sessions}
                activeId={activeSessionId}
                activeWorkspaceId={activeWorkspaceId}
                onSelect={onSelectSession}
                onDelete={onDeleteSession}
                onCreateInWorkspace={onCreateSessionInWorkspace}
                onCreateWorkspace={onCreateWorkspace}
                onRenameWorkspace={onRenameWorkspace}
                onDeleteWorkspace={onDeleteWorkspace}
              />
            )}
          </div>

        <div className="sidebar-bottom">
          <button
            className="sidebar-bottom-btn"
            onClick={onOpenSettings}
            title={t("nav.settings")}
            aria-label={t("nav.settings")}
          >
            <SettingsIcon />
          </button>
          <button
            className="sidebar-bottom-btn"
            onClick={onToggleTheme}
            title={theme === "dark" ? t("theme.day") : t("theme.night")}
            aria-label={t("theme.toggle")}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </div>
    </aside>
  );
}

function SidebarNavItem({
  active,
  onClick,
  icon,
  label,
  navKey,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  /** 稳定的导航标识，供 E2E 定位（locale 无关）。 */
  navKey: string;
  /** 未读角标（>0 才渲染，超过 99 显示 99+）。 */
  badge?: number;
}) {
  return (
    <button
      className={`sidebar-nav-item ${active ? "active" : ""}`}
      data-nav={navKey}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className="sidebar-nav-icon">{icon}</span>
      <span className="sidebar-nav-label">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="sidebar-nav-badge" aria-label={`${badge}`}>
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

function GroupList({
  groups,
  activeId,
  busyByGroup,
  onSelect,
  onCreate,
}: {
  groups: Group[];
  activeId: string | null;
  busyByGroup: Record<string, number>;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="sidebar-groups" role="tabpanel">
      <div className="sidebar-ws-section-header">
        <span className="sidebar-section-title">{t("nav.roundtable")}</span>
        <button
          className="sidebar-create-btn"
          onClick={onCreate}
          title={t("groups.newGroup")}
          aria-label={t("groups.newGroup")}
        >
          <PlusIcon />
        </button>
      </div>
      {groups.length === 0 ? (
        <div className="sidebar-empty">
          <p>{t("groups.empty.title")}</p>
          <p className="sidebar-empty-desc">{t("groups.empty.desc")}</p>
        </div>
      ) : (
        groups.map((g) => {
          const busy = busyByGroup[g.id] ?? 0;
          return (
            <button
              key={g.id}
              className={`sidebar-group-item ${activeId === g.id ? "active" : ""}`}
              onClick={() => onSelect(g.id)}
              aria-pressed={activeId === g.id}
            >
              <span className="sidebar-group-icon">
                <GroupIcon />
              </span>
              <span className="sidebar-group-meta">
                <span className="sidebar-group-name">{g.name}</span>
                {busy > 0 ? (
                  <span
                    className="sidebar-group-status status-busy"
                    title={t("groups.member.working")}
                    aria-label={`${t("groups.member.working")}${busy > 1 ? ` (${busy})` : ""}`}
                  >
                    <span className="sidebar-busy-dot" />
                    <span className="sidebar-busy-label">
                      {t("groups.member.working")}
                      {busy > 1 ? ` (${busy})` : ""}
                    </span>
                  </span>
                ) : (
                  <span
                    className={`sidebar-group-status status-${g.status.toLowerCase()}`}
                    title={t(`groups.status.${g.status}` as DictKey)}
                    aria-label={t(`groups.status.${g.status}` as DictKey)}
                  />
                )}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}

// ── 工作区分组树（docs/design/workspace-design.md v2）──
// 工作区是一等实体（资源共享/隔离边界），下挂多个会话；侧边栏按工作区把会话聚成
// 可折叠父分组。顶部「+」在激活工作区直接建会话（保留旧 E2E 行为），chevron 选择器
// 让用户显式选工作区；每个工作区头部「+」直接在该工作区建会话。
function WorkspaceTree({
  workspaces,
  sessions,
  activeId,
  activeWorkspaceId,
  onSelect,
  onDelete,
  onCreateInWorkspace,
  onCreateWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
}: {
  workspaces: Workspace[];
  sessions: Session[];
  activeId: string | null;
  activeWorkspaceId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCreateInWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: (name: string) => void;
  onRenameWorkspace: (workspaceId: string, name: string) => void;
  onDeleteWorkspace: (workspaceId: string, moveToDefault: boolean) => void;
}) {
  const { t } = useI18n();
  // 任务（默认项目）区默认折叠
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ [DEFAULT_WORKSPACE_ID]: true });

  // 当前激活会话所属的工作区自动展开，避免新建/切换会话后列表看不见。
  useEffect(() => {
    if (!activeId) return;
    const wsId = sessions.find((s) => s.id === activeId)?.workspace_id ?? DEFAULT_WORKSPACE_ID;
    if (collapsed[wsId]) {
      setCollapsed((c) => ({ ...c, [wsId]: false }));
    }
  }, [activeId, sessions]);

  const [menuWs, setMenuWs] = useState<string | null>(null);
  // 点击菜单外部自动关闭
  useEffect(() => {
    if (!menuWs) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".ws-menu-pop") && !target.closest(".sidebar-ws-menu")) {
        setMenuWs(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuWs]);
  const [editingWs, setEditingWs] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmWs, setConfirmWs] = useState<string | null>(null);
  // 项目区整体折叠态（顶栏「项目」行可点击收起/展开），默认折叠
  const [projectCollapsed, setProjectCollapsed] = useState(true);

  // 按 workspace_id 分组（NULL → 默认项目）；保证每个项目都出现（含空项目）。
  const groups = useMemo(() => {
    const m = new Map<string, Session[]>();
    for (const s of sessions) {
      // 群会话专属 GroupList，不入侧栏普通会话清单（避免「任务」区混入群消息）。
      // 判定覆盖三种来源：① mode="group"（单聊升级为群）；② mode="worker"（群 Worker 运行时）；
      // ③ 关联 group_id；④ 圆桌固定 Worker 会话 rt:{group}:{worker}（历史路径未打 mode，靠前缀兜底）。
      const isGroupSession =
        s.mode === "group" ||
        s.mode === "worker" ||
        !!s.group_id ||
        s.id.startsWith("rt:");
      if (isGroupSession) continue;
      const key = s.workspace_id ?? DEFAULT_WORKSPACE_ID;
      const arr = m.get(key);
      if (arr) arr.push(s);
      else m.set(key, [s]);
    }
    return workspaces.map((ws) => ({ ws, items: m.get(ws.id) ?? [] }));
  }, [workspaces, sessions]);

  const defaultGroup = groups.find((g) => g.ws.id === DEFAULT_WORKSPACE_ID);
  const namedGroups = groups.filter((g) => g.ws.id !== DEFAULT_WORKSPACE_ID);
  const defaultCount = defaultGroup?.items.length ?? 0;
  // 默认项目（任务）区折叠态：复用 collapsed 映射，键为默认工作区 id
  const defaultCollapsed = !!collapsed[DEFAULT_WORKSPACE_ID];
  const toggleDefault = () =>
    setCollapsed((c) => ({ ...c, [DEFAULT_WORKSPACE_ID]: !c[DEFAULT_WORKSPACE_ID] }));

  const commitRename = (wsId: string) => {
    const n = editName.trim();
    if (n) onRenameWorkspace(wsId, n);
    setEditingWs(null);
    setEditName("");
  };

  return (
    <div className="sidebar-ws-tree">
      {/* 任务（默认项目）：与「项目」平级，整行可折叠 */}
      <div
        className={`sidebar-ws-section-header sidebar-ws-section-header--inline${defaultCollapsed ? "" : " expanded"}`}
        role="button"
        tabIndex={0}
        aria-expanded={!defaultCollapsed}
        onClick={toggleDefault}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleDefault();
          }
        }}
      >
        <span className="sidebar-section-title">{t("sidebar.section.tasks", { count: defaultCount })}</span>
        <ChevronIcon open={!defaultCollapsed} />
      </div>
      {!defaultCollapsed && (
        <div className="sidebar-ws-items">
          {defaultCount === 0 ? (
            <div className="sidebar-ws-empty">{t("workspace.emptySessions")}</div>
          ) : (
            <SessionList
              sessions={defaultGroup?.items ?? []}
              activeId={activeId}
              onSelect={onSelect}
              onDelete={onDelete}
            />
          )}
        </div>
      )}

      {/* 项目（命名项目目录）：整行可折叠，显示项目数量；无项目时默认 (0) */}
      <div
        className={`sidebar-ws-section-header sidebar-ws-section-header--inline${projectCollapsed ? "" : " expanded"}`}
        role="button"
        tabIndex={0}
        aria-expanded={!projectCollapsed}
        onClick={() => setProjectCollapsed((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setProjectCollapsed((v) => !v);
          }
        }}
      >
        <span className="sidebar-section-title">{t("sidebar.section.workspaces", { count: namedGroups.length })}</span>
        <ChevronIcon open={!projectCollapsed} />
      </div>

      {!projectCollapsed && (
        <>
          {namedGroups.map(({ ws, items }) => {
            const isCollapsed = collapsed[ws.id];
            const isActiveWs = ws.id === activeWorkspaceId;
            return (
              <div
                key={ws.id}
                className={`sidebar-ws-group${isActiveWs ? " active-ws" : ""}`}
              >
                <div className="sidebar-ws-head">
                  <button
                    className="sidebar-ws-toggle"
                    onClick={() => setCollapsed((c) => ({ ...c, [ws.id]: !c[ws.id] }))}
                    aria-label={isCollapsed ? t("workspace.expand") : t("workspace.collapse")}
                    aria-expanded={!isCollapsed}
                  >
                    <ChevronIcon open={!isCollapsed} />
                  </button>

                  {editingWs === ws.id ? (
                    <input
                      className="sidebar-ws-edit"
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onBlur={() => commitRename(ws.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(ws.id);
                        else if (e.key === "Escape") {
                          setEditingWs(null);
                          setEditName("");
                        }
                      }}
                    />
                  ) : (
                    <button
                      className="sidebar-ws-name"
                      onDoubleClick={() => {
                        setEditingWs(ws.id);
                        setEditName(ws.name);
                      }}
                      onClick={() => setCollapsed((c) => ({ ...c, [ws.id]: !c[ws.id] }))}
                      title={ws.name}
                    >
                      <FolderIcon />
                      <span className="sidebar-ws-name-text">{ws.name}</span>
                    </button>
                  )}

                  <div className="sidebar-ws-actions">
                    <button
                      className="sidebar-ws-add"
                      title={t("workspace.newSessionIn").replace("{name}", ws.name)}
                      aria-label={t("workspace.newSessionIn").replace("{name}", ws.name)}
                      onClick={() => onCreateInWorkspace(ws.id)}
                    >
                      <PlusIcon />
                    </button>
                    <button
                      className="sidebar-ws-menu"
                      title={t("workspace.menu")}
                      aria-label={t("workspace.menu")}
                      onClick={() => {
                        setMenuWs((m) => (m === ws.id ? null : ws.id));
                        setConfirmWs(null);
                      }}
                    >
                      <DotsIcon />
                    </button>
                  </div>

                  {menuWs === ws.id && (
                    <div className="ws-menu-pop" role="menu">
                      <button
                        role="menuitem"
                        className="danger"
                        onClick={() => {
                          setMenuWs(null);
                          setConfirmWs(ws.id);
                        }}
                      >
                        {t("workspace.delete")}
                      </button>
                    </div>
                  )}

                  {confirmWs === ws.id && (
                    <div className="ws-menu-pop" role="menu">
                      <p className="ws-confirm-text">{t("workspace.deleteConfirm")}</p>
                      <button
                        role="menuitem"
                        onClick={() => {
                          onDeleteWorkspace(ws.id, true);
                          setConfirmWs(null);
                        }}
                      >
                        {t("workspace.moveToDefault")}
                      </button>
                      <button
                        role="menuitem"
                        className="danger"
                        onClick={() => {
                          onDeleteWorkspace(ws.id, false);
                          setConfirmWs(null);
                        }}
                      >
                        {t("workspace.cascade")}
                      </button>
                      <button role="menuitem" onClick={() => setConfirmWs(null)}>
                        {t("workspace.cancel")}
                      </button>
                    </div>
                  )}
                </div>

                {!isCollapsed && (
                  <div className="sidebar-ws-items">
                    {items.length === 0 ? (
                      <div className="sidebar-ws-empty">{t("workspace.emptySessions")}</div>
                    ) : (
                      <SessionList
                        sessions={items}
                        activeId={activeId}
                        onSelect={onSelect}
                        onDelete={onDelete}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

/* ── Icons (18px grid, currentColor) ── */
function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function KanbanIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="5" height="16" rx="1" />
      <rect x="10" y="4" width="5" height="10" rx="1" />
      <rect x="17" y="4" width="4" height="13" rx="1" />
    </svg>
  );
}
function CalendarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18M8 2v4M16 2v4" />
      <path d="M8 14h2M14 14h2M8 18h2M14 18h2" />
    </svg>
  );
}
function InspireIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18h6M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
    </svg>
  );
}
function ToolsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8 6.2 21l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.4 2.4-2.5-.6-.6-2.5 2.5-2.3z" />
    </svg>
  );
}


function InboxIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}
function GroupIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2m-9.66-9.66 1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2m-4.93-4.93-1.41 1.41M6.34 17.66l-1.41 1.41" />
    </svg>
  );
}
