/**
 * 全局预览唤起 Provider。
 *
 * 把 `ArtifactPreview` 从「群产出物专属」提升为应用级能力：任何界面
 * （chat 写盘结果、任务输出、群产出物、全局产出文件浏览器）只要调用
 * `usePreview().openPreview({ filePath })` 或 `{ deliverable }` 即可打开预览，
 * 不再依赖某个具体页面的嵌入。预览抽屉在 App 根统一渲染。
 *
 * 「默认 sessionId」机制：调用方可显式传 `sessionId`；不传时 fall-back 到
 * Provider 内部的 `defaultSessionId`（Workbench 在 chat session 切换时同步
 * 调用 `setDefaultSessionId`）。这是为 R8-Plus 设计——LLM 在 final answer
 * 文本里 hallucinate 出错误路径（如把 `workspaces` 写成 `tmp`、UUID 字符
 * 错位）时，后端按 basename 在该 session 的 changeset product 行做精确兜底
 * （唯一匹配 → 回退到真实产物文件）。让 chat 答案区内的「绝对路径链接」
 * 不会因 LLM 路径幻觉而失效。
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import type { Deliverable, TraceRef, Worker } from "../../types";

export interface PreviewRequest {
  /** 群产出物（带作者/溯源元信息）。 */
  deliverable?: Deliverable;
  /** 任意模型产出文件的绝对路径（通用入口）。 */
  filePath?: string;
  /**
   * 当前会话 id。可选：LLM 答案文本里的路径常因 hallucinate 而失效，
   * 后端按 basename 在该 session 的 changeset product 行做兜底（唯一匹配
   * 回退到真实产物文件）。不传时自动用 Provider 的 `defaultSessionId`。
   */
  sessionId?: string;
  /** 预设溯源引用。 */
  traceRef?: TraceRef | null;
  workers?: Worker[];
  resolveName?: (ref: string) => string;
}

interface PreviewContextValue {
  openPreview: (req: PreviewRequest) => void;
  closePreview: () => void;
  /** 当前预览请求（null = 关闭）。供布局层在 flex 流内渲染右栏。 */
  previewReq: PreviewRequest | null;
  /**
   * 设置 Provider 的默认 sessionId。Workbench 在 chat 会话切换时调用；
   * 之后所有不带 sessionId 的 openPreview 调用都会自动带上。
   */
  setDefaultSessionId: (id: string | null) => void;
}

const PreviewContext = createContext<PreviewContextValue | null>(null);

export function PreviewProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<PreviewRequest | null>(null);
  // 用 ref 而非 state：defaultSessionId 只在 openPreview 闭包里读，无需触发重渲染。
  const defaultSessionIdRef = useRef<string | null>(null);
  const setDefaultSessionId = useCallback((id: string | null) => {
    defaultSessionIdRef.current = id;
  }, []);
  const openPreview = useCallback((r: PreviewRequest) => {
    setReq({ ...r, sessionId: r.sessionId ?? defaultSessionIdRef.current ?? undefined });
  }, []);
  const closePreview = useCallback(() => setReq(null), []);

  return (
    <PreviewContext.Provider value={{ openPreview, closePreview, previewReq: req, setDefaultSessionId }}>
      {children}
    </PreviewContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePreview(): PreviewContextValue {
  const ctx = useContext(PreviewContext);
  if (!ctx) throw new Error("usePreview must be used within PreviewProvider");
  return ctx;
}