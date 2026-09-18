import type { DeliverableMedia } from "../../../types";
import type { DictKey } from "../../../i18n/dict";

/** 所有渲染器共享的 props（双通道：content 文本流 / media 文件流）。 */
export interface RendererProps {
  /** content 流文本（markdown/code 可能直接来自正文） */
  content: string;
  /** file 流媒体（图片/HTML/CSV/二进制文件）；可空 */
  media?: DeliverableMedia;
  /** 用系统默认程序打开（Fallback / 图片放大） */
  onOpen?: (path: string) => void;
  /** 在文件管理器中显示 */
  onReveal?: (path: string) => void;
  /** 国际化函数（可选，缺失时回退中文文案） */
  t?: (k: DictKey, v?: Record<string, string | number>) => string;
}
