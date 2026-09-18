//! F5：广播（@全员）二次确认 + 成本预估。
//!
//! 广播语义是「全部在线席位并发作答后竞速」——一次点击就会同时点燃 N 个 LLM 回合，
//! 是群协作里最贵的单个动作。这里在发出前把「打扰谁 / 花多少」摊开给群主看。

import type { DictKey } from "../../../i18n/dict";
import { Icons } from "../../common/Icons";
import { useDialogA11y } from "../../common/useDialogA11y";

/** 从未跑过的席位没有历史实测值，按一轮 4k token 兜底估算。 */
export const DEFAULT_EST_TOKENS = 4000;
/** 混合均价（元 / 百万 token）：介于常见模型的输入 2 与输出 8 之间取中位数。 */
export const BLENDED_YUAN_PER_MTOK = 5;

export interface BroadcastTarget {
  id: string;
  name: string;
  /** 该席位最近一轮实测 token；无历史则为 undefined（走兜底估算）。 */
  lastTokens?: number;
}

/** 纯函数：按各席位最近一轮实测（无历史走兜底）汇总本次广播的 token / 费用预估。 */
export function estimateBroadcast(targets: BroadcastTarget[]): {
  tokens: number;
  yuan: number;
  measured: number;
} {
  let tokens = 0;
  let measured = 0;
  for (const tgt of targets) {
    if (tgt.lastTokens && tgt.lastTokens > 0) {
      tokens += tgt.lastTokens;
      measured += 1;
    } else {
      tokens += DEFAULT_EST_TOKENS;
    }
  }
  return { tokens, yuan: (tokens / 1_000_000) * BLENDED_YUAN_PER_MTOK, measured };
}

export function BroadcastConfirmModal({
  targets,
  sending,
  onConfirm,
  onCancel,
  t,
}: {
  targets: BroadcastTarget[];
  sending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  t: (k: DictKey, v?: Record<string, string | number>) => string;
}) {
  const est = estimateBroadcast(targets);
  const modalRef = useDialogA11y<HTMLDivElement>(true, onCancel);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("groups.broadcast.title")}
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">{t("groups.broadcast.title")}</h2>
        <p className="modal-subtitle">
          {t("groups.broadcast.subtitle", { count: targets.length })}
        </p>

        <div className="bc-cost">
          <div className="bc-cost-item">
            <span className="bc-cost-label">{t("groups.broadcast.agents")}</span>
            <span className="bc-cost-val">{targets.length}</span>
          </div>
          <div className="bc-cost-item">
            <span className="bc-cost-label">{t("groups.broadcast.tokens")}</span>
            <span className="bc-cost-val">~{est.tokens.toLocaleString()}</span>
          </div>
          <div className="bc-cost-item">
            <span className="bc-cost-label">{t("groups.broadcast.cost")}</span>
            <span className="bc-cost-val">~¥{est.yuan.toFixed(3)}</span>
          </div>
        </div>

        <ul className="bc-targets">
          {targets.map((tgt) => (
            <li key={tgt.id} className="bc-target">
              <span className="bc-target-name">{tgt.name}</span>
              <span className="bc-target-tokens">
                {tgt.lastTokens && tgt.lastTokens > 0
                  ? `~${tgt.lastTokens.toLocaleString()}`
                  : t("groups.broadcast.noHistory")}
              </span>
            </li>
          ))}
        </ul>

        <p className="bc-hint">
          <Icons.AlertTriangle size={13} />
          <span>
            {t("groups.broadcast.hint", {
              measured: est.measured,
              fallback: targets.length - est.measured,
              price: BLENDED_YUAN_PER_MTOK,
            })}
          </span>
        </p>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={sending}>
            {t("groups.broadcast.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={sending || targets.length === 0}
          >
            {t("groups.broadcast.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
