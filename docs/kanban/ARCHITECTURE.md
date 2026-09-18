# OneDesktop 看板（Kanban）架构设计

> 状态：架构稿 v1 ｜ 关联 `docs/kanban/PRD.md` / `docs/kanban/UI.md`

---

## 1. 设计原则

- **复用优先**：不改变 `Task` 模型与 `TaskBoardRepository`；新增极小命令面（1 命令 + 1 事件）。
- **调度主导**：`task_set_status` 只改状态 + 必要时触发既有 `process_batch_entry` 重派；绝不复制依赖门逻辑。
- **零新增依赖**：拖拽用原生 HTML5 DnD + 键盘；不引入 dnd-kit 等库（保持包体小、可控）。
- **事件驱动刷新**：看板是 `allTasks` 的投影视图，靠事件总线增量刷新，不轮询。
- **前后端同规则**：转移校验纯函数两端一致，前端拦截 + 后端防御。

## 2. 数据流

```
                 ┌─────────────────────────────────────────────┐
                 │  GroupsPage (已有 allTasks = batches.flat()) │
                 └───────────────────┬─────────────────────────┘
                                     │ 进入 kanban 视图
                                     ▼
                          ┌──────────────────────┐
                          │  KanbanBoard         │  props: tasks(allTasks)
                          │  - 按 status 分列     │  workers, resolveName,
                          │  - 过滤/搜索          │  onRetry/Reassign/Skip
                          │  - 拖拽/键盘          │  (复用 GroupsPage handler)
                          └───┬──────────┬───────┘
                  拖拽落列    │          │ 点击
                              ▼          ▼
                   taskSetStatus(id,to)   KanbanDrawer
                              │
                              ▼
              ┌──────────────────────────────────┐
              │ 后端 task_set_status 命令          │
              │  1. is_valid_transition(from,to)? │
              │  2. repo.update_status            │
              │  3. emit task_status_changed      │
              │  4. if to==Pending: 触发重派       │
              └──────────────┬───────────────────┘
                             │ event
                             ▼
              ┌──────────────────────────────────┐
              │ 前端 eventBus: task_status_changed│
              │ + task_reset + group-event        │
              │ → loadDetail(activeGroupId)       │
              │ → batches 重拉 → allTasks 变 → 看板重渲 │
              └──────────────────────────────────┘
```

## 3. 后端改动

### 3.1 转移校验纯函数（新增 `src-tauri/src/group/task_board.rs`）
```rust
/// 看板人工转移白名单。scheduler 自动转移不在此约束（那是业务引擎职责）。
pub fn is_valid_transition(from: &TaskStatus, to: &TaskStatus) -> bool {
    use TaskStatus::*;
    matches!((from, to),
        (Pending, InProgress) | (Pending, Cancelled)
      | (InProgress, Completed) | (InProgress, Failed) | (InProgress, Pending)
      | (Failed, Pending) | (Failed, Cancelled)
      | (Cancelled, Pending)
    )
}
```
单测覆盖每条允许边 + 典型禁止边（`Completed→InProgress`、`Pending→Failed`、`InProgress→Cancelled` 等）。

### 3.2 命令 `task_set_status`（`commands/group.rs`）
```rust
#[tauri::command]
pub async fn task_set_status(
    gdb: State<'_, DbConnection>,
    scheduler: State<'_, Arc<TaskScheduler>>,
    task_id: String,
    status: TaskStatus,
) -> Result<Task, AgentError> {
    let repo = TaskBoardRepository::new(gdb.db.as_ref());
    let cur = repo.find_by_id(&task_id).map_err(|e| AgentError::internal(e.to_string()))?
        .ok_or_else(|| AgentError::not_found("task"))?;
    if !is_valid_transition(&cur.status, &status) {
        return Err(AgentError::invalid_transition(&cur.status, &status));
    }
    repo.update_status(&task_id, status.clone())?;           // with_conn 内仅此一行
    emit("group:task_status_changed", json!({
        "type":"task_status_changed","group_id":cur.group_id,
        "task_id":task_id,"from":cur.status,"to":status
    }));
    if status == TaskStatus::Pending {
        if let Some(bid) = cur.batch_id {
            let _ = scheduler.inner().clone()
                .process_batch_entry(&cur.group_id, &bid).await;
        }
    }
    repo.find_by_id(&task_id).map_err(|e| AgentError::internal(e.to_string()))?
        .ok_or_else(|| AgentError::not_found("task"))
}
```
- `AgentError` 已有 `{code, message}` 序列化（error.rs）；新增 `invalid_transition` 构造（code=`"invalid_transition"`）。
- 遵守 std Mutex 非重入铁律：`update_status` 在 `with_conn` 内；`process_batch_entry` 在 `with_conn` 外。

### 3.3 事件类型（`types` 与 `eventBus`）
- `src/types/index.ts` `GroupEvent` 增加：
  `{ type: "task_status_changed"; group_id: string; task_id: string; from: TaskStatus; to: TaskStatus };`
- 前端 `eventBus.ts` 增加 `subscribeToTaskStatusChanged`；`GroupsPage` 订阅后调 `loadDetail`。
- `e2e/helpers/tauriMock.ts` 增加 `task_set_status` case（返回 mock Task，含 `from` 推导或简单对象），否则 headless E2E 崩溃。

## 4. 前端改动

### 4.1 类型（`src/types/index.ts`）
`Task` 补 `last_heartbeat?: number | null; capability?: string | null;`

### 4.2 服务层（`src/services/tauri.ts`）
```ts
export async function taskSetStatus(taskId: string, status: TaskStatus): Promise<Task> {
  return invoke("task_set_status", { taskId, status });
}
```

### 4.3 组件（新增 `src/components/groups/parts/`）
- `KanbanBoard.tsx`：分列容器、过滤/搜索状态、拖拽落列处理、实时刷新订阅（或沿用 GroupsPage 已订阅的 `loadDetail`）。
- `KanbanCard.tsx`：卡片渲染 + `draggable` + 键盘 `Shift+方向键` + 点击开抽屉 + 卡死/重试标识。
- `KanbanDrawer.tsx`：详情抽屉，复用 `DeliverableDetailDrawer` 思路与 `TaskRecoveryPanel` 的恢复动作 UI。
- 导出加入 `parts/index.ts`。

### 4.4 图标（`src/components/common/Icons.tsx`）
新增 `Kanban` 三列单色 SVG（`currentColor`）。

### 4.5 i18n（`src/i18n/dict.ts`）
新增 `groups.kanban.*`：`title`(看板)、`colPending/InProgress/Completed/Failed/Cancelled`、`filterBatch/filterWorker/search`、`empty`、`stale`、`invalidMove`、`dependsOn`、`outputs`、`cancelBatch` 等；`groups.board.title` 改为「黑板」。

### 4.6 样式（`src/components/groups/groups.css`）
新增 `.kanban-*`（列、卡、角标、抽屉、状态条、空态骨架），全部用 `App.css` 令牌；暗色仅重写令牌。

### 4.7 接入（`GroupsPage.tsx`）
- `MainView` 增加 `"kanban"`。
- 工具栏加「看板」按钮（`Icons.Kanban`），`board` 按钮 title 改为「黑板」。
- `view === "kanban"` 分支渲染 `<KanbanBoard tasks={allTasks} workers={workers} resolveName={resolveName} onRetry onReassign onSkip />`，复用已有 `handleTaskRetry/Reassign/Skip`。
- 订阅 `task_status_changed` / `task_reset` / `group-event` 触发 `loadDetail`（与现有 `task_reset` 处理同构扩展）。

## 5. 文件清单

**后端**
- `src-tauri/src/group/task_board.rs`（+`is_valid_transition` + 单测）
- `src-tauri/src/commands/group.rs`（+`task_set_status` + `AgentError::invalid_transition` 调用）
- `src-tauri/src/error.rs`（+`invalid_transition` 构造，若尚未有）
- `src-tauri/src/types`（若 GroupEvent 派生自 Rust 类型，同步）

**前端**
- `src/types/index.ts`（Task 补字段；GroupEvent 补变体）
- `src/services/tauri.ts`（taskSetStatus）
- `src/services/eventBus.ts`（订阅 task_status_changed）
- `src/components/groups/parts/{KanbanBoard,KanbanCard,KanbanDrawer}.tsx`
- `src/components/groups/parts/index.ts`（导出）
- `src/components/common/Icons.tsx`（Kanban 图标）
- `src/components/groups/GroupsPage.tsx`（MainView + 标签 + 分支 + 事件订阅）
- `src/i18n/dict.ts`（groups.kanban.* + board 更名）
- `src/components/groups/groups.css`（kanban 样式）

**测试 / Mock**
- `src-tauri/src/group/task_board.rs`（转移校验单测）
- `e2e/helpers/tauriMock.ts`（task_set_status case）

## 6. 测试策略

- **后端单测**：`is_valid_transition` 边覆盖（允许 9 边 + 禁止典型边）；`task_set_status` 合法转移落库 + 非法返回 `invalid_transition`；`to==Pending` 触发重派（用 scheduler 测试桩）。运行 `cargo test --lib group::`。
- **前端类型**：`npm run check:ts` 全过。
- **E2E Mock 同步**：`tauriMock.ts` 补 `task_set_status`，跑既有 `e2e/specs/` 确认无 `for...of undefined` 崩溃；新增一个看板拖拽场景（若基线允许）。
- **手动验证**：`npm run tauri dev`，进群 → 看板标签 → 拖拽 Failed→Pending 触发重试、拖拽 Pending→InProgress 手动开跑、刷新后卡片归位。

## 7. 风险与对策

- **事件风暴**：`process_batch_entry` 重派可能批量 emit；前端 `loadDetail` 去抖（300ms）避免抖动。
- **乐观更新回滚**：拖拽后立即乐观改 `batches`，`loadDetail` 失败则回滚（保留原 `batches` ref）。
- **依赖门语义**：手动 `Pending→InProgress` 不强制依赖满足，由 scheduler 在 `process_batch` 时判定（与 retry 路径一致），不在看板重复实现。
