import { useEffect, useMemo, useState } from "react";
import { Icons } from "../../common/Icons";
import { PixelAvatar, workerColors } from "../../common/PixelAvatar";
import type { SeatLive } from "../../../features/insight/SeatDashboard";
import type { Group, Task, Worker, WorkerMetric } from "../../../types";
import { agentDisplayName } from "./helpers";
import { workerRole } from "./roles";
import type { DictKey } from "../../../i18n/dict";
import { groupGetWorkspace, groupListDeliverables } from "../../../services/groupCommands";

/**
 * GroupInfoPanel — 右侧「任务概览」侧边栏（一比一复刻截图样式）
 *
 * 信息架构（自顶向下）：
 *   ① 任务概览头        标题 + 群 ID
 *   ② 四格统计          智能体 / 进行中 / 已完成 / 预计剩余
 *   ③ 智能体工作区      PixelAvatar 头像 + 名称/职责 + 状态徽章
 *   ④ 任务产出          完成数 / 总数 + 文件图标/描述/状态徽章 + 查看全部
 *   ⑤ 任务调整          调整任务 / 重新规划
 */
export function GroupInfoPanel({
  group,
  workers,
  resolveName,
  stats,
  tasksByWorker,
  metricsByWorker,
  seatLive,
  tasks,
  refreshTick,
  onApproveBatch,
  onCancelBatch,
  onAddSeat,
  onOpenWorker,
  onAdjust,
  onReplan,
  onViewAllDeliverables,
  onOpenFile,
  t,
}: {
  group: Group;
  workers: Worker[];
  resolveName: (ref: string) => string;
  stats: { seats: number; busy: number; open: number; completed: number; awaiting: number };
  tasksByWorker: Record<string, Task[]>;
  metricsByWorker: Record<string, WorkerMetric>;
  seatLive: Record<string, SeatLive>;
  tasks: Task[];
  /** 群消息/摘要到达时 +1，驱动本面板重拉「消息产出物」（无事件时不重复请求）。 */
  refreshTick?: number;
  /** 审批该批次（AwaitingApproval → Pending 并派发）；由 GroupsPage 接真后端。 */
  onApproveBatch?: (batchId: string) => void;
  /** 取消该批次（取消未派发任务 / 优雅中止运行中任务）。 */
  onCancelBatch?: (batchId: string) => void;
  onAddSeat: () => void;
  onOpenWorker: (w: Worker) => void;
  onAdjust?: () => void;
  onReplan?: () => void;
  onViewAllDeliverables?: () => void;
  /** 点击任务产出文件时唤起预览，传入绝对路径。 */
  onOpenFile?: (absPath: string) => void;
  t: (k: DictKey, v?: Record<string, string | number>) => string;
}) {
  // worker_id → 名下待审批批次（AwaitingApproval 任务按 batch 聚合，供卡片上方提示条）。
  const approvalByWorker = useMemo(() => {
    const map: Record<string, { batchId: string; count: number }[]> = {};
    for (const tk of tasks) {
      if (tk.status !== "AwaitingApproval" || !tk.worker_id) continue;
      const wid = tk.worker_id;
      const batchId = tk.batch_id ?? "__manual__";
      const list = (map[wid] ??= []);
      const hit = list.find((b) => b.batchId === batchId);
      if (hit) hit.count += 1;
      else list.push({ batchId, count: 1 });
    }
    return map;
  }, [tasks]);

  const estimatedRemaining = useMemo(() => {    const open = stats.open;
    if (open <= 0) return "—";
    const completed = stats.completed;
    const totalDuration = Object.values(metricsByWorker).reduce(
      (sum, m) => sum + (m?.total_duration_ms ?? 0),
      0,
    );
    if (completed <= 0 || totalDuration <= 0) return "—";
    const avg = totalDuration / completed;
    const minutes = Math.round((avg * open) / 60000);
    return minutes > 0 ? `${minutes}m` : "—";
  }, [stats.open, stats.completed, metricsByWorker]);

  const agentStatus = (w: Worker): { key: string; label: string } => {
    const live = seatLive[w.id];
    if (live || w.status === "Busy") {
      return { key: "running", label: t("groups.status.busy") };
    }
    const ts = tasksByWorker[w.id] ?? [];
    if (ts.length > 0 && ts.every((tk) => tk.status === "Completed")) {
      return { key: "completed", label: t("groups.task.status.Completed") };
    }
    return { key: "waiting", label: t("groups.info.waiting") };
  };


  const [wsRoot, setWsRoot] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    groupGetWorkspace(group.id)
      .then((p) => {
        if (!cancelled) setWsRoot(p);
      })
      .catch(() => {
        if (!cancelled) setWsRoot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [group.id]);

  const resolveOutputPath = (out: string): string | null => {
    if (!out.trim()) return null;
    if (out.startsWith("/") || out.startsWith("\\")) return out;
    if (wsRoot) return `${wsRoot.replace(/\/+$/, "")}/${out.replace(/^\/+/, "")}`;
    return null;
  };

  // 消息产出物：拉群产出物一览，提取 reply 类型的 media（written_files 附件）。
  // refreshTick 变化（新群消息/摘要到达）时重拉——侧边栏产出物主动刷新。
  const [msgFiles, setMsgFiles] = useState<{ name: string; abs: string | null }[]>([]);
  useEffect(() => {
    let cancelled = false;
    groupListDeliverables(group.id)
      .then((list) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const files: { name: string; abs: string | null }[] = [];
        for (const d of list) {
          if (d.kind !== "reply") continue;
          for (const m of d.media ?? []) {
            const name = m.name || m.path.split(/[\\/]/).pop() || m.path;
            if (!name || seen.has(name)) continue;
            seen.add(name);
            files.push({ name, abs: m.path });
          }
        }
        setMsgFiles(files);
      })
      .catch(() => {
        if (!cancelled) setMsgFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [group.id, refreshTick]);

  /** 平铺所有任务产出文件，只保留文件名。 */
  const outputFiles = useMemo(() => {
    const seen = new Set<string>();
    const list: { name: string; abs: string | null }[] = [];
    const push = (name: string, abs: string | null) => {
      if (!name || seen.has(name)) return;
      seen.add(name);
      list.push({ name, abs });
    };
    tasks.forEach((tk) => {
      (tk.outputs ?? []).forEach((out) => {
        const name = out.split(/[\\/]/).pop() ?? out;
        push(name, resolveOutputPath(out));
      });
    });
    // 合并「群消息产出物」：Worker 回复时 written_files 挂在 roundtable 消息
    // attachments，经 group_list_deliverables(reply media) 聚合，与任务产出去重。
    msgFiles.forEach((f) => push(f.name, f.abs));
    return list.slice(0, 8);
  }, [tasks, wsRoot, msgFiles]);

  return (
    <aside className="group-info-panel">
      {/* ── 任务概览头 ── */}
      <header className="gi-head">
        <h2 className="gi-title">{t("groups.info.overviewTitle")}</h2>
        <span className="gi-id" title={group.id}>
          {t("groups.info.id")}: {group.id}
        </span>
      </header>

      {/* ── 四格统计 ── */}
      <div className="gi-stats" aria-label="group overview">
        <div className="gi-stat">
          <span className="gi-stat-value">{stats.seats}</span>
          <span className="gi-stat-label">{t("groups.info.agents")}</span>
        </div>
        <div className="gi-stat">
          <span className="gi-stat-value">{stats.busy}</span>
          <span className="gi-stat-label">{t("groups.info.executing")}</span>
        </div>
        <div className="gi-stat">
          <span className="gi-stat-value">{stats.completed}</span>
          <span className="gi-stat-label">{t("groups.info.completed")}</span>
        </div>
        <div className="gi-stat">
          <span className="gi-stat-value">{estimatedRemaining}</span>
          <span className="gi-stat-label">{t("groups.info.estRemaining")}</span>
        </div>
      </div>

      {/* ── 智能体工作区 ── */}
      <section className="gi-section gi-region">
        <h3 className="gi-section-title">{t("groups.info.agentWorkspace")}</h3>
        <div className="gi-agent-list">
          {workers.length === 0 ? (
            <div className="gi-empty">{t("groups.members.empty")}</div>
          ) : (
            workers.map((w) => {
              const name = agentDisplayName(w, resolveName, t);
              const role = workerRole(name, w.capabilities, t);
              const colors = workerColors(w.id);
              const status = agentStatus(w);
              // 该 worker 名下的待审批批次（AwaitingApproval 任务按 batch 聚合），
              // 提示条插在 worker 卡片上方：批准/取消即审批看板（管理员在环交接棒入口）。
              const pending = approvalByWorker[w.id] ?? [];
              return (
                <div className="gi-agent-slot" key={w.id}>
                  {pending.length > 0 && (
                    <div className="gi-approve-prompt" role="group">
                      <Icons.Hourglass size={12} />
                      <span className="gi-approve-text">
                        {t("groups.info.approvePrompt", {
                          n: pending.reduce((s, p) => s + p.count, 0),
                        })}
                      </span>
                      {pending.map((p) => (
                        <span className="gi-approve-actions" key={p.batchId}>
                          <button
                            type="button"
                            className="gi-approve-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              onApproveBatch?.(p.batchId);
                            }}
                          >
                            {t("groups.batch.accept")}
                          </button>
                          <button
                            type="button"
                            className="gi-approve-btn gi-approve-btn-cancel"
                            onClick={(e) => {
                              e.stopPropagation();
                              onCancelBatch?.(p.batchId);
                            }}
                          >
                            {t("groups.batches.cancel")}
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <button
                    type="button"
                    className={[
                      "gi-agent",
                      "info-member",
                      w.agent_ref === group.owner_agent_ref ? "is-owner" : "",
                      w.seat_type === "Capability" ? "is-cap" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => onOpenWorker(w)}
                    title={t("groups.member.openDetails", { name })}
                  >
                  <span
                    className="gi-agent-avatar"
                    style={{
                      "--w-acc": colors.light,
                      "--w-acc-dark": colors.dark,
                    } as React.CSSProperties}
                  >
                    <PixelAvatar seed={w.id} size={36} />
                  </span>
                  <span className="gi-agent-meta">
                    <span className="gi-agent-name">
                      {name}
                      {role.coordinator && (
                        <span
                          className="gi-role-badge gi-role-coordinator"
                          title={t("groups.role.coordinator")}
                        >
                          {t("groups.role.coordinatorShort")}
                        </span>
                      )}
                    </span>
                    {role.duty && role.duty !== name && (
                      <span className="gi-agent-duty">{role.duty}</span>
                    )}
                    {/* 实时「在干啥」：Busy 且持有 DAG 任务 id 时显示当前任务描述（
                        WorkerStatus 事件实时驱动 current_task_id）。 */}
                    {w.current_task_id && (
                      <span
                        className="gi-agent-task"
                        title={t("groups.member.currentTask")}
                      >
                        {tasksByWorker[w.id]?.find((tk) => tk.id === w.current_task_id)
                          ?.description ?? w.current_task_id}
                      </span>
                    )}
                  </span>
                  <span className={`gi-status-badge gi-status-${status.key}`}>
                    {status.label}
                  </span>
                  </button>
                </div>
              );
            })
          )}
          <button type="button" className="gi-add-agent" onClick={onAddSeat}>
            <span className="gi-add-agent-plus">
              <Icons.Plus size={12} />
            </span>
            <span>{t("groups.member.action.addAgent")}</span>
          </button>
        </div>
      </section>

      {/* ── 产出物：任务产出 + 群消息产出物（只保留文件名） ── */}
      <section className="gi-section gi-region">
        <h3 className="gi-section-title">
          {t("groups.info.outputs")} ({outputFiles.length})
        </h3>
        <div className="gi-task-list">
          {outputFiles.length === 0 ? (
            <div className="gi-empty">{t("groups.dispatch.empty")}</div>
          ) : (
            outputFiles.map((file, i) => (
              <button
                key={`${file.name}-${i}`}
                type="button"
                className="gi-task-output"
                disabled={!file.abs || !onOpenFile}
                title={file.abs ?? file.name}
                onClick={() => file.abs && onOpenFile?.(file.abs)}
              >
                <Icons.FileText size={14} />
                <span className="gi-task-output-name">{file.name}</span>
              </button>
            ))
          )}
        </div>
        {tasks.length > 0 && (
          <button
            type="button"
            className="gi-link"
            onClick={onViewAllDeliverables}
          >
            {t("groups.info.viewAllFiles")}
            <Icons.ChevronRight size={12} />
          </button>
        )}
      </section>

      {/* ── 任务调整 ── */}
      <section className="gi-section gi-region">
        <h3 className="gi-section-title">{t("groups.info.adjustTitle")}</h3>
        <p className="gi-hint">{t("groups.info.adjustHint")}</p>
        <div className="gi-actions">
          <button type="button" className="gi-action-btn" onClick={onAdjust}>
            <Icons.Edit size={14} />
            {t("groups.info.adjust")}
          </button>
          <button type="button" className="gi-action-btn" onClick={onReplan}>
            <Icons.Refresh size={14} />
            {t("groups.info.replan")}
          </button>
        </div>
      </section>
    </aside>
  );
}
