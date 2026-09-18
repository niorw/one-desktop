// 项目数据层（docs/design/workspace-design.md v2）。
// 项目（Workspace）= 单机用户组织「会话 + 灵感」的目录容器；随会话切换，无全局状态。
// 内置「默认」项目不可删，但可重命名；删除时前端弹窗让用户自选：移回默认 / 级联删除。

import { invoke } from "@tauri-apps/api/core";

export interface Workspace {
  id: string;
  name: string;
  icon: string;
  /** 关联的真实目录路径（打开文件夹创建；普通/默认工作区为 undefined）。 */
  path?: string;
  created_at: string;
  updated_at: string;
  session_count: number;
}

export const DEFAULT_WORKSPACE_ID = "default";

export async function listWorkspaces(): Promise<Workspace[]> {
  try {
    return await invoke<Workspace[]>("list_workspaces");
  } catch {
    // 命令不可用（E2E 早期 mock）→ 兜底默认项目
    return [
      {
        id: DEFAULT_WORKSPACE_ID,
        name: "任务",
        icon: "",
        created_at: "",
        updated_at: "",
        session_count: 0,
      },
    ];
  }
}

export async function createWorkspace(name: string, icon?: string): Promise<Workspace> {
  return invoke<Workspace>("create_workspace", { name, icon: icon ?? "" });
}

/**
 * 打开原生目录选择对话框，返回所选目录路径（取消则 null）。
 * 走 @tauri-apps/plugin-dialog（前端侧），内核仅接收 path，不依赖 Tauri dialog。
 */
export async function pickFolder(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    if (Array.isArray(selected)) return selected[0] ?? null;
    return selected ?? null;
  } catch {
    return null;
  }
}

/** 创建关联真实目录的工作区，并在该目录初始化 .one-desktop 知识库。 */
export async function createWorkspaceWithPath(name: string, path: string): Promise<Workspace> {
  return invoke<Workspace>("create_workspace_with_path", { name, path });
}

export async function renameWorkspace(
  workspaceId: string,
  name: string,
  icon?: string,
): Promise<Workspace> {
  return invoke<Workspace>("rename_workspace", { workspaceId, name, icon: icon ?? null });
}

/**
 * 删除工作区。moveToDefault=true（默认）：其下会话/灵感移回默认工作区（防误删）；
 * false：级联删除。
 */
export async function deleteWorkspace(
  workspaceId: string,
  moveToDefault: boolean,
): Promise<void> {
  return invoke("delete_workspace", { workspaceId, moveToDefault });
}
