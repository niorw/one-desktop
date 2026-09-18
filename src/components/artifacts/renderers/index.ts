/**
 * 渲染器注册表（声明式，与「开闭原则」一致）。
 * 新增类型 = 加一个组件 + 注册一项 + 在 `rendererFor` 加一条判定，互不触碰。
 */
import type { ComponentType } from "react";
import type { RenderKind } from "../../../types";
import type { RendererProps } from "./types";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { CodeRenderer } from "./CodeRenderer";
import { ImageRenderer } from "./ImageRenderer";
import { HtmlRenderer } from "./HtmlRenderer";
import { CsvRenderer } from "./CsvRenderer";
import { FallbackRenderer } from "./FallbackRenderer";

export const RENDERERS: Record<RenderKind, ComponentType<RendererProps>> = {
  markdown: MarkdownRenderer,
  code: CodeRenderer,
  image: ImageRenderer,
  html: HtmlRenderer,
  csv: CsvRenderer,
  fallback: FallbackRenderer,
};

export type { RendererProps } from "./types";
export { rendererFor, kindForMedia } from "./rendererFor";
