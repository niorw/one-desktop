import React, { useEffect, useState } from "react";
import * as tauri from "../../services/tauri";
import type { AgentProfile, SuggestedSeat, UpgradeProposal } from "../../types";
import { useDialogA11y } from "../common/useDialogA11y";
import { useI18n } from "../../i18n/I18nProvider";

/**
 * R7 单聊一键升级为群（IX-15 / FR7.1/FR7.2/FR7.4）——单聊侧预填弹窗。
 *
 * 打开即一次 LLM 调用预填「建议席位 + 任务拆解 + 成本预估」；用户只增删改：
 * - 席位：建议清单展示（name·capability），下方从已有 Agent 预设勾选实际席位；
 * - 任务：textarea 每行一个子任务（来自建议，可编辑）；
 * - 确认 → `session_confirm_upgrade`（建群 + 历史灌群种子 + 派活 + session.mode="group"），
 *   宿主把顶层导航切到 group、activeGroupId 指向新群（群已提升为与 chat 平级的导航项）。
 */
export const UpgradeModal: React.FC<{
  sessionId: string;
  presets: AgentProfile[];
  onClose: () => void;
  onConfirm: (groupId: string) => void;
}> = ({ sessionId, presets, onClose, onConfirm }) => {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [proposal, setProposal] = useState<UpgradeProposal | null>(null);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [ownerId, setOwnerId] = useState(presets[0]?.id ?? "");
  const [seatIds, setSeatIds] = useState<string[]>(presets.slice(0, 2).map((p) => p.id));
  const [tasksText, setTasksText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const modalRef = useDialogA11y<HTMLDivElement>(true, onClose);

  const propose = async () => {
    setLoading(true);
    setErr(null);
    try {
      const p = await tauri.sessionUpgradePropose(sessionId);
      setProposal(p);
      setName(p.title);
      setGoal(p.goal);
      setTasksText(p.tasks.map((t) => t.description).join("\n"));
      // 建议 N 个席位 → 默认勾选前 N 个已有预设（不足则全选）
      const n = Math.max(1, p.seats.length);
      setSeatIds(presets.slice(0, n).map((x) => x.id));
    } catch (e) {
      setErr(t("upgrade.errPropose", { err: String(e) }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void propose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const toggleSeat = (id: string) =>
    setSeatIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const canSubmit = name.trim().length > 0 && ownerId.length > 0 && seatIds.length > 0 && !loading;

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      const tasks = tasksText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((description) => ({
          id: `st_${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`,
          worker_id: null,
          description,
          input_refs: [] as string[],
          output_spec: null,
          depends_on: [] as string[],
          seat_strategy: null,
          capability: null,
          reasoning: null,
        }));
      const group = await tauri.sessionConfirmUpgrade(
        sessionId,
        name.trim(),
        goal.trim(),
        ownerId,
        seatIds,
        tasks
      );
      onConfirm(group.id);
    } catch (e) {
      setErr(t("upgrade.errUpgrade", { err: String(e) }));
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal modal-wide"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("upgrade.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">{t("upgrade.title")}</h2>
        <p className="upg-desc">
          {t("upgrade.desc")}
        </p>

        {err && <div className="modal-error">{err}</div>}

        {loading ? (
          <div className="upg-loading">{t("upgrade.loading")}</div>
        ) : proposal ? (
          <>
            <div className="modal-field">
              <label htmlFor="upg-name">{t("upgrade.name")}</label>
              <input id="upg-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="modal-field">
              <label htmlFor="upg-goal">{t("upgrade.goal")}</label>
              <input id="upg-goal" value={goal} onChange={(e) => setGoal(e.target.value)} />
            </div>

            <div className="modal-field">
              <label>{t("upgrade.suggestAgents")}</label>
              <div className="upg-seat-suggest">
                {proposal.seats.length === 0 && <span className="seat-empty">—</span>}
                {proposal.seats.map((s: SuggestedSeat, i) => (
                  <span key={i} className="upg-seat-chip">
                    <b>{s.name}</b> · {s.capability}
                  </span>
                ))}
              </div>
            </div>

            <div className="modal-field">
              <label htmlFor="upg-owner">{t("upgrade.owner")}</label>
              <select id="upg-owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                {presets.length === 0 && <option value="">—</option>}
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            <div className="modal-field">
              <label>{t("upgrade.pickAgents")}</label>
              <div className="seat-list">
                {presets.map((p) => (
                  <label key={p.id} className="seat-item">
                    <input
                      type="checkbox"
                      checked={seatIds.includes(p.id)}
                      onChange={() => toggleSeat(p.id)}
                    />
                    <span>{p.name}</span>
                  </label>
                ))}
                {presets.length === 0 && <span className="seat-empty">—</span>}
              </div>
            </div>

            <div className="modal-field">
              <label htmlFor="upg-tasks">{t("upgrade.tasks")}</label>
              <textarea
                id="upg-tasks"
                className="upg-tasks-input"
                rows={Math.max(3, proposal.tasks.length + 1)}
                value={tasksText}
                onChange={(e) => setTasksText(e.target.value)}
              />
            </div>

            {(proposal.est_calls > 0 || proposal.est_tokens > 0) && (
              <div className="upg-cost-bar">
                <span className="upg-cost-title">{t("upgrade.costTitle")}</span>
                <span>{t("upgrade.costCalls", { n: proposal.est_calls })}</span>
                <span>{t("upgrade.costTokens", { n: proposal.est_tokens.toLocaleString() })}</span>
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
              <button
                className="btn btn-primary"
                disabled={!canSubmit || submitting}
                onClick={() => void submit()}
              >
                {submitting ? t("upgrade.submitting") : t("upgrade.title")}
              </button>
            </div>
          </>
        ) : (
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
            <button type="button" className="btn btn-primary" onClick={() => void propose()}>{t("upgrade.retry")}</button>
          </div>
        )}
      </div>
    </div>
  );
};
