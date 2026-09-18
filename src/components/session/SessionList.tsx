import type { Session } from "../../types";
import { SessionItem } from "./SessionItem";

interface SessionListProps {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export function SessionList({ sessions, activeId, onSelect, onDelete }: SessionListProps) {
  if (sessions.length === 0) {
    return (
      <div style={{ padding: "var(--space-2xl) var(--space-lg)", textAlign: "center", color: "var(--text-tertiary)", fontSize: "var(--text-base)" }}>
        No sessions yet
      </div>
    );
  }

  return (
    <div className="sidebar-sessions">
      {sessions.map((session) => (
        <SessionItem
          key={session.id}
          session={session}
          isActive={session.id === activeId}
          onSelect={() => onSelect(session.id)}
          onDelete={() => onDelete(session.id)}
        />
      ))}
    </div>
  );
}
