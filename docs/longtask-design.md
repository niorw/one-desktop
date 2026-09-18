# OneDesktop 长任务技术设计稿（最终版）

> 定位：**单机个人办公助手**（非多租户 / 非服务端 / 非分布式）。
> 本稿为唯一权威设计依据，整合并取代此前散落的 `longtask-mvp.md` / `longtask-mvp-review.md` / `longtask-resume-protocol.md`（已删除）。
> 代码事实均已回源核对（`file:line` 标注）；G5 产品决策已由用户于 2026-08-07 拍板（§13）。

---

## 1. 概念与边界（先读这节，避免重蹈混淆）

- **task = 普通固定执行 job**（跟一个定时提醒任务一样简单）：一次触发跑一次，有触发记录、进度展示、可暂停。它是**顺序执行体，不是 state machine，也不是 graph**。
- 必须区分两层：
  - **Job 执行原语（本稿范围）**：`scheduled_tasks`（job 定义：触发方式/参数/超时）+ `runs`/`run_steps`（每次触发的执行实例）。长任务能力只加在这对上。
  - **群 DAG 编排层（本稿不碰）**：`tasks`/`SubTask`+`depends_on`+`group/scheduler.rs::process_batch` 是多 agent 协作的编排图，是「调度多个 job 的组合层」。它将来可作为 job 的调用方，但本稿不改它、不往它加列。
- 单 job 的**生命周期状态**（New/Running/Ok/Failed/Stopped，本稿加 Paused/Interrupted 用于 pause·resume·崩溃恢复）是普通执行实例状态，不是 FSM/graph 概念。
- 三层正交原则：执行原语（job）⟂ 编排（graph，群 DAG）⟂ 工作流（可选 FSM）。长任务只交付执行原语；graph/FSM 是调用方。

## 2. 现状事实（缺口依据）

- 两条相关执行路径：聊天单轮（`commands/agent.rs` 直接 `await`，无任务实体）、定时任务（`scheduled_tasks` + `scheduler/engine.rs`）。
- 引擎硬上限 `DEFAULT_MAX_ITERATIONS=20`（`engine.rs:36`）× `ITERATION_TIMEOUT_SECS=120s`（`:38`）；token 预算 `DEFAULT_TOKEN_BUDGET=100k`（`:37`）。
- `runs.status` 现有枚举：`Running|Ok|Failed|Cancelled|Timeout`（`ledger.rs:38-45`）——**Ok≠success，且已有 Timeout**。
- `RunLedger`：`begin`/`finish` 同步写，`step` 走 mpsc 异步批量 best-effort 通道（`ledger_sqlite.rs:7-8,160-190`）。
- 工具结果**逐轮落库 session**（`engine_toolrun.rs:131-137,457-465`）→ 续跑可带全上下文（重建式续跑的前提）。
- `build_messages` 每次 `run()` 无条件追加 user_message（`engine_history.rs:140-150`）→ resume 必须跳过，否则重复追加。
- `build_messages` 尾部已有**悬挂 tool_call 补全**（`engine_history.rs:165-217`）→ resume 自动复用，崩溃窗口语义天然落位。
- 调度器：每个 due tick spawn `execute(task)`，`next_run_at` 执行**完成后**才重算（`scheduler/engine.rs:84-189`）→ 长 job 会被 cron 并发重复触发。
- 迁移机制：已有「PRAGMA table_info → ALTER TABLE ADD COLUMN」先例（`connection.rs:674-716`）→ 复用，不新造。
- 前端 `useScheduledTasks` mount 仅拉一次、无订阅（`useScheduledTasks.ts:92-94`）。群侧已有恢复面板 `TaskRecoveryPanel.tsx` 可复用 UI 模式。

## 3. 目标与非目标

**目标**（三件事）：
1. job 进度可见（progress 列 + 实时事件 + 前端订阅）；
2. 引擎 checkpoint + 启动 recovery（跨重启续跑）；
3. 单 job pause/resume（替代不可逆 cancel）。

**非目标**：sidecar/daemon/分布式队列、群 DAG 改造、显式 FSM 引擎、工具级去重（后续增强，§10）。

## 4. 数据模型（表改动）

**迁移**：复用既有 PRAGMA+ADD COLUMN 模式（`connection.rs:674-716` 同款），逐个 `if !cols.contains(&col)` 加列。

**`scheduled_tasks` 追加：**
```sql
session_id       TEXT;   -- 恢复锚点（scheduler 触发时同步写，见 §7）
last_run_id      TEXT;   -- 信息性：最近一次 run id（run 结束后补写）
progress         REAL    NOT NULL DEFAULT 0;   -- 0..1 软进度
current_step     INTEGER NOT NULL DEFAULT 0;
total_steps      INTEGER NOT NULL DEFAULT 0;   -- 0 = 未知（自由形态）
checkpoint_json  TEXT;   -- 引擎可续跑快照 {"iteration":N,"tokens_used":M,"ts":...}
total_tokens_used INTEGER NOT NULL DEFAULT 0;  -- job 级预算/成本累计
started_at       TEXT;
finished_at      TEXT;
```
状态新增：`running`（执行中）、`interrupted`（崩溃待恢复）。**注意**：`paused` 已存在（`TaskStatus::Paused` = 任务暂停不触发，与执行中挂起是两个语义，见 §6.2）。

**`runs` 追加：**
```sql
job_id           TEXT;   -- 审计链/成本归集（A3）：scheduled 来源填 scheduled_tasks.id；chat 来源为 NULL
source           TEXT NOT NULL DEFAULT 'scheduled';  -- 'scheduled' | 'chat'，区分执行来源（方案 A）
attempt_no       INTEGER NOT NULL DEFAULT 1;  -- 该 job 第几次 run（resume 递增）
progress         REAL    NOT NULL DEFAULT 0;
current_step     INTEGER NOT NULL DEFAULT 0;
total_steps      INTEGER NOT NULL DEFAULT 0;
checkpoint_json  TEXT;
```
状态新增：`paused`、`interrupted`。
注意：`runs` 表本已含 `session_id`（§7 反查用）。scheduled 来源的 `runs.session_id` = `scheduled_tasks.session_id`，需经 §7.2 反查；**chat 来源的 `runs.session_id` 即 chat 会话 id 本身，就是恢复锚点，无需反查另一张表**（会话已持久化于 SessionManager）。

**`run_steps`**：不加列；进度时间线审计（append-only）列为后续增强（§11.1）。

### 4.1 实现偏差（已落地，Step 5 实际代码为准）

设计稿原案（§4/§7/§8）有两处与最终实现不同，此处显式记录以免返工：

1. **未新增 `runs.source` 列，复用 `runs.kind` 区分来源。**
   原案拟加 `source TEXT DEFAULT 'scheduled'`（`'scheduled' | 'chat'`）。实际 `runs` 已有 `kind`（取值 `chat|worker|scheduled|roundtable`），语义足以区分执行来源，故**不再加列**。所有原案中按 `runs.source` 分流的逻辑（§7.2 恢复归因、§8.1 resume 入参）一律改为按 `runs.kind` 分流：
   - `kind='scheduled'`：经 `runs.session_id` 反查 `scheduled_tasks.session_id`（恢复锚点）→ 置 `scheduled_tasks.status='interrupted'`。
   - `kind='chat'`：锚点即 `runs.session_id`（chat 会话 id 本身）→ 该会话标记可恢复。
   - resume 入参统一为 `run_id | job_id | session_id`，优先级 `run_id > job_id > session_id`，前端 `JobRecoveryPanel` 直接拿 `ResumableRun`（camelCase）。

2. **进度真源只有 `runs`，`scheduled_tasks` 相关列退化为低频「起止时刻」快照。**
   原案把 `scheduled_tasks.progress/current_step/total_steps` 当作实时进度列。实际实时进度完全由 `runs`（`progress`/`checkpoint_json` + 每轮 `AgentEvent::Progress` → 前端 `useLongTask` 的 `progress` map）承载；`scheduled_tasks` 只保留 `started_at/finished_at/last_run_id` 这类低频状态，不承载逐轮进度。前端 `TaskCard` 的进度条读 `useLongTask().progress[tk.id]`（key = `job_id`），不从 `scheduled_tasks.progress` 拉。

> 这两条偏差已在 Step 5 落地，本设计稿以此注释为权威说明，原案 §4/§7/§8 文字保留供对照，但不作为实现依据。

## 5. 进度可见（第 1 件事）

### 5.1 事件

`types.rs` `AgentEvent` 新增变体（exhaustive match 会强制同步 `ports.rs::topic_of`，补 `"agent:progress"`）：
```rust
Progress {
    session_id: String,
    task_id: Option<String>,   // 定时 job 填 scheduled_tasks.id；纯聊天 None
    step: u32,
    total: Option<u32>,        // 自由形态 None
    progress: f64,             // 0..1
    message: Option<String>,   // 当前在做什么
},
```
经 `RunObserver.on(ev, true)` 双发（`ports.rs:44-58`，统一通道 + agent-event）。

### 5.2 落点

`engine_loop.rs` ToolCalls 分支执行完后、循环尾（`:280` 前）发 Progress + 写 checkpoint（§6.1）。`LoopCtx` 加 `task_id: Option<String>`、`total_steps: u32`（经 `RunRequest` 传入）。

### 5.3 前端

- 新增 `hooks/useTaskProgress.ts`：复用 `subscribeToUnifiedEvents`（`eventBus.ts:28`），按 `session_id`/`task_id` 过滤 `agent:progress`。
- `useScheduledTasks.ts` 补订阅：监听 `agent:progress` + `scheduled_task_event`，按 `task_id` 更新 `progressMap`。
- `ScheduledTasksPage` 卡片加细进度条（令牌取 `App.css :root`，禁裸色）；聊天头部显示「第 N 轮」（`useTaskProgress({sessionId})`）。

## 6. Resume 协议（第 2、3 件事的核心，阻断级 A1 修复）

### 6.1 Checkpoint（同步写，A2 已定实现）

```rust
// ledger.rs
#[derive(Clone, Serialize)]
pub struct Checkpoint { pub iteration: u32, pub tokens_used: u64, pub ts: i64 }
pub trait RunLedger { /* …begin/step/finish… */ fn checkpoint(&self, run_id: &str, cp: Checkpoint); }

// ledger_sqlite.rs（仿 finish 同步写，不走 step 异步通道）
fn checkpoint(&self, id: &str, cp: Checkpoint) {
    let json = serde_json::to_string(&cp).unwrap_or_default();
    let _ = self.db.with_conn_mut(|conn| {
        conn.execute("UPDATE runs SET checkpoint_json=?1 WHERE id=?2", params![json, id])
    });
}
```
每轮 ToolCalls 分支后写：`iteration=iteration+1`、`tokens_used=prior_tokens+total_tokens`（job 累计口径）。

### 6.2 续跑语义（重建式续跑）

**核心洞察**：历史回放本身是确定性状态重建（tool_call_seq 重分配、tool 结果按序配对）。resume 不需要序列化 messages，只需三件事：

```rust
// engine.rs
pub resume: Option<ResumePoint>,   // RunRequest 新增
#[derive(Debug, Clone)]
pub struct ResumePoint {
    pub iteration: u32,      // 已完成迭代数（job 级语义）
    pub tokens_used: u64,    // job 历史累计 token
    pub job_id: Option<String>,
}
// G3①：AgentRunOutcome 新增 pub run_id: String（scheduler 写 last_run_id 依赖它）
```

- **`engine_history.rs::build_messages`** 加 `resume: Option<&ResumePoint>`：
  - `None`：现状零变更（追加落库 user_message + 自动命名）；
  - `Some(rp)`：**不追加不落库** user_message，在 `:163` 处（sanitize 之前）注入合成 continue 指令：
    ```rust
    messages.push(ChatMessage::user(&format!(
        "{}  \n（你已执行到第 {} 轮。请基于上方完整工具结果继续完成任务：\
         能直接产出最终结果就立即产出；如需新信息可调用新工具，\
         但不得重新调用结果已在上下文中的工具。）",
        CONTINUE_DIRECTIVE, rp.iteration
    )));
    ```
  - 悬挂 tool_call 补全（`:165-217`）自动复用：崩溃窗口（工具执行后、结果落库前）中断的工具，resume 时注入"被中断"占位——**这是 at-least-once 语义的精确落点**。
- **`engine_loop.rs`**：
  ```rust
  let start_iter = ctx.resume.as_ref().map(|r| r.iteration).unwrap_or(0);
  let prior_tokens = ctx.resume.as_ref().map(|r| r.tokens_used).unwrap_or(0);
  for iteration in start_iter..ctx.max_iters {   // max_iters = job 总上限
      outcome.iterations = iteration + 1;         // job 累计轮数语义
      // 预算检查：prior_tokens + total_tokens >= ctx.budget
  }
  ```
  `max_iters` 取 `max_iterations.unwrap_or(DEFAULT).max(resume.iteration + 1)`。

### 6.3 Pause（两个 Paused 语义，务必区分）

- **`TaskStatus::Paused`（已存在）** = 任务暂停：不再触发调度 → `scheduled_tasks.status='paused'`，UI「暂停任务」开关（`commands/scheduler.rs:74`）。
- **新增 `RunStatus::Paused`** = 执行中挂起：单次运行暂停可续 → `runs.status='paused'`。
- **禁止复用 `TaskStatus::Paused` 表示执行中挂起**——否则 `set_task_paused` 会误伤运行中的 job。
- 实现：`engine.rs` 新增 `pause_rx: watch::Receiver<bool>`（与 `cancel_rx` 并列）；`pause(session_id)` 发 `pause_rx=true` 不发 cancel；`engine_loop.rs` 每轮头（cancel 检查后）检测 → `ledger.checkpoint` → `StopReason::Paused` → break → `finish(RunStatus::Paused)`。
- 暂停延迟上界 = 一个 LLM 调用（≤120s），个人助手可接受。
- `resume_task` 对 `paused`/`interrupted` 任务复用 §6.2 续跑。

## 7. 启动 Recovery（第 2 件事）

`lib.rs` 启动序列（DB open + Scheduler start 后）调用一次 `recover_in_flight_tasks()`，只作用于 job 原语：

1. **孤儿 runs**：`SELECT * FROM runs WHERE status='running'` → 置 `runs.status='interrupted'`（保留 checkpoint_json）。
2. **归因锚点（按 `runs.kind` 分流，方案 A；见 §4.1 偏差）**：
   - `kind='scheduled'`：经 `runs.session_id` 反查 `scheduled_tasks.session_id`（**恢复锚点**，G3②）→ 置 `scheduled_tasks.status='interrupted'`。
   - `kind='chat'`：锚点即 `runs.session_id`（chat 会话 id 本身，会话已持久化于 SessionManager，**无需反查另一张表**）→ 该会话标记可恢复，UI 在聊天头部显示「可继续」。
3. **不自动重启**：UI 弹「可恢复任务」面板（§8.2），用户点「继续」调 `resume_task`——个人助手场景不静默触发长任务。chat 来源的续跑走同一 `resume_task` 路径（`task_id=None`，仅持 `session_id` + `checkpoint`，§8.1）。
4. 群 DAG 的崩溃回收（`tasks`/`workers` Busy 锁）不在本稿（群编排层自理）。

**G3② 锚点修正**：`scheduler/engine.rs::run_agent` 在 `create_session`（`:242-245`）后**立即同步写** `scheduled_tasks.session_id`（崩溃安全）；`last_run_id` 在 `engine.run()` 返回后经 `outcome.run_id` 补写（信息性）。恢复不依赖 last_run_id。
**方案 A 落点（chat 单会话）**：`commands/agent.rs::send_message` 在 `engine.run()` 前后补 `record_run`（写入 `runs`，`source='chat'`，`session_id` = 当前 chat 会话 id）+ 每轮 `ledger.checkpoint`（§6.1）；App 关闭后恢复见 §7.2 的 `source='chat'` 分支。引擎层 resume 协议（§6.2）完全复用，仅锚点来源不同——这正是方案 A 优于方案 B（包装成定时任务）之处：chat 不污染自动化页，执行原语统一收敛到 `runs`。

## 8. 命令层与前端

### 8.1 新命令（`commands/scheduler.rs`，风格对齐现有命令）

- `resume_task(task_id: Option<String>, session_id: Option<String>)` — scheduled 来源传 `task_id`（读 `scheduled_tasks` 的 checkpoint）；chat 来源传 `session_id`（读 `runs WHERE source='chat' AND session_id=?` 的 checkpoint）。两者均组装 `RunRequest{ resume: Some(..), user_message: "" }`（Resume 分支不使用 user_message）；
- `pause_task(task_id)` — 经 `scheduled_tasks.session_id` 调 `engine.pause()`；
- `get_task_checkpoint(task_id)` — 返回 `{iteration, progress, status}`；
- `list_interruptions()` — 恢复面板数据源（`status='interrupted'` 的 job + 关联 run 摘要）。

**铁律**：① 每个命令打 `CmdLog`（`commands/mod.rs:26-105` 审计）；② 每个命令补 `e2e/helpers/tauriMock.ts` mock case（缺省返回 undefined 致渲染崩）；③ `services/tauri.ts` 绑定蛇形全名。

### 8.2 前端

| 文件 | 改动 |
|---|---|
| `types.ts` | `ScheduledTaskDto` 加 `session_id`/`progress`/`current_step`/`total_steps`/`last_run_id`；`TaskStatus` 加 `running\|interrupted`；`ProgressEvent`；`JobRecoveryItem` |
| `hooks/useScheduledTasks.ts` | `TaskStatus` 联合类型扩展（`:14`）；补事件订阅 + `progressMap`（现 mount 仅拉一次 `:92-94`） |
| `components/tasks/ScheduledTasksPage.tsx` | 卡片进度条（令牌取 `App.css :root`）；挂载 `JobRecoveryPanel` |
| `components/tasks/JobRecoveryPanel.tsx` | **复用** `TaskRecoveryPanel` UI 模式（`groups/parts/TaskRecoveryPanel.tsx`）；逻辑：`interrupted` 过滤 + 「继续」→ `resume_task` |
| `i18n/dict.ts` + `I18nProvider` | 恢复面板文案（DictKey，禁硬编码中文） |

## 9. 配置（G5② 已决策）

- 长任务档默认：`max_iterations=200`、`token_budget=500_000`。
- 落点：`scheduler/engine.rs:228-239` 已用 `get_setting("max_iterations"/"token_budget")` 读配置 → ① 默认回退值 `unwrap_or(20)`/`unwrap_or(100000)` 改 200/500000；② Settings 页新增「长任务」配置区写入这两个 settings 键。
- 聊天路径是引擎硬编码 `DEFAULT_MAX_ITERATIONS=20`（`engine.rs:36`），不受影响——各场景设档天然成立。

## 10. 防重放与执行语义（G5①③ 已决策）

- **提示词级（MVP）**：`CONTINUE_DIRECTIVE` 禁止重放结果已在上下文的工具；**允许调用新工具**（G5①）。
- **语义**：MVP 采用 **at-least-once**（G5③ 接受）。崩溃窗口内（工具执行后、结果落库前）中断的工具可能重复执行，由悬挂补全机制承载，产品文档明示。
- **工具级去重（后续增强，非阻塞）**：resume 时从历史构建 `(tool_name, args_digest) → result` 查表（`args_digest` 现成 `ledger.rs:232`），命中跳过执行注入历史结果；仅完全一致才判重。触发条件 = 引入不可逆副作用工具（发邮件/转账类）。

## 11. 审计与可观测性

- **审计链**：`runs.job_id` + `attempt_no`（§4）支撑「某 job 全部历史 run」查询与成本归集（A3）。`run_steps` 已是逐步明细审计（`args_digest` 含敏感打码 F13）。
- **进度时间线（后续增强）**：`checkpoint_json` 是覆盖式（只保最近点）；要事后回放"job 何时到哪步"，需 append-only（`run_steps` 增补 progress 行或新增 `job_progress` 表）。
- **job 级预算视图（后续增强）**：`total_tokens_used` 列已备，聚合查询即可。

## 12. 测试清单

1. 单测（engine_history）：Resume 模式 messages 末尾是 continue 指令、session user 消息数不变；First 模式与现状逐字节一致。
2. 单测（engine_loop）：`start_iter=5, max_iters=20` → 恰跑 15 轮；`outcome.iterations` 终值 20。
3. 单测（ledger_sqlite）：`checkpoint` 同步写后立即读回一致；不触发 step flush。
4. 集成（防重放）：写文件 job，pause 第 3 轮后 resume，目标文件只写一次。
5. 集成（崩溃窗口）：工具执行后、结果落库前中断 → resume 后悬挂补全生效、协议合法（无 400）。
6. 集成（预算延续）：首跑 60k token 后 resume，`total_tokens_used` 从 60k 续。
7. 集成（恢复锚点）：scheduler 触发即写 `scheduled_tasks.session_id`；崩溃后 `list_interruptions` 能列出。
8. 回归：聊天首跑（resume=None）全量行为不变；E2E 无快照 diff。
9. E2E mock：4 命令补 `tauriMock.ts` case（铁律）。

## 13. 决策记录

| 项 | 决策 | 日期 |
|---|---|---|
| task 模型 | 普通固定执行 job（非 FSM/graph）；三层正交 | 2026-08-06 |
| 执行宿主 | App 自身即宿主，启动 recovery，无 sidecar | 2026-08-06 |
| 语言 | 全稿平实表述，不套框架术语 | 2026-08-06 |
| G5-1 | resume 后可调用新工具，但禁止重放已有结果的工具 | 2026-08-07 |
| G5-2 | 默认档 200 轮/500k token，Settings 可配 | 2026-08-07 |
| G5-3 | 接受 at-least-once | 2026-08-07 |
| G3① | `AgentRunOutcome` 加 `run_id` | 2026-08-07 |
| G3② | 恢复锚点 = `scheduled_tasks.session_id`（同步写） | 2026-08-07 |
| 方案 A | chat 单会话长任务纳入 MVP：落 `runs`（`source='chat'`）+ chat session 锚点；resume 协议通用复用，不包装成定时任务 | 2026-08-07 |

## 14. 落地顺序

1. **地基小改动**（可独立落地）：`AgentRunOutcome.run_id`、`ledger_sqlite` 同步 `checkpoint`、表加列迁移（§4）。
2. **Resume 协议**（§6.2）：`build_messages` resume 分支 + `LoopCtx.resume` + 预算延续——先钉死续跑语义。
3. **进度可见**（§5）：`AgentEvent::Progress` + 前端订阅。
4. **pause/resume**（§6.3）：`pause_rx` + `StopReason::Paused` + 两个 Paused 语义落地。
5. **启动 recovery + 命令层**（§7/§8）：`recover_in_flight_tasks`（含 chat 来源，方案 A）+ 4 命令 + 恢复面板；`commands/agent.rs::send_message` 同步补 `record_run`（source='chat'）+ 每轮 checkpoint。
6. **single-flight 阻塞策略**（B1，与 5 并行）：调度器/手动/resume 统一过 job 级锁。
7. **配置档位**（§9）：默认值 + Settings 页。

> 后续增强队列：工具级去重（§10）、进度时间线 append-only（§11）、job 级预算视图（§11）。
