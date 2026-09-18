import { useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { DictKey } from "../../i18n/dict";
import "./tools.css";
import { friendlyError } from "../../services/errors";

/* ── 图标（1.5px 描边，currentColor，无彩色 emoji）── */
function CodeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="8 6 2 12 8 18" />
      <polyline points="16 6 22 12 16 18" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="8" r="4" />
      <path d="M11 11l9 9" />
      <path d="M16 16l3-3" />
    </svg>
  );
}
function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
    </svg>
  );
}
function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z" />
    </svg>
  );
}

/* ── 通用：复制到剪贴板（带非安全上下文兜底）── */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* 带成功反馈的复制按钮 */
function CopyBtn({ text, label, doneLabel, className }: { text: string; label: string; doneLabel: string; className?: string }) {
  const [done, setDone] = useState(false);
  const onCopy = async () => {
    if (!text) return;
    if (await copyText(text)) {
      setDone(true);
      window.setTimeout(() => setDone(false), 1400);
    }
  };
  return (
    <button
      type="button"
      className={`btn btn-ghost btn-sm copy-btn${done ? " is-done" : ""}${className ? " " + className : ""}`}
      onClick={onCopy}
      disabled={!text}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
      <span>{done ? doneLabel : label}</span>
    </button>
  );
}

/* ── 卡片头（图标 + 标题）── */
function ToolCardHead({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="tool-card-head">
      <span className="tool-card-ic">{icon}</span>
      <h2 className="tool-card-title">{title}</h2>
    </div>
  );
}

/* ── Cron 解析（标准 5 段：分 时 日 月 周）── */
const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};
const WDAYS: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

interface Field {
  all: boolean;
  values: Set<number>;
}

function parseCronField(raw: string, min: number, max: number, names?: Record<string, number>): Field {
  const norm = (s: string): number => {
    s = s.trim().toUpperCase();
    if (names && names[s] !== undefined) return names[s];
    const n = Number(s);
    if (Number.isNaN(n)) throw new Error(s);
    return n;
  };
  const trimmed = raw.trim();
  if (trimmed === "*") return { all: true, values: new Set() };
  const values = new Set<number>();
  for (const part of trimmed.split(",")) {
    const p = part.trim();
    if (p.includes("/")) {
      const [range, stepStr] = p.split("/");
      const step = Number(stepStr);
      let lo = min;
      let hi = max;
      if (range !== "*") {
        if (range.includes("-")) {
          const [a, b] = range.split("-").map(norm);
          lo = a;
          hi = b;
        } else {
          lo = hi = norm(range);
        }
      }
      for (let v = lo; v <= hi; v += step) values.add(v);
    } else if (p.includes("-")) {
      const [a, b] = p.split("-").map(norm);
      for (let v = a; v <= b; v++) values.add(v);
    } else {
      values.add(norm(p));
    }
  }
  for (const v of [...values]) if (v < min || v > max) values.delete(v);
  return { all: false, values };
}

interface CronFields {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
}

function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("need 5 fields");
  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dom = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12, MONTHS);
  const dowRaw = parseCronField(parts[4], 0, 7, WDAYS);
  if (!dowRaw.all && dowRaw.values.has(7)) {
    dowRaw.values.delete(7);
    dowRaw.values.add(0);
  }
  return { minute, hour, dom, month, dow: dowRaw };
}

function matches(d: Date, f: CronFields): boolean {
  if (!f.minute.all && !f.minute.values.has(d.getMinutes())) return false;
  if (!f.hour.all && !f.hour.values.has(d.getHours())) return false;
  if (!f.month.all && !f.month.values.has(d.getMonth() + 1)) return false;
  const domOk = f.dom.all || f.dom.values.has(d.getDate());
  const dowOk = f.dow.all || f.dow.values.has(d.getDay());
  if (f.dom.all && f.dow.all) return true;
  if (f.dom.all) return dowOk;
  if (f.dow.all) return domOk;
  return domOk || dowOk;
}

function nextCronRuns(expr: string, count: number, from: Date = new Date()): Date[] {
  const f = parseCron(expr);
  const runs: Date[] = [];
  const cur = new Date(from.getTime());
  cur.setSeconds(0, 0);
  cur.setMinutes(cur.getMinutes() + 1);
  const cap = new Date(from.getTime() + 8 * 365.25 * 86_400_000);
  let guard = 0;
  while (runs.length < count && cur <= cap && guard < 5_000_000) {
    guard++;
    if (matches(cur, f)) runs.push(new Date(cur));
    cur.setMinutes(cur.getMinutes() + 1);
  }
  return runs;
}

function fieldPhrase(f: Field, unit: string): string {
  if (f.all) return `每${unit}`;
  const vals = [...f.values].sort((a, b) => a - b);
  const txt = vals
    .map((v) => String(v))
    .join(vals.length === 1 || vals[vals.length - 1] - vals[0] + 1 === vals.length ? "–" : ", ");
  return `${txt} ${unit}`;
}

/* ── 各工具组件 ── */

function JsonTool() {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = (mode: "pretty" | "min" | "check") => {
    setError(null);
    try {
      const obj = JSON.parse(input);
      if (mode === "pretty") setOutput(JSON.stringify(obj, null, 2));
      else if (mode === "min") setOutput(JSON.stringify(obj));
      else setOutput(t("tools.json.valid"));
    } catch (e) {
      const msg = friendlyError(e);
      setError(t("tools.json.invalid").replace("{msg}", msg));
      setOutput("");
    }
  };

  return (
    <section className="tool-card">
      <ToolCardHead icon={<CodeIcon />} title={t("tools.tab.json")} />
      <div className="tool-stack">
        <div className="tool-col">
          <label className="tool-label">{t("tools.json.input")}</label>
          <textarea
            className="tool-area"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("tools.json.placeholder")}
            spellCheck={false}
          />
          <div className="tool-actions">
            <button className="btn btn-primary btn-sm" onClick={() => run("pretty")}>
              {t("tools.json.format")}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => run("min")}>
              {t("tools.json.minify")}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => run("check")}>
              {t("tools.json.validate")}
            </button>
          </div>
        </div>
        <div className="tool-col">
          <label className="tool-label">{t("tools.json.output")}</label>
          <textarea
            className={`tool-area tool-out${error ? " is-error" : ""}`}
            value={error ?? output}
            readOnly
            spellCheck={false}
            wrap="off"
          />
          <div className="tool-actions">
            <CopyBtn text={error ?? output} label={t("tools.json.copy")} doneLabel={t("tools.json.copied")} />
          </div>
        </div>
      </div>
    </section>
  );
}

function CronTool() {
  const { t, locale } = useI18n();
  const [expr, setExpr] = useState("0 9 * * 1-5");
  const [result, setResult] = useState<{ fields: CronFields; runs: Date[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parse = () => {
    try {
      const fields = parseCron(expr);
      const runs = nextCronRuns(expr, 5);
      setResult({ fields, runs });
      setError(null);
    } catch {
      setResult(null);
      setError(t("tools.cron.invalid"));
    }
  };

  const fmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
        month: "2-digit",
        day: "2-digit",
        weekday: locale === "zh" ? "short" : undefined,
        hour: "2-digit",
        minute: "2-digit",
      }),
    [locale]
  );

  const rows: [string, string][] = result
    ? [
        ["分", fieldPhrase(result.fields.minute, "分")],
        ["时", fieldPhrase(result.fields.hour, "时")],
        ["日", fieldPhrase(result.fields.dom, "日")],
        ["月", fieldPhrase(result.fields.month, "月")],
        ["周", fieldPhrase(result.fields.dow, "周")],
      ]
    : [];

  return (
    <section className="tool-card">
      <ToolCardHead icon={<ClockIcon />} title={t("tools.tab.cron")} />
      <div className="tool-row">
        <input
          className="tool-input"
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          placeholder={t("tools.cron.placeholder")}
          spellCheck={false}
          aria-label={t("tools.cron.input")}
          onKeyDown={(e) => e.key === "Enter" && parse()}
        />
        <button className="btn btn-primary btn-sm" onClick={parse}>
          <ClockIcon />
          <span>{t("tools.cron.desc")}</span>
        </button>
      </div>
      <p className="tool-hint">{t("tools.cron.hint")}</p>

      {error && <div className="tool-error" role="alert">{error}</div>}

      {result && (
        <div className="cron-result">
          <div className="cron-grid">
            {rows.map(([k, v]) => (
              <div key={k} className="cron-field">
                <span className="cron-field-key">{k}</span>
                <span className="cron-field-val">{v}</span>
              </div>
            ))}
          </div>
          <h3 className="cron-next-title">{t("tools.cron.next")}</h3>
          {result.runs.length === 0 ? (
            <p className="tool-hint">{t("tools.cron.invalid")}</p>
          ) : (
            <ul className="cron-runs">
              {result.runs.map((d, i) => (
                <li key={i} className="cron-run">
                  <span className="cron-run-idx">{i + 1}</span>
                  {fmt.format(d)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function toPem(type: string, buf: ArrayBuffer): string {
  const b64 = bufToBase64(buf).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${type}-----\n${b64}\n-----END ${type}-----\n`;
}

function KeyTool() {
  const { t } = useI18n();
  const [size, setSize] = useState(2048);
  const [pub, setPub] = useState("");
  const [priv, setPriv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setError(null);
    if (!window.crypto?.subtle) {
      setError(t("tools.keys.unsupported"));
      return;
    }
    setBusy(true);
    try {
      const pair = await window.crypto.subtle.generateKey(
        {
          name: "RSA-OAEP",
          modulusLength: size,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["encrypt", "decrypt"]
      );
      const pubBuf = await window.crypto.subtle.exportKey("spki", pair.publicKey);
      const privBuf = await window.crypto.subtle.exportKey("pkcs8", pair.privateKey);
      setPub(toPem("PUBLIC KEY", pubBuf));
      setPriv(toPem("PRIVATE KEY", privBuf));
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="tool-card">
      <ToolCardHead icon={<KeyIcon />} title={t("tools.tab.keys")} />
      <div className="tool-row tool-row-wrap">
        <label className="tool-label inline">{t("tools.keys.size")}</label>
        <select
          className="tool-select"
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          aria-label={t("tools.keys.size")}
        >
          <option value={2048}>2048</option>
          <option value={4096}>4096</option>
        </select>
        <button className="btn btn-primary btn-sm" onClick={generate} disabled={busy}>
          {busy ? t("tools.keys.generating") : t("tools.keys.generate")}
        </button>
        {pub && !error && (
          <span className="tool-badge">RSA-OAEP · {size}</span>
        )}
      </div>

      {error && <div className="tool-error" role="alert">{error}</div>}

      <div className="tool-grid">
        <div className="tool-col">
          <label className="tool-label">{t("tools.keys.public")}</label>
          <textarea className="tool-area tool-out" value={pub} readOnly spellCheck={false} />
          <div className="tool-actions">
            <CopyBtn text={pub} label={t("tools.keys.copyPub")} doneLabel={t("tools.keys.copied")} />
          </div>
        </div>
        <div className="tool-col">
          <label className="tool-label">{t("tools.keys.private")}</label>
          <textarea className="tool-area tool-out" value={priv} readOnly spellCheck={false} />
          <div className="tool-actions">
            <CopyBtn text={priv} label={t("tools.keys.copyPriv")} doneLabel={t("tools.keys.copied")} />
          </div>
        </div>
      </div>
    </section>
  );
}

function PasswordTool() {
  const { t } = useI18n();
  const [length, setLength] = useState(16);
  const [upper, setUpper] = useState(true);
  const [lower, setLower] = useState(true);
  const [digits, setDigits] = useState(true);
  const [symbols, setSymbols] = useState(true);
  const [noAmbiguous, setNoAmbiguous] = useState(false);
  const [count, setCount] = useState(1);
  const [results, setResults] = useState<string[]>([]);

  const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const LOWER = "abcdefghijklmnopqrstuvwxyz";
  const DIGITS = "0123456789";
  const SYMS = "!@#$%^&*()-_=+[]{};:,.?";
  const AMBIG = "Il1O0o";

  const pool = useMemo(() => {
    let p = "";
    if (upper) p += UPPER;
    if (lower) p += LOWER;
    if (digits) p += DIGITS;
    if (symbols) p += SYMS;
    if (noAmbiguous) p = [...p].filter((c) => !AMBIG.includes(c)).join("");
    return p || LOWER;
  }, [upper, lower, digits, symbols, noAmbiguous]);

  const entropy = useMemo(() => length * Math.log2(pool.length), [length, pool]);
  const strengthClass = ((): string => {
    const e = entropy;
    if (e < 40) return "weak";
    if (e < 60) return "fair";
    if (e < 80) return "strong";
    return "excellent";
  })();

  const randInt = (max: number): number => {
    const buf = new Uint32Array(1);
    const limit = Math.floor(0xffffffff / max) * max;
    let x = 0;
    do {
      crypto.getRandomValues(buf);
      x = buf[0];
    } while (x >= limit);
    return x % max;
  };

  const generate = () => {
    const arr: string[] = [];
    for (let c = 0; c < count; c++) {
      let s = "";
      for (let i = 0; i < length; i++) s += pool[randInt(pool.length)];
      arr.push(s);
    }
    setResults(arr);
  };

  const opts: [boolean, (v: boolean) => void, DictKey][] = [
    [upper, setUpper, "tools.pass.uppercase"],
    [lower, setLower, "tools.pass.lowercase"],
    [digits, setDigits, "tools.pass.digits"],
    [symbols, setSymbols, "tools.pass.symbols"],
    [noAmbiguous, setNoAmbiguous, "tools.pass.excludeAmbiguous"],
  ];

  const strengthLabel = t(`tools.pass.strength.${strengthClass}` as DictKey);

  return (
    <section className="tool-card">
      <ToolCardHead icon={<LockIcon />} title={t("tools.tab.password")} />
      <div className="pw-controls">
        <div className="pw-slider">
          <div className="pw-slider-head">
            <label className="tool-label">{t("tools.pass.length")}</label>
            <span className="pw-num">{length}</span>
          </div>
          <input
            type="range"
            min={4}
            max={64}
            value={length}
            onChange={(e) => setLength(Number(e.target.value))}
            aria-label={t("tools.pass.length")}
          />
        </div>
        <div className="pw-checks">
          {opts.map(([val, set, key]) => (
            <label key={key} className="pw-check">
              <input type="checkbox" checked={val} onChange={(e) => set(e.target.checked)} />
              <span>{t(key)}</span>
            </label>
          ))}
        </div>
        <div className="pw-slider">
          <div className="pw-slider-head">
            <label className="tool-label">{t("tools.pass.count")}</label>
            <span className="pw-num">{count}</span>
          </div>
          <input
            type="range"
            min={1}
            max={10}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            aria-label={t("tools.pass.count")}
          />
        </div>
      </div>

      <div className="tool-row">
        <button className="btn btn-primary btn-sm" onClick={generate}>
          {t("tools.pass.generate")}
        </button>
        <CopyBtn text={results.join("\n")} label={t("tools.pass.copy")} doneLabel={t("tools.pass.copied")} />
      </div>

      {results.length > 0 && (
        <div className="pw-result">
          <div className="pw-strength">
            <span className="tool-label">{t("tools.pass.strength")}</span>
            <div className="pw-strength-bar">
              <span className={`pw-strength-fill s-${strengthClass}`} style={{ width: `${Math.min(100, (entropy / 128) * 100)}%` }} />
            </div>
            <span className="pw-strength-label">{strengthLabel}</span>
            <span className="pw-bits">{t("tools.entropy").replace("{bits}", entropy.toFixed(0))}</span>
          </div>
          <ul className="pw-list">
            {results.map((r, i) => (
              <li key={i} className="pw-item">
                <code>{r}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function UrlTool() {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const encode = () => {
    setError(null);
    try {
      setOutput(encodeURIComponent(input));
    } catch (e) {
      setError(friendlyError(e));
    }
  };
  const decode = () => {
    setError(null);
    try {
      setOutput(decodeURIComponent(input));
    } catch {
      setError(t("tools.url.invalid"));
    }
  };

  return (
    <section className="tool-card">
      <ToolCardHead icon={<LinkIcon />} title={t("tools.tab.url")} />
      <div className="tool-stack">
        <div className="tool-col">
          <label className="tool-label">{t("tools.url.input")}</label>
          <textarea
            className="tool-area"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("tools.url.placeholder")}
            spellCheck={false}
          />
          <div className="tool-actions">
            <button className="btn btn-primary btn-sm" onClick={encode}>
              {t("tools.url.encode")}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={decode}>
              {t("tools.url.decode")}
            </button>
          </div>
        </div>
        <div className="tool-col">
          <label className="tool-label">{t("tools.url.output")}</label>
          <textarea
            className={`tool-area tool-out${error ? " is-error" : ""}`}
            value={error ?? output}
            readOnly
            spellCheck={false}
            wrap="off"
          />
          <div className="tool-actions">
            <CopyBtn text={error ?? output} label={t("tools.url.copy")} doneLabel={t("tools.url.copied")} />
          </div>
        </div>
      </div>
    </section>
  );
}

const TABS: { key: string; labelKey: DictKey; icon: ReactNode }[] = [
  { key: "json", labelKey: "tools.tab.json", icon: <CodeIcon /> },
  { key: "cron", labelKey: "tools.tab.cron", icon: <ClockIcon /> },
  { key: "keys", labelKey: "tools.tab.keys", icon: <KeyIcon /> },
  { key: "password", labelKey: "tools.tab.password", icon: <LockIcon /> },
  { key: "url", labelKey: "tools.tab.url", icon: <LinkIcon /> },
];

export function DevToolsPage() {
  const { t } = useI18n();
  const [active, setActive] = useState("json");

  return (
    <div className="tools-page">
      <header className="tools-head">
        <span className="tools-head-icon"><SparkIcon /></span>
        <div className="tools-head-text">
          <h1>{t("tools.title")}</h1>
          <p className="tools-sub">{t("tools.subtitle")}</p>
        </div>
      </header>

      <div className="tools-tabs" role="tablist" aria-label={t("tools.title")}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={active === tab.key}
            className={`tools-tab${active === tab.key ? " active" : ""}`}
            onClick={() => setActive(tab.key)}
          >
            {tab.icon}
            <span>{t(tab.labelKey)}</span>
          </button>
        ))}
      </div>

      <div className="tools-panel" role="tabpanel" key={active}>
        {active === "json" && <JsonTool />}
        {active === "cron" && <CronTool />}
        {active === "keys" && <KeyTool />}
        {active === "password" && <PasswordTool />}
        {active === "url" && <UrlTool />}
      </div>
    </div>
  );
}
