/**
 * Convert tool calls to natural language descriptions.
 * Inspired by openworker's humanizeTool approach.
 */

export interface Humanized {
  action: string; // verb phrase: "Reading", "Writing", "Running"
  target: string; // main object: "README.md", "npm test"
  detail?: string; // extra context: " — install dependencies"
}

/**
 * Try to parse tool args (may be JSON string or already parsed)
 */
function parseArgs(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

/**
 * Truncate text for display
 */
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}

/**
 * Extract a short filename from a path
 */
function shortPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

const HUMANIZE_MAP: Record<string, (args: Record<string, unknown>) => Humanized> = {
  read_file: (args) => {
    const path = String(args.path || args.file_path || "");
    return { action: "读取", target: shortPath(path) };
  },

  write_file: (args) => {
    const path = String(args.path || args.file_path || "");
    return { action: "写入", target: shortPath(path) };
  },

  edit_file: (args) => {
    const path = String(args.path || args.file_path || "");
    return { action: "编辑", target: shortPath(path) };
  },

  list_dir: (args) => {
    const path = String(args.path || args.dir || "");
    return { action: "列出目录", target: shortPath(path) || "." };
  },

  run_shell: (args) => {
    const cmd = String(args.command || args.cmd || "");
    const desc = args.description ? String(args.description) : "";
    return {
      action: "执行",
      target: truncate(cmd, 60),
      detail: desc ? ` — ${desc}` : undefined,
    };
  },

  grep: (args) => {
    const pattern = String(args.pattern || "");
    const path = String(args.path || args.dir || "");
    return {
      action: "搜索",
      target: pattern ? `"${truncate(pattern, 40)}"` : "",
      detail: path ? ` 在 ${shortPath(path)} 中` : undefined,
    };
  },

  glob: (args) => {
    const pattern = String(args.pattern || "");
    return { action: "查找文件", target: pattern ? `"${truncate(pattern, 40)}"` : "" };
  },

  web_search: (args) => {
    const query = String(args.query || args.q || "");
    return { action: "搜索网页", target: truncate(query, 50) };
  },

  web_fetch: (args) => {
    const url = String(args.url || "");
    return { action: "获取网页", target: truncate(url, 50) };
  },

  send_message: (args) => {
    const target = String(args.target || args.to || args.channel || "");
    return { action: "发送消息", target };
  },

  create_file: (args) => {
    const path = String(args.path || "");
    return { action: "创建文件", target: shortPath(path) };
  },

  delete_file: (args) => {
    const path = String(args.path || "");
    return { action: "删除", target: shortPath(path) };
  },
};

/**
 * Convert a tool call (name + args) into a human-readable description.
 */
function humanizeTool(name: string, args: string): Humanized {
  const parsed = parseArgs(args);
  const handler = HUMANIZE_MAP[name];

  if (handler) {
    return handler(parsed);
  }

  // Fallback: try to extract semantic meaning from args
  // Prefer intent/description/title → path → first meaningful value
  const semantic = [
    parsed.intent, parsed.description, parsed.title,
    parsed.task, parsed.name, parsed.content,
  ].find((v): v is string => typeof v === "string" && !!v.trim());
  if (semantic) {
    return { action: name, target: truncate(semantic, 60) };
  }
  // Last resort: show up to 2 args cleanly
  const entries = Object.entries(parsed)
    .filter(([, v]) => typeof v === "string" && v.trim())
    .slice(0, 2);
  if (entries.length > 0) {
    return {
      action: name,
      target: entries.map(([k, v]) => `${k}=${truncate(String(v), 25)}`).join(", "),
    };
  }
  return { action: name, target: "" };
}

/**
 * Generate a compact one-line description of a tool call.
 */
function humanizeToolLine(name: string, args: string): string {
  const h = humanizeTool(name, args);
  let line = `${h.action} ${h.target}`;
  if (h.detail) line += h.detail;
  return line;
}

/**
 * Generate approval card title.
 * "Write secret.env" / "Run a command — fetch data"
 */
export function humanizeApprovalTitle(name: string, args: string): string {
  const h = humanizeTool(name, args);
  return `${h.action} ${h.target}${h.detail || ""}`;
}

// 文件操作：动词前置 + 省略号表示进行中（模块级常量，避免每次调用重建）。
const VERB_MAP: Record<string, string> = {
  读取: "正在读取",
  写入: "修改中",          // 对齐 WorkBuddy：「修改中 filename」
  编辑: "修改中",          // edit_file 进行中同样用「修改中」（与 write 一致）
  创建文件: "创建中",
  删除: "正在删除",
  列出目录: "正在列出",
  执行: "正在执行",
  搜索: "正在搜索",
  "查找文件": "正在查找",
  "搜索网页": "正在搜索网页",
  "获取网页": "正在获取",
  发送消息: "正在发送",
};

/**
 * 实时动作描述：running 态返回「正在写入 xxx…」的自然语言文案，
 * 让用户不用展开步骤行就知道 Agent 在干什么。
 * done 态回退到 humanizeToolLine（简短结果式）。
 */
export function humanizeAction(
  name: string,
  args: string,
  status: string
): string {
  if (status !== "running") return humanizeToolLine(name, args);

  const h = humanizeTool(name, args);
  const verb = VERB_MAP[h.action] || `正在${h.action}`;
  let text = `${verb} ${h.target}`;
  if (h.detail) text += h.detail;
  text += "…";
  return text;
}

/**
 * Parse line-change stats (+N −M) from a write_file/create_file tool result.
 *
 * The kernel emits a parseable suffix on success:
 *   - overwrite: "Successfully wrote 1234 bytes to /path (+42 - 8 lines)"
 *   - new file:  "Successfully wrote 500 bytes to /path (+20 lines, new file)"
 *
 * Returns null when the result carries no line stat (older runs, errors,
 * or non-file tools) so callers can simply skip rendering.
 */
export function parseDiffStat(
  result?: string
): { added: number; removed: number } | null {
  if (!result) return null;
  const both = result.match(/\(\+(\d+)\s*-\s*(\d+)\s*lines\)/);
  if (both) {
    return { added: Number(both[1]), removed: Number(both[2]) };
  }
  const created = result.match(/\(\+(\d+)\s*lines,\s*new file\)/);
  if (created) {
    return { added: Number(created[1]), removed: 0 };
  }
  return null;
}

/**
 * 从写盘工具（`write_file`/`create_file`/`edit_file`）的结果文本中提取被写入的
 * 绝对文件路径，供「点击预览模型产出文件」使用。
 *
 * 结果形如：`Successfully wrote 123 bytes to /abs/path (+3 -1 lines)` 或
 * `...to /abs/path (+3 lines, new file)`。仅取首行、匹配 `to <path>` 后的路径。
 * 无路径（失败/非写盘工具）返回 null。
 */
export function parseWrittenPath(result?: string): string | null {
  if (!result) return null;
  const firstLine = result.split("\n")[0];
  const m = /Successfully wrote \d+ bytes to (.+?)(?:\s*\(|\s*$)/.exec(firstLine);
  return m ? m[1].trim() : null;
}

// ──────────────────────────────────────────────
//  WorkBuddy 风格行动叙述（2026-08-10）：动作 + 可点击对象 + diff 统计
// ──────────────────────────────────────────────

/** 结构化行动叙述（动词 + 对象 + 可点击文件路径）。 */
export interface ActionParts {
  /** 动词：running="正在写入…" / done="编辑"/"读取"/"创建"。 */
  verb: string;
  /** 对象显示文本（文件名短路径，如 ProcessPanel.tsx）。 */
  target: string;
  /** 完整文件路径（仅文件类工具；用于点击打开）。 */
  filePath?: string;
  /** 附加上下文（如 " — install dependencies"）。 */
  detail?: string;
}

/** 提取文件路径（仅文件类工具；用于可点击链接）。 */
function extractFilePath(name: string, args: string): string | undefined {
  const FILE_TOOLS = new Set([
    "read_file",
    "write_file",
    "edit_file",
    "create_file",
    "delete_file",
  ]);
  if (!FILE_TOOLS.has(name)) return undefined;
  const parsed = parseArgs(args);
  const p = parsed.path ?? parsed.file_path;
  return typeof p === "string" && p ? p : undefined;
}

/**
 * 结构化行动叙述（ProcessPanel 工具行专用）。
 * running 态：「修改中 X…」（进行中）；done 态文件写入/编辑结合 diff 统计区分
 * 「编辑 / 创建」（对齐 WorkBuddy「编辑 X.tsx +N -M」）。文件类工具返回 filePath
 * 供调用方渲染可点击链接（点击用系统默认程序打开文件）。
 */
export function humanizeActionParts(
  name: string,
  args: string,
  status: string,
  result?: string
): ActionParts {
  const h = humanizeTool(name, args);
  const filePath = extractFilePath(name, args);
  let verb: string;
  if (status === "running") {
    verb = VERB_MAP[h.action] || `正在${h.action}`;
  } else {
    verb = h.action;
    // 文件写入/编辑 done 态：有 diff 统计时区分「编辑（覆盖）/ 创建（新文件）」
    if (
      (name === "write_file" || name === "edit_file" || name === "create_file") &&
      result &&
      parseDiffStat(result)
    ) {
      verb = result.includes("new file") ? "创建" : "编辑";
    }
  }
  return { verb, target: h.target, filePath, detail: h.detail };
}
