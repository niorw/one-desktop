import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { DictKey } from "../../i18n/dict";
import {
  addInspiration,
  allTags,
  deleteInspiration,
  listInspirations,
  parseTags,
  suggestInspirationTags,
  type Inspiration,
} from "../../services/inspiration";
import { DEFAULT_WORKSPACE_ID } from "../../services/workspace";
import "./inspiration.css";

function ymd(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayLabel(key: string, locale: string, t: (k: DictKey) => string): string {
  const today = ymd(Date.now());
  const y = new Date(Date.now() - 86_400_000);
  const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  if (key === today) return t("inspiration.today");
  if (key === yesterday) return t("inspiration.yesterday");
  // 非中文本地化时直接显示 ISO 日期（Intl 已在别处统一）
  if (locale === "zh") return key.replace(/-/g, " / ");
  return key;
}

const REL_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

type RangeKey = "week" | "month" | "3months" | "all" | "custom";

const DAY = 86_400_000;

/** 把时间范围预设换算成 [start, end] 时间戳；null 表示不限。 */
function rangeBounds(
  key: RangeKey,
  customFrom: string,
  customTo: string
): { start: number | null; end: number | null } {
  const now = Date.now();
  if (key === "all") return { start: null, end: null };
  if (key === "week") return { start: now - 7 * DAY, end: null };
  if (key === "month") return { start: now - 30 * DAY, end: null };
  if (key === "3months") {
    // 自然三个月：本月起往前推到 (本月-2) 的 1 号，含当月共三月。
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 2);
    d.setHours(0, 0, 0, 0);
    return { start: d.getTime(), end: null };
  }
  // custom
  let start: number | null = null;
  let end: number | null = null;
  if (customFrom) {
    const f = new Date(`${customFrom}T00:00:00`);
    if (!Number.isNaN(f.getTime())) start = f.getTime();
  }
  if (customTo) {
    const t2 = new Date(`${customTo}T23:59:59`);
    if (!Number.isNaN(t2.getTime())) end = t2.getTime();
  }
  return { start, end };
}

export function InspirationPage({ workspaceId }: { workspaceId?: string }) {
  const { t, locale } = useI18n();
  // 工作区资源共享：灵感按当前激活会话所属工作区过滤；默认工作区映射到后端 NULL。
  const wsParam = workspaceId && workspaceId !== DEFAULT_WORKSPACE_ID ? workspaceId : null;
  const [items, setItems] = useState<Inspiration[]>([]);
  const [draft, setDraft] = useState("");
  const [tagging, setTagging] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<RangeKey>("3months");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async () => {
    setItems(await listInspirations(wsParam));
  }, [wsParam]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rtf = useMemo(
    () => new Intl.RelativeTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { numeric: "auto" }),
    [locale]
  );

  const relTime = useCallback(
    (ts: number) => {
      const diff = ts - Date.now();
      const abs = Math.abs(diff);
      if (abs < 60_000) return t("inspiration.justNow");
      for (const [unit, ms] of REL_UNITS) {
        if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
      }
      return rtf.format(Math.round(diff / 60_000), "minute");
    },
    [rtf, t]
  );

  const tags = useMemo(() => allTags(items), [items]);

  const bounds = useMemo(() => rangeBounds(range, customFrom, customTo), [range, customFrom, customTo]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (activeTag && !it.tags.includes(activeTag)) return false;
      if (q && !it.content.toLowerCase().includes(q)) return false;
      if (bounds.start !== null && it.createdAt < bounds.start) return false;
      if (bounds.end !== null && it.createdAt > bounds.end) return false;
      return true;
    });
  }, [items, activeTag, query, bounds]);

  const rangeInvalid = useMemo(() => {
    if (range !== "custom") return false;
    if (!customFrom || !customTo) return false;
    const f = new Date(`${customFrom}T00:00:00`).getTime();
    const t2 = new Date(`${customTo}T23:59:59`).getTime();
    return !Number.isNaN(f) && !Number.isNaN(t2) && f > t2;
  }, [range, customFrom, customTo]);

  const groups = useMemo(() => {
    const m = new Map<string, Inspiration[]>();
    for (const it of filtered) {
      const k = ymd(it.createdAt);
      const arr = m.get(k);
      if (arr) arr.push(it);
      else m.set(k, [it]);
    }
    return [...m.entries()];
  }, [filtered]);

  const save = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    let tags: string[] = parseTags(text);
    if (tags.length === 0) {
      setTagging(true);
      try {
        tags = await suggestInspirationTags(text);
      } catch {
        tags = [];
      } finally {
        setTagging(false);
      }
    }
    await addInspiration(text, tags.length ? tags : undefined, wsParam);
    setDraft("");
    await refresh();
    taRef.current?.focus();
  }, [draft, refresh]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void save();
    }
  };

  const remove = useCallback(
    async (id: string) => {
      await deleteInspiration(id);
      await refresh();
    },
    [refresh]
  );

  const renderContent = (content: string) => {
    const parts = content.split(/(#[\p{L}\p{N}_]+)/gu);
    return parts.map((p, i) => {
      if (/^#[\p{L}\p{N}_]+$/u.test(p)) {
        const tag = p.slice(1);
        const active = activeTag === tag;
        return (
          <button
            key={i}
            type="button"
            className={`insp-tag-inline${active ? " active" : ""}`}
            onClick={() => setActiveTag(active ? null : tag)}
          >
            {p}
          </button>
        );
      }
      return <span key={i}>{p}</span>;
    });
  };

  const RANGES: { key: RangeKey; labelKey: DictKey }[] = [
    { key: "week", labelKey: "inspiration.range.week" },
    { key: "month", labelKey: "inspiration.range.month" },
    { key: "3months", labelKey: "inspiration.range.3months" },
    { key: "all", labelKey: "inspiration.range.all" },
    { key: "custom", labelKey: "inspiration.range.custom" },
  ];

  const showCount = filtered.length !== items.length;

  return (
    <div className="insp-page">
      <header className="insp-head">
        <h1>{t("nav.inspiration")}</h1>
        <span className="insp-total">
          {showCount
            ? t("inspiration.shown").replace("{n}", String(filtered.length))
            : t("inspiration.total").replace("{n}", String(items.length))}
        </span>
      </header>

      {/* 快速记录 */}
      <section className="insp-composer">
        <textarea
          ref={taRef}
          className="insp-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("inspiration.capturePlaceholder")}
          rows={3}
          aria-label={t("nav.inspiration")}
        />
        <div className="insp-composer-foot">
          <span className="insp-hint">{t("inspiration.saveHint")}</span>
          <button
            className="btn btn-primary btn-sm"
            onClick={save}
            disabled={!draft.trim() || tagging}
          >
            {tagging ? t("inspiration.tagging") : t("inspiration.save")}
          </button>
        </div>
      </section>

      {/* 时间范围检索 */}
      <div className="insp-rangebar">
        <span className="insp-range-label">{t("inspiration.rangeLabel")}</span>
        <div className="segmented-control insp-range-seg" role="group" aria-label={t("inspiration.rangeLabel")}>
          {RANGES.map(({ key, labelKey }) => (
            <button
              key={key}
              type="button"
              className={range === key ? "active" : ""}
              onClick={() => setRange(key)}
              aria-pressed={range === key}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
        {range === "custom" && (
          <div className="insp-range-custom">
            <input
              className="insp-date"
              type="date"
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => setCustomFrom(e.target.value)}
              aria-label={t("inspiration.range.from")}
            />
            <span className="insp-range-sep">→</span>
            <input
              className="insp-date"
              type="date"
              value={customTo}
              min={customFrom || undefined}
              onChange={(e) => setCustomTo(e.target.value)}
              aria-label={t("inspiration.range.to")}
            />
          </div>
        )}
      </div>
      {rangeInvalid && <p className="insp-range-err">{t("inspiration.range.invalid")}</p>}

      {/* 标签栏 + 搜索 */}
      <div className="insp-toolbar">
        <div
          className="insp-tags"
          role="list"
          aria-label={t("inspiration.tagCount").replace("{n}", String(tags.length))}
        >
          <button
            type="button"
            className={`insp-tag-chip${activeTag === null ? " active" : ""}`}
            onClick={() => setActiveTag(null)}
          >
            {t("inspiration.all")}
          </button>
          {tags.map(({ tag, count }) => (
            <button
              key={tag}
              type="button"
              className={`insp-tag-chip${activeTag === tag ? " active" : ""}`}
              onClick={() => setActiveTag(activeTag === tag ? null : tag)}
              title={`#${tag}`}
            >
              #{tag}
              <span className="insp-tag-count">{count}</span>
            </button>
          ))}
        </div>
        <input
          className="insp-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("inspiration.search")}
          aria-label={t("inspiration.search")}
        />
      </div>

      {/* 时间线（独立滚动） */}
      {groups.length === 0 ? (
        <div className="insp-empty">
          <InspireIcon />
          <p className="insp-empty-title">
            {items.length === 0 ? t("inspiration.empty") : t("inspiration.noResult")}
          </p>
          {items.length === 0 && <p className="insp-empty-desc">{t("inspiration.emptyDesc")}</p>}
        </div>
      ) : (
        <div className="insp-timeline">
          {groups.map(([key, list]) => (
            <section key={key} className="insp-day">
              <h2 className="insp-day-head">{dayLabel(key, locale, t)}</h2>
              <ul className="insp-cards">
                {list.map((it) => (
                  <li key={it.id} className="insp-card">
                    <div className="insp-card-body">{renderContent(it.content)}</div>
                    {(() => {
                      const inline = parseTags(it.content);
                      const cardTags = it.tags.filter((t) => !inline.includes(t));
                      if (cardTags.length === 0) return null;
                      return (
                        <div className="insp-card-tags">
                          {cardTags.map((t) => (
                            <button
                              key={t}
                              type="button"
                              className={`insp-card-tag${activeTag === t ? " active" : ""}`}
                              onClick={() => setActiveTag(activeTag === t ? null : t)}
                              title={`#${t}`}
                            >
                              #{t}
                            </button>
                          ))}
                        </div>
                      );
                    })()}
                    <div className="insp-card-foot">
                      <time className="insp-time">{relTime(it.createdAt)}</time>
                      <button
                        type="button"
                        className="insp-del"
                        onClick={() => void remove(it.id)}
                        title={t("inspiration.delete")}
                        aria-label={t("inspiration.delete")}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function InspireIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="insp-empty-icon">
      <path d="M9 18h6M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}
