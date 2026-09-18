//! IX-7：任意消息「分叉 / 重跑」确认弹窗。
//!
//! 两种模式共用一套表单，差别只在默认值与可改项：
//!  - `rerun`（重跑）：锚点固定为触发该发言的原指令，指令默认不改（留空即沿用），
//!    可改的是「换哪个席位来答」——用于横向比较不同 Agent 对同一问题的表现。
//!  - `fork`（分叉）：回到该消息发生的时刻另开一支，指令默认预填原文供改写，
//!    席位可选单个或全员。
//!
//! 无损前提：后端不删任何历史消息，只收窄本轮上下文窗口，因此分叉可反复执行、
//! 原分支随时可回看 —— 弹窗里也如实告知，避免用户误以为会「覆盖」旧结果。

import { useState } from "react";
import type { DictKey } from "../../../i18n/dict";
import { Icons } from "../../common/Icons";
import { useDialogA11y } from "../../common/useDialogA11y";
import type { RoundtableMessage } from "../../../types";

export type RerunMode = "rerun" | "fork";

export function MessageRerunModal({
  mode,
  message,
  seats,
  defaultWorkerId,
  submitting,
  onConfirm,
  onCancel,
  t,
}: {
  mode: RerunMode;
  message: RoundtableMessage;
  /** 可选席位（已排除能力席位，名称为带 #N 的显示名）。 */
  seats: { id: string; name: string }[];
  /** 重跑时默认选中的席位（原作者）。 */
  defaultWorkerId?: string;
  submitting: boolean;
  onConfirm: (workerId: string | null, prompt: string | null) => void;
  onCancel: () => void;
  t: (k: DictKey, v?: Record<string, string | number>) => string;
}) {
  // 分叉默认预填原文供改写；重跑默认留空 = 沿用原指令（不误导用户以为要重写）。
  const [prompt, setPrompt] = useState(mode === "fork" ? message.content : "");
  const [workerId, setWorkerId] = useState<string>(
    mode === "rerun" ? defaultWorkerId ?? "" : "",
  );

  const title = t(`groups.rerun.${mode}.title` as DictKey);
  const subtitle = t(`groups.rerun.${mode}.subtitle` as DictKey);
  const disabled = submitting || (mode === "fork" && prompt.trim().length === 0);
  const modalRef = useDialogA11y<HTMLDivElement>(true, onCancel);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">{title}</h2>
        <p className="modal-subtitle">{subtitle}</p>

        <div className="rerun-origin">
          <span className="rerun-origin-tag">#{message.seq}</span>
          <span className="rerun-origin-text">{excerpt(message.content)}</span>
        </div>

        <label className="rerun-field">
          <span className="rerun-label">{t("groups.rerun.agent")}</span>
          <select
            className="rerun-select"
            value={workerId}
            onChange={(e) => setWorkerId(e.target.value)}
            disabled={submitting}
          >
            <option value="">
              {mode === "rerun"
                ? t("groups.rerun.agentKeep")
                : t("groups.rerun.agentAll")}
            </option>
            {seats.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <label className="rerun-field">
          <span className="rerun-label">{t("groups.rerun.prompt")}</span>
          <textarea
            className="rerun-textarea"
            rows={4}
            value={prompt}
            disabled={submitting}
            placeholder={
              mode === "rerun"
                ? t("groups.rerun.promptKeepHint")
                : t("groups.rerun.promptForkHint")
            }
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>

        <p className="rerun-hint">
          <Icons.Info size={13} />
          <span>{t("groups.rerun.lossless")}</span>
        </p>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={submitting}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onConfirm(workerId || null, prompt.trim() || null)}
            disabled={disabled}
          >
            {t(`groups.rerun.${mode}.confirm` as DictKey)}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 原消息摘要：单行展示，超长截断（仅用于「你正在对哪条操作」的确认提示）。 */
function excerpt(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}
