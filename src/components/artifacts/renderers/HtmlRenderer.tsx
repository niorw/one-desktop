import { useArtifactText } from "../useArtifactText";
import { useTheme } from "../../../hooks/useTheme";
import type { RendererProps } from "./types";

/**
 * 生成 iframe 内文档的主题 base style（iframe 是独立文档，不继承外层 CSS 变量，
 * 必须用实际色值注入）。覆盖 body / input / table / a / code 等常见元素。
 */
function themeBaseCSS(isDark: boolean): string {
  if (isDark) {
    return `
      body { background: #101012; color: #f5f5f7; }
      input, textarea, select {
        background: #1c1c1e; color: #f5f5f7; border: 1px solid rgba(255,255,255,.1);
        border-radius: 6px; padding: 4px 8px;
      }
      input::placeholder, textarea::placeholder { color: #6e6e73; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid rgba(255,255,255,.1); padding: 4px 8px; text-align: left; }
      th { background: #2c2c2e; font-weight: 600; }
      tr:nth-child(even) { background: #1c1c1e; }
      a { color: #0a84ff; }
      code { background: #2c2c2e; padding: 2px 5px; border-radius: 4px; font-size: .9em; }
      pre { background: #1c1c1e; padding: 10px; border-radius: 8px; overflow-x: auto; }
      pre code { background: none; padding: 0; }
      blockquote { border-left: 3px solid #2c2c2e; margin: 0; padding-left: 12px; color: #aeaeb2; }
    `;
  }
  return `
    body { background: #fafafc; color: #1d1d1f; }
    input, textarea, select {
      background: #ffffff; color: #1d1d1f; border: 1px solid #d2d2d7;
      border-radius: 6px; padding: 4px 8px;
    }
    input::placeholder, textarea::placeholder { color: #c7c7cc; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #e5e5ea; padding: 4px 8px; text-align: left; }
    th { background: #f5f5f7; font-weight: 600; }
    tr:nth-child(even) { background: #fafafc; }
    a { color: #006edb; }
    code { background: #f5f5f7; padding: 2px 5px; border-radius: 4px; font-size: .9em; }
    pre { background: #f5f5f7; padding: 10px; border-radius: 8px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
    blockquote { border-left: 3px solid #d2d2d7; margin: 0; padding-left: 12px; color: #6e6e73; }
  `;
}

/**
 * HTML 渲染器：沙箱 iframe（`sandbox=""` 无脚本无同源，复用 RunChangesetPanel 模式）。
 * 内容经 `artifact_read_text` 读取，不接受任意 URL；相对资源在 P0 不可加载（已知降级）。
 *
 * 主题适配：检测外层 light/dark，向 srcDoc 注入匹配的 base style（iframe 不继承父级 CSS 变量）。
 */
export function HtmlRenderer({ media, content, t }: RendererProps) {
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const needFile = !content && !!media;
  const { content: fileContent, loading, error } = useArtifactText(
    needFile ? media!.path : undefined,
  );
  const rawHtml = content || fileContent || "";

  if (loading) return <div className="artifact-loading">{t?.("groups.deliverables.loading") ?? "加载中…"}</div>;
  if (error)
    return (
      <div className="artifact-error">
        {t?.("groups.deliverables.renderFailed") ?? "渲染失败"}：{error}
      </div>
    );

  // 将主题 base style 注入到 HTML 文档头部（优先于内容自有样式，确保可读性底线）
  const injected = `<style>${themeBaseCSS(isDark)}</style>` + rawHtml;

  return (
    <div className="artifact-html">
      <iframe
        className="artifact-html-iframe"
        sandbox=""
        title={t?.("groups.deliverables.htmlPreview") ?? "HTML 预览"}
        srcDoc={injected}
      />
    </div>
  );
}
