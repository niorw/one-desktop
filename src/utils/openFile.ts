/**
 * 用系统默认程序打开文件 / 目录（tauri-plugin-opener）。
 *
 * 与群模块 DeliverableDetailDrawer / GroupRoundtable 的打开逻辑保持一致：
 * 动态 import 插件、失败静默忽略（无 opener 或路径非法时不抛错打断交互）。
 */

/** 用操作系统默认关联程序打开文件或目录（目录会由 Finder/Explorer 打开）。 */
export async function openInDefaultApp(path: string): Promise<void> {
  if (!path) return;
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openPath(path);
  } catch {
    /* 无 opener 或打开失败：静默忽略 */
  }
}

/** 在系统文件管理器中高亮显示该路径（文件显示其所在目录并选中，目录直接打开）。 */
export async function revealInFolder(path: string): Promise<void> {
  if (!path) return;
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.revealItemInDir(path);
  } catch {
    /* 静默忽略 */
  }
}

/**
 * 用系统默认浏览器打开本地文件（file:// 协议路由到浏览器，适合 HTML/预览类产物）。
 * 沿用 plugin-opener 动态 import + 失败静默的约定，与 openInDefaultApp 保持一致。
 */
export async function openInBrowser(path: string): Promise<void> {
  if (!path) return;
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openUrl(`file://${encodeURI(path)}`);
  } catch {
    /* 静默忽略 */
  }
}
