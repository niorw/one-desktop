/**
 * RunArtifactsEntry — R8：答案气泡上方的「查看所有产物 / 变更」入口。
 * ----------------------------------------------------------------------------
 * 挂载点：MessageList 每个答案气泡（AssistantItem.runId 非空）上方。
 * - 计数 > 0 才渲染（用户确认：只展示有内容的入口）。
 * - 产物计数：优先用事件/落库下发的 `artifacts`（写入文件清单，即时、无需查库）；
 *   回落到 changeset 表的 product 行（history 路径）。
 * - 变更计数：据 `run_id` 查 `run_changesets` 的 change 行（before_content ≠ null）。
 * - 点击任一入口打开**右侧抽屉**（非居中弹窗 —— 2026-08-17 用户反馈：弹窗遮挡阅读、视觉割裂），
 *   复用 RunChangesetPanel（自带 产物/变更 双标签页 + 标题/折叠头，外部无需再包一层 head）。
 *   入口决定初始聚焦的标签页。抽屉遵循 a11y（role=dialog + useDialogA11y）。
 */
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { DictKey } from "../../i18n/dict";
import { Icons } from "../common/Icons";
import { useDialogA11y } from "../common/useDialogA11y";
import { RunChangesetPanel } from "../tasks/RunChangesetPanel";
import * as tauri from "../../services/tauri";
import type { ChangesetRowDto } from "../../types";

const isNormal = (r: ChangesetRowDto) => r.snapshot_type === "normal";

export function RunArtifactsEntry({
  runId,
  artifacts,
}: {
  runId: string;
  artifacts?: string[];
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<ChangesetRowDto[] | null>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"product" | "change">("change");
  const dialogRef = useDialogA11y<HTMLDivElement>(open, () => setOpen(false));

  // 拉取本 run 的 changeset，用于「变更」计数与弹窗内容。
  useEffect(() => {
    let cancelled = false;
    tauri
      .runChangesets(runId)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const { products, changes } = useMemo(() => {
    const norm = (rows ?? []).filter(isNormal);
    return {
      products: norm.filter((r) => r.before_content === null),
      changes: norm.filter((r) => r.before_content !== null),
    };
  }, [rows]);

  // 产物计数：优先实时下发清单，回落 changeset product 行。
  const productCount = artifacts && artifacts.length > 0 ? artifacts.length : products.length;
  const changeCount = changes.length;

  if (productCount === 0 && changeCount === 0) return null;

  const openWith = (which: "product" | "change") => {
    setTab(which);
    setOpen(true);
  };

  const refetch = () => {
    tauri.runChangesets(runId).then(setRows).catch(() => {});
  };

  return (
    <>
      <div className="ra-entry">
        {productCount > 0 && (
          <button className="ra-btn" onClick={() => openWith("product")} title={t("tasks.runChangeset.products" as DictKey)}>
            <Icons.FileText size={14} />
            <span>{t("tasks.runChangeset.products" as DictKey)}</span>
            <span className="ra-count">{productCount}</span>
          </button>
        )}
        {changeCount > 0 && (
          <button className="ra-btn" onClick={() => openWith("change")} title={t("tasks.runChangeset.changes" as DictKey)}>
            <Icons.Edit size={14} />
            <span>{t("tasks.runChangeset.changes" as DictKey)}</span>
            <span className="ra-count">{changeCount}</span>
          </button>
        )}
      </div>

      {open && (
        // 右侧抽屉（替代居中弹窗，2026-08-17）：用户反馈弹窗遮挡阅读、视觉割裂，
        // 抽屉不打断左侧主阅读流，扫读答案时仍可见上下文。
        <div className="drawer-overlay ra-drawer-overlay" onClick={() => setOpen(false)}>
          <div
            className="drawer ra-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={t("tasks.runChangeset.title" as DictKey)}
            ref={dialogRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ra-drawer-body">
              <RunChangesetPanel
                runId={runId}
                runTitle={runId}
                rows={rows ?? undefined}
                initialTab={tab}
                onChanged={refetch}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
