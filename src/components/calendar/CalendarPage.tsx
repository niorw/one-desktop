import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import {
  createCalendarEvent,
  listCalendarEventsByMonth,
  updateCalendarEvent,
  deleteCalendarEvent,
  testReminderNotification,
  type CalendarEvent,
} from "../../services/tauri";
import { Icons } from "../common/Icons";
import "./calendar.css";

/* ═════════════════════════════════════════
   农历计算（纯 JS，无外部依赖）
   基于 1900-2100 年农历数据表
   ═════════════════════════════════════════ */

const LUNAR_INFO = [
  0x04bd8,0x04ae0,0x0a570,0x054d5,0x0d260,0x0d950,0x16554,0x056a0,0x09ad0,0x055d2,
  0x04ae0,0x0a5b6,0x0a4d0,0x0d250,0x1d255,0x0b540,0x0d6a0,0x0ada2,0x095b0,0x14977,
  0x04970,0x0a4b0,0x0b4b5,0x06a50,0x06d40,0x1ab54,0x02b60,0x09570,0x052f2,0x04970,
  0x06566,0x0d4a0,0x0ea50,0x06e95,0x5ad0,0x02b60,0x186e3,0x092e0,0x1c8d7,0x0c950,
  0x0d4a0,0x1d8a6,0x0b550,0x056a0,0x1a5b4,0x025d0,0x092d0,0x0d2b2,0x0a950,0x0b557,
  0x06ca0,0x0b550,0x15355,0x04da0,0x0a5b0,0x14573,0x052b0,0x0a9a8,0x0e950,0x06aa0,
  0x0aea6,0x0ab50,0x04b60,0x0aae4,0x0a570,0x05260,0x0f263,0x0d950,0x05b57,0x056a0,
  0x096d0,0x04dd5,0x04ad0,0x0a4d0,0x0d4d4,0x0d250,0x0d558,0x0b540,0x0b6a0,0x195a6,
  0x095b0,0x049b0,0x0a974,0x0a4b0,0x0b27a,0x06a50,0x06d40,0x0af46,0x0ab60,0x09570,
  0x04af5,0x04970,0x064b0,0x074a3,0x0ea50,0x06b58,0x05ac0,0x0ab60,0x096d5,0x092e0,
  0x0c960,0x0d954,0x0d4a0,0x0da50,0x07552,0x056a0,0x0abb7,0x025d0,0x092d0,0x0cab5,
  0x0a950,0x0b4a0,0x0baa4,0x0ad50,0x055d9,0x04ba0,0x0a5b0,0x15176,0x052b0,0x0a930,
  0x07954,0x06aa0,0x0ad50,0x05b52,0x04b60,0x0a6e6,0x0a4e0,0x0d260,0x0ea65,0x0d530,
  0x05aa0,0x076a3,0x096d0,0x04afb,0x0ad60,0x055d2,0x04ae0,0x0a5b6,0x0a4d0,0x0d250,
  0x1d255,0x0b540,0x0d6a0,0x0ada2,0x095b0,0x14977,0x04970,0x0a4b0,0x0b4b5,0x06a50,
  0x06d40,0x1ab54,0x02b60,0x09570,0x052f2,0x04970,0x06566,0x0d4a0,0x0ea50,0x06e95,
  0x5ad0,0x02b60,0x186e3,0x092e0,0x1c8d7,0x0c950,0x0d4a0,0x1d8a6,0x0b550,0x056a0,
  0x1a5b4,0x025d0,0x092d0,0x0d2b2,0x0a950,0x0b557,0x06ca0,0x0b550,0x15355,0x04da0,
  0x0a5b0,0x14573,0x052b0,0x0a9a8,0x0e950,0x06aa0,0x0aea6,0x0ab50,0x04b60,0x0aae4,
  0x0a570,0x05260,0x0f263,0x0d950,0x05b57,0x056a0,0x096d0,0x04dd5,0x04ad0,0x0a4d0,
  0x0d4d4,0x0d250,0x0d558,0x0b540,0x0b6a0,0x195a6,0x095b0,0x049b0,0x0a974,0x0a4b0,
  0x0b27a,0x06a50,0x06d40,0x0af46,0x0ab60,0x09570,0x04af5,0x04970,0x064b0,0x074a3,
  0x0ea50,0x06b58,0x05ac0,0x0ab60,0x096d5,0x092e0,0x0c960,0x0d954,0x0d4a0,0x0da50,
  0x07552,0x056a0,0x0abb7,0x025d0,0x092d0,0x0cab5,0x0a950,0x0b4a0,0x0baa4,0x0ad50,
  0x055d9,0x04ba0,0x0a5b0,0x15176,0x052b0,0x0a930,0x07954,0x06aa0,0x0ad50,0x05b52,
  0x04b60,0x0a6e6,0x0a4e0,0x0d260,0x0ea65,0x0d530,0x05aa0,0x076a3,0x096d0,0x04afb,
  0x0ad60,0x055d2,0x04ae0,0x0a5b6,0x0a4d0,0x0d250,0x1d255,0x0b540,0x0d6a0,0x0ada2,
];

const LUNAR_MONTH_NAMES = ["正","二","三","四","五","六","七","八","九","十","冬","腊"];
const LUNAR_DAY_NAMES = [
  "初一","初二","初三","初四","初五","初六","初七","初八","初九","初十",
  "十一","十二","十三","十四","十五","十六","十七","十八","十九","二十",
  "廿一","廿二","廿三","廿四","廿五","廿六","廿七","廿八","廿九","三十",
];

function getLunarMonthDays(year: number, month: number): number {
  return (LUNAR_INFO[year - 1900] & (0x10000 >> month)) ? 30 : 29;
}
function getLeapMonth(year: number): number {
  return LUNAR_INFO[year - 1900] & 0xf;
}
function getLeapMonthDays(year: number): number {
  if (getLeapMonth(year)) {
    return (LUNAR_INFO[year - 1900] & 0x10000) ? 30 : 29;
  }
  return 0;
}
function lunarYearDays(year: number): number {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[year - 1900] & i) ? 1 : 0;
  return sum + getLeapMonthDays(year);
}

function solarToLunar(y: number, m: number, d: number): [number, number, number] {
  const baseDate = new Date(1900, 0, 31);
  const target = new Date(y, m - 1, d);
  let offset = Math.floor((target.getTime() - baseDate.getTime()) / 86400000);

  let ly = 1900, lm = 1, ld = 1;
  // Year loop
  for (; ly < 2101 && offset > 0; ly++) {
    const daysInYear = lunarYearDays(ly);
    if (offset < daysInYear) break;
    offset -= daysInYear;
  }
  // Month loop
  let leap = getLeapMonth(ly), isLeap = false;
  for (let i = 1; i <= 12 && offset > 0; i++) {
    if (leap > 0 && i === leap + 1 && !isLeap) { --i; isLeap = true; lm = i; ld = 1; continue; }
    lm = i;
    const daysInMonth = isLeap ? getLeapMonthDays(ly) : getLunarMonthDays(ly, i);
    if (offset > daysInMonth) { offset -= daysInMonth; if (isLeap) isLeap = false; else if (leap === i) isLeap = true; }
    else break;
  }
  ld = offset || 1;
  return [ly, lm, ld];
}

function formatLunar(date: Date): string {
  try {
    const [, m, d] = solarToLunar(date.getFullYear(), date.getMonth() + 1, date.getDate());
    if (d === 1) return LUNAR_MONTH_NAMES[m - 1] + "月";
    return LUNAR_DAY_NAMES[d - 1];
  } catch { return ""; }
}

// 预设事件分类色（作为领域数据持久化到事件记录，故保留具体色值而非语义变量）
const EVENT_COLORS = [
  "#0a84ff",
  "#ff453a",
  "#30d158",
  "#ff9f0a",
  "#bf5af2",
  "#64d2ff",
];

/* ═════════════════════════════════════════
   日期工具（本地时区安全）
   ═════════════════════════════════════════ */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function addYears(d: Date, n: number): Date {
  return new Date(d.getFullYear() + n, d.getMonth(), d.getDate());
}

/** 生成以「周日」为首的 6×7 网格（42 格），覆盖 cursor 所在月份。 */
function buildGrid(cursor: Date): Date[] {
  const first = startOfMonth(cursor);
  const dow = first.getDay(); // 周日=0 ... 周六=6
  const start = new Date(first.getFullYear(), first.getMonth(), first.getDate() - dow);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }
  return cells;
}

/** 星期头日期：取每列第一行的日期 */
function buildWeekdayDates(grid: Date[]): Date[] {
  return grid.slice(0, 7);
}

/** cursor 所在周的 7 天（周日-周六） */
function buildWeekDates(cursor: Date): Date[] {
  const start = addDays(cursor, -cursor.getDay());
  const out: Date[] = [];
  for (let i = 0; i < 7; i++) out.push(addDays(start, i));
  return out;
}

/** 年份视图：该年 12 个月（每月 1 号） */
function buildYearMonths(cursor: Date): Date[] {
  const y = cursor.getFullYear();
  const out: Date[] = [];
  for (let m = 0; m < 12; m++) out.push(new Date(y, m, 1));
  return out;
}

/** 月/周视图共用的单日格子 */
type DayCellVariant = "month" | "week";
function DayCell({
  date,
  events,
  onOpen,
  variant = "month",
  other = false,
}: {
  date: Date;
  events: CalendarEvent[];
  onOpen: (key: string) => void;
  variant?: DayCellVariant;
  other?: boolean;
}) {
  const key = ymd(date);
  const isToday = key === ymd(new Date());
  const limit = variant === "week" ? 8 : 3;
  return (
    <div
      className={[
        "cal-cell",
        variant === "week" ? "cal-cell--week" : "",
        other ? "cal-cell--other" : "",
        isToday ? "cal-cell--today" : "",
      ].filter(Boolean).join(" ")}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(key)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(key);
        }
      }}
    >
      <div className="cal-date-row">
        <span className="cal-date-num">{date.getDate()}</span>
        <span className="cal-lunar">{formatLunar(date)}</span>
      </div>
      {events.length > 0 && (
        <div className="cal-events-list">
          {events.slice(0, limit).map((ev) => (
            <div
              key={ev.id}
              className="cal-event-bar"
              style={{
                color: ev.color || EVENT_COLORS[0],
                background: `${ev.color || EVENT_COLORS[0]}18`,
              }}
              onClick={(e) => {
                e.stopPropagation();
                onOpen(key);
              }}
              title={`${ev.title}${ev.time_start ? ` ${ev.time_start}` : ""}`}
            >
              <span className="cal-bar-dot" />
              <span className="cal-bar-text">{ev.title}</span>
            </div>
          ))}
          {events.length > limit && (
            <span className="cal-more-events">+{events.length - limit}</span>
          )}
        </div>
      )}
    </div>
  );
}

/* ═════════════════════════════════════════
   主组件
   ═════════════════════════════════════════ */

type ViewMode = "month" | "week" | "day" | "year";
type PopupMode = "view" | "create" | "edit";

export function CalendarPage() {
  const { t, locale } = useI18n();
  const [cursor, setCursor] = useState<Date>(new Date());
  const [viewMode, setViewMode] = useState<ViewMode>("month");
  const [eventsByDate, setEventsByDate] = useState<Record<string, CalendarEvent[]>>({});

  // 弹窗状态
  const [popupDate, setPopupDate] = useState<string | null>(null); // 打开弹窗的日期 key
  const [popupMode, setPopupMode] = useState<PopupMode>("view");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"schedule" | "reminder">("schedule");

  // 表单状态
  const [formTitle, setFormTitle] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formTimeStart, setFormTimeStart] = useState("");
  const [formTimeEnd, setFormTimeEnd] = useState("");
  const [formColor, setFormColor] = useState(EVENT_COLORS[0]);

  const grid = useMemo(() => buildGrid(cursor), [cursor]);
  const weekdayDates = useMemo(() => buildWeekdayDates(grid), [grid]);
  const todayKey = ymd(new Date());
  const cursorYear = cursor.getFullYear();
  const cursorMonth = cursor.getMonth() + 1;

  // 当前视图需要加载的月份范围（周视图跨相邻月，年视图覆盖全年）
  const monthsToLoad = useMemo<{ year: number; month: number }[]>(() => {
    if (viewMode === "year") {
      return Array.from({ length: 12 }, (_, i) => ({ year: cursorYear, month: i + 1 }));
    }
    if (viewMode === "week") {
      const prev = new Date(cursorYear, cursorMonth - 2, 1);
      const next = new Date(cursorYear, cursorMonth, 1);
      return [
        { year: prev.getFullYear(), month: prev.getMonth() + 1 },
        { year: cursorYear, month: cursorMonth },
        { year: next.getFullYear(), month: next.getMonth() + 1 },
      ];
    }
    return [{ year: cursorYear, month: cursorMonth }];
  }, [viewMode, cursorYear, cursorMonth]);

  // 加载事件（按视图范围批量拉取并合并到单一数据源）
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      monthsToLoad.map((m) =>
        listCalendarEventsByMonth(m).catch(() => [] as CalendarEvent[]),
      ),
    )
      .then((lists) => {
        if (cancelled) return;
        const grouped: Record<string, CalendarEvent[]> = {};
        for (const rows of lists) {
          for (const ev of rows) (grouped[ev.date_key] ||= []).push(ev);
        }
        setEventsByDate(grouped);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [monthsToLoad]);

  const headerTitle = (() => {
    if (viewMode === "year") {
      return locale === "zh" ? `${cursorYear} 年` : `${cursorYear}`;
    }
    if (viewMode === "month") {
      return locale === "zh"
        ? `${cursorYear} 年 ${cursorMonth} 月`
        : `${cursorMonth} / ${cursorYear}`;
    }
    if (viewMode === "week") {
      const wk = buildWeekDates(cursor);
      const f = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
      return `${f(wk[0])} – ${f(wk[6])}`;
    }
    const d = cursor;
    return locale === "zh"
      ? `${d.getMonth() + 1} 月 ${d.getDate()} 日`
      : `${d.getMonth() + 1}/${d.getDate()}`;
  })();

  const weekdays =
    locale === "zh"
      ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
      : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const goToday = () => {
    setCursor(new Date());
  };
  const stepNav = (dir: number) => {
    if (viewMode === "day") setCursor((c) => addDays(c, dir));
    else if (viewMode === "week") setCursor((c) => addDays(c, 7 * dir));
    else if (viewMode === "month") setCursor((c) => addMonths(c, dir));
    else setCursor((c) => addYears(c, dir));
  };

  /* ── 弹窗操作 ── */

  const openPopup = useCallback((key: string) => {
    setPopupDate(key);
    setPopupMode("view");
    setEditingId(null);
  }, []);

  const closePopup = useCallback(() => {
    setPopupDate(null);
    setPopupMode("view");
    setEditingId(null);
    resetForm();
  }, []);

  const resetForm = () => {
    setFormTitle("");
    setFormContent("");
    setFormTimeStart("");
    setFormTimeEnd("");
    setFormColor(EVENT_COLORS[0]);
  };

  const startCreate = () => {
    resetForm();
    setPopupMode("create");
    setEditingId(null);
  };

  const startEdit = (ev: CalendarEvent) => {
    setFormTitle(ev.title);
    setFormContent(ev.content || "");
    setFormTimeStart(ev.time_start || "");
    setFormTimeEnd(ev.time_end || "");
    setFormColor(ev.color || EVENT_COLORS[0]);
    setPopupMode("edit");
    setEditingId(ev.id);
  };

  const saveEvent = async () => {
    const title = formTitle.trim();
    if (!title) return;
    try {
      if (popupMode === "edit" && editingId) {
        const updated = await updateCalendarEvent({
          id: editingId,
          title,
          content: formContent.trim() || undefined,
          time_start: formTimeStart || null,
          time_end: formTimeEnd || null,
          color: formColor,
        });
        setEventsByDate((prev) => {
          const next = { ...prev };
          for (const k of Object.keys(next)) {
            next[k] = next[k].map((e) => (e.id === updated.id ? updated : e));
          }
          return next;
        });
      } else if (popupDate) {
        const created = await createCalendarEvent({
          date_key: popupDate,
          title,
          content: formContent.trim() || undefined,
          time_start: formTimeStart || undefined,
          time_end: formTimeEnd || undefined,
          color: formColor,
          kind: activeTab,
        });
        setEventsByDate((prev) => ({
          ...prev,
          [created.date_key]: [...(prev[created.date_key] || []), created],
        }));
      }
    } catch {}
    setPopupMode("view");
    setEditingId(null);
    resetForm();
  };

  const removeEvent = async (ev: CalendarEvent) => {
    try {
      await deleteCalendarEvent(ev.id);
      setEventsByDate((prev) => {
        const next = { ...prev };
        const list = (next[ev.date_key] || []).filter((e) => e.id !== ev.id);
        if (list.length === 0) delete next[ev.date_key];
        else next[ev.date_key] = list;
        return next;
      });
    } catch {}
  };

  /* ── 渲染 ── */

  const popupEvents = useMemo(
    () => (popupDate ? (eventsByDate[popupDate] || []).filter((e) => e.kind === activeTab) : []),
    [popupDate, eventsByDate, activeTab],
  );
  const popupFormatted = popupDate
    ? (() => {
        const d = new Date(popupDate + "T12:00:00");
        if (isNaN(d.getTime())) return popupDate;
        return locale === "zh"
          ? `${d.getMonth() + 1}月${d.getDate()}日`
          : d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
      })()
    : "";

  return (
    <div className="calendar-page">
      {/* ── 顶部导航 ── */}
      <header className="cal-header">
        <div className="cal-header-left">
          <span className="cal-year-month">{headerTitle}</span>
        </div>

        <div className="cal-view-tabs">
          {(["day", "week", "month", "year"] as ViewMode[]).map((v) => (
            <button
              key={v}
              className={`cal-view-tab ${viewMode === v ? "active" : ""}`}
              onClick={() => setViewMode(v)}
            >
              {{
                day: locale === "zh" ? "日" : "Day",
                week: locale === "zh" ? "周" : "Week",
                month: locale === "zh" ? "月" : "Month",
                year: locale === "zh" ? "年" : "Year",
              }[v]}
            </button>
          ))}
        </div>

        <div className="cal-header-right">
          <button className="cal-nav-btn" onClick={() => stepNav(-1)} aria-label="‹">‹</button>
          <button className="cal-today-btn" onClick={goToday}>
            {locale === "zh" ? "今天" : "Today"}
          </button>
          <button className="cal-nav-btn" onClick={() => stepNav(1)} aria-label="›">›</button>
        </div>
      </header>

      {/* ── 月视图 ── */}
      {viewMode === "month" && (
        <>
          <div className="cal-weekdays">
            {weekdays.map((_, i) => (
              <div key={i} className="cal-weekday-item">
                <span className="cal-wd-name">{weekdays[i]}</span>
                <span className="cal-wd-date">{weekdayDates[i].getDate()}</span>
              </div>
            ))}
          </div>
          <div className="cal-grid">
            {grid.map((cell) => (
              <DayCell
                key={ymd(cell)}
                date={cell}
                events={eventsByDate[ymd(cell)] || []}
                onOpen={openPopup}
                variant="month"
                other={cell.getMonth() !== cursor.getMonth()}
              />
            ))}
          </div>
        </>
      )}

      {/* ── 周视图 ── */}
      {viewMode === "week" &&
        (() => {
          const wk = buildWeekDates(cursor);
          return (
            <>
              <div className="cal-weekdays">
                {wk.map((d, i) => (
                  <div key={i} className="cal-weekday-item">
                    <span className="cal-wd-name">{weekdays[d.getDay()]}</span>
                    <span className="cal-wd-date">{d.getDate()}</span>
                  </div>
                ))}
              </div>
              <div className="cal-grid cal-grid--week">
                {wk.map((d) => (
                  <DayCell
                    key={ymd(d)}
                    date={d}
                    events={eventsByDate[ymd(d)] || []}
                    onOpen={openPopup}
                    variant="week"
                  />
                ))}
              </div>
            </>
          );
        })()}

      {/* ── 日视图 ── */}
      {viewMode === "day" &&
        (() => {
          const key = ymd(cursor);
          const evs = [...(eventsByDate[key] || [])].sort((a, b) =>
            (a.time_start || "99:99").localeCompare(b.time_start || "99:99"),
          );
          return (
            <div className="cal-day-view">
              <div className="cal-day-head">
                <span className="cal-date-num cal-date-num--lg">{cursor.getDate()}</span>
                <span className="cal-lunar">{formatLunar(cursor)}</span>
              </div>
              <div className="cal-day-list">
                {evs.length === 0 ? (
                  <div className="cal-popup-empty">
                    {locale === "zh" ? "这一天还没有安排" : "Nothing scheduled"}
                  </div>
                ) : (
                  evs.map((ev) => (
                    <div
                      key={ev.id}
                      className="cal-day-row"
                      style={{ borderLeftColor: ev.color || EVENT_COLORS[0] }}
                      onClick={() => openPopup(key)}
                    >
                      <span className="cal-day-time">
                        {ev.time_start || (ev.kind === "reminder" ? "提醒" : "全天")}
                      </span>
                      <span className="cal-day-title">{ev.title}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })()}

      {/* ── 年视图 ── */}
      {viewMode === "year" && (
        <div className="cal-year-grid">
          {buildYearMonths(cursor).map((m) => {
            const mg = buildGrid(m);
            const miniWd = locale === "zh" ? ["日", "一", "二", "三", "四", "五", "六"] : ["S", "M", "T", "W", "T", "F", "S"];
            return (
              <div
                key={m.getMonth()}
                className="cal-mini-month"
                onClick={() => {
                  setCursor(m);
                  setViewMode("month");
                }}
              >
                <div className="cal-mini-title">
                  {locale === "zh" ? `${m.getMonth() + 1} 月` : `M${m.getMonth() + 1}`}
                </div>
                <div className="cal-mini-weekdays">
                  {miniWd.map((w, i) => (
                    <span key={i}>{w}</span>
                  ))}
                </div>
                <div className="cal-mini-grid">
                  {mg.map((d) => {
                    const k = ymd(d);
                    const has = (eventsByDate[k] || []).length > 0;
                    const t = k === ymd(new Date());
                    return (
                      <span
                        key={k}
                        className={[
                          "cal-mini-cell",
                          t ? "is-today" : "",
                          d.getMonth() !== m.getMonth() ? "is-other" : "",
                          has ? "has-evt" : "",
                        ].filter(Boolean).join(" ")}
                      >
                        {d.getDate()}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── 弹窗 ── */}
      {popupDate && (
        <div className="cal-overlay" onClick={closePopup}>
          <div className="cal-popup" onClick={(e) => e.stopPropagation()}>
            {/* 头部 */}
            <div className="cal-popup-head">
              <span className="cal-popup-date">{popupFormatted}</span>
              <button type="button" className="cal-popup-close" onClick={closePopup} aria-label={t("common.close")}>
                <Icons.Close size={14} />
              </button>
            </div>

            {/* 标签页：日程 / 提醒事项（真实切换 + 各自独立数据） */}
            <div className="cal-popup-tabs">
              <button
                className={`cal-popup-tab ${activeTab === "schedule" ? "active" : ""}`}
                onClick={() => setActiveTab("schedule")}
              >
                {t("calendar.schedule")}
              </button>
              <button
                className={`cal-popup-tab ${activeTab === "reminder" ? "active" : ""}`}
                onClick={() => setActiveTab("reminder")}
              >
                {t("calendar.reminders")}
              </button>
            </div>

            {/* 新建按钮 / 表单 / 列表 三态切换 */}
            {popupMode === "create" || popupMode === "edit" ? (
              <>
                <div className="cal-form">
                  <div className="cal-form-field">
                    <label className="cal-form-label">{t("calendar.title")}</label>
                    <input
                      className="cal-form-input"
                      autoFocus
                      value={formTitle}
                      onChange={(e) => setFormTitle(e.target.value)}
                      placeholder={t("calendar.titlePlaceholder")}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveEvent(); } }}
                    />
                  </div>

                  <div className="cal-form-row">
                    <div className="cal-form-field">
                      <label className="cal-form-label">{t("calendar.startTime")}</label>
                      <input
                        className="cal-form-input"
                        type="time"
                        value={formTimeStart}
                        onChange={(e) => setFormTimeStart(e.target.value)}
                      />
                    </div>
                    <div className="cal-form-field">
                      <label className="cal-form-label">{t("calendar.endTime")}</label>
                      <input
                        className="cal-form-input"
                        type="time"
                        value={formTimeEnd}
                        onChange={(e) => setFormTimeEnd(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="cal-form-field">
                    <label className="cal-form-label">{t("calendar.notes")}</label>
                    <textarea
                      className="cal-form-textarea"
                      value={formContent}
                      onChange={(e) => setFormContent(e.target.value)}
                      placeholder={t("calendar.notesPlaceholder")}
                    />
                  </div>

                  <div className="cal-form-field">
                    <label className="cal-form-label">{t("calendar.color")}</label>
                    <div className="cal-colors">
                      {EVENT_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={`cal-color-swatch ${formColor === c ? "selected" : ""}`}
                          style={{ background: c }}
                          onClick={() => setFormColor(c)}
                          aria-label={c}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="cal-form-actions">
                    <button
                      type="button"
                      className="cal-btn cal-btn-test"
                      onClick={() => { testReminderNotification().catch(() => {}); }}
                      title={t("calendar.testHint")}
                    >
                      {t("calendar.testNotify")}
                    </button>
                    <button className="cal-btn cal-btn-cancel" onClick={() => { setPopupMode("view"); setEditingId(null); resetForm(); }}>
                      {t("common.cancel")}
                    </button>
                    <button className="cal-btn cal-btn-save" onClick={saveEvent}>
                      {t("calendar.save")}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <button className="cal-new-btn" onClick={startCreate}>
                  <span className="cal-plus-icon">+</span>
                  {activeTab === "reminder"
                    ? t("calendar.newReminder")
                    : t("calendar.newEvent")}
                </button>

                <div className="cal-popup-events">
                  {popupEvents.length === 0 ? (
                    <div className="cal-popup-empty">
                      {activeTab === "reminder"
                        ? t("calendar.emptyReminder")
                        : t("calendar.emptyDay")}
                    </div>
                  ) : (
                    popupEvents.map((ev) => (
                      <div key={ev.id} className={`cal-pe-item ${ev.kind === "reminder" ? "is-reminder" : ""}`}>
                        <div className="cal-pe-color" style={{ background: ev.color || EVENT_COLORS[0] }} />
                        <div className="cal-pe-body" onClick={() => startEdit(ev)}>
                          <div className="cal-pe-title">{ev.title}</div>
                          {ev.time_start && (
                            <div className="cal-pe-time">
                              {ev.time_start}{ev.time_end ? ` – ${ev.time_end}` : ""}
                            </div>
                          )}
                          {ev.content && <div className="cal-pe-content">{ev.content}</div>}
                        </div>
                        <button
                          className="cal-pe-del"
                          onClick={(e) => { e.stopPropagation(); removeEvent(ev); }}
                          aria-label={t("calendar.delete")}
                        >
                          <Icons.Trash2 size={14} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
