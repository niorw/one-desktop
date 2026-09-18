import { Icons } from "../../common/Icons";
import type { RendererProps } from "./types";

/** 兜底渲染器：未知/二进制类型 → 文件卡 + 系统程序打开 + 在文件夹中显示。 */
export function FallbackRenderer({ media, onOpen, onReveal, t }: RendererProps) {
  if (!media) {
    return (
      <div className="artifact-error">
        {t?.("groups.deliverables.fileMissing") ?? "无文件"}
      </div>
    );
  }

  return (
    <div className="artifact-fallback">
      <div className="artifact-filecard">
        <span className="artifact-filecard-ic">
          <Icons.FileText size={28} />
        </span>
        <div className="artifact-filecard-meta">
          <div className="artifact-filecard-name">{media.name}</div>
          <div className="artifact-filecard-path">{media.path}</div>
        </div>
      </div>
      <div className="artifact-actions">
        <button className="btn btn-secondary btn-sm" type="button" onClick={() => onOpen?.(media.path)}>
          {t?.("groups.deliverables.open") ?? "打开"}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => onReveal?.(media.path)}>
          {t?.("groups.deliverables.reveal") ?? "在文件夹中显示"}
        </button>
      </div>
      <p className="artifact-hint">
        {t?.("groups.deliverables.fallbackHint") ?? "该类型不支持站内预览，请在系统程序中打开。"}
      </p>
    </div>
  );
}
