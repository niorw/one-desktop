// 灵感（flomo 式）数据层 —— SQLite 持久化（docs/design/workspace-design.md v2，灵感归入工作区）。
// 迁移策略：真实环境读 SQLite；若 SQLite 为空且 localStorage 有旧数据，一次性导入后清空（幂等）。
// 自动打标：内容无 #标签时，调后端 LLM 建议语义标签；失败/离线回退本地关键词提取。

import { invoke } from "@tauri-apps/api/core";

export interface Inspiration {
  id: string;
  workspaceId: string | null; // null = 默认工作区
  content: string;
  tags: string[];
  createdAt: number; // epoch ms
}

const STORAGE_KEY = "onedesktop.inspirations";
const MIGRATED_KEY = "onedesktop.inspirations.migrated";

/** 从文本中解析 #标签（支持中英文与数字、下划线）。 */
export function parseTags(content: string): string[] {
  const re = /#([\p{L}\p{N}_]+)/gu;
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) set.add(m[1]);
  return [...set];
}

/** 清洗 + 去重标签（去 #、去空、限长）。 */
export function dedupeTags(input: string[]): string[] {
  const set = new Set<string>();
  for (const raw of input) {
    const t = raw.trim().replace(/^#/, "").trim();
    if (t && t.length <= 8) set.add(t);
  }
  return [...set];
}

/** 本地兜底打标：无 LLM / 离线时，抽取内容中的英文/数字词（≥3 字符）作为标签。 */
export function extractLocalTags(content: string): string[] {
  const set = new Set<string>();
  const re = /\b[A-Za-z][A-Za-z0-9_]{2,}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) set.add(m[0].toLowerCase());
  return [...set].slice(0, 3);
}

/**
 * 内容无 #标签时，调用后端 LLM 建议 1-3 个语义标签。
 * 失败 / 未配置 key / 命令不存在 → 回退本地关键词提取。
 */
export async function suggestInspirationTags(content: string): Promise<string[]> {
  try {
    const tags = await invoke<string[]>("suggest_inspiration_tags", { content });
    if (Array.isArray(tags) && tags.length) return dedupeTags(tags).slice(0, 3);
  } catch {
    /* 离线 / 命令缺失 / LLM 失败 → 本地兜底 */
  }
  return extractLocalTags(content);
}

// ── localStorage 旧数据（迁移源）──────────────────────────

function readLocal(): Inspiration[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? (arr as Inspiration[]).map((i) => ({ ...i, workspaceId: i.workspaceId ?? null }))
      : [];
  } catch {
    return [];
  }
}

/** 旧数据（含首次启动的演示种子）一次性导入 SQLite，成功后清 localStorage（幂等）。 */
async function migrateLocalIfNeeded(): Promise<void> {
  if (localStorage.getItem(MIGRATED_KEY)) return;
  const local = readLocal();
  if (local.length > 0) {
    try {
      for (const it of local) {
        await invoke("create_inspiration", {
          content: it.content,
          tags: it.tags ?? [],
          workspaceId: null,
        });
      }
    } catch {
      return; // 迁移失败不阻塞：下次启动重试
    }
  }
  localStorage.setItem(MIGRATED_KEY, "1");
}

// ── SQLite API ───────────────────────────────────────────

/** 后端 DTO（snake_case），与 commands/inspiration.rs 的 InspirationDto 对齐。 */
interface InspirationRow {
  id: string;
  workspace_id: string | null;
  content: string;
  tags: string[];
  created_at: number;
}

/** 列出灵感（时间倒序）。workspaceId=null 默认工作区；"__all__" 全部。 */
export async function listInspirations(workspaceId?: string | null): Promise<Inspiration[]> {
  await migrateLocalIfNeeded();
  try {
    const rows = await invoke<InspirationRow[]>("list_inspirations", {
      workspaceId: workspaceId ?? null,
    });
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id ?? null,
      content: r.content,
      tags: r.tags ?? [],
      createdAt: r.created_at,
    }));
  } catch {
    // 命令不可用（E2E 早期 mock / 异常）→ 回退本地读取（只读，不丢数据）
    return readLocal()
      .filter((i) => i.workspaceId === (workspaceId ?? null))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}

export async function addInspiration(
  content: string,
  presetTags?: string[],
  workspaceId?: string | null,
): Promise<Inspiration | null> {
  const text = content.trim();
  if (!text) return null;
  const tags = presetTags && presetTags.length ? dedupeTags(presetTags) : parseTags(text);
  try {
    const row = await invoke<InspirationRow>("create_inspiration", {
      content: text,
      tags,
      workspaceId: workspaceId ?? null,
    });
    return {
      id: row.id,
      workspaceId: row.workspace_id ?? null,
      content: row.content,
      tags: row.tags ?? [],
      createdAt: row.created_at,
    };
  } catch {
    // 命令不可用 → 本地兜底（内存/localStorage），不丢用户输入
    const item: Inspiration = {
      id: `insp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: workspaceId ?? null,
      content: text,
      tags,
      createdAt: Date.now(),
    };
    const items = readLocal();
    items.push(item);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      /* 静默降级 */
    }
    return item;
  }
}

export async function deleteInspiration(id: string): Promise<void> {
  try {
    await invoke("delete_inspiration", { inspirationId: id });
  } catch {
    /* 本地兜底 */
    const items = readLocal().filter((i) => i.id !== id);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      /* 静默降级 */
    }
  }
}

/** 统计所有标签及其出现次数（按次数降序）。 */
export function allTags(items: Inspiration[]): { tag: string; count: number }[] {
  const m = new Map<string, number>();
  for (const i of items) for (const t of i.tags) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}
