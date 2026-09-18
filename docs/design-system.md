# OneDesktop Design System v1.0

> 面向 AI Agent 桌面应用的设计系统：从组件审计到落地 spec。
> 基于当前 OneDesktop 代码库（Tauri 2 + React 18 + TypeScript）与 OpenWorker 截图目标形态。

---

## 1. 设计原则（Why）

| 原则 | 定义 | 在 Agent 场景中的意义 |
|---|---|---|
| **连续性优先** | 同一任务的状态、上下文、历史在视觉上连续呈现 | Agent 执行是多步 ReAct 循环，用户需要看到“从意图到结果”的完整链条 |
| **透明化** | 系统思考、工具调用、错误、延迟都可见 | 降低黑盒焦虑，建立用户对 Agent 的信任 |
| **可逆原则** | 危险操作（删除、覆盖、授权）必须可撤销或可确认 | Agent 会读写文件、执行命令，误操作成本高 |
| **本地优先** | 不依赖云端即可工作，离线体验完整 | 桌面 Agent 的核心价值之一是隐私与本地可控 |
| **密度适中** | 信息密度高于普通 C 端，低于 IDE | Agent 用户需要同时看到对话、执行过程、结果，但不能信息过载 |

---

## 2. 组件审计

### 2.1 现有 UI 元素分类清单

#### 2.1.1 布局层（Layout）

| 元素 | 位置 | 当前实现 | 问题 |
|---|---|---|---|
| `app-layout` | `App.tsx` | flex 横向：Sidebar + Main | ✅ 合理 |
| `sidebar` | `Sidebar.tsx` | 固定 260px，含 header/sessions/footer | 底部缺少“用户中心”入口；设置入口隐藏在标题栏 `...` 按钮 |
| `main-content` | `App.tsx` | flex 列：ChatArea | 当前只有对话主区，无设置/详情等二级页面 |
| `modal-overlay` | `SettingsModal.tsx` | 居中弹窗 480px | ❌ 与截图目标不符；设置项多后空间局促 |

#### 2.1.2 导航层（Navigation）

| 元素 | 位置 | 当前实现 | 问题 |
|---|---|---|---|
| New session | `Sidebar.tsx` | 标题栏 `+` 图标按钮 | 图标语义弱；截图中为高亮蓝色主按钮 |
| Search | 无 | 无 | ❌ 缺失，会话多后无法快速定位 |
| Automations | 无 | 无 | ❌ 缺失 |
| Team | 无 | 无 | ❌ 缺失 |
| Settings | `Sidebar.tsx` | `...` 图标 | ❌ 发现性差；应为文字/图标混合的底部导航项 |
| 会话列表 | `SessionList.tsx` | 简单列表 | 缺少分组、搜索、固定 |

#### 2.1.3 对话层（Conversation）

| 元素 | 位置 | 当前实现 | 问题 |
|---|---|---|---|
| Message bubble | `MessageList.tsx` | 左右分栏气泡 | ✅ 基础可用；缺少统一 agent 身份标识 |
| User input | `InputBar.tsx` | pill 形状底部输入框 | ✅ 视觉舒适；可加强 placeholder/空状态 |
| Thinking block | `ThinkingBlock.tsx` | 可折叠思考区 | 已被 ProcessPanel 替代，保留旧代码 |
| Process panel | `ProcessPanel.tsx` | ReAct 时间线 | ✅ 最新设计；需继续打磨动效与响应式 |
| Tool step row | `ProcessPanel.tsx` | 时间线节点 | ✅ 已类型化；需统一图标系统 |
| HITL approval | `ProcessPanel.tsx` | 内联授权 | ✅ 优于旧底部横条 |
| Empty state | `MessageList.tsx` | 欢迎语 + chips | ✅ 已落地；文案可 A/B |

#### 2.1.4 表单与设置层（Forms & Settings）

| 元素 | 位置 | 当前实现 | 问题 |
|---|---|---|---|
| Settings modal | `SettingsModal.tsx` | 弹窗表单 | ❌ 未按截图实现卡片式设置页 |
| Provider selector | `SettingsModal.tsx` | native select | 可用但缺乏品牌感 |
| API Key input | `SettingsModal.tsx` | password input | 缺少可见性切换、安全提示 |
| Model dropdown | `InputBar.tsx` | 自定义 dropdown | ✅ 体验较好，可复用到设置页 |
| Permission selector | `ChatArea.tsx` | 底部权限下拉 | 位置合理但视觉权重过低 |

#### 2.1.5 反馈层（Feedback）

| 元素 | 位置 | 当前实现 | 问题 |
|---|---|---|---|
| Error banner | `ChatArea.tsx` | 红色横幅 | ✅ 可用；缺少自动重试/诊断 |
| Loading dots | `ThinkingDots.tsx` | 三点头 | ✅ 通用 |
| Toast / copy feedback | `MessageList.tsx` | 简单 fade toast | 缺少全局 toast 系统 |
| Status dot | `App.css` | 12px 圆点 | 尺寸过大，与文本基线不齐 |

#### 2.1.6 图标与视觉资产（Icons）

| 元素 | 位置 | 当前实现 | 问题 |
|---|---|---|---|
| Icon set | `common/Icons.tsx` | SVG 内联 | 已集中，但缺少工具图标映射规范 |
| Agent avatar | 无统一 | 使用 ◆ 符号 | 需要正式 avatar/brand mark |

### 2.2 冗余度分析

| 冗余项 | 位置 | 说明 | 建议 |
|---|---|---|---|
| `TurnGroup.tsx` | `components/chat/` | 旧版 ReAct 容器 | **删除**；功能已被 `ProcessPanel.tsx` 替代 |
| `ThinkingBlock.tsx` | `components/chat/` | 旧版思考块 | **删除**；已并入 `ProcessPanel.tsx` |
| `.react-step-*` / `.workflow-*` 样式 | `App.css` | 旧 ProcessPanel / TurnGroup 样式 | **清理**；只保留当前时间线相关样式 |
| `.tool-call-card` 样式 | `App.css` | 更早期的工具卡片 | **清理**；当前使用 timeline |
| `.hitl-bar` 样式 | `App.css` | 旧底部授权条 | **清理**；已改为内联授权 |

**冗余度评分：中等偏高（约 25% CSS 与 2 个组件已废弃）**

---

## 3. 系统设计

### 3.1 原子级组件库（Atoms）

> 原子组件无业务逻辑，只依赖 design tokens。

#### 3.1.1 Button

```tsx
interface ButtonProps {
  variant: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
}
```

| 变体 | 用途 | 视觉 |
|---|---|---|
| `primary` | 主操作：Send、Save、New session | 蓝色填充、白色文字、圆角 8px |
| `secondary` | 辅助操作：Browse、Cancel | 灰色填充、深色文字 |
| `ghost` | 图标按钮、工具栏 | 透明背景、hover 显背景 |
| `danger` | 删除、拒绝授权 | 红色填充或红色文字 |

#### 3.1.2 Input

```tsx
interface InputProps {
  type?: "text" | "password" | "number" | "search";
  size?: "sm" | "md";
  error?: string;
  helper?: string;
  label?: string;
  suffix?: React.ReactNode; // 如 visibility toggle
}
```

- 统一高度：`sm=28px`, `md=32px`
- focus ring：`0 0 0 3px rgba(0,113,227,0.25)`
- 错误态：边框变红 + 下方 error text

#### 3.1.3 Segmented Control

```tsx
interface SegmentedControlProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}
```

- 用于 Theme（Light / Dark / Auto）、Provider 切换
- 当前选中项：白色背景 + 阴影，未选项透明

#### 3.1.4 Card

```tsx
interface CardProps {
  title?: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}
```

- 圆角 12px，白色背景，1px `border-light`
- 内边距 16-20px
- 这是截图中设置页的核心容器

#### 3.1.5 Toggle / Checkbox

```tsx
interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  description?: string;
}
```

- macOS 风格 pill toggle
- 用于 Always-on、Auto approve 等开关设置

#### 3.1.6 Spinner / Skeleton

| 组件 | 用途 |
|---|---|
| `Spinner` | 按钮 loading、步骤执行中 |
| `SkeletonLine` | 等待首 token 时的占位 |
| `SkeletonBubble` | 等待回答时的气泡占位 |

#### 3.1.7 Status Badge

```tsx
interface StatusBadgeProps {
  status: "idle" | "running" | "success" | "error" | "warning";
  label?: string;
}
```

- 圆角 pill，颜色与语义状态绑定

### 3.2 复合组件（Molecules / Organisms）

#### 3.2.1 Sidebar

```tsx
interface SidebarProps {
  header: { title: string; onNewSession: () => void };
  navItems: NavItem[];
  sessions: Session[];
  activeSessionId: string | null;
  activeNav?: string;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onSelectNav: (id: string) => void;
}
```

- 顶部：品牌 + 蓝色 New session 主按钮
- 中部：Global nav（Search、Automations、Team）+ 会话列表
- 底部：User nav（Inbox、Connectors、Settings、Automations、Activity）+ 账号状态
- 与截图对齐

#### 3.2.2 ChatArea

```tsx
interface ChatAreaProps {
  items: Item[];
  isStreaming: boolean;
  pendingApproval?: PendingApproval;
  onSendMessage: (text: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onStop: () => void;
  onRegenerate: () => void;
}
```

- `MessageList`：渲染对话流
- `InputBar`：底部输入
- `ErrorBanner`：错误提示

#### 3.2.3 MessageList

- 空状态：欢迎区 + 能力建议 chips
- 用户气泡右对齐
- Agent turn 左对齐，含统一身份标识 + ProcessPanel

#### 3.2.4 ProcessPanel

```tsx
interface ProcessPanelProps {
  steps: Step[];
  status: "running" | "done" | "error";
  pendingApproval?: PendingApproval;
  onApprove?: () => void;
  onReject?: () => void;
}
```

- 折叠态：状态点 + 面包屑工具图标
- 展开态：ReAct 竖向时间线
- 内联 HITL

#### 3.2.5 SettingsPage

```tsx
interface SettingsPageProps {
  settings: Settings;
  onSave: (settings: Settings) => void;
  onClose?: () => void;
}
```

- 左侧：设置分类导航（General、Models、Voice input…）
- 右侧：分组卡片式设置表单
- 与截图 OpenWorker 设置页对齐

#### 3.2.6 ModelSelector

- 复用 `InputBar.tsx` 中的 dropdown 设计
- 支持 provider 分组、模型描述

---

## 4. 交互规范

### 4.1 用户意图 → 系统反馈完整链路

```
用户输入
  ↓
[本地校验 + 上下文组装]          → 空输入：shake input / placeholder 提示
  ↓
发送请求                          → InputBar 进入 loading；显示用户气泡
  ↓
Streaming reasoning               → ProcessPanel 自动展开，显示 thinking 节点
  ↓
Tool call                         → 时间线新增 step 节点，状态 running
  ↓
HITL（如需要）                    → 内联显示 Approve/Reject
  ↓
Tool result                       → step 状态变为 done/error，展开显示结果
  ↓
Final answer                      → Agent 气泡渲染，ProcessPanel 自动折叠
  ↓
Error / Timeout / Cancel          → 显示 Notice banner，支持 Retry
```

### 4.2 异常态设计

| 场景 | 触发条件 | 反馈方式 | 恢复路径 |
|---|---|---|---|
| **Loading** | 请求发送后首 token 前 | InputBar spinner + ProcessPanel 展开 + skeleton | 自动 |
| **Empty** | 无会话或首屏无消息 | 欢迎语 + 建议 chips | 用户点击或输入 |
| **Error** | 网络/模型/API 错误 | Notice banner（error 色）+ Retry 按钮 | 用户点击 Retry |
| **Timeout** | 30s 无响应 | Notice banner（warning 色）+ Cancel/Retry | Retry 或检查代理 |
| **HITL** | 危险工具调用 | ProcessPanel 内联授权 + 高亮该 step | Approve/Reject |
| **Offline** | 代理不可达 / 无网络 | 顶部离线条 + 禁用发送 | 网络恢复后自动重试 |
| **Validation** | 空输入、非法参数 | Input shake + 字段级 error | 用户修正 |

### 4.3 状态一致性规则

1. **一个 turn 只有一个 ProcessPanel**：同一轮对话的思考+执行必须合并。
2. **折叠态永远可见状态**：用户无需展开即可知道是否出错、进行了哪些工具。
3. **授权必须内联**：授权请求出现在触发它的步骤内，不可在底部全局条。
4. **错误必须可重试**：所有 retriable error 提供 Retry；非 retriable 提供 Copy error。
5. **输入不可丢失**：发送失败时保留输入框内容，方便重发。

---

## 5. 体验优化

### 5.1 Fitts's Law 应用

> 目标越大、距离越短，点击越快。

| 优化点 | 当前问题 | 改进 |
|---|---|---|
| New session 按钮 | 标题栏小图标 | 改为左侧边栏顶部全宽蓝色大按钮（截图样式）， Fitts 指数大幅提升 |
| 会话列表项 | 只有文字可点，删除按钮小 | 整行可点，hover 显示删除；删除按钮 28×28px |
| 发送按钮 | 36px 圆形 | ✅ 已较大，保持 |
| HITL 按钮 | 内联后位于步骤内 | 按钮宽度 ≥ 60px，间距 8px |
| Settings 入口 | `...` 图标 | 改为底部导航文字项，增大热区 |

### 5.2 Jakob's Law 应用

> 用户把大部分时间花在别的产品上，他们希望你的产品用起来像别的产品。

| 优化点 | 行业惯例 | 当前差距 |
|---|---|---|
| 设置页布局 | macOS Settings / Linear / Raycast：左侧分类 + 右侧卡片 | 当前是弹窗，与截图目标差距大 |
| 侧边栏结构 | ChatGPT / Claude：顶部新建、中部历史、底部设置 | 当前缺少底部用户区 |
| 主题切换 | Light / Dark / Auto 三段 | 当前无主题设置 |
| 输入框 | 底部固定 pill | ✅ 已对齐 |
| 气泡 | 左右分栏 | ✅ 已对齐 |

### 5.3 其他可用性原则

| 原则 | 应用 |
|---|---|
| **Hick-Hyman Law** | 工具面包屑最多显示 5 个节点，超出折叠为 `+N` |
| **Miller's Law** | 会话列表默认显示 7±2 条，超出折叠；设置卡片每组 3-5 项 |
| **Proximity** | 同一 turn 的气泡、ProcessPanel、操作按钮在视觉上一组 |
| **Visibility of system status** | 每个 step 都有明确状态图标；ProcessPanel 折叠态显示面包屑 |
| **Error prevention** | HITL 授权、文件覆盖二次确认、危险命令高亮 |

---

## 6. 落地文档

### 6.1 CSS Design Tokens（已部分落地，建议统一）

```css
:root {
  /* Color */
  --bg-primary: #ffffff;
  --bg-secondary: #f5f5f7;
  --bg-tertiary: #e8e8ed;
  --bg-elevated: #ffffff;

  --text-primary: #1d1d1f;
  --text-secondary: #6e6e73;
  --text-tertiary: #aeaeb2;
  --text-inverse: #ffffff;

  --accent: #0071e3;
  --accent-hover: #0077ed;
  --accent-pressed: #006edb;
  --accent-soft: rgba(0, 113, 227, 0.08);

  --danger: #ff3b30;
  --success: #34c759;
  --warning: #ff9500;

  /* Border & Shadow */
  --border-light: rgba(0, 0, 0, 0.08);
  --border-medium: rgba(0, 0, 0, 0.12);
  --border-heavy: rgba(0, 0, 0, 0.18);

  --shadow-sm: 0 1px 3px rgba(0,0,0,0.06);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.08);
  --shadow-lg: 0 8px 30px rgba(0,0,0,0.12);

  /* Typography */
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", sans-serif;
  --font-mono: "SF Mono", "Menlo", "Monaco", monospace;

  /* Radius */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 20px;

  /* Spacing */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 12px;
  --space-lg: 16px;
  --space-xl: 24px;
  --space-2xl: 32px;

  /* Layout */
  --sidebar-width: 260px;
  --titlebar-height: 38px;
}
```

### 6.2 动效曲线参数

| 场景 | 时长 | 曲线 | 说明 |
|---|---|---|---|
| Hover 反馈 | 120-150ms | `ease` | 快速响应，不拖沓 |
| Focus ring | 200ms | `ease` | 明确但不刺眼 |
| Modal / 页面切换 | 200-250ms | `cubic-bezier(0.16, 1, 0.3, 1)` | Apple 风格 ease-out |
| ProcessPanel 折叠 | 200ms | `ease` | 保持流式感 |
| Toast 出现/消失 | 200ms / 150ms | `ease-out` | 快速告知 |
| Spinner | 800ms linear | `linear` | 持续旋转 |
| Skeleton shimmer | 1.6s | `ease-in-out` | 无限循环 |

### 6.3 组件 API 建议（新增）

#### SettingsPage

```tsx
interface SettingsSection {
  id: string;
  label: string;
  icon?: React.ReactNode;
  cards: SettingsCard[];
}

interface SettingsCard {
  title: string;
  description?: string;
  fields: SettingsField[];
}

interface SettingsField {
  id: string;
  type: "segmented" | "input" | "select" | "toggle" | "path" | "number";
  label: string;
  description?: string;
  value: unknown;
  onChange: (value: unknown) => void;
}
```

#### Sidebar

```tsx
interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}
```

---

## 7. 与行业最佳实践的差距

| 维度 | 行业最佳实践 | OneDesktop 当前状态 | 差距等级 |
|---|---|---|---|
| **设置页** | 独立页面、左侧分类、卡片分组 | 弹窗表单 | 🔴 大 |
| **主题系统** | Light/Dark/Auto + 系统同步 | 仅 Light | 🔴 大 |
| **全局导航** | 底部用户区 + 顶部新建 | 顶部图标 + 底部版权 | 🟡 中 |
| **搜索** | 全局搜索会话/消息 | 无 | 🟡 中 |
| **Toast 系统** | 全局堆叠 toast | 局部 copy toast | 🟡 中 |
| **图标系统** | 统一图标库 + 语义映射 | 内联 SVG | 🟢 小 |
| **Agent 身份** | 统一头像 + 名称 | ◆ 符号 | 🟡 中 |
| **键盘快捷键** | Cmd+N、Cmd+K、Esc | 无 | 🟡 中 |
| **无障碍** | ARIA label、focus trap、color contrast | 部分缺失 | 🟡 中 |
| **响应式** | 适配 narrow sidebar / 宽屏 | 固定 260px | 🟢 小 |

---

## 8. 实施路线图（P0 / P1 / P2）

### P0 — 必须先做（阻塞核心体验）

- [x] ReAct 执行过程可视化（ProcessPanel 时间线）
- [x] 内联 HITL 授权
- [x] 空状态引导
- [x] Agent 身份标识
- [ ] **Settings 页面从弹窗改为截图式独立页面**（本次交付）
- [ ] **Sidebar 底部用户导航与顶部 New session 主按钮**（本次交付）
- [ ] 清理冗余组件与 CSS（TurnGroup、ThinkingBlock、旧样式）

### P1 — 近期优化（显著提升可用性）

- [ ] 全局搜索（Cmd+K）
- [ ] 主题切换 Light / Dark / Auto
- [ ] 统一图标库与工具图标映射
- [ ] 全局 Toast 系统
- [ ] API Key 安全提示与可见性切换
- [ ] 键盘快捷键

### P2 — 中长期增强

- [ ] 无障碍全面审计
- [ ] 动画系统抽离为 `useMotion`
- [ ] 会话分组 / 固定 / 标签
- [ ] 响应式布局（narrow / wide）
- [ ] 设计 token Figma 同步

---

## 9. 本次交付重点

根据用户截图，本次优先落地 **P0 中的 Settings 独立页面 + Sidebar 导航结构改造**，使 OneDesktop 的前端架构从“弹窗式设置”向“OpenWorker 式设置页”对齐，同时为后续 P1/P2 优化奠定组件基础。
