import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import * as tauri from "../../services/tauri";
import type { Task, TaskStatus } from "../../types";
import { KanbanBoard } from "../groups/parts/KanbanBoard";
import { friendlyError } from "../../services/errors";

/**
 * 全局看板：侧边栏入口，承载「个人任务」。
 *
 * 看板与群协作彻底解耦：后端 `task_list_all` 仅返回 `batch_id IS NULL` 的个人任务，
 * 群 DAG 批次任务（恒带 `batch_id`）不会进入看板，前端不再做任何 group 级过滤/判断。
 */
export function KanbanPage() {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 「新建任务」弹窗状态
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  // 列头「+」快捷新建携带的目标状态（null=默认 Pending，即顶部「新建任务」按钮路径）
  const [initialStatus, setInitialStatus] = useState<TaskStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      // 后端 `task_list_all` 已只返回个人任务（batch_id IS NULL），前端直接渲染，
      // 不再做 group 级过滤/判断。
      const ts = await tauri.taskListAll();
      setTasks(ts);
      setError(null);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 列头「+」：打开弹窗并记住目标列状态，落库时带上。
  const handleCreateFor = useCallback((status: TaskStatus) => {
    setInitialStatus(status);
    setShowCreate(true);
  }, []);

  const handleCreate = useCallback(async () => {
    const description = newTitle.trim();
    if (!description) return;
    setCreating(true);
    try {
      const created = await tauri.taskCreate({
        description,
        status: initialStatus ?? undefined,
      });
      setTasks((prev) => [created, ...prev]);
      setNewTitle("");
      setInitialStatus(null);
      setShowCreate(false);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setCreating(false);
    }
  }, [newTitle, initialStatus, t]);

  const handleSetStatus = useCallback(
    async (taskId: string, status: TaskStatus) => {
      try {
        await tauri.taskSetStatus(taskId, status);
        await refresh();
      } catch (e) {
        setError(friendlyError(e));
        throw e; // 让看板层弹 toast
      }
    },
    [refresh],
  );

  const handleEdit = useCallback(
    async (taskId: string, p: { description?: string; reasoning?: string }) => {
      try {
        await tauri.taskUpdate(taskId, p);
        await refresh();
      } catch (e) {
        setError(friendlyError(e));
        throw e;
      }
    },
    [refresh],
  );

  const handleReorder = useCallback(
    async (taskId: string, beforeId: string | null) => {
      try {
        await tauri.taskReorder(taskId, beforeId);
        await refresh();
      } catch (e) {
        setError(friendlyError(e));
      }
    },
    [refresh],
  );

  if (loading) {
    return <div className="kanban-page-loading">{t("groups.kanban.loading") ?? "加载中…"}</div>;
  }

  return (
    <div className="kanban-page">
      <header className="kanban-page-head">
        <h1>{t("nav.kanban")}</h1>
        <span className="kanban-page-sub">{t("groups.kanban.globalHint") ?? "个人任务看板"}</span>
      </header>
      {error && <div className="kanban-page-error" role="alert">{error}</div>}
      <KanbanBoard
        tasks={tasks}
        onSetStatus={handleSetStatus}
        onReorder={handleReorder}
        onCreateTask={handleCreateFor}
        onCreateFirst={() => { setInitialStatus(null); setShowCreate(true); }}
        onEdit={handleEdit}
      />
      {showCreate && (
        <div className="kanban-create-overlay" role="dialog" aria-modal="true" onClick={() => { setInitialStatus(null); setShowCreate(false); }}>
          <div className="kanban-create-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t("groups.kanban.newTask") ?? "新建任务"}</h3>
            {initialStatus && (
              <div className="kanban-create-hint">
                {t("groups.kanban.willAddTo", { col: initialStatus }) ?? `将添加到「${initialStatus}」列`}
              </div>
            )}
            <label className="kanban-create-field">
              <span>{t("groups.kanban.newTaskTitle") ?? "任务标题"}</span>
              <input
                autoFocus
                className="kanban-create-input"
                value={newTitle}
                placeholder={t("groups.kanban.newTaskPlaceholder") ?? "例如：周五前提交周报"}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !creating) void handleCreate();
                  if (e.key === "Escape") setShowCreate(false);
                }}
              />
            </label>
            <div className="kanban-create-actions">
              <button className="btn btn-ghost" onClick={() => { setInitialStatus(null); setShowCreate(false); }}>
                {t("groups.kanban.newTaskCancel") ?? "取消"}
              </button>
              <button className="btn btn-primary" onClick={() => void handleCreate()} disabled={!newTitle.trim() || creating}>
                {t("groups.kanban.newTaskAdd") ?? "添加"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
