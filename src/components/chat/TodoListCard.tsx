import React, { useMemo, useState } from "react";
import type { TodoEntry, TodoStatus } from "../../types";
import { Icons } from "../common/Icons";
import "./agentPlan.css";

/**
 * 能力①「自动规划 + 待办顺序执行」的清单卡（参考 WorkBuddy TaskCreate/TaskList 形态）。
 *
 * 形态取舍（为什么不是 Item）：
 * `MessageList.buildTurns` 会静默吞掉未知 Item kind，且待办是「整回合的状态」
 * 而非时间线上的一次事件 —— 所以做成会话流顶部的独立常驻卡，由 useAgent 的
 * `todos` 快照直接驱动（内核每次跃迁全量重推，前端零合并逻辑）。
 *
 * 状态机：pending（灰空心）→ active（蓝脉冲）→ done（绿勾）/ failed（红叉）。
 * 注意与 ToolStatus（pending/running/done/error）不是同一套，别混用。
 */
export const TodoListCard: React.FC<{
  todos: TodoEntry[];
  /** 折叠态默认值；done 全绿后建议由父级传 true 收起。 */
  defaultCollapsed?: boolean;
  /** 浮窗形态下标题/计数由父级浮窗条承担，本卡只输出进度条+列表。 */
  headerless?: boolean;
}> = ({ todos, defaultCollapsed = false, headerless = false }) => {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const { doneCount, activeTodo, allDone, hasFailed } = useMemo(() => {
    const done = todos.filter((t) => t.status === "done").length;
    const active = todos.find((t) => t.status === "active") ?? null;
    return {
      doneCount: done,
      activeTodo: active,
      allDone: todos.length > 0 && done === todos.length,
      hasFailed: todos.some((t) => t.status === "failed"),
    };
  }, [todos]);

  if (todos.length === 0) return null;

  const percent = Math.round((doneCount / todos.length) * 100);

  return (
    <section
      className={`todo-card${allDone ? " is-complete" : ""}${hasFailed ? " has-failed" : ""}`}
      aria-label="本回合待办清单"
    >
      {!headerless && (
      <header className="todo-card-head">
        <button
          type="button"
          className="todo-card-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "展开待办清单" : "折叠待办清单"}
        >
          <span className={`todo-chevron${collapsed ? "" : " open"}`}>
            <Icons.ChevronRight size={10} />
          </span>
        </button>

        <span className="todo-card-title">
          {allDone ? "全部完成" : hasFailed ? "执行中断" : "执行计划"}
        </span>

        {/* 折叠时把「正在做什么」提到标题行，收起也不丢当前进度语义 */}
        {collapsed && activeTodo && (
          <span className="todo-card-now">{activeTodo.active_form || activeTodo.title}</span>
        )}

        <span className="todo-card-count" aria-live="polite">
          {doneCount}/{todos.length}
        </span>
      </header>
      )}

      <div
        className="todo-progress"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="待办完成进度"
      >
        <span className="todo-progress-fill" style={{ width: `${percent}%` }} />
      </div>

      {!collapsed && (
        <ol className="todo-list">
          {todos.map((t, i) => (
            <li key={t.id || i} className={`todo-item status-${t.status}`}>
              <StatusDot status={t.status} />
              <span className="todo-item-text">
                {t.status === "active" ? t.active_form || t.title : t.title}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};

/** 状态点：done/failed 用图标承担语义（不只靠颜色，色盲可辨）。 */
const StatusDot: React.FC<{ status: TodoStatus }> = ({ status }) => {
  const label =
    status === "done" ? "已完成" : status === "active" ? "进行中" : status === "failed" ? "失败" : "待执行";
  return (
    <span className={`todo-dot dot-${status}`} role="img" aria-label={label} title={label}>
      {status === "done" && <Icons.Check size={10} />}
      {status === "failed" && <Icons.Cross size={10} />}
    </span>
  );
};
