# 圆桌（群协作）UI 交互设计说明 · v4

> 版本：v4（微信群式 · 聚焦对话）
> 日期：2026-08-02
> 设计语言：Apple HIG（克制 / Deference）+ 项目统一设计令牌（App.css）
> 交付物：`docs/ui-mockup-roundtable-v4-shell.html`（完整 App 外壳）、`docs/ui-mockup-roundtable-v4-chat.html`（圆桌视图单页）

---

## 0. 设计判词（一锤定音）

圆桌**不是**一种特殊视图，而是一种**并存的多人协作模式**——像微信里的"群"。

- 主区**只管对话流**，信息密度让给侧栏；
- Worker 的创建、管理、状态、统计**挪到侧边栏群信息面板**，不抢占对话舞台；
- 常规单 Agent 会话与圆桌是**兄弟分区**，共用同一外壳，体验一致、互不干扰；
- 全程**零彩色 emoji**，只用 `App.css` 语义令牌 + `Icons.tsx` 单色 SVG（`stroke="currentColor"`）。

相对 v3（卡包化、任务通行证占主舞台），v4 的关键转向是：**执行卡片不再独占主区，回归群聊范式**——进度降级为对话内小卡与侧栏进度环，真正聚焦对话。

---

## 1. 信息架构

```
导航（对话 / 任务 / 扩展）
└─ 对话区：会话 | 圆桌   ← 段控切换，二选一显示列表（更聚焦）
   ├─ 会话列表（常规单 Agent 会话项）
   └─ 圆桌列表（卡包 mini 卡：进行中 pill + 席位/在忙/待验收统计）
        │
        ├─ 选中「会话」→ 常规单 Agent 会话视图
        └─ 选中「圆桌」→ 微信群式圆桌视图（+ 右侧群信息面板）
```

**设计原则（Apple HIG Deference）**
- 常规会话不放任何 Worker 管理入口（那不是它的场景）；
- 圆桌专属的「群信息面板 + 席位管理」只在圆桌视图出现；
- 侧边栏用**图标 + 状态点**区分两类列表项：会话=单人图标，圆桌=多人图标（Users）+ 进行中状态点。

---

## 2. 常规单 Agent 会话视图

主区 = **单 Agent 聊天**，是圆桌的"地基"。结构：

| 层 | 元素 | 说明 |
|---|---|---|
| 顶栏 | 标题 + 副标（模型名 · 单 Agent）+ 主题切换 | 与全局外壳一致 |
| 主对话流 | human 气泡（右）+ 单个 Agent 气泡（左） | 自然滚动 |
| 结构化卡片 | `.wf-group`（对话内嵌） | Agent 的推理/执行以**步骤清单 + 进度条 + 状态**呈现，不独占舞台 |
| 产物 | `.artifact`（对话内嵌） | 带「采纳产物」按钮，像群里发文件 |
| 输入区 | composer（与全局一致） | 发消息 / 附件 / 发送 |

`.wf-group` 步骤状态三态：`done`（绿勾）、`run`（accent 旋转）、`todo`（灰点）。
**刻意不放**席位条、群信息面板、Worker 进度环——单 Agent 场景不需要，避免装饰堆砌。

---

## 3. 圆桌视图（微信群式 · 聚焦对话）

### 3.1 布局
```
┌──────────┬───────────────────────────┬──────────────┐
│ 侧边栏    │ 主对话流（聚焦）            │ 群信息面板    │
│ 会话/圆桌  │ human 右 / 群主·Worker 左   │ 统计卡 ×4     │
│ 列表       │ 消息自然滚动              │ Worker 名单   │
│           │ Worker 进度=内联小卡       │ + 进度环      │
│           │ HITL / 产物=内联           │ 添加席位      │
└──────────┴───────────────────────────┴──────────────┘
```

### 3.2 主对话流（中间）
- **human** 气泡靠右（accent 实心）；**群主 / Worker** 气泡靠左（secondary 底）。
- **群主拆解派活**：一条系统消息（`.sys-msg`，accent 软底）"群主 已拆解并派活给 N 个 Worker"，非阻断。
- **Worker 执行进度**：降级为对话内紧凑小卡 `.wk-task`（一条细进度条 + 状态药丸 `exec`/`done`），不展开大卡。
- **HITL 待批**：内联在对话里 `.hitl`（accent 软底 + 确认/婉拒按钮），人类只在"待批"与"验收"两个节点被拉入。
- **产物验收**：对话内 `.artifact` 卡片（左侧 accent 竖条 + 标题 + 描述 + 「采纳产物」按钮），闭环收口在对话中完成。
- **@ 提及**：composer 的 @ 按钮 + 气泡内 `.mention`（accent 文字）高亮被派活的 Worker。

### 3.3 群信息面板（右侧，可一键显隐）
顶栏 info 按钮切换 `panel.hidden`。内容：
1. **2×2 统计卡 `.gstat`**：席位总数 / 正在执行 / 进行中任务 / 待你验收——大数字 + 顶部色带（blue/green/amber/red）。
2. **Worker 名单 `.wk-cell`**：头像 + 状态环（idle/busy 旋转/offline）+ 姓名 + 角色（群主带 `mod` 标）+ 右下**进度环**（SVG 弧 `5/7`，不用点开即知进展）。
3. **能力席位**：虚线头像卡 `.wk-cell.cap`（诚实表达"按需匹配的空位"，不画假头像）。
4. **添加席位**：面板底部虚线按钮 `.panel-add`，唤起添加席位弹窗。

---

## 4. Worker 创建与管理（两层模型）

### 4.1 两层（v1 没讲清的核心）
| 层 | 是什么 | 字段（取自代码） |
|---|---|---|
| **AgentProfile（预设库 / 种源）** | 全局可复用的 Agent 模板 | name / model / system_prompt / capabilities / skills / mcp / tools |
| **Worker（席位实例）** | 建群时从预设"实例化" | seat_type（静态/动态/能力）/ status（Idle/Busy/Offline）/ max_concurrency / capabilities |

> 改预设库 = 改"种源"，所有从该预设实例化的 Worker 同步更新。

### 4.2 创建（三种入口，对应代码三个注册点）
1. **静态席位** — 建群弹窗里从预设勾选，建群即注册（`WorkerPool::register`）。
2. **动态席位** — 圆桌运行中，面板「添加席位」→ 弹窗选预设 + 选类型，确认即进群（`add_at_runtime`）。
3. **能力席位** — 同为添加席位弹窗选"能力"类型：不绑具体人，只声明"需会 visualize 的 Worker"，调度时自动匹配空闲 Worker（`pick / match_by_capability`）；界面用虚线卡诚实表达。

### 4.3 管理
- **席位详情抽屉**（双击 / 点席位从右侧滑出）：状态、来源预设、席位类型、并发上限、能力标签、当前任务 + 编辑能力 / 离线上线 / 移除。低频操作只进抽屉，不占主界面。
- **Agent 预设库**（顶栏按钮，全局）：预设列表 + 新建/编辑/删除。

---

## 5. 添加席位弹窗（`modal` 体系）

- 复用全局 `.modal` / `.overlay`（遮罩 `var(--overlay)`，圆角 `--radius-xl`）。
- **类型切换 `.type-opt`**：静态 / 动态 / 能力 三选一。
- **预设平铺 `.preset`**：卡包卡，顶部状态色带；点选即加。选"能力"类型时预设网格置灰（能力席位不绑具体人）。
- 底部「取消 / 添加席位」`btn / btn-primary`。

---

## 6. 组件 → 令牌 / 图标 映射（严格不漂移）

| 组件 | 关键令牌 | 图标（Icons.tsx 单色 SVG） |
|---|---|---|
| 气泡 / 状态环 | `--accent-strong` / `--bg-secondary` / `--border-*` | 无（状态环用 CSS border） |
| 统计卡 | `--bg-elevated` + 色带 `--accent` / `--status-success` / `--cap-color` / `--status-error` | 无 |
| Worker 进度环 | `--accent` / `--bg-tertiary` | 无（SVG 弧） |
| 产物卡 | `--accent`（左竖条）+ `--bg-elevated` | FileText |
| 采纳按钮 | `--accent-strong` / `--status-success`(done) | Check |
| 添加席位 | `--accent` / `--accent-soft` | Plus |
| 群信息切换 | -- | Users / Info |
| 能力席位（虚线） | `--border-heavy`（虚线）/ `--text-tertiary` | Sparkles（虚线头像内） |
| 系统消息 | `--accent-soft` / `--status-info-strong` | 群主（Building2 / 自定义） |

**强制规则（项目铁律）**
- 颜色只用 `App.css` `:root` 语义令牌，禁止组件内写死 hex/rgb；暗色仅 `[data-theme="dark"]` 重写令牌、组件零改动。
- 字号用 type-scale（`--text-2xs … --text-3xl`）；间距/圆角/阴影用 `--space-*` / `--radius-*` / `--shadow-*`。
- 图标唯一来源 `Icons.tsx`（Lucide 风格、`stroke="currentColor"`），**禁止彩色 emoji**。

---

## 7. 深色模式
- 顶栏主题按钮切换 `document.documentElement[data-theme]`。
- 全部令牌在 `:root[data-theme="dark"]` 重定义（含 `--accent-strong` / `--status-*-strong` 强色，保证 WCAG AA 4.5:1）。
- 圆桌视图已用 mockup 验证：切换后统计卡色带、进度环、对话气泡、群信息面板均正确重绘。

---

## 8. 空态 / 异常
- **无圆桌**：侧边栏「圆桌」段为空时显示「创建圆桌」引导卡（虚线 + Plus 图标 + 一句引导文案），点按唤起建群弹窗。
- **Worker 全离线**：群信息面板统计卡"正在执行=0"，列表以 offline 状态环呈现，composer 仍可发需求（群主会重新派活）。
- **能力席位无人匹配**：虚线卡保留，hover 提示"等待具备该能力的空闲 Worker"。

---

## 9. 与 v1 → v3 的关键差异（收敛史）

| 版本 | 核心思路 | 一句话 |
|---|---|---|
| v1 | 三栏（成员 + 聊天 + 文件树） | emoji 满天飞、"圆桌"无视觉表达 |
| v2 | 席位条 + 主聊天 + 可折叠任务看板 | 引入"席位条"签名元素，清 emoji |
| v3 | 卡包化（席位卡 + 任务通行证占主舞台） | 数据展示强，但执行卡抢了对话焦点 |
| **v4** | **微信群式 · 聚焦对话 + 侧栏群信息面板** | **执行退为内联小卡/侧栏进度环，对话回归主角** |

v4 相对 v3 推翻点：任务通行证（巨型 pass 卡）不再占主区；卡包化语言仅保留在**侧栏统计卡与 Worker 卡**上，主区回归自然对话流。

---

## 10. 落地建议（下一步）
将 v4 落进真实 `GroupsPage.tsx`：
1. **复用现有原子**：`App.css` 令牌、`Icons.tsx` 图标、`composer`、`.modal`/`.overlay` 体系——不新建重复样式。
2. **新增组件**（集中放 `extensibility.css` 或独立 `roundtable.css`，只读令牌）：
   - `RoundtableShell`（左栏段控 + 列表切换 + 主区切换）
   - `ChatStream`（human/agent 气泡 + `.wf-group` / `.wk-task` / `.hitl` / `.artifact`）
   - `GroupInfoPanel`（`.gstat` ×4 + `.wk-cell` 名单 + `.panel-add`）
   - `SeatModal`（`.type-opt` + `.preset` 网格）
3. **数据绑定**：会话列表读 `sessions` 表；圆桌列表读 `groups`（`grp-status-*`）+ `workers`（`resolveName`）；进度环读 Worker `status` + 子任务计数。
4. **无障碍**：弹窗接 `useDialogA11y.ts`（ESC + focus-trap + 焦点恢复）；所有交互元素 ≥44px 触控区；尊重 `prefers-reduced-motion`。

---

## 11. 验收清单
- [x] 常规会话与圆桌是兄弟分区，侧边栏段控切换、不同时摊列表
- [x] 圆桌主区为纯对话流，Worker 进度内联小卡 + 侧栏进度环，不抢焦点
- [x] 产物验收内联在对话（「采纳产物」），闭环收口
- [x] 群信息面板含统计卡 + Worker 名单 + 添加席位，可显隐
- [x] Worker 两层模型（预设库 / 席位实例）在设计中有明确表达
- [x] 零彩色 emoji；全程 App.css 令牌 + Icons.tsx 单色 SVG
- [x] 深色模式一键切换、组件零改动
- [x] mockup 经 Python 校验零彩色 emoji / 零符号字符
- [x] 能力席位可创建（声明能力、不绑预设）并在侧栏以虚线卡呈现
- [x] Worker 可手动离线 / 上线 / 移除（移除在跑时取消 session + 标任务 Cancelled）
- [x] 三命令已接入 e2e（mock 后端 + fullchain 用例），旧用例已修到 v4 DOM

---

## 12. 已闭合的后端缺口（v4.1 补强）

> 设计判词先行：v4 前端落地时，圆桌的"创建/管理 Worker"有两个能力在后端未暴露命令，前端只能只读展示（虚线能力卡、抽屉无写操作）。本次把这两个缺口真正补上——**这是设计文档与实现的再对齐，不是新功能堆叠**。

### 12.1 缺口与决策（ADR 视角）

| 缺口 | Context（当时为何留空） | Decision（本次怎么补） | Consequences（取舍） |
|---|---|---|---|
| **能力席位创建** | `SeatType::Capability` 与 `WorkerStatus::Offline` 在存储层已支持，但无 tauri 命令暴露；添加席位弹窗只支持选预设加静态/动态席位 | 新增 `group_add_capability_seat`：落成 `Capability` + 空 `agent_ref` + `Offline` 的**声明式空槽** | 诚实表达"按需匹配的空位"，调度器 `pick` 只认 Idle 不会被误派发；**但能力→Worker 的真实匹配尚未接入派发链路**（既有 scheduler 对无 `worker_id` 的任务仍 `pick` 任意 Idle），本次只补齐"创建/管理"，调度匹配留待后续 |
| **Worker 离线 / 上线 / 移除** | 无对应 tauri 命令，`WorkerDetailDrawer` 只能只读 | 新增 `group_set_worker_status`（仅 `Idle ↔ Offline` 互转）、`group_remove_worker`（Busy 时取消其引擎 session + 标任务 `Cancelled` + 删库 + 广播 `worker_removed`） | `set_status` 故意拒绝手改 `Busy` 态——避免打断在跑任务，是可逆性与安全的有意取舍；`remove` 会连带回收在跑任务，属不可逆操作，前端走 `window.confirm` 二次确认 |

### 12.2 后端落点（已实现，非本档虚构）
- `src-tauri/src/group/manager.rs` — `add_capability_seat`
- `src-tauri/src/commands/group.rs` — `group_add_capability_seat` / `group_set_worker_status` / `group_remove_worker`
- `src-tauri/src/lib.rs` — 三者注册进 `generate_handler!`
- 约束：`cargo check` 干净通过（语法/类型），但未跑 `tauri dev` 实机联调（需 GUI session + 已配 API key）。

### 12.3 前端接线
- `src/services/tauri.ts` — `groupAddCapabilitySeat` / `groupSetWorkerStatus` / `groupRemoveWorker`
- `src/components/groups/GroupsPage.tsx` — `AddSeatModal` 加「预设席位 / 能力席位」切换；`WorkerDetailDrawer` 加 **离线 / 上线 / 移除** 按钮 + 对应 handler；能力席位（空 `agent_ref`）显示名回退为能力名；@提及与派活下拉过滤能力席位；`worker_removed` 事件触发刷新并关抽屉
- `src/types/index.ts` — `GroupEvent` 补 `worker_removed` 分支
- `src/i18n/dict.ts` — 补 `groups.seat.preset/capability/capabilityHint`、`groups.worker.setOffline/setOnline/remove/confirmRemove`

### 12.4 e2e 覆盖（mock 后端 + fullchain）
- `e2e/helpers/tauriMock.ts` — 三命令 mock 实现（`group_list_workers` 改深拷贝以触发 React 重渲染）；`group_remove_worker` 广播 `worker_removed`
- `e2e/specs/fullchain.spec.ts` — 新增三条用例：**添加能力席位**（虚线卡 + 席位 +1）、**席位离线/上线**（抽屉状态切换）、**移除席位**（dialog 接受后抽屉关闭 + 席位 −1）；并修复了 v4 重构后失配的两条旧用例（派活闭环改走面板「派发任务」+ 顶部待验收条；圆桌摘要去掉已删除的「圆桌」文字 tab）

> ⚠️ **已知 e2e 债务（需浏览器/网络，本沙箱无法执行）**：`e2e/specs/visual.spec.ts` 的 `groups-overview` 等视觉基线来自 v4 前的「概览 tab」，v4 已移除该 tab，基线需重新生成（`npm run test:e2e:update` 在装有浏览器的 macOS 上跑）。a11y 审计不受 DOM 改名影响。无头 UI e2e 全链路（含本次新增三条）需在装有 Chromium/WebKit 的环境实跑验证。
