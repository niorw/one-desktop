import { useCallback } from "react";
import type { Task } from "../../../types";
import { Icons } from "../../common/Icons";
import { usePreview } from "../../artifacts/PreviewProvider";

// 状态语义色统一由 groups.css 的 `.kb-card.status-Xxx` 类提供（--kb-strip / --kb-pill-bg / --kb-pill-color），
// 全部映射到 App.css :root 全局令牌，组件内禁止裸 hex。

function shortBatch(bid: string | null): string {
  if (!bid) return "—";
  return bid.length > 10 ? "bat·" + bid.slice(-6) : bid;
}

function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 0) return "";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function KanbanCard({
  task,
  onOpen,
  onDragStart,
  onDragEnd,
  dragging,
  onMoveKey,
  onMoveVertical,
  onCardDragOver,
  onCardDrop,
  dropIndicator,
}: {
  task: Task;
  onOpen: (task: Task) => void;
  onDragStart: (task: Task) => void;
  onDragEnd: () => void;
  dragging: boolean;
  onMoveKey: (task: Task, dir: "left" | "right") => void;
  /** 列内上下移动（键盘 ↑/↓）。 */
  onMoveVertical?: (task: Task, dir: "up" | "down") => void;
  /** 作为放置目标：拖拽悬停时回调（用于显示插入指示）。 */
  onCardDragOver?: (task: Task, e: React.DragEvent) => void;
  /** 作为放置目标：松手时回调（同列重排 / 跨列移动）。 */
  onCardDrop?: (task: Task, e: React.DragEvent) => void;
  /** 插入指示方向：拖拽悬停在该卡之前/之后。 */
  dropIndicator?: "before" | "after" | null;
}) {
  const { openPreview } = usePreview();

  const depN = task.depends_on?.length ?? 0;
  const outN = task.outputs?.length ?? 0;

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onOpen(task);
      } else if (e.shiftKey && e.key === "ArrowRight") {
        e.preventDefault();
        onMoveKey(task, "right");
      } else if (e.shiftKey && e.key === "ArrowLeft") {
        e.preventDefault();
        onMoveKey(task, "left");
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        onMoveVertical?.(task, "up");
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        onMoveVertical?.(task, "down");
      }
    },
    [task, onOpen, onMoveKey, onMoveVertical]
  );

  return (
    <div
      className={`kb-card status-${task.status}${dragging ? " kb-dragging" : ""}${
        dropIndicator === "before" ? " kb-drop-before" : dropIndicator === "after" ? " kb-drop-after" : ""
      }`}
      draggable
      tabIndex={0}
      role="listitem"
      aria-label={`${task.description} · ${task.status}`}
      onClick={() => onOpen(task)}
      onKeyDown={onKey}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart(task);
      }}
      onDragEnd={onDragEnd}
      onDragOver={onCardDragOver ? (e) => onCardDragOver(task, e) : undefined}
      onDrop={onCardDrop ? (e) => onCardDrop(task, e) : undefined}
    >
      <div className="kb-card-inner">
        {/* 标题区 */}
        <div className="kb-card-title-row">
          <span className="kb-card-title">{task.description}</span>
        </div>

        {/* 描述/副文本 */}
        {task.reasoning && (
          <p className="kb-card-desc">
            <span>{task.reasoning.length > 120 ? task.reasoning.slice(0, 120) + "…" : task.reasoning}</span>
          </p>
        )}

        {/* 标签行 */}
        <div className="kb-card-tags">
          {/* 状态 pill（颜色由 .kb-card.status-Xxx 提供） */}
          <span className="kb-pill kb-pill-status">
            {task.status}
          </span>

          {/* 批次 */}
          {task.batch_id && (
            <span className="kb-pill kb-pill-batch" title={task.batch_id}>
              <Icons.Folder size={11} />
              {shortBatch(task.batch_id)}
            </span>
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="kb-card-footer">
          <div className="kb-footer-left">
          {/* 时间 */}
          {task.last_heartbeat && (
            <span className="kb-footer-item" title={new Date(task.last_heartbeat * 1000).toLocaleString()}>
              <Icons.Clock size={12} />
              {timeAgo(task.last_heartbeat * 1000)}
            </span>
          )}
          </div>
          <div className="kb-footer-right">
            {/* 依赖数 */}
            {depN > 0 && (
              <span className="kb-footer-icon" title={`${depN} dependencies`}>
                <Icons.Network size={13} />
                <span className="kb-footer-badge">{depN}</span>
              </span>
            )}
            {/* 产出物：可点击 chip → openPreview */}
            {outN > 0 && (
              <span className="kb-footer-icon kb-footer-outputs" title={`${outN} outputs`}>
                <Icons.Paperclip size={13} />
                {(task.outputs ?? []).slice(0, 3).map((fp, i) => {
                  const name = fp.split(/[\\/]/).pop() || fp;
                  const short = name.length > 12 ? name.slice(0, 11) + "…" : name;
                  return (
                    <button
                      key={i}
                      className="kb-output-chip"
                      title={fp}
                      onClick={(e) => {
                        e.stopPropagation();
                        openPreview({ filePath: fp });
                      }}
                    >
                      {short}
                    </button>
                  );
                })}
                {outN > 3 && (
                  <span className="kb-footer-badge">+{outN - 3}</span>
                )}
              </span>
            )}
            {/* 重试次数 */}
            {(task.retry_count ?? 0) > 0 && (
              <span className="kb-footer-icon" title={`Retried ${task.retry_count}x`}>
                <Icons.Refresh size={13} />
                <span className="kb-footer-badge">{task.retry_count}</span>
              </span>
            )}
            {/* InProgress 指示：静态圆点，避免与加载/Agent 转圈混淆 */}
            {task.status === "InProgress" && (
              <span className="kb-progress-dot" title="In Progress" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
