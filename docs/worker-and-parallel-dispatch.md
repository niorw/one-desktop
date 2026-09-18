# 研究结论：Worker 概念与多 Agent 并行任务分配

> 基于《Agent群协作系统-技术架构文档》与《Agent群协作系统-需求文档》两份材料。
> 结论：文档里 Worker 与"多 Agent 同时分配任务"都已有雏形，但都偏"聊天驱动、弱结构"。
> 本文给出把二者做成一等公民（first-class）的设计与落地改动点。

---

## 一、现状盘点：文档里已经有什么

### 1. Worker 概念（已存在，但不完整）

- `GroupManager::create_group` 已接收 `worker_agent_ids: Vec<String>`，并生成 `AgentRole::Worker` 快照。
- `Group` 结构里 `members: Vec<AgentSnapshot>`，每个 member 带 `role: AgentRole`（Owner / Worker）。
- `TaskBoard::Task` 有 `assigned_to: String`（worker instance_id）、`status`、`depends_on`。
- Owner 模式里，群主通过 `@Worker` 自然语言派活，`dispatch_to_mentioned` 遍历 mentions 逐个 `invoke_agent`。

**缺口**：Worker 只是成员的一个"角色标签"，没有独立的运行时实体、状态机、能力画像、容量/并发控制。`TaskBoard.assigned_to` 是裸 id，无法表达"worker 现在忙不忙""能接几个任务""擅长什么"。

### 2. 多 Agent 同时分配（已有雏形，但靠聊天驱动）

- Owner 在一条消息里 @ 多个 Worker → `dispatch_to_mentioned` 对**每个 mention 都 spawn 一个 tokio 任务** → 天然并行。
- `dispatch_broadcast`（平权）是多 Agent 并行但**竞速只留一个赢家**（`wait_first_success`），不是 fan-out。
- ❌ 没有结构化的"批量派活 API"：分配完全依赖群主 LLM 是否正确地在一条消息里 @ 多个人、是否写对了任务描述。
- ❌ 没有 join/聚合触发：所有 Worker 完成后，要靠群主"看到"再手动验收，没有"子任务全部完成 → 自动触发聚合"的机制。
- ❌ 依赖关系只存在于文档描述（群主心里记着）。`TaskBoard` 有 `depends_on` 字段，但**没有调度器去消费它**。

---

## 二、如何增加 Worker 概念（把它做成一等公民）

核心思路：**把 Worker 从"成员标签"升级为"运行时可执行单元"**，与 Agent（静态能力快照）解耦。

### 2.1 新增实体 `Worker`

```rust
// src-tauri/src/group/worker.rs
#[derive(Debug, Clone)]
pub struct Worker {
    pub worker_id: String,          // = agent instance_id
    pub agent_ref: String,          // 指向 AgentSnapshot
    pub role: AgentRole,            // Worker / Owner
    pub status: WorkerStatus,       // Idle / Busy / Offline
    pub current_task_id: Option<String>,
    pub max_concurrency: usize,     // 默认 1，能力强的可多开
    pub capabilities: Vec<String>,  // 能力标签：["crawl","analyze","write"]
    pub last_heartbeat: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WorkerStatus { Idle, Busy, Offline }
```

### 2.2 新增 `WorkerPool`（群内 worker 注册表 + 选择器）

```rust
pub struct WorkerPool {
    workers: RwLock<HashMap<String, Worker>>,
}
impl WorkerPool {
    // 建群时根据 worker_agent_ids 初始化
    pub async fn register(&self, snapshot: &AgentSnapshot) { /* ... */ }

    // 能力匹配：选一个空闲且具备某能力的 worker
    pub async fn pick(&self, need: &[String]) -> Option<String> { /* ... */ }

    // 占用 / 释放
    pub async fn acquire(&self, id: &str, task_id: &str) { /* ... */ }
    pub async fn release(&self, id: &str) { /* ... */ }

    pub async fn idle_workers(&self) -> Vec<Worker> { /* ... */ }
}
```

- `GroupContext` 增加 `worker_pool: Arc<WorkerPool>`（平权模式也可有，只是无人"派活"）。
- `create_group` 里把 `worker_agent_ids` 灌进 WorkerPool，而不是只塞进 members。

### 2.3 Worker 状态机

```
Idle ──acquire(task)──▶ Busy ──release()──▶ Idle
  │                        │
  └──offline()──▶ Offline ──online()──▶ Idle
```

- `invoke_agent` 开始时 `acquire`，`task completed/failed` 时 `release`。
- 群主派活前先 `pick()`，避免把任务派给忙的 worker（或允许超过并发上限时排队）。

### 2.4 收益

- 群主"选人"从拍脑袋变成 `pick(capabilities)` 能力匹配。
- `TaskBoard.assigned_to` 现在指向一个有状态、有能力的 Worker，可展示"谁在干嘛"。
- 失败换人：worker 执行失败 → `release` + `pick(同类能力)` 换一个，闭环到 TaskBoard。

---

## 三、如何给多个 Agent 同时分配任务（fan-out + DAG 调度）

文档里"并行派活"靠群主在一条消息里 @ 多人。要**结构化、可追踪、可聚合**，需要三件套：结构化派活 + 依赖调度器 + 等全部的并发执行 + 聚合触发。

### 3.1 结构化派活指令（替代靠聊天 @）

新增一个明确的分配入口（群主调用，或系统代群主调用），不依赖自然语言：

```rust
pub struct SubTask {
    pub worker_id: String,
    pub description: String,
    pub input_refs: Vec<String>,   // 共享空间输入文件
    pub output_spec: String,       // 期望产出
    pub depends_on: Vec<String>,   // 子任务 id
}

pub async fn dispatch_fanout(&self, subtasks: Vec<SubTask>) -> Vec<String> {
    let mut task_ids = Vec::new();
    for st in &subtasks {
        let tid = self.ctx.task_board
            .create(st.description.clone(), st.worker_id.clone(), st.depends_on.clone())
            .await;
        task_ids.push(tid.clone());
        let prompt = self.render_assignment(&st, &tid);
        // 依赖满足才真正 invoke；不满足则留在 Pending，等调度器
        if st.depends_on.is_empty() {
            self.spawn_worker_task(&st.worker_id, prompt, &tid).await;
        }
    }
    task_ids
}
```

### 3.2 任务调度器（消费 depends_on，实现真并行）

`TaskBoard` 已有 `depends_on`，但没人消费。加一个轻量 `TaskScheduler`，在 Dispatcher 里周期性 tick：

```rust
pub async fn tick(&self) {
    let pending = self.ctx.task_board.get_by_status(TaskStatus::Pending).await;
    for task in pending {
        let deps_done = self.ctx.task_board.all_completed(&task.depends_on).await;
        if deps_done {
            self.ctx.task_board.update_status(&task.id, TaskStatus::InProgress).await;
            let worker = task.assigned_to.clone();
            let prompt = self.render_assignment_by_task(&task);
            self.spawn_worker_task(&worker, prompt, &task.id).await;
        }
    }
}
```

- **无依赖的子任务** → `tick` 第一批全部 `InProgress` → `tokio::spawn` 并发 → **同时分配**。
- **有依赖的子任务** → 等依赖 `Completed` 后下一批并发。
- 这就是文档 3.3.4 里"任务②依赖任务①"的机器实现。

### 3.3 并发执行（复用 invoke_agent，换等待语义）

关键区别：`dispatch_broadcast` 用 `wait_first_success`（竞速留一）；fan-out 用 **`JoinSet` 等全部完成**：

```rust
let mut set = JoinSet::new();
for (worker, prompt, tid) in ready {
    set.spawn(async move {
        invoke_agent_streaming(&worker, &prompt, &ctx, &app).await;
        tid
    });
}
while let Some(res) = set.join_next().await {
    let tid = res?;
    ctx.task_board.update_status(&tid, TaskStatus::Completed).await;
}
```

- 每个 worker 是独立 `tokio::task`，天然并行（受 WorkerPool `max_concurrency` 约束）。
- 进度通过现有流式事件回前端，互不阻塞。

### 3.4 Join 点 / 聚合触发（当前架构缺失的关键一环）

所有并行子任务跑完后，需要自动触发群主"验收/聚合"，而不是等群主自己发现：

```rust
// 在 set.join_next 循环结束后
if self.ctx.task_board.all_completed(&batch_task_ids).await {
    let outputs = self.ctx.task_board.get_outputs(&batch_task_ids).await;
    let agg_msg = ChatMessage {
        sender: MessageSender::System,
        content: format!("[子任务全部完成] 请群主整合以下产出：{:?}", outputs),
        mentions: vec![self.owner_instance_id.clone()],
        ..Default::default()
    };
    self.ctx.dispatcher.dispatch(agg_msg).await;  // 群主收到 → 验收/汇报
}
```

- 这样实现文档 3.3.4 Step 5 "群主验收"的**自动触发**。
- 失败时：`get_failed()` 非空 → 群主收到"请处理失败任务"事件，走"换人/重试/上报"。

---

## 四、改动清单（落地到现有模块）

| 模块 | 改动 |
|------|------|
| `group/worker.rs` | **新增**：Worker 实体 + WorkerPool + pick/acquire/release |
| `group/manager.rs` | `create_group` 用 `worker_agent_ids` 初始化 WorkerPool；`switch_mode` 重建角色时同步 WorkerPool |
| `group/context.rs` | `GroupContext` 增加 `worker_pool` 字段；`on_message` 透传 |
| `group/task_board.rs` | 加 `TaskBatch` / `get_by_status` / `all_completed`；`depends_on` 被调度器消费 |
| `group/dispatcher.rs` | 新增 `dispatch_fanout` + `TaskScheduler::tick` + fan-out 等待（JoinSet 等全部） |
| `group/mode_handler.rs` | `OwnerModeStrategy` 增加"结构化派活"分支：识别派活意图 → 调 `dispatch_fanout` |
| 前端 | 任务看板可视化（worker × task 矩阵）、派活表单、"批量分配"按钮 |

---

## 五、一句话总结

- **Worker**：文档已有"角色标签"，要补的是带状态机 + 能力画像的运行时实体（WorkerPool），让"派活选人"可程序化。
- **多 Agent 同时分配**：文档靠群主一条消息 @ 多人实现并行，但要变成可追踪、可聚合，需要"结构化 `dispatch_fanout` + 消费 `depends_on` 的调度器 + 等全部的 JoinSet + 子任务完成自动触发群主验收"四件套。
