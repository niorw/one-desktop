// ── Agent 能力候选列表（F4 / 2026-09-02）──
//
// 给 AgentEditorModal 提供可视化 chip 多选的预设；不接后端注册表（避免引入新的
// capabilities 查询命令）。这些是当前内置的内置工具名 + 常见 skills / mcp / plugins
// 标识 —— 用户也可以直接在 ChipMultiSelect 里输入自定义值（见 ChipMultiSelect）。
//
// 来源：
//  - Tools:   BUILTIN_AGENT_TEMPLATES 中已落地的工具名（Read/Write/Edit/Bash/WebFetch/Grep/Glob）
//  - Skills:  BUILTIN_AGENT_TEMPLATES 的 capabilities（search/summarize/critique/execute）
//  - MCP:     常见 MCP server 名（filesystem / github / slack / notion / web-search）
//  - Plugins: 业内常见 connector / expert 插件标识（feishu/github/jira/linear/figma）

export const AGENT_TOOL_CANDIDATES: string[] = [
  "Read", "Write", "Edit", "Bash", "WebFetch", "Grep", "Glob", "Summarize",
];

export const AGENT_SKILL_CANDIDATES: string[] = [
  "search", "summarize", "critique", "execute", "plan", "review",
];

export const AGENT_MCP_CANDIDATES: string[] = [
  "filesystem", "github", "slack", "notion", "web-search", "playwright",
];

export const AGENT_PLUGIN_CANDIDATES: string[] = [
  "feishu", "github", "jira", "linear", "figma", "lark-doc", "dingtalk",
];
