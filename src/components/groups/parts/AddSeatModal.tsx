import { useState } from "react";
import { useI18n } from "../../../i18n/I18nProvider";
import type { DictKey } from "../../../i18n/dict";
import { useDialogA11y } from "../../common/useDialogA11y";
import { Icons } from "../../common/Icons";
import type { AgentProfile, Worker } from "../../../types";
export function AddSeatModal({
  presets,
  existing,
  resolveName,
  onCancel,
  onAdd,
  onAddCapability,
  t,
}: {
  presets: AgentProfile[];
  existing: Set<string>;
  resolveName: (ref: string) => string;
  onCancel: () => void;
  onAdd: (agentRef: string, capabilities: string[]) => void | Promise<void>;
  onAddCapability: (capabilities: string[]) => void | Promise<void>;
  t: (k: DictKey, v?: Record<string, string | number>) => string;
}) {
  const [mode, setMode] = useState<"preset" | "capability">("preset");
  const [pickId, setPickId] = useState("");
  const [capsText, setCapsText] = useState("");
  const modalRef = useDialogA11y<HTMLDivElement>(true, onCancel);
  const available = presets.filter((p) => !existing.has(p.id));

  const confirmPreset = () => {
    if (!pickId) return;
    const preset = presets.find((p) => p.id === pickId);
    void onAdd(pickId, preset?.capabilities ?? []);
    onCancel();
  };

  const confirmCapability = () => {
    const caps = capsText.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (caps.length === 0) return;
    void onAddCapability(caps);
    onCancel();
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal modal-wide"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("groups.info.addAgent")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">{t("groups.info.addAgent")}</h2>

        <div className="segmented-control seat-seg">
          <button
            className={mode === "preset" ? "active" : ""}
            onClick={() => setMode("preset")}
            type="button"
          >
            {t("groups.agent.preset")}
          </button>
          <button
            className={mode === "capability" ? "active" : ""}
            onClick={() => setMode("capability")}
            type="button"
          >
            {t("groups.agent.capability")}
          </button>
        </div>

        {mode === "preset" ? (
          <>
            <p className="modal-subtitle">{t("groups.agent.pickHint")}</p>
            {available.length === 0 ? (
              <div className="groups-empty">{t("groups.members.allAdded")}</div>
            ) : (
              <div className="seat-card-grid">
                {available.map((p) => (
                  <button
                    key={p.id}
                    className={`seat-card ${pickId === p.id ? "active" : ""}`}
                    onClick={() => setPickId(p.id)}
                    type="button"
                  >
                    <span className="seat-card-avatar">{p.name.slice(0, 1)}</span>
                    <span className="seat-card-name">{p.name}</span>
                    <span className="seat-card-model">{p.model}</span>
                    {p.capabilities.length > 0 && (
                      <span className="seat-card-caps">
                        {p.capabilities.slice(0, 3).map((c) => (
                          <span key={c} className="seat-card-cap">{c}</span>
                        ))}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={onCancel}>
                {t("common.cancel")}
              </button>
              <button className="btn btn-primary" disabled={!pickId} onClick={confirmPreset}>
                {t("common.confirm")}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="modal-subtitle">{t("groups.agent.capabilityHint")}</p>
            <div className="modal-field">
              <label htmlFor="cap-input">{t("groups.member.capabilities")}</label>
              <input
                id="cap-input"
                value={capsText}
                onChange={(e) => setCapsText(e.target.value)}
                placeholder="search, summarize"
                autoFocus
              />
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={onCancel}>
                {t("common.cancel")}
              </button>
              <button
                className="btn btn-primary"
                disabled={capsText.trim().length === 0}
                onClick={confirmCapability}
              >
                {t("common.confirm")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── 席位详情抽屉 ──
