import { useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "../../../i18n/I18nProvider";
import type { DictKey } from "../../../i18n/dict";
import { useDialogA11y } from "../../common/useDialogA11y";
import { Icons } from "../../common/Icons";
import { PixelAvatar, workerColors } from "../../common/PixelAvatar";
import { SeatRunHistory } from "../../../features/insight/SeatDashboard";
import * as tauri from "../../../services/tauri";
import type { AgentProfile, Group, SeatInsight, Task, Worker, WorkerMetric } from "../../../types";
import { formatDuration, agentDisplayName, AGENT_TYPE_KEY, WORKER_STATUS_KEY } from "./helpers";
import { workerRole } from "./roles";
import { ProgressRing } from "./ProgressRing";
export function WorkerDetailDrawer({
  worker,
  group,
  presets,
  tasksByWorker,
  metric,
  resolveName,
  onClose,
  onSetStatus,
  onSetAgent,
  onRemove,
  t,
}: {
  worker: Worker;
  group: Group | null;
  presets: AgentProfile[];
  tasksByWorker: Record<string, Task[]>;
  metric?: WorkerMetric;
  resolveName: (ref: string) => string;
  onClose: () => void;
  onSetStatus: (workerId: string, status: "idle" | "offline") => void | Promise<void>;
  onSetAgent: (workerId: string, agentRef: string) => void | Promise<void>;
  onRemove: (workerId: string) => void | Promise<void>;
  t: (k: DictKey, v?: Record<string, string | number>) => string;
}) {
  const drawerRef = useDialogA11y<HTMLDivElement>(true, onClose);
  const isOwner = worker.agent_ref === group?.owner_agent_ref;
  const isCap = worker.seat_type === "Capability";
  const name = agentDisplayName(worker, resolveName, t);
  // 与群内成员列表同源：seed = worker.id → 同一个像素头像，配色也一致。
  const colors = workerColors(worker.id);
  // 数据面板取 runs 聚合（insight，查询期实时计算）。不用 `worker_metrics`：
  // 那张表只有 roundtable 回合会写（全项目仅 roundtable.rs 一处 record），
  // 任务执行的 run 从不写入 → 用它会导致 token 被严重低估（实测差 28 倍）。
  const [insight, setInsight] = useState<SeatInsight | null>(null);
  useEffect(() => {
    let cancelled = false;
    setInsight(null);
    tauri
      .insightSeatRuns(worker.id, 8)
      .then((d) => {
        if (!cancelled) setInsight(d);
      })
      .catch(() => {
        if (!cancelled) setInsight(null);
      });
    return () => {
      cancelled = true;
    };
  }, [worker.id]);
  const sum = insight?.summary ?? null;
  const hasRuns = (sum?.total_runs ?? 0) > 0;
  const isCoordinator = workerRole(name, worker.capabilities, t).coordinator;
  const ts = tasksByWorker[worker.id] ?? [];
  const done = ts.filter((x) => x.status === "Completed").length;

  return (
    <div className="modal-overlay drawer-overlay" onClick={onClose}>
      <div
        className="drawer"
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("groups.agent.detail")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <div className="drawer-title-row">
            <span
              className="drawer-avatar"
              style={
                {
                  "--w-acc": colors.light,
                  "--w-acc-dark": colors.dark,
                } as CSSProperties
              }
            >
              <PixelAvatar seed={worker.id} size={50} />
              <span className={`status-dot status-${worker.status.toLowerCase()}`} />
            </span>
            <div>
              <h2 className="drawer-title">{name}</h2>
              <span className="drawer-sub">
                {t(AGENT_TYPE_KEY[worker.seat_type])}
                {isOwner ? ` · ${t("groups.info.ownerTag")}` : ""}
                {isCoordinator ? ` · ${t("groups.role.coordinatorShort")}` : ""}
              </span>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label={t("common.cancel")}>
            ✕
          </button>
        </div>

        <div className="drawer-body">
          <div className="drawer-section">
            <div className="drawer-field">
              <span className="drawer-label">{t("groups.status")}</span>
              <span className={`grp-status grp-status-${worker.status.toLowerCase()}`}>
                {t(WORKER_STATUS_KEY[worker.status])}
              </span>
            </div>
            <div className="drawer-field">
              <span className="drawer-label">
                {isCap ? t("groups.worker.changeAgent") : t("groups.worker.source")}
              </span>
              {isCap ? (
                <select
                  className="drawer-agent-select"
                  value=""
                  onChange={(e) => e.target.value && void onSetAgent(worker.id, e.target.value)}
                >
                  <option value="">{t("groups.agent.pickHint")}</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.model}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <span className="drawer-value">{resolveName(worker.agent_ref)}</span>
                  <select
                    className="drawer-agent-select"
                    value=""
                    onChange={(e) => e.target.value && void onSetAgent(worker.id, e.target.value)}
                  >
                    <option value="">{t("groups.worker.changeAgent")}</option>
                    {presets
                      .filter((p) => p.id !== worker.agent_ref)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {p.model}
                        </option>
                      ))}
                  </select>
                </>
              )}
            </div>
            <div className="drawer-field">
              <span className="drawer-label">{t("groups.worker.concurrency")}</span>
              <span className="drawer-value">{worker.max_concurrency}</span>
            </div>
            {worker.current_task_id && (
              <div className="drawer-field">
                <span className="drawer-label">{t("groups.member.currentTask")}</span>
                <span className="drawer-mono">{worker.current_task_id}</span>
              </div>
            )}
            {ts.length > 0 && (
              <div className="drawer-field">
                <span className="drawer-label">{t("groups.info.openTasks")}</span>
                <div className="drawer-progress">
                  <ProgressRing value={done} total={ts.length} size={34} />
                  <span className="drawer-progress-text">
                    {done}/{ts.length} {t("groups.batch.tasks")}
                  </span>
                </div>
              </div>
            )}
          </div>

          {worker.capabilities.length > 0 && (
            <div className="drawer-section">
              <span className="drawer-section-title">{t("groups.member.capabilities")}</span>
              <div className="worker-cap-list">
                {worker.capabilities.map((c) => (
                  <span key={c} className="worker-cap">{c}</span>
                ))}
              </div>
            </div>
          )}

          <div className="drawer-section">
            <span className="drawer-section-title">{t("groups.member.metrics")}</span>
            {hasRuns && sum ? (
              <>
                <div className="worker-metrics">
                  {/* 累计口径一律取 runs 聚合（圆桌回合 + 任务执行全覆盖），查询期实时计算，不写死 */}
                  <div className="metric-card highlight">
                    <span className="metric-val">{sum.total_tokens.toLocaleString()}</span>
                    <span className="metric-key">{t("groups.member.metricTokens")}</span>
                    <span className="metric-sub">
                      {t("groups.member.metricAvg")}{" "}
                      {Math.round(sum.total_tokens / Math.max(1, sum.total_runs)).toLocaleString()} token
                    </span>
                  </div>
                  <div className="metric-card">
                    <span className="metric-val">{formatDuration(sum.total_duration_ms)}</span>
                    <span className="metric-key">{t("groups.member.metricDuration")}</span>
                    <span className="metric-sub">
                      {sum.total_runs} {t("groups.member.metricRuns")} ·{" "}
                      {formatDuration(Math.round(sum.total_duration_ms / Math.max(1, sum.total_runs)))}{" "}
                      {t("groups.member.metricAvg")}
                    </span>
                  </div>
                  <div className="metric-card">
                    <span className="metric-val">{sum.total_runs}</span>
                    <span className="metric-key">{t("insight.history.totalRuns")}</span>
                    <span className="metric-sub">
                      {t("insight.history.successRate", {
                        n: sum.success_runs,
                        p: Math.round((sum.success_runs / Math.max(1, sum.total_runs)) * 100),
                      })}
                    </span>
                  </div>
                  <div className="metric-card">
                    <span className="metric-val">¥{sum.est_cost_yuan.toFixed(3)}</span>
                    <span className="metric-key">{t("insight.history.totalCost")}</span>
                    <span className="metric-sub">{t("insight.history.costHint")}</span>
                  </div>
                  {/* 以下两项是 roundtable 回合快照（非累计），标签已标明「最近一轮 / 最近响应」 */}
                  {metric && (
                    <>
                      <div className="metric-card">
                        <span className="metric-val">{metric.last_total_tokens.toLocaleString()}</span>
                        <span className="metric-key">{t("groups.member.metricLastRound")}</span>
                        <span className="metric-sub">
                          {metric.last_msg_count} {t("groups.member.metricContext")}
                        </span>
                      </div>
                      <div className="metric-card">
                        <span className="metric-val">{metric.last_context_tokens.toLocaleString()}</span>
                        <span className="metric-key">{t("groups.member.metricLastTokens")}</span>
                        <span className="metric-sub">{t("groups.member.metricLastResponse")}</span>
                      </div>
                    </>
                  )}
                </div>
              </>
            ) : (
              <span className="drawer-hint">{t("groups.member.metricEmpty")}</span>
            )}
            <SeatRunHistory seatId={worker.id} insight={insight} />
          </div>
        </div>

        <div className="drawer-actions">
          {worker.status === "Idle" && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => void onSetStatus(worker.id, "offline")}
              type="button"
            >
              {t("groups.worker.setOffline")}
            </button>
          )}
          {worker.status === "Offline" && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => void onSetStatus(worker.id, "idle")}
              type="button"
            >
              {t("groups.worker.setOnline")}
            </button>
          )}
          <button
            className="btn btn-danger btn-sm"
            onClick={() => void onRemove(worker.id)}
            type="button"
          >
            {t("groups.agent.remove")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Create group modal ──
