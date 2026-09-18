import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeToUnifiedEvents, type EventEnvelope } from "../../services/eventBus";
import * as groupCommands from "../../services/groupCommands";
import { listActiveRuns } from "../../services/chatCommands";
import { Icons } from "../common/Icons";
import { useI18n } from "../../i18n/I18nProvider";
import "./TaskDrawer.css";

type TaskStatus = "running" | "done" | "failed";
type TaskKind = "run" | "task" | "worker";

interface BgTask {
  key: string;
  kind: TaskKind;
  name: string;
  groupId?: string;
  status: TaskStatus;
  startedAt: number;
  endedAt?: number;
  sub?: string;
}

const MAX_TASKS = 60;

function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 10) : id;
}

function defaultName(key: string): string {
  if (key.startsWith("run:")) return "智能体运行";
  if (key.startsWith("task:")) return `任务 ${shortId(key.slice(5))}`;
  return `Worker ${shortId(key.slice(7))}`;
}

function kindOf(key: string): TaskKind {
  if (key.startsWith("run:")) return "run";
  if (key.startsWith("task:")) return "task";
  return "worker";
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${String(r).padStart(2, "0")}s`;
}

interface TaskDrawerProps {
  open: boolean;
  onClose: () => void;
  onActiveChange?: (n: number) => void;
}

/**
 * TaskDrawer —— 「⚡ 后台任务」抽屉（移植自 WorkBuddy demo，Apple 中性重做）。
 *
 * 数据源：复用统一事件总线 `subscribeToUnifiedEvents`，聚合两类真实后台任务：
 *   1) 当前会话的 agent run（agent:tool_call/thinking/done/error）
 *   2) 圆桌/群组的 task 与 worker（group:task_status_changed / group:worker_status）
 *
 * 名称经 `groupListTasks` / `groupListWorkers` 按 group_id 懒加载并缓存（失败回退到短 id），
 * 不做任何内核改动。进度条在运行态为 indeterminate 流光，完成/失败为满条。
 */
export function TaskDrawer({ open, onClose, onActiveChange }: TaskDrawerProps) {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<BgTask[]>([]);
  const [, setTick] = useState(0); // 已用时间刷新
  const nameCache = useRef<Record<string, { tasks: Map<string, string>; workers: Map<string, string>; ts: number }>>({});

  // ── 内部更新器（functional，避免闭包陈旧） ──
  const upsert = useCallback((key: string, patch: Partial<BgTask> & Pick<BgTask, "kind" | "name" | "status">) => {
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.key === key);
      let next: BgTask[];
      if (idx >= 0) {
        const cur = prev[idx];
        const updated: BgTask = { ...cur, ...patch };
        if (patch.status && patch.status !== "running" && !cur.endedAt) updated.endedAt = Date.now();
        next = [...prev];
        next[idx] = updated;
      } else {
        const created: BgTask = {
          key,
          kind: patch.kind,
          name: patch.name,
          groupId: patch.groupId,
          status: patch.status,
          sub: patch.sub,
          startedAt: Date.now(),
        };
        if (patch.status !== "running") created.endedAt = Date.now();
        next = [created, ...prev];
      }
      return next.length > MAX_TASKS ? next.slice(0, MAX_TASKS) : next;
    });
  }, []);

  const markEnd = useCallback((key: string, status: TaskStatus) => {
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.key === key);
      if (idx < 0) {
        const created: BgTask = {
          key,
          kind: kindOf(key),
          name: defaultName(key),
          status,
          startedAt: Date.now(),
          endedAt: Date.now(),
        };
        return [created, ...prev].slice(0, MAX_TASKS);
      }
      const updated: BgTask = { ...prev[idx], status, endedAt: prev[idx].endedAt ?? Date.now() };
      const next = [...prev];
      next[idx] = updated;
      return next;
    });
  }, []);

  const patchName = useCallback((key: string, name: string) => {
    setTasks((prev) => prev.map((t) => (t.key === key ? { ...t, name } : t)));
  }, []);

  // ── 名称懒加载（按 group_id 缓存 4s） ──
  const resolveNames = useCallback(async (groupId: string) => {
    const cache = nameCache.current[groupId];
    const now = Date.now();
    if (cache && now - cache.ts < 4000) return cache;
    try {
      const [ts, ws] = await Promise.all([
        groupCommands.groupListTasks(groupId),
        groupCommands.groupListWorkers(groupId),
      ]);
      const taskMap = new Map(ts.map((t) => [t.id, t.description || t.id]));
      const workerMap = new Map(
        ws.map((w) => [w.id, w.agent_ref || w.seat_type || shortId(w.id)]),
      );
      const entry = { tasks: taskMap, workers: workerMap, ts: now };
      nameCache.current[groupId] = entry;
      return entry;
    } catch {
      return { tasks: new Map<string, string>(), workers: new Map<string, string>(), ts: now };
    }
  }, []);

  // ── 与后端 runs 表同步，补偿丢失的 done/error 事件 ──
  const syncFromBackend = useCallback(async () => {
    try {
      const rows = await listActiveRuns();
      const now = Date.now();

      // 按 session_id 去重，保留最新的 running run
      const bySession = new Map<string, (typeof rows)[0]>();
      for (const r of rows) {
        if (!bySession.has(r.session_id)) {
          bySession.set(r.session_id, r);
        }
      }

      setTasks((prev) => {
        const next = [...prev];
        const activeKeys = new Set<string>();

        // 1. 同步后端真实存在的 running run（用后端 started_at 校正时间）
        for (const [, r] of bySession) {
          const key = `run:${r.session_id}`;
          activeKeys.add(key);
          const idx = next.findIndex((t) => t.key === key);
          if (idx >= 0) {
            const cur = next[idx];
            next[idx] = { ...cur, status: "running", startedAt: r.started_at };
          } else {
            next.unshift({
              key,
              kind: "run",
              name: "智能体运行",
              status: "running",
              startedAt: r.started_at,
            });
          }
        }

        // 2. 前端有但后端已不存在的 run 任务 → 事件丢失，保守标记为 done
        for (let i = 0; i < next.length; i++) {
          const t = next[i];
          if (t.kind === "run" && t.status === "running" && !activeKeys.has(t.key)) {
            next[i] = { ...t, status: "done", endedAt: t.endedAt ?? now };
          }
        }

        return next.length > MAX_TASKS ? next.slice(0, MAX_TASKS) : next;
      });
    } catch (e) {
      console.error("[TaskDrawer] sync failed", e);
    }
  }, []);

  // ── 订阅统一事件总线，聚合后台任务 ──
  useEffect(() => {
    const unsub = subscribeToUnifiedEvents((env: EventEnvelope) => {
      const type = env.type;
      const p = (env.payload ?? {}) as Record<string, unknown>;
      const sid = env.session_id;

      if (type === "agent:tool_call" || type === "agent:thinking") {
        const key = `run:${sid || "active"}`;
        const sub =
          type === "agent:tool_call"
            ? String(p?.name ?? p?.tool ?? "")
            : "";
        upsert(key, { kind: "run", name: "智能体运行", status: "running", sub: sub || undefined });
      } else if (type === "agent:done") {
        markEnd(`run:${sid || "active"}`, "done");
      } else if (type === "agent:error") {
        markEnd(`run:${sid || "active"}`, "failed");
      } else if (type === "group:task_status_changed") {
        const gid = p?.group_id ? String(p.group_id) : undefined;
        const tid = p?.task_id ? String(p.task_id) : "";
        if (!tid) return;
        const to = String(p?.to ?? "");
        const status: TaskStatus = /completed|done|success/i.test(to)
          ? "done"
          : /fail|error|cancel/i.test(to)
            ? "failed"
            : "running";
        const key = `task:${tid}`;
        upsert(key, { kind: "task", name: `任务 ${shortId(tid)}`, groupId: gid, status });
        if (gid) {
          resolveNames(gid).then((c) =>
            patchName(key, c.tasks.get(tid) || `任务 ${shortId(tid)}`),
          );
        }
      } else if (type === "group:worker_status") {
        const gid = p?.group_id ? String(p.group_id) : undefined;
        const wid = p?.worker_id ? String(p.worker_id) : "";
        if (!wid) return;
        const st = String(p?.status ?? "");
        const key = `worker:${wid}`;
        if (/busy|running/i.test(st)) {
          upsert(key, { kind: "worker", name: `Worker ${shortId(wid)}`, groupId: gid, status: "running" });
        } else {
          markEnd(key, "done");
        }
        if (gid) {
          resolveNames(gid).then((c) =>
            patchName(key, c.workers.get(wid) || `Worker ${shortId(wid)}`),
          );
        }
      }
    });
    return unsub;
  }, [upsert, markEnd, patchName, resolveNames]);

  // ── 已用时间每秒刷新（仅抽屉打开时） ──
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [open]);

  // ── 与后端状态同步：挂载时 + 抽屉打开时立即 sync + 每 15s 轮询 ──
  useEffect(() => {
    syncFromBackend();
  }, [syncFromBackend]);

  useEffect(() => {
    if (!open) return;
    syncFromBackend();
    const id = setInterval(() => syncFromBackend(), 15000);
    return () => clearInterval(id);
  }, [open, syncFromBackend]);

  // ── 上报 active 数量给顶栏 badge ──
  const activeCount = tasks.filter((t) => t.status === "running").length;
  useEffect(() => {
    onActiveChange?.(activeCount);
  }, [activeCount, onActiveChange]);

  const clearDone = useCallback(() => {
    setTasks((prev) => prev.filter((t) => t.status === "running"));
  }, []);

  const now = Date.now();

  return (
    <div
      className={`task-drawer${open ? " open" : ""}`}
      role="log"
      aria-label={t("tasks.drawer.title")}
      aria-hidden={!open}
    >
      <div className="task-drawer-header">
        <div className="title">
          <BoltIcon />
          <span>{t("tasks.drawer.title")}</span>
          <span className="task-count">{activeCount ? t("tasks.drawer.countActive", { n: activeCount }) : tasks.length}</span>
        </div>
        <div className="task-drawer-actions">
          <button
            type="button"
            className="task-btn"
            onClick={clearDone}
            disabled={!open || !tasks.some((t) => t.status !== "running")}
            title={t("tasks.drawer.clearDone")}
          >
            {t("tasks.drawer.clearDone")}
          </button>
          <button type="button" className="task-btn" onClick={onClose} title={t("common.close")} aria-label={t("tasks.drawer.close")} disabled={!open}>
            <Icons.Close size={13} />
          </button>
        </div>
      </div>
      <div className="task-list">
        {tasks.length === 0 ? (
          <div className="task-empty">{t("tasks.drawer.empty")}</div>
        ) : (
          tasks.map((task) => {
            const elapsed = task.endedAt ? task.endedAt - task.startedAt : now - task.startedAt;
            return (
              <div key={task.key} className={`task-item status-${task.status}`}>
                <div className="task-item-header">
                  {task.status === "running" ? (
                    <span className="task-spinner" />
                  ) : task.status === "failed" ? (
                    <span className="task-icon-failed">
                      <CrossIcon />
                    </span>
                  ) : (
                    <span className="task-icon-done">
                      <CheckIcon />
                    </span>
                  )}
                  <span className="task-name" title={task.name}>
                    {task.name}
                  </span>
                  <span className="task-time">{formatElapsed(elapsed)}</span>
                </div>
                {task.sub && task.status === "running" && (
                  <div className="task-sub">{task.sub}</div>
                )}
                <div className="task-progress">
                  <div
                    className={
                      "task-progress-bar " +
                      (task.status === "running"
                        ? "indeterminate"
                        : task.status === "failed"
                          ? "failed"
                          : "done")
                    }
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function BoltIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export default TaskDrawer;
