import { useMemo } from "react";
import { useI18n } from "../../../i18n/I18nProvider";
import type { DictKey } from "../../../i18n/dict";
import { Icons } from "../../common/Icons";
import type { Deliverable, DeliverableKind, Worker } from "../../../types";
import { delivFilterKey, delivKindKey, fmtDelivTime, agentDisplayName } from "./helpers";
export function GroupDeliverables({
  groupId,
  deliverables,
  workers,
  filter,
  setFilter,
  search,
  setSearch,
  resolveName,
  onOpen,
  t,
}: {
  groupId: string;
  deliverables: Deliverable[];
  workers: Worker[];
  filter: "all" | DeliverableKind;
  setFilter: (f: "all" | DeliverableKind) => void;
  search: string;
  setSearch: (s: string) => void;
  resolveName: (ref: string) => string;
  onOpen: (d: Deliverable) => void;
  t: (k: DictKey, v?: Record<string, string | number>) => string;
}) {
  const { locale } = useI18n();
  const filters: Array<"all" | DeliverableKind> = ["all", "reply", "task_output", "summary"];

  // 同名 Worker（同一 Agent 画像）会出现多个，给每个分配稳定的「名字 #N」，
  // 与群聊气泡、@ 选择器保持一致，使产出物里也能区分是谁的产出。
  const workerLabelById = useMemo(() => {
    const byRef = new Map<string, number>();
    const map = new Map<string, string>();
    for (const w of workers) {
      const base = agentDisplayName(w, resolveName, t);
      const n = (byRef.get(w.agent_ref) ?? 0) + 1;
      byRef.set(w.agent_ref, n);
      map.set(w.id, n > 1 ? `${base} #${n}` : base);
    }
    return map;
  }, [workers, resolveName, t]);

  const authorLabel = (d: Deliverable): string =>
    d.worker_id
      ? workerLabelById.get(d.worker_id) ?? (d.author ? resolveName(d.author) : "")
      : d.author
        ? resolveName(d.author)
        : "";

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return deliverables.filter((d) => {
      if (filter !== "all" && d.kind !== filter) return false;
      if (!q) return true;
      const author = authorLabel(d);
      return (
        author.toLowerCase().includes(q) ||
        d.title.toLowerCase().includes(q) ||
        d.preview.toLowerCase().includes(q) ||
        d.content.toLowerCase().includes(q)
      );
    });
  }, [deliverables, filter, search, authorLabel]);

  return (
    <div className="deliverables">
      <div className="deliverables-toolbar">
        <p className="deliverables-desc">{t("groups.deliverables.desc")}</p>
        <div className="deliverables-controls">
          <div className="seg-filter" role="tablist" aria-label={t("groups.deliverables.title")}>
            {filters.map((f) => (
              <button
                key={f}
                className={`seg-filter-btn ${filter === f ? "active" : ""}`}
                onClick={() => setFilter(f)}
                type="button"
                role="tab"
                aria-selected={filter === f}
              >
                {t(delivFilterKey(f))}
              </button>
            ))}
          </div>
          <input
            className="deliverables-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("groups.deliverables.search")}
          />
        </div>
        <div className="deliverables-count">
          {t("groups.deliverables.count", { count: filtered.length })}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="groups-empty">{t("groups.deliverables.empty")}</div>
      ) : (
        <div className="deliv-table" role="table">
          <div className="deliv-row deliv-head" role="row">
            <span className="deliv-cell deliv-type">{t("groups.deliverables.colType")}</span>
            <span className="deliv-cell deliv-author">{t("groups.deliverables.colAuthor")}</span>
            <span className="deliv-cell deliv-content">{t("groups.deliverables.colContent")}</span>
            <span className="deliv-cell deliv-time">{t("groups.deliverables.colTime")}</span>
          </div>
          {filtered.map((d) => (
            <button
              key={d.id}
              className="deliv-row deliv-item"
              role="row"
              onClick={() => onOpen(d)}
              type="button"
            >
              <span className="deliv-cell deliv-type">
                <span className={`deliv-kind deliv-kind-${d.kind}`}>{t(delivKindKey(d.kind))}</span>
                {d.meta && <span className="deliv-meta">{d.meta}</span>}
              </span>
              <span className="deliv-cell deliv-author">
                {authorLabel(d) || t("groups.deliverables.noTime")}
              </span>
              <span className="deliv-cell deliv-content">
                <span className="deliv-title">{d.title}</span>
                <span className="deliv-preview">{d.preview}</span>
                {(d.media ?? []).length > 0 && (
                  <span className="deliv-media-row">
                    {(d.media ?? []).slice(0, 3).map((mm, i) => (
                      <span key={i} className={`deliv-media-chip deliv-media-${mm.type}`} title={mm.path}>
                        {mm.type === "image" ? <Icons.Image size={13} /> : <Icons.FileText size={13} />}
                        <span className="deliv-media-name">{mm.name}</span>
                      </span>
                    ))}
                    {(d.media ?? []).length > 3 && (
                      <span className="deliv-media-more">+{(d.media ?? []).length - 3}</span>
                    )}
                  </span>
                )}
              </span>
              <span className="deliv-cell deliv-time">
                {d.created_at ? fmtDelivTime(d.created_at, locale) : t("groups.deliverables.noTime")}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

