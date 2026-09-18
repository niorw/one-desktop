import React, { useMemo, useState } from "react";
import type { ProposalPayload } from "../../types";
import { useDialogA11y } from "../common/useDialogA11y";
import { Icons } from "../common/Icons";
import "./agentPlan.css";

/**
 * 能力②「方案多选项确认」弹窗（参考 WorkBuddy AskUserQuestion 的选项卡形态）。
 *
 * 内核侧是 fail-closed 阻塞：ProposalBroker 注册后 await 决策，5 分钟无应答按
 * rejected 收（本回合 StopReason::Cancelled），所以这里**不允许点遮罩关闭** ——
 * 静默关掉会让用户以为"取消了"，实际内核仍在阻塞等待。只能走三个明确出口：
 * 选项 / 自定义方向 / 取消本次任务。
 *
 * Esc 走 useDialogA11y → 与「取消本次任务」同义（显式 rejected，立刻解除阻塞）。
 */
export const ProposalModal: React.FC<{
  proposal: ProposalPayload;
  onResolve: (decision: "selected" | "custom" | "rejected", optionId?: string, customText?: string) => void;
}> = ({ proposal, onResolve }) => {
  // 默认选中内核推荐项；没有推荐项则选第一个，避免"确认"按钮开局就是灰的。
  const defaultId = useMemo(
    () => proposal.options.find((o) => o.recommended)?.id ?? proposal.options[0]?.id ?? "",
    [proposal.options]
  );
  const [selected, setSelected] = useState<string>(defaultId);
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState("");

  const cancel = () => onResolve("rejected");
  const ref = useDialogA11y<HTMLDivElement>(true, cancel);

  const canConfirm = customMode ? customText.trim().length > 0 : Boolean(selected);

  const confirm = () => {
    if (!canConfirm) return;
    if (customMode) onResolve("custom", undefined, customText.trim());
    else onResolve("selected", selected);
  };

  return (
    <div className="modal-overlay proposal-overlay">
      <div
        className="modal proposal-modal"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="proposal-title"
        tabIndex={-1}
      >
        <div className="proposal-head">
          <span className="proposal-badge">
            <Icons.Compass size={13} /> 需要你确认方向
          </span>
          <h3 className="modal-title proposal-title" id="proposal-title">
            {proposal.title}
          </h3>
          {proposal.summary && <p className="proposal-summary">{proposal.summary}</p>}
          {proposal.seat && <span className="proposal-seat">来自 Worker {proposal.seat}</span>}
        </div>

        <div className="proposal-options" role="radiogroup" aria-label="可选方案">
          {proposal.options.map((opt) => {
            const active = !customMode && selected === opt.id;
            return (
              <button
                type="button"
                key={opt.id}
                role="radio"
                aria-checked={active}
                className={`proposal-option${active ? " selected" : ""}`}
                onClick={() => {
                  setCustomMode(false);
                  setSelected(opt.id);
                }}
                onDoubleClick={confirm}
              >
                <span className="proposal-option-top">
                  <span className="proposal-option-label">{opt.label}</span>
                  {opt.recommended && <span className="proposal-rec">推荐</span>}
                  <RiskDot risk={opt.risk} />
                </span>
                {opt.description && (
                  <span className="proposal-option-desc">{opt.description}</span>
                )}
              </button>
            );
          })}

          {/* 兜底出口：预置选项都不合适时，直接给 Agent 写方向（内核按 custom 处理） */}
          <button
            type="button"
            role="radio"
            aria-checked={customMode}
            className={`proposal-option proposal-option-custom${customMode ? " selected" : ""}`}
            onClick={() => setCustomMode(true)}
          >
            <span className="proposal-option-top">
              <span className="proposal-option-label">都不是，我来说</span>
            </span>
            <span className="proposal-option-desc">自己描述想要的方向，Agent 按你的说法继续</span>
          </button>
        </div>

        {customMode && (
          <textarea
            className="approval-input proposal-custom-input"
            rows={3}
            autoFocus
            value={customText}
            placeholder="例如：先只做只读分析，不要动任何文件"
            onChange={(e) => setCustomText(e.target.value)}
          />
        )}

        <div className="modal-actions proposal-actions">
          <button type="button" className="hitl-btn reject" onClick={cancel}>
            取消本次任务
          </button>
          <button type="button" className="hitl-btn approve" disabled={!canConfirm} onClick={confirm}>
            <Icons.Check size={12} /> 按此继续
          </button>
        </div>
      </div>
    </div>
  );
};

/** 风险点：low 绿 / medium 橙 / high 红。附 title + aria-label，不靠纯色传达语义。 */
const RiskDot: React.FC<{ risk?: string }> = ({ risk }) => {
  const level = risk === "high" ? "high" : risk === "low" ? "low" : "medium";
  const label = level === "high" ? "高风险" : level === "low" ? "低风险" : "中风险";
  return <span className={`proposal-risk risk-${level}`} role="img" aria-label={label} title={label} />;
};
