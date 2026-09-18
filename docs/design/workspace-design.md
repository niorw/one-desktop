# 工作区（Workspace）概念与功能设计 v2（决策定稿）

> 状态：已拍板 · 作者：AI Agent 产品设计 · 日期：2026-08-10
> 关联约束：单机 1人×N Agent（第一性）、Apple HIG、DB additive 迁移（ADR-006）、内核端口计数 8 不加新端口

---

## 1. 结论先行

**工作区 = 单机用户用于组织「会话 + 灵感」的目录容器，随会话切换。**

关键设计判定（用户拍板）：**圆桌群不纳入工作区** —— 群本身已是项目容器（goal + 多 Agent + DAG 任务），与工作区平级而非嵌套；工作区只做两件事：

1. **会话/灵感归组** — 平铺列表变按工作区分组，新建会话可选工作区目录
2. **项目记忆隔离** — PROJECT.md 按工作区分文件，A 项目事实不再污染 B 项目（核心价值）

全局保持全局：`USER.md`（人格）、`MEMORY.md`（长期记忆）、`settings`（provider/api_key/温度）、MCP 服务器。

---

## 2. 现状痛点（设计依据）

| # | 现状 | 痛点 |
|---|------|------|
| P1 | `sessions` 表无归属字段，会话全平铺 | 会话 10+ 后找不到、无法按项目回顾 |
| P2 | `PROJECT.md` 全局唯一，每次 run 全量注入 | **跨项目记忆互相污染**（用户真实双线场景） |
| P3 | 灵感页纯前端 localStorage | 无归属，换项目后无法按项目回看 |

> 圆桌无此痛点：`groups` 自带 goal 语义，天然按项目组织，无需再归组。

---

## 3. 概念模型

```
OneDesktop（单机）
├── 工作区 Workspace   ← 新增层（会话 + 灵感 + 项目记忆）
│   ├── 会话 Sessions（chat 模式，归属 workspace_id）
│   ├── 灵感 Inspirations（归属 workspace_id，localStorage → SQLite）
│   └── 项目记忆 PROJECT.md（按工作区分文件）
├── 圆桌 Groups（项目容器，与工作区平级，不嵌套）
│   └── 任务 Tasks / Workers（沿用 group_id 归属）
└── 全局：USER.md / MEMORY.md / settings / MCP / 日历
```

### 3.1 切换语义（用户拍板：随会话切换）

- **无全局"当前工作区"状态**。UI 打开哪个工作区的会话，即进入该工作区上下文：
  - 会话列表按工作区分组展示（分节标题 + 折叠）
  - 记忆注入切到该会话工作区的 PROJECT.md
  - 灵感列表过滤到该工作区
- 圆桌 run 的记忆注入：读**默认工作区**的 PROJECT.md（保持现状路径，圆桌无工作区归属）

### 3.2 默认工作区

- 内置不可删除的「默认」工作区，**承载全部存量数据**（`workspace_id` 为 NULL 即默认）
- 升级后现有会话/灵感自动归入默认，**无感迁移、零数据操作**
- 查询时 `COALESCE(workspace_id, 'default')` 归一

---

## 4. 数据模型（additive，符合 ADR-006）

```sql
-- 新表：工作区
CREATE TABLE IF NOT EXISTS workspaces (
    id          TEXT PRIMARY KEY,          -- 'default' 或 uuid
    name        TEXT NOT NULL,
    icon        TEXT NOT NULL DEFAULT '',  -- 单色 SVG 名称（Apple 中性）
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- sessions 加列（additive：先查列存在再 ALTER / 走 migrations 版本号）
ALTER TABLE sessions ADD COLUMN workspace_id TEXT;   -- NULL = 默认工作区

-- 灵感页从 localStorage 迁入 SQLite
CREATE TABLE IF NOT EXISTS inspirations (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT,                       -- NULL = 默认工作区
    content      TEXT NOT NULL,
    tags         TEXT NOT NULL DEFAULT '[]', -- JSON 数组（含自动打标）
    created_at   TEXT NOT NULL
);
```

- `groups` 表**不加列**（用户拍板：群不涉及工作区）
- 索引：`idx_sessions_workspace(workspace_id, updated_at)`、`idx_inspirations_workspace(workspace_id, created_at)`

### 4.1 删除语义（用户拍板：删除时让用户自选）

删除工作区弹窗提供两个选项：
1. **移回默认工作区**（默认选中，防误删）—— 其下会话/灵感解绑为 NULL
2. **级联删除** —— 二次强确认后连带删除其下所有会话/灵感

默认工作区不可删。

---

## 5. 记忆注入改造

现状：`read_memory_block()` 固定读 `~/.one-desktop/memory/{USER,PROJECT,MEMORY}.md`

改造：
```
~/.one-desktop/memory/
├── USER.md            ← 全局（人格，不变）
├── MEMORY.md          ← 全局（长期记忆，不变）
├── PROJECT.md         ← 默认工作区（兼容存量路径）
└── workspaces/
    └── {ws_id}/
        └── PROJECT.md ← 非默认工作区的项目记忆
```

- `read_memory_block(workspace_id)`：`default` 读旧路径，其余读 `workspaces/{ws_id}/PROJECT.md`，文件不存在则跳过（不报错）
- 记忆写入工具（`remember`）按当前 run 的会话工作区落盘
- **单聊 run**：按会话归属工作区注入 `<project_memory>`；**圆桌 run**：读默认 PROJECT.md（现状不变）

---

## 6. 设置模型（用户拍板：仅 model + preamble）

| 设置 | 归属 |
|------|------|
| provider / api_key / 温度 / max_tokens / token_budget | 全局（不变） |
| model | 工作区可覆盖 |
| preamble（人设） | 工作区可覆盖 |

实现：`settings` 表加 `scope TEXT DEFAULT 'global'` + `workspace_id TEXT` 列，读取优先级：工作区级 > 全局。

---

## 7. UI 交互（Apple HIG 中性）

### 7.1 会话列表按工作区分组

- Sidebar 会话清单：按工作区分节（分节标题 = 工作区名 + 单色图标，可折叠）
- 展开的工作区下显示其会话；点开会话 = 进入该工作区上下文
- 空态：`该工作区还没有会话`

### 7.2 新建会话可选工作区

- `Cmd/Ctrl+N` 与侧栏「+」按钮：新建弹窗/下拉附**工作区目录选择器**（默认选中当前上下文工作区，可改）
- 新建后会话归属所选工作区

### 7.3 灵感页按工作区

- 灵感列表过滤到当前上下文工作区（跟随当前打开的会话所属工作区）
- 灵感数据迁 SQLite（P1 与 workspaces 表同批迁移）

### 7.4 管理工作区（设置页新分节）

- 列表：名称、图标、会话数、更新时间
- 操作：新建、重命名、改图标、删除（自选移回/级联）
- 新建/改图标：中性单色图标选择（禁多彩 emoji）

---

## 8. 分阶段落地

| 阶段 | 内容 | 验证 |
|------|------|------|
| **P1 数据层** | workspaces 表 + sessions 加列 + inspirations 迁 SQLite（additive 迁移，幂等） | `cargo test --lib` 全绿；重复启动不炸 |
| **P2 归组与切换** | Sidebar 分组展示 + 新建会话选工作区 + 灵感过滤 | E2E：分组渲染、新建归属、切会话切上下文 |
| **P3 记忆隔离** | read_memory_block 按工作区读 PROJECT.md + remember 按工作区写 | 单测：不同工作区注入不同 project_memory |
| **P4 偏好与管理** | 工作区级 model/preamble 覆盖 + 设置页管理工作区 | E2E + 手动回归 |

每阶段独立可交付，P1 做完即无感，P2 起有 UI。

---

## 9. 边界与明确不做

- ❌ 多人协作 / 分享 / 权限矩阵 / 跨端同步（第一性约束：单机无第二个人）
- ❌ 圆桌归入工作区（群=项目容器，平级不嵌套 —— 用户拍板）
- ❌ 全局"当前工作区"状态（随会话切换，无独立状态机 —— 用户拍板）
- ❌ 工作区级 token 预算 / USER.md / MEMORY.md（人格与长期记忆是"你"的，不是某个项目的）
- ❌ 嵌套工作区（一层足够）

---

## 10. 决策记录（2026-08-10 用户拍板）

| 编号 | 决策 | 结论 |
|------|------|------|
| D1 | 灵感归属 | 纳入（迁 SQLite 归组） |
| D2 | 设置覆盖范围 | 仅 model + preamble |
| D3 | 删除语义 | 弹窗自选：移回默认 / 级联删除 |
| D4 | 切换形态 | **随会话切换**；新建会话可选工作区目录；**群不涉及工作区**（群=工作区替代概念） |
