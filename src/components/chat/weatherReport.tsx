/** 天气结构化渲染：内核返回 weather_report JSON，按 kind 分发到组件绘制；答案行剥离 LLM 自造的半残表。独立成文件是为规避 ProcessPanel 混合导出触发的 Fast Refresh 失效。 */
import React, { memo } from "react";

export interface WeatherRow {
  label: string;
  value: string;
}
export interface WeatherDayBlock {
  label: string;
  rows: WeatherRow[];
}
export interface WeatherReportPayload {
  kind: "weather_report";
  version: number;
  source: string;
  area: string;
  summary: string;
  current: WeatherRow[];
  days: WeatherDayBlock[];
}

/** 类型守卫：解析 tool.result 字符串为载荷，识别 kind 才走专用渲染。 */
export function tryParseWeatherPayload(raw: string): WeatherReportPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.kind !== "weather_report") return null;
  if (!Array.isArray(obj.current) || !Array.isArray(obj.days)) return null;
  return obj as unknown as WeatherReportPayload;
}

/**
 * 剥离 LLM 文本里的"结构化数据复述"块：
 *  ① 规范 markdown 表（行首 `|` + 下一行 `| --- |` 分隔行），整段跳过；
 *  ② `||` 拼装行（模型格式崩塌产物，整行剥离）。
 * 单竖线正常 prose 不误杀。用途：答案行 (.pp-line--answer) 接管时移除 LLM 自造
 * 半残表，改由工具结果行的结构化组件呈现。
 */
export function stripMarkdownTables(text: string): { cleanText: string; strippedTable: boolean } {
  if (!text.includes("|")) return { cleanText: text, strippedTable: false };
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  let stripped = false;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) i++;
      stripped = true;
      while (out.length > 0 && out[out.length - 1] === "") out.pop();
      continue;
    }
    if (line.includes("||")) {
      stripped = true;
      while (out.length > 0 && out[out.length - 1] === "") out.pop();
      i++;
      continue;
    }
    out.push(line);
    i++;
  }
  return { cleanText: out.join("\n").trim(), strippedTable: stripped };
}

/** 天气结构化表格块：标题 + 表格。无卡片外壳，复用 .md 容器 table 样式。 */
function WeatherSection({ title, rows }: { title: string; rows: WeatherRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="weather-section">
      <h4 className="weather-section-title">{title}</h4>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td>{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** 渲染 weather_report 载荷。容器复用 .md 的 table/th/td 样式。 */
export const WeatherReportView = memo(function WeatherReportView({
  data,
}: {
  data: WeatherReportPayload;
}) {
  return (
    <div className="md weather-report-view">
      <header className="weather-report-head">
        <span className="weather-report-area">{data.area}</span>
        <span className="weather-report-source">来源 {data.source}</span>
      </header>
      <WeatherSection title="实时" rows={data.current} />
      {data.days.map((d) => (
        <WeatherSection key={d.label} title={d.label} rows={d.rows} />
      ))}
    </div>
  );
});
