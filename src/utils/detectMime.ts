/**
 * 文件类型判定纯函数（与「判定逻辑抽纯函数」纪律一致，可单测）。
 * 仅做字符串解析，不触碰文件系统、不依赖运行环境。
 */

/** 从路径/文件名抽取扩展名（小写，不含点；无扩展名返回 ""）。 */
export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const m = base.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
}

const MIME_BY_EXT: Record<string, string> = {
  // images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  // html
  html: "text/html",
  htm: "text/html",
  // tabular
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  // text / markup
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  // code
  py: "text/x-python",
  ts: "text/typescript",
  tsx: "text/typescript",
  js: "text/javascript",
  jsx: "text/javascript",
  rs: "text/x-rust",
  go: "text/x-go",
  java: "text/x-java",
  c: "text/x-c",
  cpp: "text/x-c++",
  h: "text/x-c",
  css: "text/css",
  sh: "text/x-sh",
  sql: "text/x-sql",
  rb: "text/x-ruby",
  php: "text/x-php",
  kt: "text/x-kotlin",
  swift: "text/x-swift",
  toml: "application/toml",
  // binary
  pdf: "application/pdf",
};

/** 纯函数：根据文件名/路径判定 MIME；未知 → application/octet-stream。 */
export function detectMime(pathOrName: string): string {
  return MIME_BY_EXT[extOf(pathOrName)] ?? "application/octet-stream";
}
