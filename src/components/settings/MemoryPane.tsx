import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { SegmentedControl } from "../common/Controls";
import { memoryRead, memoryWrite, memorySearch } from "../../services/chatCommands";
import { friendlyError } from "../../services/errors";
import type { MemoryHitDto } from "../../types";

type MemoryTier = "user" | "project" | "memory";

const TIER_LABEL_KEY = {
  user: "settings.memory.tier.user",
  project: "settings.memory.tier.project",
  memory: "settings.memory.tier.memory",
} as const;

const TIER_HINT_KEY = {
  user: "settings.memory.tier.userHint",
  project: "settings.memory.tier.projectHint",
  memory: "settings.memory.tier.memoryHint",
} as const;

const TIER_BADGE: Record<string, string> = {
  user: "user",
  project: "project",
  memory: "long-term",
};

/** 设置 → 记忆：三档记忆文件查看/编辑/清空 + 跨档检索。 */
export function MemoryPane() {
  const { t } = useI18n();
  const [tier, setTier] = useState<MemoryTier>("user");
  const [content, setContent] = useState("");
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);

  // 检索
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MemoryHitDto[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    memoryRead(tier)
      .then((d) => {
        if (!alive) return;
        setContent(d.content);
        setPath(d.path);
      })
      .catch((e) => {
        if (alive) setError(friendlyError(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tier]);

  const handleSave = async () => {
    setError("");
    try {
      await memoryWrite(tier, content);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  const handleClear = async () => {
    if (!window.confirm(t("settings.memory.clearConfirm"))) return;
    setError("");
    try {
      await memoryWrite(tier, "");
      setContent("");
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  const handleSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError("");
    try {
      const r = await memorySearch(q);
      setHits(r);
      setSearched(true);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setSearching(false);
    }
  };

  return (
    <>
      <div className="settings-main-header">
        <h2>{t("settings.memory")}</h2>
        <p className="settings-main-subtitle">{t("settings.memory.subtitle")}</p>
      </div>

      <div className="settings-cards">
        <section className="settings-card">
          <div className="settings-card-header">
            <h3>{t("settings.memory.editor")}</h3>
            <p>{t(TIER_HINT_KEY[tier])}</p>
          </div>
          <div className="settings-card-body">
            <div className="memory-tier-switch">
              <SegmentedControl
                options={(["user", "project", "memory"] as MemoryTier[]).map((v) => ({
                  value: v,
                  label: t(TIER_LABEL_KEY[v]),
                }))}
                value={tier}
                onChange={setTier}
              />
            </div>

            {loading ? (
              <p className="field-hint">{t("common.loading")}</p>
            ) : (
              <textarea
                className="settings-textarea memory-editor"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                spellCheck={false}
                aria-label={t("settings.memory.editor")}
              />
            )}

            {path && <p className="memory-file-path">{path}</p>}
            {error && <p className="field-hint err">{error}</p>}

            <div className="settings-footer-actions">
              <button type="button" className="btn btn-danger-text" onClick={handleClear}>
                {t("settings.memory.clearBtn")}
              </button>
              <button type="button" className="btn btn-primary" onClick={handleSave} disabled={loading}>
                {t("settings.memory.saveBtn")}
              </button>
              {saved && <span className="settings-saved-hint">{t("settings.memory.saved")}</span>}
            </div>
          </div>
        </section>

        <section className="settings-card">
          <div className="settings-card-header">
            <h3>{t("settings.memory.search")}</h3>
          </div>
          <div className="settings-card-body">
            <div className="memory-search-row">
              <input
                className="settings-text-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSearch();
                }}
                placeholder={t("settings.memory.searchPlaceholder")}
                aria-label={t("settings.memory.search")}
              />
              <button type="button" className="btn btn-secondary" onClick={handleSearch} disabled={searching}>
                {searching ? t("common.loading") : t("settings.memory.searchBtn")}
              </button>
            </div>

            {searched && hits.length === 0 && (
              <p className="field-hint memory-search-empty">{t("settings.memory.searchEmpty")}</p>
            )}
            {!searched && <p className="field-hint">{t("settings.memory.searchIdle")}</p>}

            {hits.length > 0 && (
              <ul className="memory-hit-list">
                {hits.map((h, i) => (
                  <li key={i} className="memory-hit">
                    <div className="memory-hit-meta">
                      <span className={`memory-hit-tier tier-${h.tier}`}>
                        {TIER_BADGE[h.tier] ?? h.tier}
                      </span>
                      <span className="memory-hit-line">
                        {t("settings.memory.hit.line")} {h.line}
                      </span>
                    </div>
                    <code className="memory-hit-text">{h.text}</code>
                    <span className="memory-hit-path">{h.path}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
