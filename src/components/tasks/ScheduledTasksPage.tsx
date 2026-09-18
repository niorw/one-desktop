import { useMemo, useState } from "react";
import { useScheduledTasks, type ScheduledTask, type TaskSource, type TaskStatus, type TaskType } from "../../hooks/useScheduledTasks";
import { useI18n } from "../../i18n/I18nProvider";
import type { DictKey } from "../../i18n/dict";
import "./tasks.css";
import { useDialogA11y } from "../common/useDialogA11y";
import { Icons } from "../common/Icons";
import { CreateTaskModal } from "./CreateTaskModal";

const SOURCE_KEY: Record<TaskSource, DictKey> = {
  agent_dialog: "tasks.source.agent",
  skill_callback: "tasks.source.skill",
  mcp_event: "tasks.source.mcp",
  system_init: "tasks.source.system",
};
const STATUS_KEY: Record<TaskStatus, DictKey> = {
  active: "tasks.status.active",
  paused: "tasks.status.paused",
  completed: "tasks.status.completed",
  failed: "tasks.status.failed",
  expired: "tasks.status.expired",
};
const TYPE_KEY: Record<TaskType, DictKey> = {
  cron: "tasks.type.cron",
  once: "tasks.type.once",
  interval: "tasks.type.interval",
};

function formatDate(iso: string | undefined, locale: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function ScheduledTasksPage() {
  const { t, locale } = useI18n();
  const { tasks, togglePause, remove, removeMany, create, update } = useScheduledTasks();

  const [query, setQuery] = useState("");
  const [srcFilter, setSrcFilter] = useState<"all" | TaskSource>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | TaskStatus>("all");
  const [typeFilter, setTypeFilter] = useState<"all" | TaskType>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [detail, setDetail] = useState<ScheduledTask | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((tk) => {
      if (srcFilter !== "all" && tk.source !== srcFilter) return false;
      if (statusFilter !== "all" && tk.status !== statusFilter) return false;
      if (typeFilter !== "all" && tk.type !== typeFilter) return false;
      if (q && !`${tk.title} ${tk.description ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tasks, query, srcFilter, statusFilter, typeFilter]);

  const counts = useMemo(() => {
    return tasks.reduce(
      (acc, tk) => {
        acc.total++;
        if (tk.status === "active") acc.active++;
        else if (tk.status === "paused") acc.paused++;
        else if (tk.status === "failed") acc.failed++;
        else if (tk.status === "completed") acc.done++;
        return acc;
      },
      { total: 0, active: 0, paused: 0, failed: 0, done: 0 }
    );
  }, [tasks]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const allSelected = filtered.length > 0 && filtered.every((tk) => selected.has(tk.id));
  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(filtered.map((tk) => tk.id)));
  };

  return (
    <div className="tasks-page">
      <header className="page-header">
        <h1>{t("tasks.title")}</h1>
        <p className="page-subtitle">{t("tasks.empty.desc")}</p>
      </header>

      <div className="tasks-toolbar">
        <input
          className="tasks-search"
          placeholder={t("tasks.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="tasks-select" value={srcFilter} onChange={(e) => setSrcFilter(e.target.value as typeof srcFilter)}>
          <option value="all">{t("tasks.filterSource")}</option>
          <option value="agent_dialog">{t("tasks.source.agent")}</option>
          <option value="skill_callback">{t("tasks.source.skill")}</option>
          <option value="mcp_event">{t("tasks.source.mcp")}</option>
          <option value="system_init">{t("tasks.source.system")}</option>
        </select>
        <select className="tasks-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
          <option value="all">{t("tasks.filterStatus")}</option>
          <option value="active">{t("tasks.status.active")}</option>
          <option value="paused">{t("tasks.status.paused")}</option>
          <option value="failed">{t("tasks.status.failed")}</option>
          <option value="completed">{t("tasks.status.completed")}</option>
          <option value="expired">{t("tasks.status.expired")}</option>
        </select>
        <select className="tasks-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}>
          <option value="all">{t("tasks.filterType")}</option>
          <option value="cron">{t("tasks.type.cron")}</option>
          <option value="once">{t("tasks.type.once")}</option>
          <option value="interval">{t("tasks.type.interval")}</option>
        </select>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          + {t("tasks.new")}
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="tasks-empty">
          <div className="tasks-empty-icon"><Icons.Clock size={40} /></div>
          <h2>{t("tasks.empty.title")}</h2>
          <p>{t("tasks.empty.desc")}</p>
        </div>
      ) : (
        <div className="tasks-list">
          <label className="tasks-selectall">
            <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
            <span>{t("common.all")}</span>
          </label>
          {filtered.map((tk) => (
            <TaskCard
              key={tk.id}
              task={tk}
              selected={selected.has(tk.id)}
              onToggleSelect={() => toggleSelect(tk.id)}
              onTogglePause={() => togglePause(tk.id)}
              onDelete={() => remove(tk.id)}
              onEdit={() => setEditing(tk)}
              onViewDetail={() => setDetail(tk)}
              t={t}
              locale={locale}
            />
          ))}
        </div>
      )}

      {selected.size > 0 && (
        <div className="tasks-batchbar">
          <span>{selected.size} selected</span>
          <button className="btn btn-danger" onClick={() => { removeMany([...selected]); setSelected(new Set()); }}>
            {t("tasks.batchDelete")}
          </button>
        </div>
      )}

      <footer className="tasks-count">
        {t("tasks.count", {
          total: counts.total,
          active: counts.active,
          paused: counts.paused,
          failed: counts.failed,
          done: counts.done,
        })}
      </footer>

      {creating && (
        <CreateTaskModal
          onCancel={() => setCreating(false)}
          onCreate={async (input) => {
            await create(input);
            setCreating(false);
          }}
          t={t}
        />
      )}

      {editing && (
        <CreateTaskModal
          editing={editing}
          onCancel={() => setEditing(null)}
          onCreate={async (input) => {
            await create(input);
            setEditing(null);
          }}
          onUpdate={async (input) => {
            await update(input);
            setEditing(null);
          }}
          t={t}
        />
      )}

      {detail && (
        <TaskDetailDrawer
          task={detail}
          onClose={() => setDetail(null)}
          onEdit={() => {
            setEditing(detail);
            setDetail(null);
          }}
          t={t}
          locale={locale}
        />
      )}
    </div>
  );
}

function TaskCard({
  task,
  selected,
  onToggleSelect,
  onTogglePause,
  onDelete,
  onEdit,
  onViewDetail,
  t,
  locale,
}: {
  task: ScheduledTask;
  selected: boolean;
  onToggleSelect: () => void;
  onTogglePause: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onViewDetail: () => void;
  t: (k: DictKey, v?: Record<string, string | number>) => string;
  locale: string;
}) {
  const isPaused = task.status === "paused";
  return (
    <div
      className={`task-card ${selected ? "selected" : ""}`}
      onClick={onViewDetail}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onViewDetail(); }}
    >
      <div className="task-card-head">
        <input
          type="checkbox"
          className="task-check"
          checked={selected}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggleSelect}
        />
        <span className="task-title">{task.title}</span>
        <div className="task-actions">
          <button
            className="btn btn-ghost btn-icon"
            title={t("tasks.detail")}
            onClick={(e) => { e.stopPropagation(); onViewDetail(); }}
          >
            <Icons.Eye size={15} />
          </button>
          <button
            className="btn btn-ghost btn-icon"
            title={t("tasks.edit")}
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
          >
            <Icons.Edit size={15} />
          </button>
          {task.status !== "completed" && task.status !== "expired" && (
            <button
              className="btn btn-ghost btn-icon"
              title={isPaused ? t("tasks.resume") : t("tasks.pause")}
              onClick={(e) => { e.stopPropagation(); onTogglePause(); }}
            >
              {isPaused ? <Icons.Play size={15} /> : <Icons.Pause size={15} />}
            </button>
          )}
          <button
            className="btn btn-ghost btn-icon btn-danger-text"
            title={t("tasks.delete")}
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
          >
            <Icons.Trash2 size={15} />
          </button>
        </div>
      </div>
      {task.description && <p className="task-desc">{task.description}</p>}
      <div className="task-meta">
        <span className="task-tag">{t(SOURCE_KEY[task.source])}</span>
        <span className="task-tag">· {t(TYPE_KEY[task.type])}</span>
        <span className="task-next">{t("tasks.nextRun")}: {formatDate(task.nextRunAt, locale)}</span>
      </div>
    </div>
  );
}

function TaskDetailDrawer({
  task,
  onClose,
  onEdit,
  t,
  locale,
}: {
  task: ScheduledTask;
  onClose: () => void;
  onEdit: () => void;
  t: (k: DictKey, v?: Record<string, string | number>) => string;
  locale: string;
}) {
  const modalRef = useDialogA11y<HTMLDivElement>(true, onClose);
  const rows: { label: string; value: string }[] = [
    { label: t("tasks.field.id"), value: task.id },
    { label: t("tasks.field.title"), value: task.title },
    { label: t("tasks.field.desc"), value: task.description || "—" },
    { label: t("tasks.field.type"), value: t(TYPE_KEY[task.type]) },
    { label: t("tasks.field.source"), value: t(SOURCE_KEY[task.source]) },
    { label: t("tasks.field.status"), value: t(STATUS_KEY[task.status]) },
    {
      label: t("tasks.field.schedule"),
      value:
        task.type === "cron"
          ? task.schedule.cron ?? "—"
          : task.type === "once"
          ? task.schedule.once ?? "—"
          : task.schedule.interval ?? "—",
    },
    { label: t("tasks.field.action"), value: t(`tasks.action.${task.actionType}` as DictKey) },
    { label: t("tasks.field.actionPayload"), value: task.actionPayload },
    { label: t("tasks.field.nextRun"), value: formatDate(task.nextRunAt, locale) },
    { label: t("tasks.field.lastRun"), value: formatDate(task.lastRunAt, locale) },
    { label: t("tasks.field.runCount"), value: String(task.runCount ?? 0) },
    { label: t("tasks.field.createdAt"), value: formatDate(task.createdAt, locale) },
    { label: t("tasks.field.updatedAt"), value: formatDate(task.updatedAt, locale) },
  ];
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal task-detail"
        role="dialog"
        aria-modal="true"
        aria-label={t("tasks.detailTitle")}
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="task-detail-head">
          <h2 className="modal-title">{t("tasks.detailTitle")}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} title={t("common.close")}>
            <Icons.Close size={16} />
          </button>
        </div>
        <dl className="task-detail-list">
          {rows.map((r) => (
            <div className="task-detail-row" key={r.label}>
              <dt>{r.label}</dt>
              <dd className={r.label === t("tasks.field.actionPayload") ? "mono" : ""}>{r.value}</dd>
            </div>
          ))}
        </dl>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>{t("common.close")}</button>
          <button className="btn btn-primary" onClick={onEdit}>{t("tasks.edit")}</button>
        </div>
      </div>
    </div>
  );
}
