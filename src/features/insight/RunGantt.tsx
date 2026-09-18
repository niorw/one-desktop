import React, { useEffect, useMemo, useState } from "react";
import type { GroupInsight, RunWithSteps } from "../../types";
import { exportRunReplay, insightGroupRuns } from "../../services/groupCommands";
import { Markdown } from "../../utils/markdown";
import { Icons } from "../../components/common/Icons";
import { ChangesetPanel } from "../../components/groups/parts/ChangesetPanel";
import { useI18n } from "../../i18n/I18nProvider";
import { friendlyError } from "../../services/errors";
import type { DictKey } from "../../i18n/dict";

/** IX-8 信息密度三档：只看结论 / 看步骤（含工具摘要）/ 看全部（含参数与原始输出）。 */
export type DensityLevel = "conclusion" | "steps" | "all";
const DENSITY_LEVELS: DensityLevel[] = ["conclusion", "steps", "all"];
const densityLabel = (t: (k: DictKey) => string, lvl: DensityLevel): string =>
  t(`insight.density.${lvl}` as DictKey);
const densityTip = (t: (k: DictKey) => string, lvl: DensityLevel): string =>
  t(`insight.density.${lvl}Tip` as DictKey);

/** IX-8 顶部密度切换（三档滑杆式分段控件）。 */
export const DensityToggle: React.FC<{
  value: DensityLevel;
  onChange: (v: DensityLevel) => void;
}> = ({ value, onChange }) => {
  const { t } = useI18n();
  return (
    <div className="density-toggle" role="group" aria-label={t("insight.density")}>
      {DENSITY_LEVELS.map((lvl) => (
        <button
          key={lvl}
          type="button"
          className={"density-seg" + (value === lvl ? " active" : "")}
          onClick={() => onChange(lvl)}
          title={densityTip(t, lvl)}
        >
          {densityLabel(t, lvl)}
        </button>
      ))}
    </div>
  );
};

/**
 * R5 运行摘要条 + 甘特时间线（IX-2）—— insight 层组件，自拉数据、零群状态依赖。
 *
 * FR5.2 顶部固定摘要条：run 数 / prompt / completion tokens / 请求数 / 总耗时 / 预估成本。
 * FR5.3 甘特式时间线：任务级执行条（按 seat 着色），下钻看 Agent / LLM / 工具 / 状态。
 * FR5.4 并行度可视化：三个 Worker 的条若错位而非重叠，说明扇出未生效。
 */

/** 运行条配色：按 seat 稳定分配（同 seat 同色），从令牌派生、无写死色值。 */
const SEAT_COLORS = [
  "var(--accent)",
  "var(--status-success)",
  "var(--status-warning)",
  "var(--status-info-strong)",
  "var(--status-error-strong)",
];
const seatColor = (seat: string | null): string => {
  if (!seat) return "var(--text-tertiary)";
  let h = 0;
  for (let i = 0; i < seat.length; i++) h = (h * 31 + seat.charCodeAt(i)) >>> 0;
  return SEAT_COLORS[h % SEAT_COLORS.length];
};

const fmtDur = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
};

const fmtTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

/** FR5.2 顶部固定摘要条。 */
export const RunsSummaryBar: React.FC<{ summary: GroupInsight["summary"] }> = ({ summary }) => {
  const { t } = useI18n();
  return (
  <div className="runs-summary-bar">
    <div className="run-summary-cell">
      <span className="run-summary-val">{summary.run_count}</span>
      <span className="run-summary-key">{t("insight.summary.runs")}</span>
    </div>
    <div className="run-summary-cell">
      <span className="run-summary-val">{summary.prompt_tokens.toLocaleString()}</span>
      <span className="run-summary-key">{t("insight.summary.promptIn")}</span>
    </div>
    <div className="run-summary-cell">
      <span className="run-summary-val">{summary.output_tokens.toLocaleString()}</span>
      <span className="run-summary-key">{t("insight.summary.outputOut")}</span>
    </div>
    <div className="run-summary-cell">
      <span className="run-summary-val">{fmtDur(summary.total_duration_ms)}</span>
      <span className="run-summary-key">{t("insight.summary.duration")}</span>
    </div>
    <div className="run-summary-cell">
      <span className="run-summary-val">¥{summary.est_cost_yuan.toFixed(3)}</span>
      <span className="run-summary-key">{t("insight.summary.cost")}</span>
    </div>
  </div>
  );
};

/** 单条甘特 bar + 下钻（FR5.3）。IX-8 按密度档位渲染步骤明细。 */
const GanttRow: React.FC<{
  item: RunWithSteps;
  resolveWorkerName: (seat: string | null) => string;
  density: DensityLevel;
}> = ({ item, resolveWorkerName, density }) => {
  const { t } = useI18n();
  const { run, steps } = item;
  const [open, setOpen] = useState(false);
  const dur = run.ended_at != null ? Math.max(0, run.ended_at - run.started_at) : undefined;
  const color = seatColor(run.seat_id);
  const statusLabel =
    run.status === "ok" ? t("insight.status.ok") : run.status === "running" ? t("insight.status.running") : run.status;
  // IX-8：密度「只看结论」时仍可点击展开（默认折叠）；「看步骤/看全部」默认展开。
  const effOpen = density === "conclusion" ? open : true;
  const showArgs = density === "all";

  return (
    <div className={`gantt-row${open ? " open" : ""}`}>
      <button type="button" className="gantt-row-main" onClick={() => setOpen((v) => !v)}>
        <span className="gantt-kind" title={run.kind}>
          {run.kind === "worker" ? <Icons.Bot size={12} /> : run.kind === "chat" ? <Icons.User size={12} /> : <Icons.Zap size={12} />}
        </span>
        <span className="gantt-seat" style={{ color }}>
          {resolveWorkerName(run.seat_id)}
        </span>
        <span className={`gantt-track`}>
          <span
            className="gantt-bar"
            style={{
              background: color,
              // 高度固定，宽度按耗时比例动态（内联仅动态值，符合样式规范）
              width: `${Math.min(100, Math.max(6, dur ?? 6))}%`,
            }}
          >
            <span className="gantt-bar-label">{dur ? fmtDur(dur) : "…"}</span>
          </span>
        </span>
        <span className="gantt-model">{run.model ?? "—"}</span>
        <span className="gantt-tokens">
          {run.prompt_tokens + run.output_tokens > 0
            ? `${(run.prompt_tokens + run.output_tokens).toLocaleString()} tok`
            : ""}
        </span>
        <span className={`gantt-status gantt-status-${run.status}`}>{statusLabel}</span>
        <span className={"gantt-caret" + (open ? " open" : "")}>
          <Icons.ChevronRight size={9} />
        </span>
      </button>

      {effOpen && (
        <div className="gantt-detail">
          <div className="gantt-detail-meta">
            <span>{fmtTime(run.started_at)} → {run.ended_at ? fmtTime(run.ended_at) : "…"}</span>
            <span>{t("insight.iterations", { n: run.iterations })}</span>
            <span>{run.prompt_tokens.toLocaleString()} in / {run.output_tokens.toLocaleString()} out</span>
            <code>{run.id.slice(0, 8)}</code>
          </div>
          {steps.length === 0 ? (
            <div className="gantt-no-steps">{t("insight.noSteps")}</div>
          ) : (
            <div className="gantt-steps">
              {steps.map((s) => (
                <div key={s.seq} className={`gantt-step gantt-step-${s.outcome}`}>
                  <span className="gantt-step-kind">
                    {s.kind === "llm" ? "LLM" : s.kind === "tool" ? t("insight.stepTool") : t("insight.stepApproval")}
                  </span>
                  <span className="gantt-step-name">{s.name ?? "—"}</span>
                  {s.origin && <code className="gantt-step-origin">{s.origin}</code>}
                  {s.duration_ms != null && (
                    <span className="gantt-step-dur">{fmtDur(s.duration_ms)}</span>
                  )}
                  <span className={`gantt-step-outcome gantt-step-outcome-${s.outcome}`}>
                    {s.outcome === "ok" ? "✓" : s.outcome === "failed" ? "✗" : t("insight.stepNotReady")}
                  </span>
                  {/* IX-8「看全部」：工具入参摘要（F13 已打码，无密钥）。 */}
                  {showArgs && s.args_digest && (
                    <code className="gantt-step-args" title={s.args_digest}>
                      {s.args_digest}
                    </code>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * R5「运行」视图（自拉数据）：摘要条 + 甘特时间线。
 * 挂载点：GroupsPage 群详情第 4 个 tab（MainView="runs"）。
 */
export const RunsView: React.FC<{
  groupId: string;
  resolveWorkerName: (seat: string | null) => string;
}> = ({ groupId, resolveWorkerName }) => {
  const { t } = useI18n();
  const [insight, setInsight] = useState<GroupInsight | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // IX-8：信息密度（默认「看步骤」——既有行为的等价档位）。
  const [density, setDensity] = useState<DensityLevel>("steps");
  // IX-14：回放导出状态（exporting / 成功路径 / 失败消息）。
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const handleExport = async () => {
    if (!groupId || exporting) return;
    setExporting(true);
    setExportMsg(null);
    try {
      const p = await exportRunReplay(groupId);
      setExportMsg({ ok: true, text: t("insight.exported", { path: p }) });
    } catch (e) {
      setExportMsg({ ok: false, text: t("insight.exportFail", { err: friendlyError(e) }) });
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setInsight(null);
    setErr(null);
    insightGroupRuns(groupId)
      .then((d) => {
        if (!cancelled) setInsight(d);
      })
      .catch((e) => {
        if (!cancelled) setErr(t("insight.loadFail"));
      });
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  if (err) return <div className="runs-empty">{err}</div>;
  if (!insight) return <div className="runs-empty">{t("insight.loading")}</div>;
  if (insight.runs.length === 0) {
    return (
      <div className="runs-view">
        <RunsSummaryBar summary={insight.summary} />
        <div className="runs-empty">{t("insight.empty")}</div>
      </div>
    );
  }

  return (
    <div className="runs-view">
      <div className="runs-head">
        <RunsSummaryBar summary={insight.summary} />
        <div className="runs-tools">
          {/* IX-14：导出自包含 HTML 回放（可离线分享）。 */}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void handleExport()}
            disabled={exporting}
            title={t("insight.exportHint")}
          >
            {exporting ? t("insight.exporting") : t("insight.export")}
          </button>
          <DensityToggle value={density} onChange={setDensity} />
        </div>
      </div>
      {exportMsg && (
        <div className={"runs-export-msg " + (exportMsg.ok ? "ok" : "err")} role="status">
          {exportMsg.text}
        </div>
      )}
      {/* IX-10：变更集审阅（本次群协作改了哪些文件、谁改的、可一键回滚）。 */}
      <ChangesetPanel groupId={groupId} />
      <div className="gantt-list">
        {insight.runs.map((item) => (
          <GanttRow
            key={item.run.id}
            item={item}
            resolveWorkerName={resolveWorkerName}
            density={density}
          />
        ))}
      </div>
    </div>
  );
};
