import React, { useEffect, useState } from "react";
import type { SeatInsight, WorkerMetric } from "../../types";
import * as tauri from "../../services/tauri";
import { useI18n } from "../../i18n/I18nProvider";

/**
 * R4 席位运行仪表（IX-1）—— insight 层组件。
 *
 * `SeatMiniDash`：席位卡内仪表（实时状态文案 FR4.2 + 历史 token/耗时徽标 FR4.1）；
 * `SeatRunHistory`：详情抽屉里的运行历史（成功率 / 累计成本 / 最近运行）。
 * 数据由宿主注入或自拉，零群状态依赖。
 */

export interface SeatLive {
  /** 空闲 | 思考中 | 正在运行 | 等待审批 */
  label: string;
  /** 具体工具名（FR4.2：「正在运行 `run_shell`」） */
  tool?: string;
}

const fmtDur = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
};

/** 席位卡内迷你仪表：实时状态 + 指标徽标。 */
export const SeatMiniDash: React.FC<{
  live: SeatLive | null;
  metric?: WorkerMetric;
  busy: boolean;
}> = ({ live, metric, busy }) => {
  const { t } = useI18n();
  const stateText = live?.label ?? (busy ? t("insight.seat.busy") : t("insight.seat.idle"));
  return (
    <span className="seat-mini-dash">
      <span className={`seat-live seat-live-${live ? "active" : busy ? "busy" : "idle"}`}>
        {live?.tool ? (
          <>
            {live.label} <code className="seat-live-tool">{live.tool}</code>
          </>
        ) : (
          stateText
        )}
      </span>
      {metric && metric.runs > 0 && (
        <span className="seat-mini-metrics">
          <span className="seat-mini-tok" title={t("insight.seat.tokens")}>
            {(metric.total_tokens / 1000).toFixed(1)}k
          </span>
          <span className="seat-mini-dur" title={t("insight.seat.duration")}>
            {fmtDur(metric.total_duration_ms)}
          </span>
        </span>
      )}
    </span>
  );
};

/**
 * 详情抽屉里的**最近运行列表**（FR4.1 历史部分）。
 *
 * 汇总指标（总运行 / 累计 token / 累计成本）由宿主抽屉统一渲染并注入 `insight`——
 * 避免两块口径打架：抽屉的汇总卡与下方的历史卡若各自取数，会出现
 * 「上面 7,833 token、下面 220,863 token」这类自相矛盾（2026-08-31 修复）。
 * 注入时不再自拉，省一次往返。
 */
export const SeatRunHistory: React.FC<{
  seatId: string;
  insight?: SeatInsight | null;
}> = ({ seatId, insight: injected }) => {
  const { t } = useI18n();
  const [fetched, setFetched] = useState<SeatInsight | null>(null);

  useEffect(() => {
    // 宿主已注入（含显式的 null = 已查过且无数据）→ 不重复拉取。
    if (injected !== undefined) return;
    let cancelled = false;
    tauri
      .insightSeatRuns(seatId, 8)
      .then((d) => {
        if (!cancelled) setFetched(d);
      })
      .catch(() => {
        if (!cancelled) setFetched(null);
      });
    return () => {
      cancelled = true;
    };
  }, [seatId, injected]);

  const insight = injected !== undefined ? injected : fetched;
  if (!insight || insight.recent_runs.length === 0) return null;

  return (
    <div className="seat-run-history">
      <span className="drawer-section-title">{t("insight.history.title")}</span>
      <div className="seat-recent-runs">
        {insight.recent_runs.map((r) => (
          <div key={r.id} className="seat-recent-run">
            <span className={`seat-recent-status seat-recent-status-${r.status}`}>
              {r.status === "ok" ? "✓" : r.status === "failed" ? "✗" : r.status === "running" ? "●" : "—"}
            </span>
            <span className="seat-recent-kind">{r.kind}</span>
            <span className="seat-recent-tokens">
              {r.prompt_tokens + r.output_tokens > 0
                ? `${(r.prompt_tokens + r.output_tokens).toLocaleString()} tok`
                : "—"}
            </span>
            <span className="seat-recent-time">
              {new Date(r.started_at).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
