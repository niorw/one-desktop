import { useCallback, useMemo, useState } from "react";
import { useI18n } from "../../../i18n/I18nProvider";
import type { Task, TaskStatus } from "../../../types";
import { Icons } from "../../common/Icons";
import { KanbanCard } from "./KanbanCard";
import { KanbanDrawer } from "./KanbanDrawer";
import { friendlyError } from "../../../services/errors";

const COLUMNS: { status: TaskStatus; key: string }[] = [
  { status: "Pending", key: "colPending" },
  { status: "InProgress", key: "colInProgress" },
  { status: "Completed", key: "colCompleted" },
  { status: "Failed", key: "colFailed" },
  { status: "Cancelled", key: "colCancelled" },
];

export function KanbanBoard({
  tasks,
  onSetStatus,
  onReorder,
  onCreateTask,
  onCreateFirst,
  onEdit,
}: {
  tasks: Task[];
  onSetStatus: (taskId: string, status: TaskStatus) => Promise<void> | void;
  /** 列内拖拽重排：将 taskId 移到 beforeId 之前（null=该列末尾）。 */
  onReorder?: (taskId: string, beforeId: string | null) => void | Promise<void>;
  /** 列头「+」快捷新建：携带该列的目标状态。 */
  onCreateTask?: (status: TaskStatus) => void;
  /** 看板为空时的「新建任务」入口（列头 + 在空状态下不可见，需此兜底）。 */
  onCreateFirst?: () => void;
  /** 编辑手动任务（标题 / 描述）。个人任务（无批次）可编辑。 */
  onEdit?: (taskId: string, p: { description?: string; reasoning?: string }) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Task | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  const [dragOverCardId, setDragOverCardId] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<"before" | "after" | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const filtered = useMemo(
    () =>
      tasks.filter(
        (tk) =>
          search.trim() === "" ||
          tk.description.toLowerCase().includes(search.trim().toLowerCase())
      ),
    [tasks, search]
  );

  const byStatus = useMemo(() => {
    const m: Record<string, Task[]> = {};
    for (const c of COLUMNS) m[c.status] = [];
    for (const tk of filtered) (m[tk.status] ??= []).push(tk);
    for (const c of COLUMNS) {
      m[c.status].sort(
        (a, b) => (a.order_idx ?? 0) - (b.order_idx ?? 0) || (a.id < b.id ? -1 : 1),
      );
    }
    return m;
  }, [filtered]);

  // 看板是简单任务记录：任意列之间都可自由拖拽，仅禁止落到原列。
  const canMove = (from: TaskStatus, to: TaskStatus) => from !== to;

  const flashToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 2600);
  };

  const doMove = useCallback(
    async (id: string, to: TaskStatus) => {
      const tk = tasks.find((x) => x.id === id);
      if (!tk || !canMove(tk.status, to)) {
        if (tk) flashToast(t("groups.kanban.invalidMove", { from: tk.status, to }));
        return;
      }
      try {
        await onSetStatus(id, to);
      } catch (e) {
        flashToast(friendlyError(e));
      }
    },
    [tasks, onSetStatus, t]
  );

  const moveKey = (task: Task, dir: "left" | "right") => {
    const idx = COLUMNS.findIndex((c) => c.status === task.status);
    const next = dir === "right" ? idx + 1 : idx - 1;
    if (next < 0 || next >= COLUMNS.length) return;
    const to = COLUMNS[next].status;
    if (canMove(task.status, to)) void doMove(task.id, to);
  };

  // 列内上下移动（键盘）：上移插到上方卡片之前，下移插到下方卡片之后。
  const moveVertical = (task: Task, dir: "up" | "down") => {
    const col = byStatus[task.status] ?? [];
    const idx = col.findIndex((x) => x.id === task.id);
    if (idx < 0) return;
    if (dir === "up") {
      if (idx <= 0) return;
      onReorder?.(task.id, col[idx - 1].id);
    } else {
      if (idx >= col.length - 1) return;
      const beforeId = idx + 2 < col.length ? col[idx + 2].id : null;
      onReorder?.(task.id, beforeId);
    }
  };

  const handleCardDragOver = (card: Task, e: React.DragEvent) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const pos: "before" | "after" =
      e.clientY - rect.top < rect.height / 2 ? "before" : "after";
    setDragOverCardId(card.id);
    setDragPos(pos);
  };

  const handleCardDrop = (card: Task, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const id = draggingId;
    setDragOverCardId(null);
    setDragPos(null);
    setDragOver(null);
    setDraggingId(null);
    if (!id || id === card.id) return;
    const dragged = tasks.find((x) => x.id === id);
    if (!dragged) return;
    if (dragged.status === card.status) {
      // 同列重排：before = 拖到卡片之前；after = 拖到卡片之后（即下一卡之前或末尾）。
      let beforeId: string | null = card.id;
      if (dragPos === "after") {
        const col = byStatus[card.status] ?? [];
        const ci = col.findIndex((x) => x.id === card.id);
        beforeId = ci >= 0 && ci + 1 < col.length ? col[ci + 1].id : null;
      }
      if (beforeId !== id) onReorder?.(id, beforeId);
    } else {
      void doMove(id, card.status);
    }
  };

  const handleDrop = (to: TaskStatus) => {
    const id = draggingId;
    setDragOver(null);
    setDragOverCardId(null);
    setDragPos(null);
    setDraggingId(null);
    if (!id) return;
    const dragged = tasks.find((x) => x.id === id);
    if (!dragged) return;
    if (dragged.status === to) {
      // 落在同列空白处 → 移到该列末尾。
      onReorder?.(id, null);
    } else {
      void doMove(id, to);
    }
  };

  const total = tasks.length;

  return (
    <section className="kb-board" aria-label={t("groups.kanban.title")}>
      {/* ── 工具栏 ── */}
      <div className="kb-toolbar">
        <div className="kb-toolbar-left">
          {/* 搜索 */}
          <div className="kb-search-wrap">
            <svg className="kb-search-icon" viewBox="0 0 16 16" fill="none" width={14} height={14} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M11 11l3 3"/></svg>
            <input
              className="kb-search"
              placeholder={t("groups.kanban.search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label={t("groups.kanban.search")}
            />
          </div>
        </div>

        <div className="kb-toolbar-right">
          <span className="kb-total">{total} tasks</span>
        </div>
      </div>

      {/* ── 看板主体（空看板也常显，各列保留占位与「+」，不隐藏整个面板） ── */}
      <div className="kb-cols" role="list">
        {COLUMNS.map((col) => {
          const items = byStatus[col.status] ?? [];
          const over = dragOver === col.status;
          return (
            <div key={col.status} className={`kb-col status-${col.status}`}>
              {/* 列头：彩色圆点 + 名称 + 计数 + 添加按钮 */}
              <div className="kb-col-head">
                <div className="kb-col-head-left">
                  <span className="kb-col-dot" />
                  <span className="kb-col-name">{t(`groups.kanban.${col.key}` as any)}</span>
                  <span className="kb-col-count">{items.length}</span>
                </div>
                <button
                  className="kb-col-add"
                  title={t("groups.kanban.addToCol", { col: col.status }) ?? `Add to ${col.status}`}
                  onClick={() => onCreateTask?.(col.status)}
                  aria-label={t("groups.kanban.addToCol", { col: col.status }) ?? `Add to ${col.status}`}
                >
                  <Icons.Plus size={14} />
                </button>
              </div>

              {/* 列体：卡片列表 */}
              <div
                className={`kb-col-body${over ? " kb-drop-target" : ""}`}
                role="listitem"
                onDragOver={(e) => {
                  const tk = draggingId ? tasks.find((x) => x.id === draggingId) : null;
                  if (!tk) return;
                  e.preventDefault();
                  if (canMove(tk.status, col.status)) setDragOver(col.status);
                }}
                onDragLeave={() => setDragOver((d) => (d === col.status ? null : d))}
                onDrop={() => handleDrop(col.status)}
              >
                {items.length === 0 ? (
                  <div className="kb-col-placeholder">
                    <span>{t("groups.kanban.colEmpty") ?? "拖拽或点击 + 添加任务"}</span>
                  </div>
                ) : (
                  items.map((tk) => (
                    <KanbanCard
                      key={tk.id}
                      task={tk}
                      onOpen={setSelected}
                      onDragStart={(task) => setDraggingId(task.id)}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setDragOverCardId(null);
                        setDragPos(null);
                      }}
                      dragging={draggingId === tk.id}
                      onMoveKey={moveKey}
                      onMoveVertical={moveVertical}
                      onCardDragOver={handleCardDragOver}
                      onCardDrop={handleCardDrop}
                      dropIndicator={dragOverCardId === tk.id ? dragPos : null}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 空看板兜底：整板无任务时，在列下方给一个醒目的「新建任务」入口（列内 + 已足够，这里再补一层）。 */}
      {total === 0 && onCreateFirst && (
        <div className="kb-empty-boarding">
          <Icons.Kanban size={38} />
          <p>{t("groups.kanban.empty")}</p>
          <button className="btn btn-primary" onClick={onCreateFirst}>
            + {t("groups.kanban.newTask") ?? "新建任务"}
          </button>
        </div>
      )}

      {/* Toast 提示 */}
      {toast && (
        <div className="kb-toast" role="status">
          {toast}
        </div>
      )}

      {/* 详情抽屉 */}
      {selected && (
        <KanbanDrawer
          task={selected}
          allTasks={tasks}
          onClose={() => setSelected(null)}
          onSetStatus={(s) => onSetStatus(selected.id, s)}
          onEdit={onEdit ? (p) => onEdit(selected.id, p) : undefined}
        />
      )}
    </section>
  );
}
