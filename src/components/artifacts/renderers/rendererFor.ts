/**
 * 渲染器判定纯函数（与「判定逻辑抽纯函数」纪律一致，可单测）。
 * 只回答「这是什么」，不渲染、不读取文件。
 *
 * 双通道数据模型（docs/design/deliverable-preview-arch.md §4.3）：
 *   - file 流：media 文件（图片/HTML/CSV/二进制）— 优先，有真实文件按文件渲染
 *   - content 流：deliverable.content 文本（markdown/code）— 兜底
 */

import type { Deliverable, DeliverableMedia, RenderKind } from "../../../types";
import { extOf } from "../../../utils/detectMime";

const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
]);
const CODE_EXT = new Set([
  "py",
  "ts",
  "tsx",
  "js",
  "jsx",
  "rs",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "css",
  "json",
  "yaml",
  "yml",
  "toml",
  "sh",
  "sql",
  "xml",
  "rb",
  "php",
  "kt",
  "swift",
]);

/**
 * 不可在站内内联渲染的二进制类型 → 降级为文件卡（系统程序打开）。
 * 这些类型 `kindForMedia` 同样返回 "fallback"，需要在此显式拦回卡片态，
 * 否则会被默认 markdown 渲染成乱码。图片/HTML/CSV 不在此列（有专属渲染器）。
 */
const UNRENDERABLE_EXT = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "zip",
  "rar",
  "7z",
  "tar",
  "gz",
  "exe",
  "dmg",
  "bin",
  "iso",
]);

/** 纯函数：扩展名是否属于「文本类可渲染」（markdown/code/csv/html/text），供渲染器决定是否读文件内容。 */
export function isTextExt(name: string): boolean {
  const ext = extOf(name);
  return (
    IMAGE_EXT.has(ext) === false &&
    (CODE_EXT.has(ext) ||
      ["html", "htm", "csv", "tsv", "md", "markdown", "txt", "log", "json", "yaml", "yml", "xml", "toml", "pdf"].includes(
        ext,
      ))
  );
}

/** 纯函数：单个 media 条目 → 渲染种类（无 media 返回 null）。 */
export function kindForMedia(m: DeliverableMedia | undefined): RenderKind | null {
  if (!m) return null;
  const ext = extOf(m.path || m.name || "");
  if (IMAGE_EXT.has(ext) || m.type === "image") return "image";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "csv" || ext === "tsv") return "csv";
  return "fallback";
}

/**
 * 纯函数：产出物 → 渲染种类。
 * 优先级：media 真实可渲染类型（image/html/csv） > content/扩展名判定（markdown/code） > 默认 markdown。
 *
 * 注意：`kindForMedia` 对未知文件返回 "fallback"，但「fallback 卡片」只应留给
 * 不可内联渲染的二进制（pdf/zip/...）。文本类产出（.md/.py/.json/...）必须落到
 * 内容渲染，否则预览只会显示文件卡（文件名+路径），而非文件内容——这是此前
 * chat 链接点开「只看到基本信息/路径」的根因。
 */
export function rendererFor(
  d: Deliverable,
  activeMedia?: DeliverableMedia,
): RenderKind {
  // 1) 真实可渲染的 media（图片/HTML/CSV）优先按文件渲染；
  //    "fallback" 不是决定性 media 类型，不能短路内容判定。
  const media = activeMedia ?? d.media?.[0];
  const mediaKind = kindForMedia(media);
  if (mediaKind && mediaKind !== "fallback") return mediaKind;

  // 2) content 流：按扩展名（标题/文件路径常带 .md/.csv/.py 等）决定 markdown/code。
  const ext = extOf(d.title || media?.path || media?.name || "");
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (CODE_EXT.has(ext)) return "code";

  // 3) 二进制/不可内联渲染 → 文件卡（系统程序打开），避免被默认 markdown 渲染成乱码。
  if (UNRENDERABLE_EXT.has(ext)) return "fallback";

  // 4) 默认 markdown（含 .md/.txt/.json 等文本，复用 utils/markdown）
  return "markdown";
}
