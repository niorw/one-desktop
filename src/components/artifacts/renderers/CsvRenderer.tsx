import { useMemo } from "react";
import { useArtifactText } from "../useArtifactText";
import { extOf } from "../../../utils/detectMime";
import type { RendererProps } from "./types";

/** CSV/TSV 渲染阈值：超过此行数只渲染前 N 行，避免大文件卡顿。 */
const MAX_ROWS = 500;

/** 纯函数：解析 CSV/TSV 文本为二维数组（支持引号转义与换行引号内）。 */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV/TSV 渲染器：表格化 + 行数统计 + 阈值保护。 */
export function CsvRenderer({ media, content, t }: RendererProps) {
  const needFile = !content && !!media;
  const { content: fileContent, loading, error } = useArtifactText(
    needFile ? media!.path : undefined,
  );
  const text = content || fileContent || "";
  const delimiter = extOf(media?.name ?? "").toLowerCase() === "tsv" ? "\t" : ",";
  const rows = useMemo(() => (text ? parseDelimited(text, delimiter) : []), [text, delimiter]);

  if (loading) return <div className="artifact-loading">{t?.("groups.deliverables.loading") ?? "加载中…"}</div>;
  if (error)
    return (
      <div className="artifact-error">
        {t?.("groups.deliverables.renderFailed") ?? "渲染失败"}：{error}
      </div>
    );
  if (rows.length === 0)
    return <div className="artifact-error">{t?.("groups.deliverables.emptyContent") ?? "无内容"}</div>;

  const dataRows = rows.length - 1;
  const head = rows[0];
  const body = rows.slice(1, MAX_ROWS + 1);
  const truncated = dataRows > MAX_ROWS;

  return (
    <div className="artifact-csv">
      <div className="artifact-csv-meta">
        {t?.("groups.deliverables.csvRows", { n: dataRows }) ?? `${dataRows} 行`}
        {truncated &&
          ` · ${
            (t?.("groups.deliverables.csvTruncated") ?? "仅显示前 {n} 行").replace(
              "{n}",
              String(MAX_ROWS),
            )
          }`}
      </div>
      <div className="artifact-csv-scroll">
        <table className="artifact-csv-table">
          <thead>
            <tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {body.map((r, i) => (
              <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
