# OneDesktop 看板（Kanban）功能 PRD

> 状态：设计稿 v1（待评审）
> 作者：Senior Developer（高级开发工程师）
> 关联：群协作内核 M3 / F6 任务心跳与恢复 / F7 共享黑板

---

## 1. 背景与现状（已核实代码）

群协作内核已具备**完整的任务数据模型与调度生命周期**，看板只需在此基础上补「视图 + 人工改状态命令 + 实时事件」，无需重建模型。

| 层 | 现状 | 看板是否复用 |
|---|---|---|
| 数据模型 | `Task`（`id / group_id / batch_id / worker_id / description / depends_on / input_refs / output_spec / status / retry_count / assigned_worker / outputs / reasoning / capability / last_heartbeat`）、`TaskStatus = {Pending, InProgress, Completed, Failed, Cancelled}` | ✅ 直接复用，五状态即五列 |
| 持久化 | `TaskBoardRepository`（CRUD + `update_status` + F6 心跳/卡死探测/retry/reassign/skip） | ✅ 复用 `update_status` |
| 调度 | `TaskScheduler`：`submit_batch → Pending →(依赖门)→ InProgress → Completed/Failed`；F6 卡死回收为 Failed | ✅ 仍主导生命周期，看板不接管 |
| 命令层 | `group_list_tasks`、`task_retry`、`task_reassign`、`task_skip_dependency`、`group_cancel_batch` | ✅ 看板复用列表与恢复命令 |
| 前端 | `Task`/`SubTask`/`TaskStatus` 类型已定义；`GroupsPage` 已加载 `allTasks`（`batches` 聚合）；`TaskDagView`（依赖 DAG）、`TaskRecoveryPanel`（失败恢复）已存在 | ✅ 复用数据、处理器、组件模式 |
| **缺口** | ① 无「跨列拖拽改状态」命令（仅有恢复类命令回到 Pending）；② 无状态变更的实时事件；③ **看板 UI 本身不存在** | ❌ 本次建设范围 |

> ⚠️ **命名澄清**：现有 `GroupsPage` 的 `view === "board"` 标签实际是 **F7 共享黑板**（群级 KV 状态板，`groups.board.*` i18n），**不是任务看板**。看板将作为独立的 `kanban` 视图，黑板标签保留并更名为「黑板」以避免混淆。

---

## 2. 目标

为群内任务提供**可视化看板**：五列对应五个生命周期状态；卡片跨列拖拽即「人工改状态」（经新增 `task_set_status`，带转移校验）；点击卡片查看详情与依赖链；失败/卡死卡可直接触发恢复动作；调度器推进时卡片实时流动，无需手动刷新。

## 3. 非目标

- 不重建调度器 / 依赖引擎（scheduler 仍主导生命周期）。
- 不改 `Task` 数据模型（仅复用，前端类型按需补 `last_heartbeat`/`capability` 可选字段用于展示）。
- 不移除黑板功能（看板用独立 `kanban` 视图；`board` 标签重命名为「黑板」）。
- 不在卡片内编辑任务描述 / 依赖（任务由 scheduler 派生，手动编辑超出范围）。

## 4. 用户故事

- **观察**：群主进群 → 点「看板」标签 → 一眼看到各状态任务数与分布。
- **操作**：拖拽 `Failed → Pending` 触发重试；拖拽 `Pending → InProgress` 手动开跑；拖拽 `→ Completed` 手动标记完成；拖拽 `→ Cancelled` 取消。
- **排查**：点击卡片 → 抽屉展示描述、依赖链、产出物、重试次数、心跳（卡死标识）、恢复动作。
- **实时**：调度器推进时，看板卡片自动流动（`Pending→InProgress→Completed/Failed`），无需刷新。
- **无障碍**：键盘可达——Tab 聚焦卡片，`Shift+方向键` 或菜单移动到目标列。

## 5. 功能需求（FR）

- **FR1 看板视图**：新增 `kanban` `MainView` + 标签按钮（新增 Kanban 三列图标）。
- **FR2 五列**：待办 `Pending` / 进行中 `InProgress` / 已完成 `Completed` / 失败 `Failed` / 已取消 `Cancelled`；列头含状态色 + 计数。
- **FR3 卡片**：描述（截断 2 行）、批次徽章、执行席位（`assigned_worker ?? worker_id`，座位名解析）、依赖角标（`depends_on.length>0` 显示「⛓ N」，悬停看依赖 id）、产出物芯片（`outputs` 数）、重试次数、卡死标识（`InProgress` 且 `last_heartbeat` 超时/缺失 → 红点「卡死」）。
- **FR4 拖拽移动**：原生 HTML5 拖放 + 键盘可达；落列调用 `task_set_status`（带校验）。
- **FR5 转移校验**：非法转移拒绝并 toast（前端阻止落位 + 后端防御）。
- **FR6 卡片详情抽屉**：完整字段 + 依赖链（resolve 依赖任务描述）+ 产出物列表（可点开 `DeliverableDetailDrawer` 或文件路径）+ 恢复动作（重试/改派/跳依赖）+ 取消批次（若属某 batch 且未终态）。
- **FR7 恢复动作复用**：直接复用现有 `task_retry`/`task_reassign`/`task_skip_dependency`（已在 `GroupsPage` handler 实现，看板透传）。
- **FR8 实时刷新**：监听 `task_status_changed`（新增）、`task_reset`、`group-event`（`batch_completed`/`task_failed`/`batch_cancelled`）→ 重新 `loadDetail`（重拉 `batches`）。
- **FR9 过滤/搜索**：按批次下拉、按席位、关键词（描述）搜索。
- **FR10 空/加载态**：无任务 → 引导文案；切换群/视图懒加载。
- **FR11 无障碍**：列/卡 `role`/`aria-label`、键盘移动、焦点环、状态色非仅靠颜色（加图标/文字）。
- **FR12 主题**：亮/暗均按 `App.css` 令牌，状态色用 `--status-success/-warning/-error/-info` 及 `-strong` 变体；禁止裸 hex/rgb。

## 6. 数据模型（复用，仅前端补字段）

复用后端 `Task`。前端 `src/types/index.ts` 的 `Task` 新增两个可选字段以便展示：
```ts
last_heartbeat?: number | null;   // epoch seconds，卡死判定
capability?: string | null;       // 能力路由，展示用
```

## 7. 状态转移规则（`task_set_status` 校验）

纯函数 `is_valid_transition(from, to) -> bool`，后端与前端共用规则（前端用于阻止非法落位，后端用于防御）。

**允许的人工转移**：
| from → to | 语义 |
|---|---|
| Pending → InProgress | 手动开跑（触发该 batch 重派，由 scheduler 做依赖门） |
| Pending → Cancelled | 取消 |
| InProgress → Completed | 手动标记完成 |
| InProgress → Failed | 手动标记失败（进入恢复） |
| InProgress → Pending | 暂停/收回 |
| Failed → Pending | 重试（等价 `task_retry`） |
| Failed → Cancelled | 取消失败任务 |
| Cancelled → Pending | 恢复（等价重派思路） |

**禁止**：`Completed` / `Cancelled` 除 `→ Pending` 恢复外，禁止拖向其他状态（终态锁定）。其余未列出的组合（如任意 → Completed 直接跳、Pending → Failed）均禁止。

## 8. 命令与事件

- **新增命令** `task_set_status(task_id: String, status: TaskStatus) -> Result<Task, AgentError>`
  - 校验 `is_valid_transition(from, to)`，非法返回 `AgentError { code: "invalid_transition", message }`。
  - `repo.update_status`；`emit("group:task_status_changed", {group_id, task_id, from, to})`。
  - 若 `to == Pending` 且任务属某 `batch_id`：触发 `scheduler.process_batch_entry(group_id, batch_id)`（与 `task_retry` 同构重派）。
  - 遵守 std Mutex 非重入铁律：命令内仅 `update_status`，重派在 `with_conn` 外。
- **事件** `task_status_changed` 加入 `GroupEvent` 联合类型：
  `{ type: "task_status_changed"; group_id: string; task_id: string; from: TaskStatus; to: TaskStatus }`。
- **前端**：`src/services/tauri.ts` 加 `taskSetStatus(taskId, status)`；`eventBus.ts` 订阅 `task_status_changed`；`e2e/helpers/tauriMock.ts` 补 case（避免 headless E2E 崩溃）。

## 9. 边界与异常

- 拖到非法列：前端阻止落位 + toast；后端 `invalid_transition` 防御。
- 依赖未满足的 `Pending → InProgress`：**允许**改状态并触发 `process_batch_entry`，真正执行由 scheduler 在 `process_batch` 时做依赖门（统一重派路径，不重复实现依赖逻辑）。
- 并发：`task_set_status` 命令体内仅 `update_status`，不嵌套 `with_conn`。
- 卡死任务：看板显示红点，建议「重试/改派」。

## 10. 成功指标

- 看板加载 < 300ms（复用已加载 `allTasks`，无额外请求）。
- 拖拽 → 状态变更端到端 < 500ms（本地 SQLite）。
- 调度推进时卡片在事件到达后即时流动（无需手动刷新）。
- 无障碍：键盘可从任意卡移动到任意列并改状态。

## 11. 待确认决策（请评审拍板）

- **D1 标签命名**：新增 `kanban` 标签「看板」，`board` 标签重命名为「黑板」。（推荐）
- **D2 依赖门**：手动 `Pending → InProgress` 不强制依赖满足，改状态后由 scheduler 在 `process_batch` 时判定。（推荐）
- **D3 终态**：`Completed`/`Cancelled` 是否允许拖回 `Pending`？本文档建议允许（恢复语义）。（推荐）
- **D4 前端类型**：是否补 `last_heartbeat`/`capability`？建议补（卡死展示 + 能力展示）。（推荐）
