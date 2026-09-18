# OneDesktop · Agent 使用方式的入口与功能管理设计（能力包分层）

> 文档定位：产品 + 架构级设计（ADR 候选）。回答一个问题：**「写代码」与既有 Agent 使用方式（会话/圆桌/定时任务/多 Agent 编排）如何在入口与功能管理上组织**，避免入口膨胀、权限散落、快捷键分裂。
> 约束：单机「1 人 × N Agent」、无服务端/账号；NavKey 已收敛为 `chat | tasks`（不回退）；Apple HIG 无卡片/无彩色；noise-free（未配置的能力不渲染）；复用既有结构而非平行实现；权限沿用现有三态矩阵；DB additive 迁移（ADR-006）；内核纯净度（kernel 禁 `use tauri::`）。

---

## 0. 结论先行

1. **写代码不是一个新页面，而是输入入口的「模式形态」（mode）。** 会话 / 圆桌 / 代码 / 任务共享**统一命令入口**（⌘K 命令面板 + 输入框），差异只发生在**输入框形态**与**产物层**。为写代码开独立侧边栏入口会让 NavKey 从收敛后的 `chat|tasks` 退回多导航——2026-08 系列把「群协作」从侧边栏收进 segmented control（ChatMode `session|group`）的收敛全部白费。
2. **入口层 = 统一命令入口 + 意图路由。** 模式是「这次任务的属性」，不是「你所在的页面」；输入时自动识别意图，显式 chip 切换兜底；⌘K 是所有 Agent 使用方式的**单源索引**。
3. **功能管理层 = 能力包（Capability Package）。** 每种使用方式 = **提示词模板 + 工具集 + 权限模板 + UI 形态** 的打包；与 Agent 分离（一个 Agent 可挂多个包）；授权三层（可用 / 需审批 / 禁用）按工作区隔离。
4. **写代码模式零新基建**：终端 / git / 测试工具、`write_gate`、`ChangesetPanel` diff 审阅、审批卡、`ProcessPanel` 过程流全部已有。落地 = 把既有组件串起来 + 输入框形态升级 + 一个代码提示词模板。

---

## 1. 问题诊断：为什么不能「每种方式一个入口」

### 1.1 Agent 使用方式清单（现状 + 将加入）

| 使用方式 | 现状入口 | 与「会话」的本质差异 |
|---|---|---|
| 一对一会话 | chat 页 + 输入框 | 基准形态 |
| 圆桌 / WorkerPool | ChatMode `group`（segmented control） | 多 Agent 广播、角色拆解 |
| 定时 / 自动化任务 | tasks 页（`scheduled_tasks` 域） | 无人值守、定时触发 |
| 多 Agent 任务编排 | tasks 页（`tasks` DAG 域） | 依赖图、并行执行 |
| **写代码（新增）** | 无 | 工具集（终端/git/测试）+ 写盘授权 + diff 产物 |

> 术语纪律：`scheduled_tasks`（定时自动化）与 `tasks`（DAG 任务编排）命名相近、**实质无关**，本设计按两个独立使用方式对待，互不混谈。

### 1.2 反模式：每方式一个入口的后果

- **导航膨胀**：侧边栏 1 → N，NavKey 失去「收敛为两种」的意义；
- **快捷键分裂**：⌘N 新建什么？⌘K 搜什么？每个入口各自一套 → 键盘流碎掉（与「新增会话必须聚焦输入框」的快捷键一致性诉求直接冲突）；
- **功能管理散落**：权限在设置页、工具在 MCP 配置、模式在侧边栏，同一个「能不能写盘」的问题被拆成三处回答。

### 1.3 本质判断：写代码与写文案同构

「写代码」与「写调研报告」本质都是**对话式 Agent 工作**：人给意图 → Agent 思考 → 调用工具 → 产出。差别只在三个维度，而这三个维度**都不足以支撑一个独立页面**：

| 维度 | 写文案 | 写代码 |
|---|---|---|
| 工具集 | web search / read / grep | terminal / git / test / write_file |
| 权限 | 只读全自动 | 写盘需审批 |
| 产物形态 | 文本卡片 | diff / 文件 |

结论：差异应表达为**同一入口上的不同「能力包」**，而非**不同的页面**。

---

## 2. 入口层设计：统一命令入口 + 意图路由

### 2.1 三条规则

1. **⌘K 是单源索引**。`CommandPalette`（`src/components/layout/CommandPalette.tsx`，现有 `act-new` 等条目）扩展为所有 Agent 使用方式的索引：新建会话 / 进入圆桌 / `task` 建定时任务 / 进入代码模式 / 搜 MCP 工具。记住一个快捷键即可到达任何方式。
2. **意图路由是默认，显式切换是兜底**。输入时按信号自动挂对应能力包；识别错时输入框旁的模式 chip 可显式切换。模式是任务的属性——换模式不清空会话、不丢上下文。
3. **NavKey 不回退**。保持 `chat | tasks` 两个导航；圆桌走 ChatMode、代码走模式 chip、定时/DAG 走 tasks 页。

### 2.2 意图路由规则表

| 触发信号（输入侧） | 路由 | 挂载工具集 | 权限默认档 |
|---|---|---|---|
| 代码块 / `@file` 引用 / 「改、写、修、跑测试」类指令 | 代码模式 | terminal / git / test / write_file / read / grep | `plan`（写盘需审批） |
| `@group …` | 圆桌模式 | 群工具集 + Worker 广播 | 群权限模板 |
| `/task …` | 任务模式（定时/DAG） | 任务工具集 | 无人值守模板（fail-closed） |
| 其余 | 会话模式 | web search / read / grep（只读） | `full_access`（只读自动） |

### 2.3 模式形态差异：只发生在输入框与产物层

共享部分：输入框本体、`ProcessPanel` 过程流、`MessageActions` 答案操作栏、`ApprovalCard` 审批卡——**四模式同构渲染**。

| 层 | 会话 | 代码（新增形态） | 圆桌 | 任务 |
|---|---|---|---|---|
| 输入框 | 单行/多行文本 | 多行代码块 + `@file` 引用 + 回车执行 | 输入框 + `@成员` | 表单（cron / DAG 配置） |
| 产物 | 文本卡片 | diff 审阅（`ChangesetPanel`）+ 文件卡片 | 拟人气泡 | 运行记录 / 恢复面板 |

### 2.4 快捷键单源

| 快捷键 | 行为 |
|---|---|
| ⌘K | 命令面板 = 所有使用方式的索引 |
| ⌘N | 新建（当前导航态：chat → 新会话；group → 新圆桌；tasks → 新任务） |
| 输入即路由 | 不额外记快捷键 |

---

## 3. 功能管理层：能力包（Capability Package）

### 3.1 能力包四要素

| 要素 | 含义 | 示例（代码包） |
|---|---|---|
| ① 提示词模板 | 人设 + 系统提示，决定「它怎么想」 | 「你是资深工程师，先读码后改码，遵循既有风格」 |
| ② 工具集 | 可调用的工具白名单，决定「它能做什么」 | terminal / git / test / write_file（经 `tool_permissions` / `mcp_servers` 注册） |
| ③ 权限模板 | 默认授权档，决定「它多大胆」 | `plan`（写盘走 `write_gate` + 审批卡） |
| ④ UI 形态 | 输入框 / 产物 / 过程流密度，决定「它长什么样」 | 多行代码输入 + diff 审阅 + 测试结果回流 |

**与 Agent 分离**：Agent（`agents` 表）= 人设 + 模型；能力包 = 工具 + 权限 + UI。同一个 Agent 挂多个包即获得多面能力，不新建实体。

### 3.2 授权三层 · 按工作区隔离

| 授权状态 | 语义 | 映射 |
|---|---|---|
| 可用 | 挂到 Agent 即可调用 | `enabled=1` + permission ∈ {`full_access`, `auto_edit`} |
| 需审批 | 敏感操作默认挡 | `enabled=1` + permission = `plan`（复用现有审批卡） |
| 禁用 | 不渲染入口（noise-free） | `enabled=0` |

隔离规则复用 Workspace 模型（`docs/design/workspace-design.md`）：能力包挂载**按工作区隔离**；全局公共资源（灵感库 / 自动化 / 看板）**不设过滤**——代码能力在「代码工作区」启用、在「调研工作区」禁用，互不干扰。

### 3.3 数据模型（additive，新增两表，不动旧表）

```sql
-- 能力包注册表
CREATE TABLE IF NOT EXISTS capabilities (
    id          TEXT PRIMARY KEY,             -- 'code' | 'research' | 'roundtable' | 'task' …
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,                -- 路由键：'code' | 'chat' | 'roundtable' | 'task'
    system_prompt TEXT NOT NULL DEFAULT '',   -- 提示词模板
    ui_mode     TEXT NOT NULL DEFAULT 'chat', -- 输入框/产物形态：'chat' | 'code' | …
    enabled     INTEGER NOT NULL DEFAULT 1,   -- 0 = 禁用（不渲染入口）
    created_at  TEXT NOT NULL
);

-- Agent ↔ 能力包（多对多，按工作区授权）
CREATE TABLE IF NOT EXISTS agent_capabilities (
    agent_id       TEXT NOT NULL,
    capability_id  TEXT NOT NULL,
    workspace_id   TEXT,                      -- NULL = 全局；非 NULL 按工作区隔离
    permission     TEXT NOT NULL DEFAULT 'plan',  -- full_access | auto_edit | plan
    PRIMARY KEY (agent_id, capability_id, workspace_id)
);
```

`kind`（路由键）与 `tool_permissions` / `mcp_servers` 的现有注册机制正交：能力包**引用**已注册工具，不重复注册。

### 3.4 与现有实体的关系

```
Agent（人设 + 模型）
  └── 挂 N 个 Capability（工具集 + 权限模板 + UI 形态）
        └── 引用已注册 Tools（tool_permissions / mcp_servers）
        └── 按 Workspace 隔离授权
```

---

## 4. 写代码模式落地清单（零新基建）

| 能力 | 既有资产 | 状态 |
|---|---|---|
| 工具执行 | `terminal` / `git` / `test` 工具（`src-tauri/src/agent/tools/`） | 已有 |
| 写盘保护 | `write_gate`（`src-tauri/src/agent/write_gate.rs`） | 已有 |
| 写盘审批 | 审批卡（`ApprovalCard`）+ 三态权限矩阵 | 已有 |
| diff 审阅 | `ChangesetPanel`（`src/components/groups/parts/ChangesetPanel.tsx`）/ `RunChangesetPanel` | 已有 |
| 产物入口 | `RunArtifactsEntry`（`src/components/chat/RunArtifactsEntry.tsx`） | 已有 |
| 过程流 | `ProcessPanel`（thinking/工具/观察/答案统一渲染） | 已有 |
| 输入框 | `InputBar`（需升级：多行代码 + `@file` + 模式 chip） | **待做** |
| 路由 | 意图识别（新，前端纯逻辑，无内核改动） | **待做** |
| 提示词 | 代码能力包 `system_prompt` 模板 | **待做** |

---

## 5. 迁移路径（每步独立可用）

| 阶段 | 内容 | 改动面 |
|---|---|---|
| P1 | ⌘K 扩展为所有使用方式的索引（会话/圆桌/任务/代码模式条目） | `CommandPalette.tsx` 纯前端 |
| P2 | 输入框意图路由：代码块 / `@file` / `/task` / `@group` 检测 → 自动挂工具集与权限档 | `InputBar.tsx` + `useAgent` 纯前端 |
| P3 | 能力包注册表 + 设置页「Agent 能力」管理（挂载 / 授权 / 工作区隔离） | 内核新增两表（additive）+ 前端设置页 |
| P4 | 代码模式输入框升级：多行、文件引用、diff 审阅、测试门禁与 `tasks` DAG 联动（定时跑测试） | 前端为主 |

P1–P2 无内核改动（纯前端），符合「先验证交互、再落存储」的推进节奏；P3 落表时走 additive 迁移（ADR-006）。

---

## 6. 明确不做的（反模式）

1. **不为写代码开独立侧边栏入口 / 独立 NavKey**——NavKey 保持 `chat | tasks`，这是本设计的第一约束；
2. **不新增「能力包管理员 / 角色」等第二人语义**——单机 1 人，授权是个人偏好不是组织治理；
3. **不为模式建平行 UI 组件**——四模式共享 `ProcessPanel` / `MessageActions` / `ApprovalCard`，代码模式仅输入框与产物层有形态差异；
4. **不做模式切换时上下文丢失**——模式是任务属性，切换不重建 session。

---

## 7. 与本设计直接相关的既有约定

- 入口收敛：NavKey `chat | tasks`；ChatMode `session | group`（segmented control）
- 权限：三态矩阵（`full_access` / `auto_edit` / `plan`）
- 存储：DB additive 迁移（ADR-006）；`scheduled_tasks`（定时）与 `tasks`（DAG）按两个域对待
- 展示：noise-free（未配置的能力不渲染入口）；Apple HIG 无卡片 / 单色图标 / 语义色变量
