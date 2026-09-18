import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { NavKey } from "./Sidebar";
import type { Session } from "../../types";
import { useI18n } from "../../i18n/I18nProvider";

interface Command {
  id: string;
  label: string;
  group: string;
  icon: React.ReactNode;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  sessions: Session[];
  onNavigate: (key: NavKey) => void;
  onCreateSession: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onSelectSession: (id: string) => void;
}

export function CommandPalette({
  open,
  onClose,
  sessions,
  onNavigate,
  onCreateSession,
  onToggleTheme,
  onOpenSettings,
  onSelectSession,
}: CommandPaletteProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 命令集：导航 / 操作 / 跳转会话，全部接真实回调（非死占位）
  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: "nav-chat", label: t("nav.chat"), group: t("command.group.navigate"), icon: <ChatIcon />, run: () => onNavigate("chat") },
      { id: "nav-tasks", label: t("nav.tasks"), group: t("command.group.navigate"), icon: <ClockIcon />, run: () => onNavigate("tasks") },
      { id: "nav-kanban", label: t("nav.kanban"), group: t("command.group.navigate"), icon: <KanbanIcon />, run: () => onNavigate("kanban") },
      { id: "nav-calendar", label: t("nav.calendar"), group: t("command.group.navigate"), icon: <CalendarIcon />, run: () => onNavigate("calendar") },
      { id: "nav-inspiration", label: t("nav.inspiration"), group: t("command.group.navigate"), icon: <InspireIcon />, run: () => onNavigate("inspiration") },
      { id: "nav-tools", label: t("nav.tools"), group: t("command.group.navigate"), icon: <ToolsIcon />, run: () => onNavigate("tools") },
    ];
    const actions: Command[] = [
      { id: "act-new", label: t("command.newSession"), group: t("command.group.action"), icon: <PlusIcon />, run: onCreateSession },
      { id: "act-theme", label: t("command.toggleTheme"), group: t("command.group.action"), icon: <ThemeIcon />, run: onToggleTheme },
      { id: "act-settings", label: t("nav.settings"), group: t("command.group.action"), icon: <SettingsIcon />, run: onOpenSettings },
    ];
    const jumps: Command[] = sessions.slice(0, 20).map((s) => ({
      id: `session-${s.id}`,
      label: s.title || t("nav.newSession"),
      group: t("command.group.jump"),
      icon: <ChatIcon />,
      run: () => onSelectSession(s.id),
    }));
    return [...nav, ...actions, ...jumps];
  }, [sessions, t, onNavigate, onCreateSession, onToggleTheme, onOpenSettings, onSelectSession]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)
    );
  }, [commands, query]);

  // 打开时重置并聚焦输入框
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // 选中项滚动进可视区
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const exec = (cmd: Command | undefined) => {
    if (!cmd) return;
    cmd.run();
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      exec(filtered[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="cmd-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="cmd-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("command.title")}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="cmd-input-row">
          <SearchIcon />
          <input
            ref={inputRef}
            className="cmd-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("command.placeholder")}
            aria-label={t("command.placeholder")}
            aria-controls="cmd-listbox"
          />
          <kbd className="cmd-kbd">Esc</kbd>
        </div>

        <div className="cmd-list" ref={listRef} id="cmd-listbox" role="listbox" aria-label={t("command.title")}>
          {filtered.length === 0 ? (
            <div className="cmd-empty">{t("command.empty")}</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                data-idx={i}
                role="option"
                aria-selected={i === active}
                className={`cmd-item${i === active ? " active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => exec(c)}
              >
                <span className="cmd-item-icon">{c.icon}</span>
                <span className="cmd-item-label">{c.label}</span>
                <span className="cmd-item-group">{c.group}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Icons (16px grid, currentColor, 1.5px stroke) ── */
function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}
function ChatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function KanbanIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="5" height="16" rx="1" />
      <rect x="10" y="4" width="5" height="10" rx="1" />
      <rect x="17" y="4" width="4" height="13" rx="1" />
    </svg>
  );
}
function CalendarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18M8 2v4M16 2v4" />
      <path d="M8 14h2M14 14h2M8 18h2M14 18h2" />
    </svg>
  );
}
function InspireIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18h6M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
    </svg>
  );
}
function ToolsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8 6.2 21l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.4 2.4-2.5-.6-.6-2.5 2.5-2.3z" />
    </svg>
  );
}
function ThemeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2m-9.66-9.66 1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2m-4.93-4.93-1.41 1.41M6.34 17.66l-1.41 1.41" />
    </svg>
  );
}
function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function InboxIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}
