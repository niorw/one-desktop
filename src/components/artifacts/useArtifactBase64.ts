/**
 * 受控读取文件二进制（图片/PDF 内嵌通道）。
 *
 * 经 `artifact_read_base64` 命令获取 base64 + mime，内部已做 scope 同源校验
 * （任一工作区根目录，含用户自选工作区），越界路径拒绝。
 * 返回 `data:<mime>;base64,<data>` 形式的 data URL，供 <img> 直接内嵌，
 * 不再依赖 asset protocol 静态白名单——因此任意工作区的模型产出文件都能预览。
 */
import { useEffect, useState } from "react";
import type { ArtifactBytes } from "../../types";
import { artifactReadBase64 } from "../../services/groupCommands";
import { friendlyError } from "../../services/errors";

export interface ArtifactBytesState {
  dataUrl?: string;
  size?: number;
  loading: boolean;
  error?: string;
}

/** 读取给定路径的文件二进制并拼成 data URL；path 为空直接置空。 */
export function useArtifactBase64(path?: string): ArtifactBytesState {
  const [state, setState] = useState<ArtifactBytesState>({ loading: false });

  useEffect(() => {
    if (!path) {
      setState({ loading: false });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    artifactReadBase64(path)
      .then((r: ArtifactBytes) => {
        if (!cancelled) {
          setState({
            dataUrl: `data:${r.mime};base64,${r.data}`,
            size: r.size,
            loading: false,
          });
        }
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setState({
            loading: false,
            error: friendlyError(e),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return state;
}
