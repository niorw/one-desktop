/**
 * 附件服务：Tauri 命令封装（粘贴板/拖拽/选择附件统一落盘 `~/.one-desktop/attachments/`）。
 */
import { invoke } from "@tauri-apps/api/core";

/** `import_attachment` 返回：落盘路径 + 字节数。 */
export interface ImportedAttachment {
  path: string;
  size: number;
}

/**
 * 把粘贴板数据（base64 data URL）落盘为附件文件，返回绝对路径。
 * @param dataUrl 形如 `data:image/png;base64,...` 的 data URL（自动剥前缀）。
 * @param fileName 原始文件名（后端仅取 basename 并清洗）。
 */
export async function savePasteAttachment(
  dataUrl: string,
  fileName: string,
): Promise<string> {
  const b64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
  return invoke<string>("save_paste_attachment", { dataB64: b64, fileName });
}

/**
 * 把磁盘文件复制到附件目录（选择/拖拽的上传语义），返回新路径与大小。
 * @param sourcePath 源文件绝对路径（来自系统文件选择对话框）。
 */
export async function importAttachment(
  sourcePath: string,
): Promise<ImportedAttachment> {
  return invoke<ImportedAttachment>("import_attachment", { sourcePath });
}
