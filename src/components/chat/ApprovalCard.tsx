import React, { useState } from "react";
import type { PendingApproval } from "../../types";
import { humanizeApprovalTitle } from "../../utils/humanize";
import { Icons } from "../common/Icons";
import { useI18n } from "../../i18n/I18nProvider";

/**
 * A-4 四态审批卡片（R3 / D9）：
 * - Accept（允许）→ 原参执行
 * - Ignore（拒绝）→ 不执行
 * - Edit（改参）→ 用编辑后的参数执行（PRD 判定价值最高）
 * - Respond（反馈）→ 不执行，把反馈喂回 LLM 让它换做法
 *
 * 复用 `approval-inline` / `hitl-btn` 样式体系（App.css 令牌）；新增输入框样式
 * `approval-input` 在 App.css 一并补齐（仅引用令牌）。
 */
export const ApprovalCard: React.FC<{
  approval: PendingApproval;
  onDecide: (action: "accept" | "edit" | "respond" | "ignore", args?: unknown, feedback?: string) => void;
  compact?: boolean;
}> = ({ approval, onDecide, compact }) => {
  const { t } = useI18n();
  const [panel, setPanel] = useState<"edit" | "respond" | null>(null);
  const [editArgs, setEditArgs] = useState(() => pretty(approval.tool_args));
  const [feedback, setFeedback] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submitEdit = () => {
    try {
      const parsed = JSON.parse(editArgs);
      setErr(null);
      onDecide("edit", parsed);
    } catch {
      setErr(t("approval.errJson"));
    }
  };

  const submitRespond = () => {
    if (!feedback.trim()) {
      setErr(t("approval.errFeedback"));
      return;
    }
    setErr(null);
    onDecide("respond", undefined, feedback.trim());
  };

  return (
    <div className="approval-inline">
      <div className="approval-inline-title">
        {approval.risk === "high" ? (
          <span className="approval-risk high" title={t("approval.highRisk")}>{t("approval.high")}</span>
        ) : (
          <span className="approval-risk" title={t("approval.riskLevel")}>{t("approval.mid")}</span>
        )}
        <span>{t("approval.needAuth", { title: humanizeApprovalTitle(approval.tool_name, approval.tool_args) })}</span>
        {approval.seat && <span className="approval-seat">{t("approval.fromWorker", { seat: approval.seat })}</span>}
      </div>

      {!compact && (
        <pre className="approval-args">{approval.tool_args}</pre>
      )}

      {err && <div className="approval-err">{err}</div>}

      {panel === "edit" && (
        <div className="approval-panel">
          <textarea
            className="approval-input"
            rows={4}
            value={editArgs}
            spellCheck={false}
            onChange={(e) => setEditArgs(e.target.value)}
          />
          <div className="approval-panel-actions">
            <button type="button" className="hitl-btn approve" onClick={submitEdit}>
              <Icons.Zap size={12} /> {t("approval.editExecute")}
            </button>
            <button type="button" className="hitl-btn" onClick={() => setPanel(null)}>{t("common.cancel")}</button>
          </div>
        </div>
      )}

      {panel === "respond" && (
        <div className="approval-panel">
          <textarea
            className="approval-input"
            rows={3}
            value={feedback}
            placeholder={t("approval.placeholder")}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="approval-panel-actions">
            <button type="button" className="hitl-btn approve" onClick={submitRespond}>
              <Icons.MessageSquare size={12} /> {t("approval.sendFeedback")}
            </button>
            <button type="button" className="hitl-btn" onClick={() => setPanel(null)}>{t("common.cancel")}</button>
          </div>
        </div>
      )}

      <div className="approval-inline-actions">
        <button type="button" className="hitl-btn reject" onClick={() => onDecide("ignore")}>{t("approval.reject")}</button>
        <button type="button" className="hitl-btn" onClick={() => { setErr(null); setPanel(panel === "respond" ? null : "respond"); }}>
          <Icons.MessageSquare size={12} /> {t("approval.feedback")}
        </button>
        <button type="button" className="hitl-btn" onClick={() => { setErr(null); setPanel(panel === "edit" ? null : "edit"); }}>
          {t("approval.editArgs")}
        </button>
        <button type="button" className="hitl-btn approve" onClick={() => onDecide("accept")}>{t("approval.allow")}</button>
      </div>
    </div>
  );
};

function pretty(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}
