import { useState } from "react";
import { useDialogA11y } from "../common/useDialogA11y";
import { Icons } from "../common/Icons";
import { friendlyError } from "../../services/errors";
import type {
  CreateTaskInput,
  ScheduledTask,
  TaskSource,
  TaskType,
  UpdateTaskInput,
} from "../../hooks/useScheduledTasks";
import type { DictKey } from "../../i18n/dict";

function buildPayload(actionType: "agent" | "shell" | "skill", payload: string): string {
  return actionType === "agent"
    ? JSON.stringify({ prompt: payload })
    : actionType === "shell"
    ? JSON.stringify({ command: payload })
    : JSON.stringify({ skill_id: payload });
}

/**
 * Shared scheduled-task creation modal.
 * `defaultOnce` (datetime-local format `YYYY-MM-DDTHH:mm`) pre-selects the
 * "once" schedule type and fills the field — used by the calendar page as a
 * lightweight shortcut that opens with the selected date pre-filled.
 *
 * `editing` switches the modal into edit mode: fields are pre-filled from the
 * task and the primary action calls `onUpdate` instead of `onCreate`.
 */
export function CreateTaskModal({
  onCancel,
  onCreate,
  onUpdate,
  t,
  defaultOnce,
  editing,
}: {
  onCancel: () => void;
  onCreate: (input: CreateTaskInput) => void | Promise<void>;
  onUpdate?: (input: UpdateTaskInput) => void | Promise<void>;
  t: (k: DictKey, v?: Record<string, string | number>) => string;
  defaultOnce?: string;
  editing?: ScheduledTask;
}) {
  const [title, setTitle] = useState(editing?.title ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [type, setType] = useState<TaskType>(editing?.type ?? (defaultOnce ? "once" : "cron"));
  const [cronExpr, setCronExpr] = useState(
    editing?.schedule.cron ?? "0 2 * * *"
  );
  const [onceExpr, setOnceExpr] = useState(
    editing?.schedule.once ?? defaultOnce ?? ""
  );
  const [intervalExpr, setIntervalExpr] = useState(editing?.schedule.interval ?? "30m");
  const [source, setSource] = useState<TaskSource>(editing?.source ?? "agent_dialog");
  const [actionType, setActionType] = useState<"agent" | "shell" | "skill">(
    editing?.actionType ?? "agent"
  );
  const [payload, setPayload] = useState(editing?.actionPayload ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const modalRef = useDialogA11y<HTMLDivElement>(true, onCancel);

  const isEditing = Boolean(editing);

  const scheduleExpr =
    type === "cron" ? cronExpr : type === "once" ? onceExpr : intervalExpr;

  const canSubmit =
    title.trim().length > 0 &&
    scheduleExpr.trim().length > 0 &&
    payload.trim().length > 0;

  const submit = async () => {
    if (!canSubmit || (isEditing && !onUpdate) || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const actionPayload = buildPayload(actionType, payload);
      const base = {
        title: title.trim(),
        description: description.trim() || undefined,
        type,
        schedule:
          type === "cron"
            ? { cron: cronExpr.trim() }
            : type === "once"
            ? { once: onceExpr.trim() }
            : { interval: intervalExpr.trim() },
        source,
        actionType,
        actionPayload,
      };
      if (isEditing && onUpdate) {
        await onUpdate({ ...base, id: editing!.id });
      } else {
        await onCreate(base);
      }
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal modal-wide"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("tasks.createTitle")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">{isEditing ? t("tasks.editTitle") : t("tasks.createTitle")}</h2>

        <div className="modal-field">
          <label>{t("tasks.field.title")}</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="每日数据备份" />
        </div>

        <div className="modal-field">
          <label>{t("tasks.field.desc")}</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div className="modal-grid">
          <div className="modal-field">
            <label>{t("tasks.field.type")}</label>
            <select value={type} onChange={(e) => setType(e.target.value as TaskType)}>
              <option value="cron">{t("tasks.type.cron")}</option>
              <option value="once">{t("tasks.type.once")}</option>
              <option value="interval">{t("tasks.type.interval")}</option>
            </select>
          </div>
          <div className="modal-field">
            <label>{t("tasks.field.source")}</label>
            <select value={source} onChange={(e) => setSource(e.target.value as TaskSource)}>
              <option value="agent_dialog">{t("tasks.source.agent")}</option>
              <option value="skill_callback">{t("tasks.source.skill")}</option>
              <option value="mcp_event">{t("tasks.source.mcp")}</option>
              <option value="system_init">{t("tasks.source.system")}</option>
            </select>
          </div>
        </div>

        <div className="modal-field">
          <label>{t("tasks.field.schedule")}</label>
          {type === "cron" && (
            <input value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} placeholder={t("tasks.hint.cron")} />
          )}
          {type === "once" && (
            <input type="datetime-local" value={onceExpr} onChange={(e) => setOnceExpr(e.target.value)} />
          )}
          {type === "interval" && (
            <input value={intervalExpr} onChange={(e) => setIntervalExpr(e.target.value)} placeholder={t("tasks.hint.interval")} />
          )}
        </div>

        <div className="modal-field">
          <label>{t("tasks.field.action")}</label>
          <select value={actionType} onChange={(e) => setActionType(e.target.value as typeof actionType)}>
            <option value="agent">{t("tasks.action.agent")}</option>
            <option value="shell">{t("tasks.action.shell")}</option>
            <option value="skill">{t("tasks.action.skill")}</option>
          </select>
        </div>

        <div className="modal-field">
          <label>{t("tasks.field.payload")}</label>
          <textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            placeholder={
              actionType === "agent"
                ? "总结今天的对话要点"
                : actionType === "shell"
                ? "echo hello"
                : "doc-summarizer"
            }
          />
        </div>

        {error && (
          <div className="modal-error" role="alert">
            <Icons.AlertTriangle size={14} />
            <span>{error}</span>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onCancel} disabled={submitting}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" disabled={!canSubmit || submitting} onClick={submit}>
            {submitting ? t("common.saving") : t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
