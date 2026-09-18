/**
 * 附件工具：粘贴板/拖拽附件落盘与「单聊附件文本协议」。
 *
 * 群聊附件走 `roundtable_messages.attachments` 列（paths 数组），不经过文本协议；
 * 单聊 messages 表无 attachments 列（引擎核心表，不加列），采用文本协议：
 * 发送时把附件路径以 `[附件] <path>` 行追加到用户消息 content 尾部，
 * 引擎模型可见路径（可调 read 工具读取），渲染端解析剥离展示为附件卡片。
 */

export interface PendingAttachment {
  path: string;
  name: string;
  size: number;
}

/** 单聊文本协议标记行。 */
const ATTACH_LINE = /^\[附件\]\s+(.+)$/gm;

/** 图片扩展名（chips 用 Image 图标 / 缩略区分）。 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i;

/** 是否图片类型（按文件名）。 */
export function isImageName(name: string): boolean {
  return IMAGE_EXT.test(name);
}

/** 把附件路径数组拼成消息尾部文本块；空数组返回空串。 */
export function buildAttachmentSuffix(paths: string[]): string {
  if (paths.length === 0) return "";
  return "\n\n" + paths.map((p) => `[附件] ${p}`).join("\n");
}

/** 解析消息文本中的 `[附件]` 块：返回正文（剥离附件块）与附件路径列表。 */
export function splitAttachmentLines(text: string): { body: string; paths: string[] } {
  const paths: string[] = [];
  const body = text.replace(ATTACH_LINE, (m, p: string) => {
    const t = p.trim();
    if (t) paths.push(t);
    return "";
  });
  return { body: body.replace(/\n{3,}/g, "\n\n").trim(), paths };
}

/** 文件 → base64 data URL（粘贴图片等内存文件落盘前的中转）。 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

/** 从粘贴板 DataTransfer 提取图片文件（macOS 截图 / 复制的图片）。 */
export function extractPastedImage(dataTransfer: DataTransfer | null): File | null {
  if (!dataTransfer) return null;
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

/** 从拖拽/粘贴的 DataTransfer 提取全部文件（粘贴文本不进入）。 */
export function extractDroppedFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return [];
  return Array.from(dataTransfer.files ?? []).filter((f) => f.type || f.name);
}

/** 字节数 → 人类可读（B / KB / MB），chips 与附件卡片展示用。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
