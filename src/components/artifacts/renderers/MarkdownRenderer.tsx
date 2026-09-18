import { Markdown } from "../../../utils/markdown";
import { useArtifactText } from "../useArtifactText";
import { isTextExt } from "./rendererFor";
import type { RendererProps } from "./types";

/** Markdown / 文本渲染器：复用 `utils/markdown`。content 优先，空且有文本类文件则读文件。 */
export function MarkdownRenderer({ content, media, t }: RendererProps) {
  const needFile = !content && !!media && isTextExt(media.path || media.name || "");
  const { content: fileContent, loading, error } = useArtifactText(
    needFile ? media!.path : undefined,
  );
  const text = content || fileContent || "";

  if (loading) return <div className="artifact-loading">{t?.("groups.deliverables.loading") ?? "加载中…"}</div>;
  if (error)
    return (
      <div className="artifact-error">
        {t?.("groups.deliverables.renderFailed") ?? "渲染失败"}：{error}
      </div>
    );

  return (
    <div className="artifact-md">
      <Markdown>{text}</Markdown>
    </div>
  );
}
