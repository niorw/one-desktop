# UI 交互设计：OneDesktop Agent 群协作（圆桌 Roundtable）

> 设计原则：**100% 复用现有 OneDesktop 设计系统**（App.css 令牌 + common/Icons.tsx 单色 SVG + 现有组件类），不引入新的视觉语言。Worker 执行卡片直接复用单 Agent 已有的 `.workflow-group` / `.tool-call-card`，保证风格一致、维护成本最低。

---

## 1. 设计目标与原则

- **风格一致**：颜色只用 `App.css` 语义令牌；字号用 type-scale；间距用 `--space-*`；圆角用 `--radius-*`；图标只用 `Icons.tsx` 单色 SVG（禁止彩色 emoji）。
- **组件复用优先**：圆桌的「执行卡片」= 单 Agent 的 `.workflow-group`（可折叠 ReAct 容器），不重新发明。
- **讨论与执行不分裂**：采用「讨论气泡 + 内嵌执行卡片」混合模型（已确认），执行过程折叠进卡片，避免独立任务页割裂上下文。
- **治理可见**：成员状态、席位类型、生命周期操作都在界面上显式呈现，群主/人类始终掌控。

---

## 2. 信息架构

```
Sidebar
├── 导航（Chat / 任务 / 扩展 ...）
├── 会话列表（现有单 Agent）
└── 群（Group）★新增分区
    ├── 🟢 市场调研群
    ├── 🟡 官网重构群
    └── ＋ 创建群

Main（点击群 → 圆桌视图）
├── TopBar：返回 ｜ 群名 + 状态徽标 ｜ ⋯ 生命周期菜单（暂停/恢复/解散）
├── Body（三栏）
│   ├── 左：成员栏（Worker 列表 + 状态点 + 席位类型）
│   ├── 中：圆桌聊天流（讨论气泡 + 内嵌执行卡片）
│   └── 右：可选「工作空间」文件树（只读浏览，可「在 Finder 打开」）
└── 底部：派活输入（复用 chat-input，群主模式下人类发需求即触发拆解）
```

---

## 3. 关键界面

### 3.1 群列表（侧边栏新增分区）
- 复用 `.sidebar-section-label`（大写小标题）+ `.session-item` 样式。
- 群项左侧图标：`Icons.Users`（群）或 `Icons.Network`（拓扑）；右侧状态点 `.status-dot`（Active=accent / Paused=warning / Archived=tertiary）。
- 悬停出现 `⋯` 菜单（恢复/归档/删除），复用 `.session-item-delete` 交互。

### 3.2 圆桌视图（核心）
- **左·成员栏**（新增，约 220px，`.bg-secondary` 背景）：
  - 群主项：图标 `Icons.Brain`，标签「群主」，状态常驻。
  - 每个 Worker 项：图标 `Icons.MessageSquare`（或角色图标）、名称、`Icons.Folder` 小标表示其工作空间沙箱子目录、右侧 `.status-dot`（Idle=灰 / Busy=accent+spinner / Offline=tertiary）。
  - 席位类型徽标：`静态` / `动态` / `能力`（小字 `text-tertiary`）。
  - 群主模式下「＋ 加人」入口（动态席位）。
- **中·聊天流**（复用 `.message-list` / `.message-row` / `.message-bubble`）：
  - 讨论气泡：人类/群主/Worker 发言，普通 `.message-bubble`。
  - **@提及高亮**：消息中 `@Worker名` 用 `--accent` 着色（轻量 span，不新建组件）。
  - **内嵌执行卡片**：每个 Worker 的一次执行 = 一个 `.workflow-group`：
    - header：Worker 名 + `.status-dot` + 进度文字（如「3/5 子任务」）+ 状态徽标（executing/done/error，复用 `.workflow-status`）。
    - body：该 Worker 的 ReAct 步骤，复用 `.react-step` / `.tool-call-card` / `.thinking-block`；默认折叠，点击展开。
  - **系统消息**：「子任务全部完成，请群主验收」用 `.message-bubble.assistant` + 轻微 `.accent-soft` 底色区分。
  - **HITL 内联**：Worker 工具调用待批时，在该执行卡片内渲染 `.hitl-bar`（复用，带 `approve/reject`），`session_id` 已随事件带来。
- **右·工作空间**（可选，P1）：文件树展示 `groups/{id}/workers/{wid}/` 与 `artifacts/`；顶部「在 Finder 打开」按钮（调用 `reveal` 命令）。

### 3.3 创建群弹窗（复用 `.modal-overlay` / `.modal-content`）
- 表单字段（复用 `.form-group` + `.btn`）：
  - 群名（input）
  - 目标 / 用途（textarea）
  - 群主（select：候选规划型 Agent）
  - 席位配置（`.radio-group`，三选项：静态名单 / 动态候选池 / 能力标签库；选静态则出现成员多选列表）
- 底部 `.modal-actions`：`取消`（`.btn-ghost`）/ `创建`（`.btn-primary`）。
- 确认前不建 session、不建目录（对应 Draft 态）。

### 3.4 派活 / 子任务表单（群主拆解后由人类确认，或人类直接派）
- 复用 `.modal-content`：列出群主拆解出的 `SubTask[]`（每项：指派 Worker / 依赖 / 产出要求）。
- 能力匹配席位时 Worker 留空，显示「自动匹配」。
- 确认即写 TaskBoard 并触发调度（FR-3）。

### 3.5 群设置（复用 SettingsCard 风格）
- 群名、目标、群主（可换，需人类确认）、席位管理（静态名单 / 动态加人 / 能力标签）。
- 生命周期操作：暂停 / 恢复 / 解散（解散走二次确认 `.btn-danger`）。

### 3.6 归档视图（Archived）
- 群列表中标灰只读；点击进入只读圆桌（输入禁用）。
- 提供「在 Finder 打开工作空间」与「删除归档」（删除需二次确认）。

---

## 4. 核心交互流程（界面态变化）

| 阶段 | 界面表现 |
|------|---------|
| 创建（Draft→Active） | 弹窗填表 → 确认 → 左侧出现群项 + 圆桌开启 + 成员栏就位（Idle） |
| 派活（混合编排） | 人类发需求 → 群主产出 SubTask → 弹窗确认/或自动 → 聊天流出现多条执行卡片（折叠） |
| 并行执行 | 成员栏多个 Worker 状态点变 Busy（spinner）；对应执行卡片 header 显示 executing；body 按需展开看步骤 |
| 完成触发验收 | 系统消息「全部完成，请群主验收」高亮；群主验收结论以气泡呈现；人类点「采纳产物」→ 执行卡片标 done、artifacts 落盘 |
| 失败 | 执行卡片状态变 error；瞬时失败自动重试（卡片内显示「重试 1/3」）；结构性失败 → 系统消息 `@人类` 请求决策 |
| 暂停/恢复 | TopBar 状态徽标变 warning/active；成员状态点暂冻结 |
| 解散（Archiving→Archived） | 二次确认弹窗 → 执行卡片全部收尾 → 群列表标灰只读 → 工作空间置只读 |

---

## 5. 组件复用映射表

| 群场景需求 | 复用现有 | 说明 |
|-----------|---------|------|
| 群项 / 成员项 | `.session-item` / `.sidebar-section-label` | 只换图标与状态点 |
| 圆桌聊天流 | `.message-list` / `.message-row` / `.message-bubble` | 直接复用 |
| Worker 执行卡片 | `.workflow-group` / `.react-step` / `.tool-call-card` / `.thinking-block` | **核心复用**，折叠态一致 |
| 成员状态 | `.status-dot`（+ spinner 动画） | Idle/Busy/Offline |
| 工具调用待批 | `.hitl-bar` / `.hitl-btn` | 内联到执行卡片，复用 `approve_tool` |
| 创建/派活弹窗 | `.modal-overlay` / `.modal-content` / `.form-group` / `.btn-*` | 直接复用 |
| 席位类型选择 | `.radio-group` | 静态/动态/能力 |
| 生命周期菜单 | `.session-item-delete` 交互 + `.btn-danger` 二次确认 | 暂停/恢复/解散 |
| 图标 | `Icons.tsx`：Users/Network/MessageSquare/Brain/Folder/Check/Cross | 单色 SVG，禁止 emoji |

---

## 6. 状态与异常

- **成员状态点**：Idle（灰）/ Busy（accent + `spin`）/ Offline（tertiary）。
- **执行卡片状态**：executing（accent 脉冲）/ done（success）/ error（danger）。
- **空态**：圆桌无消息时复用 `.chat-empty`（「发起第一条需求，群主会帮你拆解并派活」）。
- **错误态**：调度失败用 `.error-banner`；worker 结构性失败用系统消息 `@人类`。
- **并行扇入**：聊天流列表虚拟化（现有 `.message-list` overflow-y），多 worker 事件按 `session_id` 对账，避免抖动。

---

## 7. 设计令牌与图标使用

- 颜色：仅 `--bg-*` / `--text-*` / `--accent*` / `--status-*` / `--border-*` / `--overlay`。
- 字号：`--text-xs`~`--text-xl`（正文 `--text-base` 13px）。
- 图标：`Icons.tsx` 单色 `stroke="currentColor"`，尺寸 18（导航）/14（工具）/10-13（小标）。
- 圆角：`--radius-md`(10) 卡片、`--radius-lg`(14) 气泡、`--radius-xl`(20) 弹窗。
- 暗色主题：仅 `[data-theme="dark"]` 重写令牌，组件零改动（与现有一致）。

---

## 8. 待确认细节（非阻塞）
- Q1 右栏「工作空间文件树」是否 v1 就做，还是先用「在 Finder 打开」按钮（建议先按钮，P1 再做树）。
- Q2 成员栏宽度与是否可折叠（建议默认可折叠，窄屏隐藏）。
- Q3 派活弹窗是否每次都需人类确认，还是群主可自动派（建议首次确认、可勾选「自动派活」）。
