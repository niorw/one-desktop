/**
 * 受控读取文件文本内容（HTML/CSV/Markdown/Code 渲染的内容通道）。
 *
 * 经 `artifact_read_text` 命令获取内容，内部已做 scope 同源校验
 * （只允许工作区目录，与 asset protocol scope 单一事实源一致）。
 * 文件缺失 / scope 外 / 读取失败 → error，由渲染器降级处理。
 */
import { useCallback, useEffect, useState } from "react";
import type { ArtifactText } from "../../types";
import { artifactReadText } from "../../services/groupCommands";
import { friendlyError } from "../../services/errors";

export interface ArtifactTextState {
  content?: string;
  size?: number;
  loading: boolean;
  error?: string;
  /** 强制重新读取当前文件（用于预览面板刷新按钮）。 */
  reload: () => void;
}

/** 读取给定路径的文件文本内容；path 为空直接置空。`sessionId` 可选：见 groupCommands 注释。 */
export function useArtifactText(path?: string, sessionId?: string): ArtifactTextState {
  const [state, setState] = useState<ArtifactTextState>({ loading: false, reload: () => {} });

  const reload = useCallback(() => {
    if (!path) {
      setState({ loading: false, reload });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    artifactReadText(path, sessionId)
      .then((r: ArtifactText) => {
        if (!cancelled) setState({ content: r.content, size: r.size, loading: false, reload });
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setState({
            loading: false,
            error: friendlyError(e),
            reload,
          });
      });
    return () => {
      cancelled = true;
    };
  }, [path, sessionId]);

  useEffect(() => {
    const cleanup = reload();
    return cleanup;
  }, [reload]);

  return state;
}
