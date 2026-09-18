/**
 * RunChangesetPanel — run 级「产物 / 变更 / Diff 审阅」（ADR-021 / UX-021）
 * ----------------------------------------------------------------------------
 * 挂载点：run 详情抽屉 / 产物入口下的「审阅改动 ▸ N」展开区（HtmlRenderer、RunArtifactsEntry 引用）。
 * - 产物组（before_content = null）：文件卡片 + 预览 + 版本 + 回滚（删除新建）。
 * - 变更组（before_content ≠ null）：文件名 + 摘要 +N/~M/-K + 内联红绿 diff + 版本胶囊 + 回滚。
 * - 回滚走存档式（ADR-021 §6.2）：被后续修改覆盖时先自动存档再回滚，不丢数据。
 *
 * 数据来自 `run_changesets`；diff 由共享 DiffView 用 before/after_content 做 LCS。
 * 样式见 run-changeset.css（.run-cs-* 前缀，dark 透明白）。
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { DictKey } from "../../i18n/dict";
import * as tauri from "../../services/tauri";
import { Icons } from "../common/Icons";
import type { ChangesetRowDto } from "../../types";
import { DiffView } from "../common/DiffView";
import "./run-changeset.css";
import { friendlyError } from "../../services/errors";

const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/* 新增同规格单色图标（1.5px，禁彩色 emoji；与 Icons.tsx 同语言） */
const DiffLines = ({ size = 14 }: { size?: number }) => (
  <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 4h4M9 4h4" />
    <path d="M3 8h4M9 8h4" />
    <path d="M3 12h10" />
  </svg>
);
const History = ({ size = 14 }: { size?: number }) => (
  <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 8a5.5 5.5 0 1 0 1.7-3.97" />
    <path d="M2 2v3h3" />
    <path d="M8 5v3l2 1.5" />
  </svg>
);
const Undo = ({ size = 14 }: { size?: number }) => (
  <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 4 2.5 7.5 6 11" />
    <path d="M2.5 7.5H9a4 4 0 0 1 0 8H5" />
  </svg>
);

function errText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof (e as { message?: unknown }).message === "string")
    return (e as { message: string }).message;
  return friendlyError(e);
}

function fileIcon(file: string): React.ReactNode {
  if (file.endsWith(".md")) return <Icons.FileText size={16} />;
  if (file.endsWith(".yaml") || file.endsWith(".yml")) return <Icons.Edit size={16} />;
  if (file.endsWith(".ts") || file.endsWith(".tsx")) return <Icons.Edit size={16} />;
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(file)) return <Icons.Image size={16} />;
  return <Icons.WriteFile size={16} />;
}

function kindOf(file: string): "image" | "html" | "text" {
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(file)) return "image";
  if (file.endsWith(".html") || file.endsWith(".htm")) return "html";
  return "text";
}

/* ── 产物卡片行 ── */
function ProductRow({
  row,
  runId,
  versions,
  rollingId,
  onRollback,
  onLoadVersions,
}: {
  row: ChangesetRowDto;
  runId: string;
  versions: ChangesetRowDto[];
  rollingId: string | null;
  onRollback: (id: string) => void;
  onLoadVersions: (file: string) => void;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState(false);
  const [openVer, setOpenVer] = useState(false);
  const kind = kindOf(row.file);
  const verList = versions.length ? versions : [row];
  const latest = verList[verList.length - 1];

  return (
    <div className="run-cs-row">
      <div className="run-cs-row-main">
        <span className="run-cs-file-icon">{fileIcon(row.file)}</span>
        <div className="run-cs-file-meta">
          <span className="run-cs-file-name">{row.file}</span>
          <span className="run-cs-file-sub">
            {kind === "image" ? t("tasks.runChangeset.image" as DictKey) : kind === "html" ? "HTML" : t("tasks.runChangeset.text" as DictKey)}
            {latest.after_content && !/\.(png|jpe?g|gif)$/i.test(row.file) ? ` · ${new Blob([latest.after_content]).size} B` : ""}
          </span>
        </div>
        <div className="run-cs-actions">
          <button className="run-cs-act" onClick={() => { setPreview((p) => !p); onLoadVersions(row.file); }}>
            <Icons.Eye size={13} /> {t("tasks.runChangeset.preview" as DictKey)}
          </button>
          <button className="run-cs-act" onClick={() => { setOpenVer((v) => !v); onLoadVersions(row.file); }}>
            <History size={13} /> {t("tasks.runChangeset.version" as DictKey)} v{verList.length}
          </button>
          <button className="run-cs-act danger" disabled={rollingId === row.id} onClick={() => onRollback(row.id)}>
            <Undo size={13} /> {t("tasks.runChangeset.rollback" as DictKey)}
          </button>
        </div>
      </div>

      {preview && (
        <div className="run-cs-diff">
          {kind === "image" ? (
            <div className="run-cs-binary-note">{t("tasks.runChangeset.imagePreview" as DictKey)}</div>
          ) : kind === "html" ? (
            <iframe className="run-cs-html" sandbox="" title="preview" srcDoc={latest.after_content ?? ""} />
          ) : (
            <pre className="run-cs-code" style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", fontSize: 13 }}>
              {(latest.after_content ?? "").slice(0, 2000)}
            </pre>
          )}
        </div>
      )}

      {openVer && (
        <div className="run-cs-diff">
          <div className="run-cs-versions" role="group" aria-label={t("changeset.version.history" as DictKey)}>
            {verList.map((v, i) => (
              <button key={v.id} className="run-cs-ver" aria-pressed={i === verList.length - 1}>
                v{i + 1}
                {i === verList.length - 1 && <span className="run-cs-ver-snapshot" title={t("changeset.version.current" as DictKey)} />}
              </button>
            ))}
          </div>
          <div className="run-cs-binary-note">{t("tasks.runChangeset.versionNote" as DictKey)}</div>
        </div>
      )}
    </div>
  );
}

/* ── 变更文件行 ── */
function ChangeRow({
  row,
  runId,
  versions,
  rollingId,
  onRollback,
  onLoadVersions,
}: {
  row: ChangesetRowDto;
  runId: string;
  versions: ChangesetRowDto[];
  rollingId: string | null;
  onRollback: (id: string) => void;
  onLoadVersions: (file: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState<"ok" | "err" | null>(null);

  const verList = versions.length ? versions : [row];
  const [selId, setSelId] = useState<string>(verList[verList.length - 1]?.id ?? row.id);
  const selected = verList.find((v) => v.id === selId) ?? verList[verList.length - 1] ?? row;
  const isBinary = selected.before_content !== null && selected.after_content === null;

  return (
    <div className={cn("run-cs-row", open && "is-open")}>
      <div className="run-cs-row-main">
        <button
          className="run-cs-expand"
          aria-expanded={open}
          aria-label={open ? t("tasks.runChangeset.collapse" as DictKey) : t("tasks.runChangeset.expand" as DictKey)}
          onClick={() => { setOpen((o) => !o); setConfirm(false); if (!open) onLoadVersions(row.file); }}
        >
          <span className="run-cs-expand-chevron"><Icons.ChevronRight size={12} /></span>
        </button>
        <span className="run-cs-file-icon">{fileIcon(row.file)}</span>
        <div className="run-cs-file-meta">
          <span className="run-cs-file-name">{row.file}</span>
        </div>
        <div className="run-cs-actions">
          <button className="run-cs-act" onClick={() => { setOpen(true); onLoadVersions(row.file); }}>
            <History size={13} /> {t("tasks.runChangeset.version" as DictKey)}
          </button>
          <button
            className="run-cs-act danger"
            disabled={rollingId === row.id}
            onClick={() => { setConfirm(true); setOpen(true); onLoadVersions(row.file); }}
          >
            <Undo size={13} /> {t("tasks.runChangeset.rollback" as DictKey)}
          </button>
        </div>
      </div>

      {open && (
        <>
          <div className="run-cs-diff">
            {verList.length > 1 && (
              <div className="run-cs-versions" role="group" aria-label={t("changeset.version.history" as DictKey)}>
                {verList.map((v, i) => (
                  <button
                    key={v.id}
                    className="run-cs-ver"
                    aria-pressed={v.id === selId}
                    onClick={() => setSelId(v.id)}
                  >
                    v{i + 1}
                    {i === verList.length - 1 && <span className="run-cs-ver-snapshot" title={t("changeset.version.current" as DictKey)} />}
                  </button>
                ))}
              </div>
            )}
            {isBinary ? (
              <div className="run-cs-binary-note">{t("changeset.diff.binary" as DictKey)}</div>
            ) : (
              <DiffView before={selected.before_content} after={selected.after_content} />
            )}
          </div>

          {confirm && !done && (
            <div className="run-cs-confirm" role="alertdialog" aria-label={t("changeset.rollback.confirm" as DictKey)}>
              <span className="run-cs-confirm-text">{t("changeset.rollback.confirm" as DictKey)}</span>
              <div className="run-cs-confirm-actions">
                <button className="btn btn-ghost" onClick={() => setConfirm(false)} disabled={rollingId === row.id}>
                  {t("tasks.runChangeset.cancel" as DictKey)}
                </button>
                <button
                  className="btn btn-danger"
                  disabled={rollingId === row.id}
                  onClick={() => { setConfirm(false); onRollback(row.id); }}
                >
                  {rollingId === row.id ? <><span className="run-cs-spin" /> {t("tasks.runChangeset.rolling" as DictKey)}</> : t("tasks.runChangeset.rollback" as DictKey)}
                </button>
              </div>
            </div>
          )}

          {done === "ok" && (
            <div className="run-cs-feedback ok">
              <Icons.Check size={14} />
              <span>
                {t("changeset.rollback.done" as DictKey)}
                <small>{t("changeset.rollback.archived" as DictKey)}</small>
              </span>
            </div>
          )}
          {done === "err" && (
            <div className="run-cs-feedback err">
              <Icons.AlertTriangle size={14} />
              <span>{t("changeset.rollback.failed" as DictKey)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── 面板主体 ── */
export interface RunChangesetPanelProps {
  runId: string;
  runTitle: string;
  /** 预取的 rows；缺省时组件自行拉取。 */
  rows?: ChangesetRowDto[];
  /** 回滚成功后通知父级刷新计数。 */
  onChanged?: () => void;
  /** R8：外部入口（如答案气泡上方「查看所有产物」）指定初始聚焦的标签页。 */
  initialTab?: "product" | "change";
}

export function RunChangesetPanel({ runId, runTitle, rows: initial, onChanged, initialTab = "change" }: RunChangesetPanelProps) {
  const { t } = useI18n();
  const [rows, setRows] = useState<ChangesetRowDto[] | null>(initial ?? null);
  const [loading, setLoading] = useState(initial == null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"product" | "change">(initialTab);
  const [rollingId, setRollingId] = useState<string | null>(null);
  const [versionsFor, setVersionsFor] = useState<Record<string, ChangesetRowDto[]>>({});

  const load = useCallback(() => {
    if (initial) {
      setRows(initial);
      setLoading(false);
      return;
    }
    setLoading(true);
    tauri
      .runChangesets(runId)
      .then((r) => { setRows(r); setError(null); })
      .catch((e) => setError(errText(e)))
      .finally(() => setLoading(false));
  }, [runId, initial]);

  useEffect(() => { load(); }, [load]);

  const handleRollback = (id: string) => {
    if (rollingId) return;
    setRollingId(id);
    tauri
      .changesetRollback(id)
      .then(() => { load(); onChanged?.(); })
      .catch(() => setRollingId(null))
      .finally(() => setRollingId((cur) => (cur === id ? null : cur)));
  };

  const loadVersions = (file: string) => {
    if (versionsFor[file]) return;
    tauri
      .runChangesetVersions(runId, file)
      .then((v) => setVersionsFor((p) => ({ ...p, [file]: v })))
      .catch(() => setVersionsFor((p) => ({ ...p, [file]: [] })));
  };

  const products = useMemo(
    () => (rows ?? []).filter((r) => r.before_content === null && r.snapshot_type === "normal"),
    [rows]
  );
  const productFiles = useMemo(() => {
    const m = new Map<string, number>();
    products.forEach((p) => m.set(p.file, (m.get(p.file) ?? 0) + 1));
    return Array.from(m.entries());
  }, [products]);
  const changes = useMemo(
    () => (rows ?? []).filter((r) => r.before_content !== null && r.snapshot_type === "normal"),
    [rows]
  );

  if (loading) return <div className="run-cs-binary-note">{t("tasks.runChangeset.loading" as DictKey)}</div>;
  if (error) return <div className="run-cs-binary-note run-cs-err">{error}</div>;

  return (
    <div className="run-cs-panel" role="region" aria-label={t("tasks.runChangeset.title" as DictKey)}>
      <div className="run-cs-head">
        <div className="run-cs-head-titles">
          <span className="run-cs-title"><DiffLines /> {t("tasks.runChangeset.title" as DictKey)}</span>
          <span className="run-cs-sub">{runTitle}</span>
        </div>
      </div>

      <div className="run-cs-tabs" role="tablist" aria-label={t("tasks.runChangeset.title" as DictKey)}>
        <button role="tab" aria-selected={tab === "product"} className="run-cs-tab" onClick={() => setTab("product")}>
          {t("tasks.runChangeset.products" as DictKey)} <span className="run-cs-tab-count">{productFiles.length}</span>
        </button>
        <button role="tab" aria-selected={tab === "change"} className="run-cs-tab" onClick={() => setTab("change")}>
          {t("tasks.runChangeset.changes" as DictKey)} <span className="run-cs-tab-count">{changes.length}</span>
        </button>
      </div>

      {tab === "product" ? (
        <div className="run-cs-list" role="tabpanel">
          {productFiles.length === 0 ? (
            <div className="run-cs-binary-note">{t("tasks.runChangeset.emptyProducts" as DictKey)}</div>
          ) : (
            productFiles.map(([file, _ver]) => {
              const row = products.find((p) => p.file === file)!;
              return (
                <ProductRow
                  key={file}
                  row={row}
                  runId={runId}
                  versions={versionsFor[file] ?? []}
                  rollingId={rollingId}
                  onRollback={handleRollback}
                  onLoadVersions={loadVersions}
                />
              );
            })
          )}
        </div>
      ) : (
        <div className="run-cs-list" role="tabpanel">
          {changes.length === 0 ? (
            <div className="run-cs-binary-note">{t("tasks.runChangeset.emptyChanges" as DictKey)}</div>
          ) : (
            changes.map((row) => (
              <ChangeRow
                key={row.id}
                row={row}
                runId={runId}
                versions={versionsFor[row.file] ?? []}
                rollingId={rollingId}
                onRollback={handleRollback}
                onLoadVersions={loadVersions}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default RunChangesetPanel;
