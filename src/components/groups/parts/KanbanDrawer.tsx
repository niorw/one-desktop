import { useCallback, useState } from "react";
import { useI18n } from "../../../i18n/I18nProvider";
import type { Task, TaskStatus } from "../../../types";
import { Icons } from "../../common/Icons";
import { useDialogA11y } from "../../common/useDialogA11y";

const STATUS_LABEL: Record<TaskStatus, string> = {
  Pending: "groups.kanban.colPending",
  InProgress: "groups.kanban.colInProgress",
  Completed: "groups.kanban.colCompleted",
  Failed: "groups.kanban.colFailed",
  Cancelled: "groups.kanban.colCancelled",
  // AwaitingApproval 已随看板待审批列移除（状态仍存在于任务状态机，兜底显示英文）。
  AwaitingApproval: "Awaiting approval",
};

export function KanbanDrawer({
  task,
  allTasks,
  onClose,
  onSetStatus,
  onEdit,
}: {
  task: Task;
  allTasks: Task[];
  onClose: () => void;
  onSetStatus: (status: TaskStatus) => void | Promise<void>;
  /** 编辑手动任务（标题/描述）；仅手动任务（无批次）可用。 */
  onEdit?: (p: { description?: string; reasoning?: string }) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const drawerRef = useDialogA11y<HTMLElement>(true, onClose);

  const workerName = task.assigned_worker ?? task.worker_id ?? "—";

  const depTasks = (task.depends_on ?? []).map((id) => allTasks.find((x) => x.id === id));

  // 手动添加的日常任务（无批次、不进圆桌）：恢复类动作无意义，隐藏并给说明。
  const isManual = !task.batch_id;

  // 编辑态：仅手动任务可进入（批次任务拆解依据由群主在圆桌侧管理，不在看板编辑）。
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(task.description);
  const [editDesc, setEditDesc] = useState(task.reasoning ?? "");
  const [saving, setSaving] = useState(false);

  const startEdit = useCallback(() => {
    setEditTitle(task.description);
    setEditDesc(task.reasoning ?? "");
    setEditing(true);
  }, [task.description, task.reasoning]);

  const saveEdit = useCallback(async () => {
    if (!onEdit) return;
    const title = editTitle.trim();
    if (!title) return;
    setSaving(true);
    try {
      await onEdit({ description: title, reasoning: editDesc.trim() || undefined });
      setEditing(false);
    } catch {
      /* toast 由看板层统一弹 */
    } finally {
      setSaving(false);
    }
  }, [onEdit, editTitle, editDesc]);

  return (
    <div className="kanban-drawer-overlay" onClick={onClose} role="presentation">
      <aside
        className="kanban-drawer"
        role="dialog"
        aria-label={t("groups.kanban.detail")}
        ref={drawerRef}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="kanban-drawer-head">
          <div className={`kanban-status-badge status-${task.status}`}>
            {t(STATUS_LABEL[task.status] as any)}
          </div>
          <div className="kanban-drawer-head-actions">
            {isManual && onEdit && !editing && (
              <button className="btn btn-ghost btn-icon" onClick={startEdit} aria-label={t("groups.kanban.edit") ?? "Edit"}>
                <Icons.Pencil size={14} />
              </button>
            )}
            {isManual && editing && (
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)} disabled={saving}>
                {t("groups.kanban.editCancel") ?? "取消"}
              </button>
            )}
            {isManual && editing && (
              <button className="btn btn-primary btn-sm" onClick={() => void saveEdit()} disabled={saving || !editTitle.trim()}>
                {saving ? (t("groups.kanban.editSaving") ?? "保存中…") : (t("groups.kanban.editSave") ?? "保存")}
              </button>
            )}
            <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label={t("settings.close")}>
              <Icons.Cross size={14} />
            </button>
          </div>
        </header>

        <div className="kanban-drawer-body">
          {editing ? (
            <>
              <label className="kanban-edit-field">
                <span>{t("groups.kanban.editTitle") ?? "标题"}</span>
                <input
                  className="kanban-edit-input"
                  value={editTitle}
                  autoFocus
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !saving) void saveEdit();
                    if (e.key === "Escape") setEditing(false);
                  }}
                />
              </label>
              <label className="kanban-edit-field">
                <span>{t("groups.kanban.editDesc") ?? "备注 / 拆解依据"}</span>
                <textarea
                  className="kanban-edit-textarea"
                  value={editDesc}
                  rows={4}
                  placeholder={t("groups.kanban.editDescPlaceholder") ?? "可选：补充约束、验收标准或上下文"}
                  onChange={(e) => setEditDesc(e.target.value)}
                />
              </label>
            </>
          ) : (
            <h3 className="kanban-drawer-title">{task.description}</h3>
          )}

          <div className="kanban-drawer-meta">
            <div>
              <span className="kanban-meta-k">{t("groups.kanban.batch")}</span>
              <span className="kanban-meta-v">{task.batch_id ?? "—"}</span>
            </div>
            <div>
              <span className="kanban-meta-k">{t("groups.kanban.worker")}</span>
              <span className="kanban-meta-v">{workerName}</span>
            </div>
            {task.capability && (
              <div>
                <span className="kanban-meta-k">{t("groups.kanban.capability")}</span>
                <span className="kanban-meta-v">{task.capability}</span>
              </div>
            )}
            <div>
              <span className="kanban-meta-k">{t("groups.kanban.retryCount")}</span>
              <span className="kanban-meta-v">{task.retry_count ?? 0}</span>
            </div>
          </div>

          {task.reasoning && !editing && (
            <section className="kanban-drawer-section">
              <h4>{t("groups.kanban.reasoning")}</h4>
              <p className="kanban-drawer-text">{task.reasoning}</p>
            </section>
          )}

          {(task.depends_on?.length ?? 0) > 0 && (
            <section className="kanban-drawer-section">
              <h4>
                {t("groups.kanban.dependsOn")} ({task.depends_on.length})
              </h4>
              <ul className="kanban-dep-list">
                {depTasks.map((dt, i) => (
                  <li key={task.depends_on[i]} className={dt ? `status-${dt.status}` : ""}>
                    <span className="kanban-dep-dot" aria-hidden />
                    <span className="kanban-dep-id">{task.depends_on[i]}</span>
                    {dt && <span className="kanban-dep-desc">{dt.description}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(task.outputs?.length ?? 0) > 0 && (
            <section className="kanban-drawer-section">
              <h4>
                {t("groups.kanban.outputs")} ({task.outputs.length})
              </h4>
              <ul className="kanban-out-list">
                {task.outputs.map((o, i) => (
                  <li key={i} className="kanban-out-item">
                    <Icons.FileText size={13} /> <span className="kanban-out-path">{o}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <footer className="kanban-drawer-actions kanban-drawer-manual">
          <span className="kanban-drawer-note">
            {t("groups.kanban.manualNote") ?? "手动添加的日常任务：拖拽列即可改状态，无批次/智能体恢复动作。"}
          </span>
        </footer>
      </aside>
    </div>
  );
}
