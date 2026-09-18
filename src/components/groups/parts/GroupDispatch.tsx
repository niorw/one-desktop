import { useEffect, useState } from "react";
import { useI18n } from "../../../i18n/I18nProvider";
import type { DictKey } from "../../../i18n/dict";
import { Icons } from "../../common/Icons";
import type { PlaybookDto, SubTask, Worker } from "../../../types";
// playbookList 是 chat 命令层共享工具（圆桌派活可引用已有 Playbook），显式引入避免整组命令耦合。
import { playbookList } from "../../../services/chatCommands";
import { DraftSubTask, agentDisplayName, uid, WORKER_STATUS_KEY } from "./helpers";
export function GroupDispatch({
  workers,
  resolveName,
  onDispatch,
  onDone,
  t,
}: {
  workers: Worker[];
  resolveName: (ref: string) => string;
  onDispatch: (subtasks: SubTask[]) => void | Promise<void>;
  onDone?: () => void;
  t: (k: DictKey, v?: Record<string, string | number>) => string;
}) {
  const [drafts, setDrafts] = useState<DraftSubTask[]>([]);
  // F9 Playbook：可复用任务拆解库（应用 → 预填草稿，用户可编辑再派活）。
  const [playbooks, setPlaybooks] = useState<PlaybookDto[]>([]);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    playbookList()
      .then(setPlaybooks)
      .catch(() => setPlaybooks([]));
  }, []);

  /** 应用 Playbook：steps 的 depends_on 用数组索引 → 映射为新草稿 key。 */
  const applyPlaybook = async (id: string) => {
    const book = playbooks.find((p) => p.id === id);
    if (!book) return;
    setApplying(true);
    try {
      const keys = book.steps.map(() => uid());
      const next: DraftSubTask[] = book.steps.map((s, i) => ({
        key: keys[i],
        id: "",
        description: s.description,
        workerId: "",
        dependsOn: (s.depends_on ?? [])
          .map((depIdx) => keys[depIdx])
          .filter((k): k is string => Boolean(k)),
        capability: s.capability ?? "",
        reasoning: s.reasoning ?? "",
      }));
      // 追加到现有草稿后（不覆盖用户已输入的）。
      setDrafts((prev) => [...prev, ...next]);
    } finally {
      setApplying(false);
    }
  };

  const addDraft = () =>
    setDrafts((prev) => [
      ...prev,
      {
        key: uid(),
        id: "",
        description: "",
        workerId: "",
        dependsOn: [],
        capability: "",
        reasoning: "",
      },
    ]);

  const updateDraft = (key: string, patch: Partial<DraftSubTask>) =>
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  const removeDraft = (key: string) =>
    setDrafts((prev) =>
      prev
        .filter((d) => d.key !== key)
        .map((d) => ({ ...d, dependsOn: d.dependsOn.filter((dep) => dep !== key) })),
    );

  const toggleDep = (key: string, depKey: string) =>
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.key !== key) return d;
        const has = d.dependsOn.includes(depKey);
        return {
          ...d,
          dependsOn: has ? d.dependsOn.filter((x) => x !== depKey) : [...d.dependsOn, depKey],
        };
      }),
    );

  const canSubmit = drafts.length > 0 && drafts.every((d) => d.description.trim().length > 0);

  const submit = () => {
    if (!canSubmit) return;
    const subtasks: SubTask[] = drafts.map((d) => ({
      id: d.id || uid(),
      worker_id: d.workerId || null,
      description: d.description.trim(),
      input_refs: [],
      output_spec: null,
      depends_on: d.dependsOn,
      seat_strategy: null,
      capability: d.capability.trim() || null,
      reasoning: d.reasoning.trim() || null,
    }));
    onDispatch(subtasks);
    setDrafts([]);
    onDone?.();
  };

  return (
    <div className="group-dispatch">
      <div className="dispatch-head">
        <p className="group-dispatch-hint">{t("groups.dispatch.hint")}</p>
        {/* F9 Playbook：一键应用历史拆解（可编辑后再派活）。 */}
        {playbooks.length > 0 && (
          <select
            className="pb-apply"
            aria-label={t("groups.playbook.apply")}
            value=""
            disabled={applying}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "") return;
              void applyPlaybook(v);
              e.target.value = "";
            }}
          >
            <option value="" disabled>
              {t("groups.playbook.apply")}
            </option>
            {playbooks.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {onDone && (
          <button className="btn btn-ghost btn-sm" onClick={onDone}>
            {t("groups.dispatch.back")}
          </button>
        )}
      </div>

      {drafts.length === 0 ? (
        <div className="groups-empty">{t("groups.dispatch.empty")}</div>
      ) : (
        <div className="dispatch-list">
          {drafts.map((d, i) => (
            <div key={d.key} className="dispatch-row">
              <div className="dispatch-row-head">
                <span className="dispatch-index">#{i + 1}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => removeDraft(d.key)}>
                  ✕
                </button>
              </div>
              <textarea
                className="dispatch-desc"
                placeholder={t("groups.dispatch.descPlaceholder")}
                value={d.description}
                onChange={(e) => updateDraft(d.key, { description: e.target.value })}
              />
              <textarea
                className="dispatch-reasoning"
                placeholder={t("groups.dispatch.reasoningPlaceholder")}
                value={d.reasoning}
                onChange={(e) => updateDraft(d.key, { reasoning: e.target.value })}
              />
              <div className="dispatch-controls">
                <label className="dispatch-control">
                  <span>{t("groups.dispatch.worker")}</span>
                  <select
                    value={d.workerId}
                    onChange={(e) => updateDraft(d.key, { workerId: e.target.value })}
                  >
                    <option value="">{t("groups.dispatch.auto")}</option>
                    {workers
                      .filter((w) => w.seat_type !== "Capability")
                      .map((w) => (
                        <option key={w.id} value={w.id}>
                          {agentDisplayName(w, resolveName, t)} · {t(WORKER_STATUS_KEY[w.status])}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="dispatch-control">
                  <span>{t("groups.dispatch.capability")}</span>
                  <input
                    className="dispatch-capability"
                    placeholder="search / summarize"
                    value={d.capability}
                    onChange={(e) => updateDraft(d.key, { capability: e.target.value })}
                  />
                </label>
                {drafts.length > 1 && (
                  <label className="dispatch-control dispatch-control-dep">
                    <span>{t("groups.dispatch.dependsOn")}</span>
                    <div className="dep-list">
                      {drafts
                        .filter((o) => o.key !== d.key)
                        .map((o) => (
                          <label key={o.key} className="dep-item">
                            <input
                              type="checkbox"
                              checked={d.dependsOn.includes(o.key)}
                              onChange={() => toggleDep(d.key, o.key)}
                            />
                            <span>#{drafts.indexOf(o) + 1}</span>
                          </label>
                        ))}
                    </div>
                  </label>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="dispatch-actions">
        <button className="btn btn-secondary" onClick={addDraft}>
          + {t("groups.dispatch.add")}
        </button>
        <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>
          {t("groups.dispatch.submit")}
        </button>
      </div>
    </div>
  );
}

// ── 群内产出物一览表 ──
