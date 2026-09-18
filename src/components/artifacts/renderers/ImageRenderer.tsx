import { useArtifactBase64 } from "../useArtifactBase64";
import type { RendererProps } from "./types";

/**
 * 图片渲染器：站内内嵌大图。
 * 经 `artifact_read_base64` 取 base64 + mime → `data:` URL 内嵌，
 * 不再依赖 asset protocol 静态白名单，因此用户自选工作区里的图片也能预览。
 * 加载失败（文件被删 / scope 外）→ 降级文件卡 + 打开/在文件夹中显示。
 */
export function ImageRenderer({ media, onOpen, onReveal, t }: RendererProps) {
  const { dataUrl, loading, error } = useArtifactBase64(media?.path);

  if (!media) {
    return (
      <div className="artifact-error">
        {t?.("groups.deliverables.fileMissing") ?? "无图片文件"}
      </div>
    );
  }

  if (loading) {
    return <div className="artifact-loading">{t?.("groups.deliverables.loading") ?? "加载中…"}</div>;
  }

  if (error || !dataUrl) {
    return (
      <div className="artifact-error">
        <p>{t?.("groups.deliverables.imageLoadFailed") ?? "图片无法加载（文件已移动或删除）"}</p>
        <div className="artifact-actions">
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => onOpen?.(media.path)}>
            {t?.("groups.deliverables.open") ?? "打开"}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => onReveal?.(media.path)}>
            {t?.("groups.deliverables.reveal") ?? "在文件夹中显示"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="artifact-image">
      <img
        className="artifact-image-img"
        src={dataUrl}
        alt={media.name}
        onClick={() => onOpen?.(media.path)}
      />
    </div>
  );
}
