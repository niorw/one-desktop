# OneDesktop · AI Agent 前端交互设计系统（v2.0）

> 按《AI Agent 前端交互设计提示词 v2.0》产出，覆盖基础组件、i18n、MCP/Skill/插件管理、定时任务、主题系统五大维度。
> 本文档既是设计决策记录，也是开发者交接 spec。每条决策均标注 **Why**。

---

## 1. 设计总览

### 1.1 核心设计原则

1. **状态可见（State Visibility）**——系统在任何时刻对用户透明。连接状态、任务进度、流式输出、错误，都要有实时、低噪声的反馈。
   *Why：Agent 产品最大的焦虑来自"它在干嘛/是不是卡了"。把思考、工具调用、等待都显式呈现，比一个转圈更能建立信任。*
2. **容错与可恢复（Forgiveness）**——删除二次确认、30s 内可撤销、任务本地持久化可恢复。
   *Why：Agent 操作有副作用（写文件、发请求），错误不可逆代价高。把"撤销/确认"做重，把"重试"做轻。*
3. **渐进披露（Progressive Disclosure）**——列表先给概览（图标面包屑 + 状态色），点击展开细节（参数 JSON、结果、权限）。
   *Why：Hick's Law——默认信息密度低，高级信息按需展开，避免认知过载。*
4. **一致性（Consistency）**——启用/禁用/删除/导入在所有模块手势统一；同一状态色全局一致。
   *Why：Jakob's Law——复用主流 Agent 产品的交互范式，降低学习成本。*
5. **本地优先（Local-first）**——任务、配置、Skill 全部本地存储，启动自恢复。
   *Why：个人工作台的首要诉求是"关掉再开还在"，且避免把数据锁死在服务端。*

### 1.2 信息架构图

```
OneDesktop
├── 💬 对话（Chat）
│     ├── 会话清单（侧边栏）
│     ├── 消息流（用户/助手/工具时间线）
│     └── 输入栏（文本/语音/建议）
├── ⏰ 定时任务（Scheduled Tasks）
│     └── 列表（筛选 / 暂停·恢复 / 删除）— 无新建、无详情页
├── 🔌 MCP 管理
│     ├── 连接配置 / 导入
│     ├── 列表（状态灯 / 能力树 / 筛选 / 删除）
│     └── 详情（连接信息 / Capabilities / 日志）
├── 🔧 Skill 管理
│     ├── 导入（本地 / URL / MCP 注册）
│     ├── 列表（卡片/列表视图 / 筛选 / 批量）
│     └── 详情（Schema / 示例 / 更新日志 / 依赖）
├── 🧩 插件管理
│     ├── 导入（本地 / URL）
│     ├── 列表（运行态 / 筛选 / 批量）
│     └── 详情（权限 / 运行日志 / 版本）
└── ⚙️ 设置
      ├── 通用
      ├── 语言（zh / en）
      ├── 主题（☀️ 白天 / 🌙 夜间）
      └── 关于
```

### 1.3 设计决策背后的理由

| 决策 | 为什么 |
|------|--------|
| MCP/Skill/插件**只导入不开发** | 页面内编写代码编辑器的复杂度与安全风险远超其收益；导入 + 管控足以覆盖 90% 场景，且符合"工作台"定位而非"IDE"。 |
| 定时任务**无新建页** | 任务应由 Agent 对话/Skill/MCP 事件自然产生，页面只做治理。避免用户手动造出与对话脱节的任务。 |
| 侧边栏一级导航而非顶部 Tab | Fitts's Law——高频入口放在固定左侧，热区稳定、可肌肉记忆；对话类应用侧栏已是心智标准。 |
| 主题仅手动切换、无系统跟随 | 提示词明确要求；原因：Agent 长会话中途变主题会打断阅读，手动更可控。 |
| 深色用 `#1c1c1e`~`#242424` 而非纯黑 | 纯黑 `#000` 在 OLED 上眩光、层级难分；用 4% 亮度差区分 surface 层级更柔和。 |

---

## 2. 组件系统

> 现有项目已基于 Apple HIG Token 体系（原生 CSS 变量），故组件定义沿用该体系，而非 Tailwind。Token 命名见第 6 章。

### 2.1 原子组件表

| 组件 | 用途 | 状态枚举 | 备注 |
|------|------|----------|------|
| Button 按钮 | 主/次/危险/图标操作 | default / hover / active / disabled / loading | 主操作蓝色填充；危险红描边；**禁止固定宽度**（i18n 适配） |
| Input 输入框 | 单行/多行/带校验 | default / focus / error / disabled | 聚焦态用 `--border-focus`；错误态红边 + 下方提示 |
| Bubble 气泡 | 用户/AI/系统消息 | default / streaming / error | 用户右对齐、AI 左对齐、系统居中窄条 |
| Badge 徽标 | 数量/状态/红点 | — | 状态色映射 `--status-*` |
| Icon 图标 | 统一图标库 | — | 内联 SVG（当前实现），统一 16px 网格 |
| Divider 分割线 | 水平/垂直/带文字 | — | `var(--border-light)` |
| Tag 标签 | 可关闭/变色/带图标 | default / active / closable | 来源/类型标记 |

### 2.2 复合组件表

| 组件 | 用途 | 关键交互 |
|------|------|----------|
| 对话流容器 | 消息列表/自动滚动/加载更多 | 新消息自动滚底；手动上滚暂停 |
| 消息卡片 | 文本/代码/文件/混合 | Markdown 渲染；代码块复制/折叠 |
| 代码块 | 语法高亮/复制/折叠/语言标签 | 语言标签 + 复制按钮 |
| 工具调用面板 | 工具名/参数/状态/结果 | ReAct 时间线（已在 ProcessPanel 实现） |
| 流式响应指示器 | 打字机/逐字/闪烁光标 | reasoning 闪烁光标 |
| 状态指示灯 | 连接/任务状态 | 🟢🟡🔴⚫⚪ + 旋转/脉冲动画 |

### 2.3 布局组件表

| 组件 | 用途 | 状态 |
|------|------|------|
| 侧边栏 Sidebar | 一级导航 + 会话清单 | 固定 260px |
| 顶栏 Topbar | 全局操作/语言/面包屑 | （本次对话页用标题栏占位） |
| 抽屉 Drawer | 右侧详情（MCP/Skill/插件） | 右侧滑入 |
| 模态框 Modal | 导入确认/表单 | 居中 |
| Popover 悬浮面板 | 快捷操作/上下文菜单 | 锚定触发元素 |
| 分栏 Split | 可调比例 | （预留） |

### 2.4 组件定义规范（三维）

每个组件交付时含：**视觉规格**（尺寸/间距/圆角/阴影/Token）、**交互状态**（7 态）、**边缘情况**（空/超长/断网/无权限）。见各页实现。

---

## 3. i18n 设计方案（中英文）

### 3.1 文案分层架构

- **UI 静态文案层**：按钮、标签、菜单、错误提示、占位符 → 走 `src/i18n` 键值字典，中英文分别维护，不依赖机翻。
- **Agent 动态输出层**：AI 回复、工具结果、流式内容 → 跟随用户在 Settings 选择的语言偏好，**从下一条消息生效**。
- **混合内容层**：消息内嵌可点击卡片 → 控件文案走 UI 层，内容走动态层。

**核心原则**：AI 生成内容**不**被误译为 UI 文案。切换语言只刷 UI 层，已生成的对话保持不变。

### 3.2 中英文差异适配策略

| 维度 | 中文 | 英文 | 适配要点 |
|------|------|------|---------|
| 文字长度 | 较短（省 30%~50%） | 较长 | 容器弹性；按钮 `width:auto; white-space:nowrap` |
| 行高 | 1.5~1.6 | 1.4~1.5 | `:lang(en)` 略紧凑 |
| 字重 | 400 | 500~600 | 英文中小字号加粗 |
| 标点 | 全角 `，` `。` | 半角 `,` `.` | 字体回退链 `{ "PingFang SC", "Helvetica Neue", sans-serif }` |
| 日期/时间 | 2025年3月15日 / 15:45 | Mar 15, 2025 / 3:45 PM | `Intl.DateTimeFormat` 按 locale 自动 |
| 省略 | 「…」 | 「…」 | 截断逻辑统一，预留宽度不同 |

### 3.3 语言切换交互

```
点击顶栏/设置语言切换
  → 即时刷新 UI 静态层
  → Agent 动态输出从下一条消息生效
  → 写入偏好（localStorage 兜底；登录用户云同步）
```
- UI 层：即时无延迟。
- 对话流：当前会话保持原语言，新对话用新语言。

### 3.4 组件级适配清单（摘要）

按钮 2~4 字宽度自适应；导航菜单宽度取最大值；下拉容纳最长项（"Preferences"）；空状态文案英文更长需预留高度；错误 Toast 支持自动换行不截断；代码块注释不翻译；侧边栏折叠态 Tooltip 随语言切换。

---

## 4. MCP / Skill / 插件管理全流程设计

### 4.1 统一导航

侧边栏一级：💬对话 / ⏰定时任务 / 🔌MCP / 🔧Skill / 🧩插件 / ⚙️设置。

### 4.2 导入流程（Importer）

| 模块 | 入口 | 流程 |
|------|------|------|
| MCP | 配置连接即注册 | 类型选择(stdio/sse/http) → 填地址/命令 → 认证 → 测试连接 |
| Skill | 本地/URL/MCP注册 | 选文件 → 解析 manifest → 预览 → 确认导入 |
| 插件 | 本地/URL | 选 zip/json → 解析 → 权限确认 → 安装 |

> **约束**：三者**均不支持页面内创建/开发**，只导入 + 管控。

### 4.3 筛选与删除（统一）

- 关键词搜索（名称/描述/作者）
- 状态筛选（启用/禁用/错误/弃用）
- 来源筛选（本地/URL/MCP/内置）
- 删除：**二次确认**；批量删除底部操作栏 + 影响数量提示
- 批量启用/禁用

### 4.4 详情页结构

- **MCP**：连接信息 / Capabilities 树（Tools/Resources/Prompts）/ 历史连接日志（最近 50 条，可清空）/ 一键测试连接（DNS→TCP→握手→协商可视化）
- **Skill**：图标+版本 / 描述 / 来源+导入时间 / 启用·删除·导出 / 输入·输出 Schema / 使用示例 / 更新日志 / 依赖链（只读）
- **插件**：运行态（运行/停止/重启/日志/删除）/ 权限面板（只读展示）/ 依赖与冲突（只读）

### 4.5 状态指示灯

🟢 connected（5min 内有心跳）· 🟡 connecting（旋转）· 🔴 disconnected（重连按钮）· ⚫ error（详情）· ⚪ disabled（灰）

### 4.6 权限聚合视图

按权限类型（网络/文件系统/Shell/数据库）聚合展示已授权插件数，点击逐项管理。插件安装后权限只读，变更需重导。

---

## 5. 定时任务系统设计

> 完整实现见 `src/components/tasks/ScheduledTasksPage.tsx` + `src/hooks/useScheduledTasks.ts`。

### 5.1 核心原则

本地优先 / 启动自恢复 / 原子写入 / **只读创建（页面无新建）** / 可控可预期。

### 5.2 存储方案

- **localStorage**（`agent.tasks.index` / `agent.tasks.version`）：轻量索引，启动快速加载。
- **任务完整数据**：优先 IndexedDB；桌面端 Tauri 当前用 localStorage 简化存储（迁移路径预留）。
- 写入原子：先写临时再替换，防崩溃损坏。

### 5.3 数据结构

```jsonc
{
  "id": "task_<ts>_<rand>",
  "title": "每日数据备份",
  "description": "…",
  "type": "cron | once | interval",
  "schedule": { "cron": "0 2 * * *", "timezone": "Asia/Shanghai",
                "once": "2025-08-15T10:00:00+08:00", "interval": "30m" },
  "action": { "type": "skill|mcp|prompt|custom", "target": "backup_skill", "params": {} },
  "source": "agent_dialog|skill_callback|mcp_event|system_init",
  "status": "active|paused|completed|failed|expired",
  "createdAt": "…", "updatedAt": "…", "lastRunAt": "…", "nextRunAt": "…"
}
```

### 5.4 启动加载与自恢复

应用启动 → 读 `agent.tasks.index` → 校验 version → 加载完整数据 → 重建定时器 → 校验 `nextRunAt`（已过期标记 expired）→ 更新 UI → 提示"已恢复 N 个任务"。

### 5.5 调度器

| 模式 | 实现 |
|------|------|
| Cron | 解析 → 算下次触发 → setTimeout |
| 一次性 | 直接 setTimeout，到期移除 |
| 固定间隔 | setInterval + 防重叠锁 |

错过补偿：`visibilitychange` 回前台补偿；应用关闭则下次启动检测 overdue 并补执行（once 直接执行，cron/interval 补最近一次）。

### 5.6 任务列表页（唯一页面）

筛选栏（来源▾/状态▾/类型▾ + 搜索）+ 任务卡片（图标+标题+状态徽标+来源标签+下次触发+暂停/恢复/删除）。**无新建、无详情页**。空状态引导用户使用 Agent。

### 5.7 状态机

`created → active ⇄ paused → deleted`；`active → running → completed|failed`（failed 重试 < max 回 running）。用户仅可：暂停 / 恢复 / 删除。

### 5.8 来源联动

Agent 对话说"每天提醒我…"自动注册；Skill 回调/MCP 事件/系统初始化各自注册；`source` 字段用于筛选。

---

## 6. 主题系统规范（白天 / 夜间）

> 仅两个主题，手动切换，无系统跟随。语义化双主题，非简单反色。

### 6.1 语义化 Token（白天 / 夜间）

```css
:root {                          /* ☀️ 白天 */
  --bg-base: #ffffff;           --text-primary: #0f172a;
  --bg-surface: #f8fafc;        --text-secondary: #475569;
  --bg-elevated: #ffffff;       --text-muted: #94a3b8;
  --bg-hover: #f1f5f9;          --border-default: #e2e8f0;
  --bg-active: #e2e8f0;         --border-focus: #3b82f6;
  --status-success: #16a34a;    --accent-primary: #3b82f6;
  --status-warning: #d97706;    --accent-subtle: #dbeafe;
  --status-error: #dc2626;      --status-info: #2563eb;
}
:root[data-theme="dark"] {      /* 🌙 夜间 */
  --bg-base: #121212;           --text-primary: #e5e5e5;
  --bg-surface: #1a1a1a;        --text-secondary: #a0a0a0;
  --bg-elevated: #242424;       --text-muted: #666666;
  --bg-hover: #2a2a2a;          --border-default: #2a2a2a;
  --bg-active: #333333;         --border-focus: #60a5fa;
  --status-success: #4ade80;    --accent-primary: #60a5fa;
  --status-warning: #fbbf24;    --accent-subtle: #1e3a5f;
  --status-error: #f87171;      --status-info: #60a5fa;
}
```
*Why：语义 Token 让"背景/文字/边框/状态/主色"按角色取值，切换主题只改 Token，组件零改动。夜间避免纯黑、用 4% 亮度差分 surface 层级。*

### 6.2 组件适配规则

| 组件 | 日间 | 夜间 |
|------|------|------|
| 代码块 | GitHub Light | VS Code Dark+ |
| Tooltip | 深底白字 | 浅底深字 |
| 阴影 | `0 1px 3px rgba(0,0,0,.1)` | `0 1px 3px rgba(0,0,0,.5)` + 发光边 |
| 滚动条 | 浅灰 | 自定义深色 |
| 第三方内容 | 正常 | `filter:invert()` 桥接或暗色样式表 |

### 6.3 切换交互

- 入口：顶栏按钮（最显眼）+ 设置→主题（最完整，单选预览）。
- 状态机：用户手动选（最高优先级，持久化） / 首次默认白天。
- 动画：200ms `cubic-bezier(0.4,0,0.2,1)`，过渡 `background-color/border-color/color`，不过渡 `transform/opacity`（防重绘闪烁）。

---

## 7. 响应式策略

| 断点 | 布局 |
|------|------|
| 桌面 ≥1024px | 侧栏 260px + 主区；MCP/Skill/插件用抽屉详情 |
| 平板 768~1023px | 侧栏可收起为图标模式（64px）；主区占满 |
| 移动 ≤767px | 侧栏抽屉化（手势滑出）；对话/管理页单栏；底部 Tab 切换 |

*Why：桌面是主场景（本地工作台），响应式保证窗口缩小时不破版，但移动端为简化降级而非完整重排。*

---

## 8. Top 5 优先级优化建议

- **P0（阻塞上线）**
  1. 主题系统语义 Token 落地 + 手动切换（已完成基础，待去 auto）
  2. 定时任务本地持久化 + 自恢复（本次实现）
  3. MCP/Skill/插件统一导入 + 管控骨架（本次实现 mock 驱动）
- **P1（影响体验）**
  4. i18n 中英文框架 + 语言切换（本次实现框架，需逐步翻译各页）
  5. 导航骨架统一（本次实现）
- **P2（锦上添花）**
  6. 权限聚合视图、依赖冲突提示、批量导出 zip
  7. 字体大小/密度扩展设置
  8. 第三方内容暗色桥接

---

## 9. 开发者交接清单

### 9.1 CSS Token 命名

- 颜色：`--bg-{base|surface|elevated|hover|active}`、`--text-{primary|secondary|muted|inverse}`、`--border-{default|focus}`、`--status-{success|warning|error|info}`、`--accent-{primary|subtle}`。
- 尺度：`--space-{xs..2xl}`、`--radius-{sm..xl}`、`--shadow-{sm..lg}`。
- 主题切换：仅 `<html data-theme="dark">`，组件只读 Token。

> **实际实现校准（以 `src/App.css` 为准，2026-07-31）**：上文示例的 `--bg-base/--bg-surface/--border-default/--accent-primary/--accent-subtle` 是语义别名，代码主用 Apple HIG 原生名：`--bg-{primary|secondary|tertiary|elevated|hover|active}`、`--text-{primary|secondary|tertiary|muted|inverse}`、`--border-{light|medium|heavy|focus}`、`--accent[-hover|-pressed|-soft]`、`--danger/--success/--warning`（原生状态名）及其语义别名 `--status-{error|success|warning|info}`。**状态色统一用 `--status-*` 语义别名**（`--danger`→`--status-error`）。
> 另新增并强制使用的令牌：字号 type-scale `--text-{2xs(10)|xs(11)|sm(12)|base(13)|md(14)|lg(16)|xl(20)|2xl(24)|3xl(40)}`；遮罩 `--overlay`；开关滑块 `--thumb-bg`（白色常量，明/暗通用）。**组件 css / 内联 style 禁止写死 hex/rgb/rgba 与裸 font-size，一律走令牌。**

### 9.2 组件 API 提示

- `Sidebar`：`activeNav: NavKey`、`onNavigate(key)`、`theme`、`onToggleTheme`。
- `ScheduledTasksPage`：纯前端 localStorage，props 仅需 `onBack?`。
- `McpPage/SkillPage/PluginPage`：接收 `seed` mock 数据 + 统一 `Importer`/`DetailDrawer` 组件。
- i18n：`const t = useI18n(); t("nav.tasks")`；新增文案必补 zh/en 两条。

### 9.3 动效曲线参数

- 主题过渡：`200ms cubic-bezier(0.4,0,0.2,1)`，过渡 `bg/border/color`。
- 抽屉滑入：`240ms cubic-bezier(0.4,0,0.2,1)`。
- 列表项入场：`120ms ease-out`，`opacity 0→1 + translateY(4px→0)`。
- 状态脉冲（运行中）：`1.6s ease-in-out infinite`。

### 9.4 无障碍检查清单（WCAG 2.1 AA）

- [ ] 所有交互元素可键盘到达（Tab/Enter/Space）
- [ ] 焦点环可见（`--border-focus` 2px）
- [ ] 状态色不单独承载信息（配文字/图标）
- [ ] 正文字对比 ≥ 4.5:1（夜间已用柔白 `#e5e5e5`）
- [ ] 删除/危险操作有 `aria-label` 与二次确认
- [ ] 语言切换 `lang` 属性随 locale 更新

---

## 附录：与提示词的偏差说明

| 项 | 提示词要求 | 本次实现 | 原因 |
|----|-----------|---------|------|
| 技术栈 | React+Tailwind+shadcn | React+原生 CSS Token | 现有 app 已建立 Apple HIG Token 体系，重写为 Tailwind 是巨大弯路；Token 命名已对齐提示词语义 |
| 存储 | localStorage+IndexedDB | 当前 localStorage 简化 | Tauri 桌面端；IndexedDB 迁移路径预留 |
| MCP/Skill/插件数据 | 真实后端 | mock/seed 数据驱动 | 前端 redesign 阶段，后端接口未就绪；交互范式完整可演示 |
| 侧边栏 | 完整一级导航 | 完整一级导航 | 覆盖早前"极简侧栏"临时指令，以本提示词为准（可回退） |

---

## 附录 2：v2.1 回退记录（用户最终决策）

按用户 2026-07-31 指令，**撤销** v2 对以下两项的改动，回到 v1 形态：

1. **极简侧边栏保留**：侧边栏恢复为「新建会话按钮 + 会话清单 + 底部仅 Settings 图标(左) 与主题切换(右)」，去掉 v2 的 6 项完整一级导航。定时任务 / MCP / Skill / 插件 入口改为 **顶部栏（TopBar）图标导航**，聊天页也可一键进入；管理页内提供返回对话的箭头。
2. **Apple HIG 原生 CSS Token 体系保留**：`:root` 改回 v1 的 Apple 系统色（`--accent:#0071e3`、`--bg-secondary:#f5f5f7`、`--text-primary:#1d1d1f`、`--danger:#ff3b30` 等），深色用 Apple 暗色盘（`#000/#1c1c1e/#2c2c2e`、`systemBlue #0a84ff`）。v2 的 Tailwind 风格语义色（`#3b82f6/#f8fafc/#0f172a`）降级为别名，确保组件零改动。

> 结论：v2 的「完整导航 + 语义 Token」被用户判定为偏离其一贯偏好，最终以 **极简侧栏 + Apple HIG 原生 Token** 为准。
