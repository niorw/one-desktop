import { useArtifactText } from "../useArtifactText";
import { isTextExt } from "./rendererFor";
import type { RendererProps } from "./types";

/** 代码渲染器：带行号与迷你滚动地图的编辑器风格预览。 */
export function CodeRenderer({ content, media, t }: RendererProps) {
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

  const lines = text.split("\n");
  const lineDigits = Math.max(2, String(lines.length).length);

  return (
    <div className="artifact-code-editor">
      <div className="artifact-code-scroll">
        <div className="artifact-code-gutter" aria-hidden>
          {lines.map((_, i) => (
            <div key={i} className="artifact-code-line-no">
              {i + 1}
            </div>
          ))}
        </div>
        <pre className="artifact-code-content">
          <code>
            {lines.map((line, i) => (
              <div key={i} className="artifact-code-line">
                <span className="artifact-code-line-text">{line || " "}</span>
              </div>
            ))}
          </code>
        </pre>
      </div>
      <div className="artifact-code-minimap" aria-hidden>
        <div className="artifact-code-minimap-track">
          {lines.map((line, i) => (
            <div
              key={i}
              className="artifact-code-minimap-line"
              style={{ opacity: line.trim() ? 0.35 : 0.12 }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
