import { useEffect, useMemo, useState } from "react";
import "./artifacts.css";
import { useI18n } from "../../i18n/I18nProvider";
import type { Deliverable, DeliverableKind, TraceRef, Worker } from "../../types";
import { fmtDelivTime, agentDisplayName } from "../groups/parts/helpers";
import { openInDefaultApp, revealInFolder, openInBrowser } from "../../utils/openFile";
import { rendererFor, kindForMedia, RENDERERS } from "./renderers";
import { ArtifactTraceDrawer } from "./ArtifactTraceDrawer";
import { useArtifactText } from "./useArtifactText";
import { Icons } from "../common/Icons";

const LARGE_FILE_BYTES = 5 * 1024 * 1024;

interface Props {
  /** 群产出物（reply/task_output/summary）。与 filePath 二选一。 */
  deliverable?: Deliverable;
  /** 任意模型产出文件的绝对路径（通用预览入口：chat 写盘 / 任务输出 / 全局浏览器）。 */
  filePath?: string;
  /**
   * 当前会话 id。可选：传给后端做 basename 兜底（LLM 答案文本里的幻觉路径，
   * 后端按此 session 的 changeset product 行唯一匹配回退到真实文件）。
   */
  sessionId?: string;
  /** 预设溯源引用（来自调用方已知的会话）。 */
  presetTraceRef?: TraceRef | null;
  workers?: Worker[];
  resolveName?: (ref: string) => string;
  onClose: () => void;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}


/**
 * 统一文件预览容器（WorkBuddy 右侧边栏风格）。
 * 纯前端聚合视图：渲染器注册表分发 + 顶部轻量附件切换 + 头部操作。
 * 两种打开方式：
 * - 传 `deliverable`：群产出物（带作者/溯源等元信息）。
 * - 传 `filePath`：任意模型产出文件，自动按扩展名选择渲染器。
 */
export function ArtifactPreview({
  deliverable,
  filePath,
  sessionId,
  presetTraceRef,
  workers = [],
  resolveName = () => "",
  onClose,
}: Props) {
  const { t, locale } = useI18n();
  const [activeIndex, setActiveIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [traceRef, setTraceRef] = useState<TraceRef | null>(presetTraceRef ?? null);

  // 非模态右栏：Esc 关闭；溯源抽屉（modal）打开时让权给它，避免双重关闭。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (traceRef) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, traceRef]);

  // 重置 activeIndex 当请求变化时。
  useEffect(() => {
    setActiveIndex(0);
  }, [filePath, deliverable?.id]);

  const isPathMode = !deliverable && !!filePath;
  const fileName = filePath ? basename(filePath) : "";
  const isImage = filePath
    ? kindForMedia({ type: "file", path: filePath, name: fileName }) === "image"
    : false;

  // 文本类文件预读内容（图片走 base64，不预读）。
  const { content: fileText, loading: fileLoading, error: fileError, reload: fileReload } = useArtifactText(
    isPathMode && !isImage ? filePath : undefined,
    isPathMode ? sessionId : undefined,
  );

  // 路径模式合成一个最小 deliverable，复用既有渲染器。
  const synthetic: Deliverable | null = useMemo(
    () =>
      isPathMode
        ? {
            id: `file:${filePath}`,
            kind: "file" as unknown as DeliverableKind,
            title: fileName,
            author: "",
            worker_id: "",
            created_at: 0,
            preview: fileText ? fileText.slice(0, 200) : fileName,
            content: fileText ?? "",
            ref_seq: null,
            ref_id: null,
            meta: "",
            media: [
              {
                type: isImage ? "image" : "file",
                path: filePath!,
                name: fileName,
                size: undefined,
                mime: undefined,
                mtime: undefined,
              },
            ],
            trace_ref: presetTraceRef ?? null,
          }
        : null,
    [isPathMode, filePath, fileName, isImage, fileText, presetTraceRef],
  );

  const effective = deliverable ?? synthetic;

  const authorLabel = useMemo(() => {
    if (!effective) return "";
    const w = workers.find((x) => x.id === effective.worker_id);
    return w
      ? agentDisplayName(w, resolveName, t)
      : effective.author
        ? resolveName(effective.author)
        : "";
  }, [workers, effective, resolveName, t]);

  if (!effective) return null;

  if (fileLoading) {
    return (
      <div className="artifact-dock" role="complementary" aria-label={t("groups.deliverables.detailTitle")}>
        <div className="artifact-head">
          <span className="artifact-head-name">{fileName || t("groups.deliverables.loading")}</span>
          <button className="artifact-head-btn" onClick={onClose} aria-label={t("common.cancel")}>
            <Icons.Close size={16} />
          </button>
        </div>
        <div className="artifact-dock-body">{t("groups.deliverables.loading")}</div>
      </div>
    );
  }

  if (fileError) {
    return (
      <div className="artifact-dock" role="complementary" aria-label={t("groups.deliverables.detailTitle")}>
        <div className="artifact-head">
          <span className="artifact-head-name">{fileName || t("groups.deliverables.renderFailedTitle")}</span>
          <button className="artifact-head-btn" onClick={onClose} aria-label={t("common.cancel")}>
            <Icons.Close size={16} />
          </button>
        </div>
        <div className="artifact-dock-body">
          <div className="artifact-error">{t("groups.deliverables.renderFailed", { msg: fileError })}</div>
        </div>
      </div>
    );
  }

  const media = effective.media ?? [];
  const activeMedia = media[activeIndex] ?? media[0];

  const timeLabel = effective.created_at
    ? fmtDelivTime(effective.created_at, locale)
    : (t("groups.deliverables.noTime") ?? "—");

  const kind = rendererFor(effective, activeMedia);
  const Renderer = RENDERERS[kind];

  const showLargeWarn = activeMedia?.size !== undefined && activeMedia.size > LARGE_FILE_BYTES;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(effective.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard 可能不可用 */
    }
  };

  const activePath = activeMedia?.path || filePath || "";

  return (
    <div className="artifact-dock" role="complementary" aria-label={t("groups.deliverables.detailTitle")}>
      <div className="artifact-head">
        <div className="artifact-head-title">
          <span className="artifact-head-icon">
            <Icons.FileText size={18} />
          </span>
          <div className="artifact-head-text">
            <span className="artifact-head-name" title={effective.title}>
              {effective.title}
            </span>
            {(authorLabel || timeLabel !== "—" || activePath) && (
              <span className="artifact-head-sub">
                {authorLabel && timeLabel !== "—"
                  ? `${authorLabel} · ${timeLabel}`
                  : authorLabel || timeLabel || ""}
                {activePath && (authorLabel || timeLabel !== "—") ? " · " : ""}
                {activePath && <span className="artifact-head-path" title={activePath}>{activePath}</span>}
              </span>
            )}
          </div>
        </div>

        <div className="artifact-head-actions">
          {isPathMode && (
            <button
              className="artifact-head-btn"
              type="button"
              title={t("files.refresh")}
              onClick={() => fileReload()}
            >
              <Icons.Refresh size={14} />
            </button>
          )}
          <button
            className="artifact-head-btn"
            type="button"
            title={copied ? t("groups.deliverables.copied") : t("groups.deliverables.copy")}
            onClick={copy}
          >
            {copied ? <Icons.Check size={14} /> : <Icons.Copy size={14} />}
          </button>
          {activeMedia && (
            <button
              className="artifact-head-btn"
              type="button"
              title={t("groups.deliverables.openInBrowser")}
              onClick={() => void openInBrowser(activeMedia.path)}
            >
              <Icons.Globe size={14} />
            </button>
          )}
          {activeMedia && (
            <button
              className="artifact-head-btn"
              type="button"
              title={t("groups.deliverables.reveal") ?? "在文件夹中显示"}
              onClick={() => void revealInFolder(activeMedia.path)}
            >
              <Icons.FolderOpen size={14} />
            </button>
          )}
          {effective.trace_ref && (
            <button
              className="artifact-head-btn"
              type="button"
              title={t("groups.deliverables.viewTrace") ?? "查看产生轨迹"}
              onClick={() => setTraceRef(effective.trace_ref!)}
            >
              <Icons.GitBranch size={14} />
            </button>
          )}
          <button
            className="artifact-head-btn artifact-head-close"
            type="button"
            onClick={onClose}
            aria-label={t("common.cancel")}
          >
            <Icons.Close size={16} />
          </button>
        </div>
      </div>

      {media.length > 1 && (
        <div className="artifact-tabs" role="tablist" aria-label={t("groups.deliverables.attachments") ?? "附件"}>
          {media.map((m, idx) => (
            <button
              key={`${m.path}-${idx}`}
              role="tab"
              aria-selected={idx === activeIndex}
              className={`artifact-tab ${idx === activeIndex ? "active" : ""}`}
              onClick={() => setActiveIndex(idx)}
              title={m.path}
            >
              <Icons.FileText size={12} />
              <span>{m.name || basename(m.path)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="artifact-main">
        {showLargeWarn && (
          <div className="artifact-warn">
            <Icons.AlertTriangle size={14} />
            <span>{t("groups.deliverables.largeFileWarn") ?? "文件较大，建议用系统程序打开。"}</span>
          </div>
        )}
        <Renderer
          content={effective.content}
          media={activeMedia}
          onOpen={openInDefaultApp}
          onReveal={revealInFolder}
          t={t}
        />
      </div>

      {traceRef && (
        <ArtifactTraceDrawer traceRef={traceRef} onClose={() => setTraceRef(null)} t={t} />
      )}
    </div>
  );
}
