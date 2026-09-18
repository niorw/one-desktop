import type { NavKey } from "./Sidebar";
import { useI18n } from "../../i18n/I18nProvider";

interface TopBarProps {
  activeNav: NavKey;
  // V6: sidebar toggle 在侧边栏收起时需要能在 TopBar 展开
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /** 设计审计 P0：打开 ⌘K 命令面板 */
  onOpenCommandPalette: () => void;
  /** 打开/关闭实时事件流抽屉 */
  onToggleEventDrawer: () => void;
  eventDrawerOpen: boolean;
  /** 打开/关闭后台任务抽屉 */
  onToggleTaskDrawer: () => void;
  taskDrawerOpen: boolean;
  /** 后台任务进行中数量（badge） */
  taskCount: number;
}

/** TopBar：顶部导航 + 侧边栏展开按钮（侧边栏收起时可用）+ ⌘K 命令入口 */
export function TopBar({
  activeNav,
  sidebarCollapsed,
  onToggleSidebar,
  onOpenCommandPalette,
  onToggleEventDrawer,
  eventDrawerOpen,
  onToggleTaskDrawer,
  taskDrawerOpen,
  taskCount,
}: TopBarProps) {
  const { t } = useI18n();
  return (
    <header className={`topbar${sidebarCollapsed ? " collapsed" : ""}`}>
      <div className="topbar-left">
        {/* V6: 侧边栏展开按钮始终显示 */}
        <button
          className="topbar-back"
          onClick={onToggleSidebar}
          aria-label={sidebarCollapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")}
          title={sidebarCollapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")}
        >
          <PanelIcon collapsed={sidebarCollapsed} />
        </button>
      </div>

      {/* 设计审计 P0：居中 ⌘K 命令面板入口（胶囊） */}
      <div className="topbar-center">
        <button
          className="cmd-trigger"
          onClick={onOpenCommandPalette}
          aria-label={t("command.title")}
          aria-keyshortcuts="Meta+K"
          title={t("command.title")}
        >
          <SearchIcon />
          <span className="cmd-trigger-label">{t("command.placeholder")}</span>
          <kbd className="cmd-kbd">⌘K</kbd>
        </button>
      </div>

      {/* Flexible drag region so the window can still be moved by the top bar */}
      <div className="topbar-drag" data-tauri-drag-region />

      {/* 右侧操作区：实时事件流抽屉入口 */}
      <div className="topbar-right">
        <button
          className={`topbar-action${eventDrawerOpen ? " active" : ""}`}
          onClick={onToggleEventDrawer}
          aria-label="事件流"
          aria-pressed={eventDrawerOpen}
          title="事件流 · 实时"
        >
          <ActivityIcon />
        </button>
        <button
          className={`topbar-action${taskDrawerOpen ? " active" : ""}`}
          onClick={onToggleTaskDrawer}
          aria-label="后台任务"
          aria-pressed={taskDrawerOpen}
          title="后台任务"
        >
          <BoltIcon />
          {taskCount > 0 && (
            <span className="topbar-badge">{taskCount > 99 ? "99+" : taskCount}</span>
          )}
        </button>
      </div>
    </header>
  );
}

/* ── Icons (16px grid, currentColor) ── */
function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function PanelIcon({ collapsed }: { collapsed?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      {/* collapsed=true 时显示右箭头（展开），否则显示左箭头（收起） */}
      {collapsed ? <path d="M14 10l2 2-2 2" /> : <path d="M16 10l-2 2 2 2" />}
    </svg>
  );
}

function ActivityIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
    </svg>
  );
}
