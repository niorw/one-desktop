import { useEffect, useState } from "react";
import type { Item, TraceRef } from "../../types";
import type { DictKey } from "../../i18n/dict";
import { useDialogA11y } from "../common/useDialogA11y";
import { Icons } from "../common/Icons";
import { getTrace } from "../../services/chatCommands";
import { traceToItems } from "../../hooks/agentState";
import { ProcessPanel } from "../chat/ProcessPanel";

interface Props {
  traceRef: TraceRef;
  onClose: () => void;
  t: (k: DictKey, v?: Record<string, string | number>) => string;
}

/**
 * 轨迹下钻抽屉（P1 溯源跳转，ADR-025）。
 * 复用既有 `get_trace` 通道与 `traceToItems` 投影，经 `ProcessPanel` 以 replay 态回放
 * 该产出物对应会话（reply → roundtable session；task_output → worker run session）的
 * 思考/工具/观察全过程，供判断结果是否可信（PRD US-3）。
 */
export function ArtifactTraceDrawer({ traceRef, onClose, t }: Props) {
  const drawerRef = useDialogA11y<HTMLDivElement>(true, onClose);
  const [items, setItems] = useState<Item[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getTrace(traceRef.key)
      .then((rows) => {
        if (cancelled) return;
        setItems(rows.length > 0 ? traceToItems(rows) : []);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(typeof e === "string" ? e : "读取轨迹失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [traceRef.key]);

  const sourceLabel =
    traceRef.source === "run"
      ? (t("groups.deliverables.traceSourceRun") ?? "任务执行")
      : (t("groups.deliverables.traceSourceRound") ?? "圆桌回合");

  return (
    <div
      className="modal-overlay drawer-overlay"
      onClick={(e) => {
        // 阻止冒泡到外层预览 overlay，避免连预览一起关掉
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="drawer artifact-trace-drawer"
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("groups.deliverables.traceTitle")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head artifact-head">
          <div className="drawer-title-row">
            <span className="deliv-kind deliv-kind-trace">⌥</span>
            <div>
              <h2 className="drawer-title">{t("groups.deliverables.traceTitle")}</h2>
              <span className="drawer-sub">
                {sourceLabel} · <code className="artifact-trace-sid">{traceRef.key}</code>
              </span>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label={t("common.cancel")}>
            ✕
          </button>
        </div>

        <div className="artifact-trace-body">
          {loading && (
            <div className="artifact-trace-empty">
              <span>{t("groups.deliverables.traceLoading") ?? "正在加载轨迹…"}</span>
            </div>
          )}
          {!loading && error && (
            <div className="artifact-trace-empty artifact-trace-error">
              <Icons.AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          )}
          {!loading && !error && items && items.length === 0 && (
            <div className="artifact-trace-empty">
              <Icons.Info size={16} />
              <span>{t("groups.deliverables.traceEmpty") ?? "该会话暂无可追溯轨迹。"}</span>
            </div>
          )}
          {!loading && !error && items && items.length > 0 && (
            <ProcessPanel items={items} replay />
          )}
        </div>
      </div>
    </div>
  );
}
