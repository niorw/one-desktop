# ADR-023: 会话事件日志（session_events）收敛真相源

## Status

Proposed（2026-08-20）

## Context

同一轮 Agent 运行的记录目前被撕成三套，由 engine 散点写入、无一致性保障：

1. **messages 表**（喂 LLM 的真相源）：engine/engine_toolrun/engine_history 共 **7 处 `add_message` 调用，全部 `let _ =` 吞错**——写失败静默，下一轮 LLM 读到的是缺行历史；
2. **AgentEvent 流**（UI 推送）：经 `RunObserver` 端口发射，发完即弃，`seq` 只作排序辅助；
3. **run_steps 账本**（insight 数据底座）：写入点唯一（`RunLedger` 端口），但与 messages 之间无事务、无校验。

已发生的真实故障：**悬挂 tool_calls**（run 中断时 assistant 消息含 tool_calls 但缺 tool result → DeepSeek 400）。修 bug 是打补丁；结构性根因是「事件发射、消息存储、账本写入」三者各自为政。

参照系（DeepSeek Harness / dsh，2026-08 开源）：
- Session 是**仅追加日志**，唯一真相源；LLM 消息历史、Trace UI、指标**全部从日志派生**；
- 硬规则「**Model-Visible ⟺ Logged**」：任何到达模型请求的内容必须能从日志重建，运行时有 log-reconstruction desync 断言；
- 事件二分：**持久会话事件**（进日志）vs **瞬态 agent/\* 事件**（观察/拦截用，不进日志）——Token 流这类高频事件不落库。

## Decision

**方案 A：最小手术**——新增 append-only `session_events` 表作为持久事实的唯一真相源；messages 降级为投影；run_steps 维持现状。不采用 dsh 的「LLM 历史每次从日志实时投影」（读路径仍直读 messages，性能与简单性保留），只取其「先记事实、再派生视图 + 不变式校验」的结构性免疫。

### 1. 表结构（migration 0005，additive）

```sql
CREATE TABLE IF NOT EXISTS session_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    run_id      TEXT,                      -- 关联 runs.id（nullable：压缩摘要等非 run 事件）
    seq         INTEGER NOT NULL,          -- 会话内单调递增（见 invariant I3）
    kind        TEXT NOT NULL,             -- 事件类型（见下方词汇表）
    payload     TEXT NOT NULL,             -- JSON：与 AgentEvent 对应字段的超集
    created_at  INTEGER NOT NULL           -- unix ms
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sevt_session_seq ON session_events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_sevt_run ON session_events(run_id);
```

**持久事件词汇表**（`kind`）——只记「重启后仍需存在的事实」：

| kind | payload 要点 | 对应现状 |
|---|---|---|
| `run_begin` | run_id, kind, model, seat_id | runs 行创建 |
| `user_message` | content | messages(user) |
| `assistant_message` | content, reasoning, usage | messages(assistant) 终稿（Done 时落，非逐 token） |
| `thinking` | thought_id, content | 思考段落（含意图行） |
| `tool_call` | call_id, tool_name, args | AgentEvent::ToolCall + messages |
| `tool_result` | call_id, outcome, content, is_error, unavailable_reason | AgentEvent::ToolResult + messages |
| `approval` | approval_id, decision, source, risk | run_steps 的审批列 |
| `summary` | content, msg_count 游标 | session_summaries（compaction） |
| `run_end` | run_id, stop_reason, usage, iterations | runs 终态 |

**明确不进日志**：`Token`/`ThinkingDelta` 流式分片（高频瞬态，终稿由 `assistant_message`/`thinking` 承载）、`TodoUpdate`（派生 UI 状态）、`Notice`（提示性）。这与 dsh 的 session/event vs agent/* 二分一致。

### 2. 写入点收敛：`SessionRecorder` 端口

engine 内 7 处 `add_message` + ledger 写入 + observer 发射，收敛为单一入口（内核新端口，`agent/ports.rs` 旁）：

```rust
#[async_trait]
pub trait SessionRecorder: Send + Sync {
    /// 唯一写入点：先追加事件（真相），再投影 messages，事务包裹；
    /// 任一失败即返回 Err——消灭 `let _ =` 吞错。
    async fn record(&self, ev: SessionEvent) -> Result<(), AgentError>;
    /// 瞬态事件旁路（Token 流等，不落库，仅 observer 转发）。
    async fn emit_transient(&self, ev: AgentEvent);
}
```

写入顺序契约：**事件先落、投影后写、两者同事务**（SQLite 同连接 `BEGIN IMMEDIATE`）。投影失败 = 整个事务回滚 = 事件也没写 = 下一轮恢复逻辑看到的是「这步从未发生」，比「发生了但半个记录」安全（fail-closed）。

实现要点：
- recorder 内部持有 pending call_id set，写入时增量断言 invariant（见 §3）；
- `RunObserver` 的 UI 事件发射移到 recorder 内（投影成功后发），保证「UI 看到的必有日志」；
- engine_toolrun 的 7 处调用改为 `deps.recorder.record(...)`，错误上抛走既有 `StopReason::LlmError`→新增 `StorageError` 分支。

### 3. 三条 invariant（写入时增量断言 + 启动校验）

| # | 不变式 | 检查点 |
|---|---|---|
| I1 | **同 run 内 `tool_call` 与 `tool_result` 按 call_id 配对**：result 到来时 call 必在 pending set；run_end 时 pending 必空 | 写入时（recorder）+ 恢复时（recover_orphan） |
| I2 | **run 闭合**：每个 `run_begin` 必有同 run_id 的 `run_end`（含 Cancelled/Paused） | 恢复时扫未闭合 run，补 `run_end{stop_reason: "orphan_recovered"}` |
| I3 | **seq 会话内严格单调**（唯一索引天然强制，冲突即事务失败） | 写入时（DB 约束） |

恢复路径顺带修复存量脏数据：recover 时发现悬挂 tool_call（messages 有 tool_calls 无 result）→ 按现有修复逻辑补 tool result，同时落对应 `tool_result` 事件对齐两侧。

### 4. 三步迁移（每步独立可发布、可回滚）

**Step 1 — 双写观察（1 个版本）**
- migration 0005 建表；`SessionRecorder` 上线，engine 写入点切换；
- 读路径完全不动（LLM 仍读 messages，insight 仍读 run_steps）；
- 验收：全量单测 + E2E 绿；新增校验查询「同 run 的 events 与 messages 行数/内容 diff 为空」跑一周（dev 自用节奏可缩短），diff 报警即回滚开关（`app_config` 加 `session_events_enabled=false` 直切旧路径）。

**Step 2 — 恢复与审计切事件源**
- `recover_orphan` / 中断恢复 / 交付物 trace 改读 session_events（单一来源，不再比对三套）；
- 新增 `rebuild_messages(session_id)` 维护命令：从 events 重放投影（messages 损坏时自愈，替代手工 SQL 修数）。

**Step 3 —（可选，验证期后）messages 读路径降级为纯缓存**
- LLM 历史组装改走 events 派生（可缓存）；messages 表仅作兼容读。**此步收益（-1 张表）小于风险，默认不做**，留待有真实性能数据再定。

### 5. 测试策略

- 单测：recorder 事务性（投影失败→事件回滚）、I1/I2/I3 各自的正反例、rebuild_messages 与 add_message 幂等等价；
- 集成：沿用 `integration_test` 风格，断言「run 完成后 events 重放 == messages 现状」（这就是 dsh desync 检查的测试态版本，先在 CI 兑现）；
- E2E：现有 54 条零改动应全绿（读路径未动）；新增 1 条「kill -9 后重启，会话可继续不 400」。

## Consequences

**变容易的**：
- 悬挂 tool_calls / 缺行历史一类「三套记录失配」bug 从「修不完」变「不可能」（事务 + invariant）；
- 恢复、trace、审计单一来源；`rebuild_messages` 提供自愈能力；
- 为后续 P1（steer 通道、群层消费事件流）铺了底座——group 层轮询可换事件驱动；
- 轨迹级评估（轨迹成功率/工具成功率）从此有免费数据地基。

**变难的**：
- 每次持久写入多一条事件行（存储 +~40%；单机 SQLite 无压力，换来的是一致性）；
- engine 写入点改造涉及 7 处 + 事务语义，需要一轮完整回归；
- 新增端口与词汇表是长期契约，kind 命名要一次定准（错误命名会变成永久方言）。

**明确不做的**（防止过度工程）：
- 不做 LLM 历史实时投影（Step 3 默认不执行）；
- 不做事件 schema 版本迁移框架（单机单用户，`SESSION_FORMAT_VERSION` 式的前瞻没必要，payload 存 JSON 已留了宽松度）；
- 不做插件化事件管道（dsh 的 waterfall/monotonic guards 全套）——审批四态 Broker 已覆盖安全需求。

## 关联

- 根因分析见 2026-08-20 后端架构评审（会话记录）；
- 前置既有事实：ADR-018（skill 预算）、ADR-022（消息排队）不受影响；`RunLedger` 唯一写入点纪律（A-5）被本 ADR 收编扩展到 messages。

## 实现纪要（Step 1 落地，2026-08-20）

**收敛点偏离说明**：原设计新建 `SessionRecorder` 端口；实现时发现 `MessageRepository::create` 已是「messages + agent_trace 镜像」的单一写入拦截点（docs/design/agent-trace-layering.md），把事件追加放在这里手术面小一个数量级（engine 8 处调用点零结构改动，仅消灭 `let _ =` 吞错）。事务为该闭包内显式 `BEGIN IMMEDIATE … COMMIT/ROLLBACK`。

**Step 1 实际落地范围**：
- migration 0005（含 `call_id` 冗余列——I1 断言走普通索引，不依赖 SQLite JSON1）；
- `derive_event()`（payload → 4 种消息域 kind：user_message / assistant_message / tool_call / tool_result；其他 role 不落事件）+ `append_session_event()`（seq 分配 + I1 观察期告警 + I3 唯一索引强制）；
- engine 8 处 `let _ = add_message` → `if let Err(e) = … tracing::error!`（消灭吞错观测）；
- run_begin/run_end 事件**暂不落**（runs 表 RunLedger 已是唯一写入点，无失配问题；Step 2 恢复逻辑接入时再补 payload 关联）；
- I1 为观察期语义（warn 不阻断），Step 2 收紧为硬失败；回滚开关以 git revert 承担（单人 dev 节奏，未做运行时 config 开关）。

**验证**：cargo check / check:kernel 通过；`cargo test --lib` **381 passed**（新增 4 测试：seq 单调、kind 派生、events↔messages 行对齐、未知 role 跳过）；运行库 user_version=5 迁移生效。

## 实现纪要（Step 2 落地，2026-08-20）

**新增模块 `storage/session_event_repo.rs`**：
- `rebuild_messages(session_id)`：从事件重放投影（DELETE messages + agent_trace → 逐事件 `insert_message_and_trace` 重建，单事务）。**不落新事件**——事件是真相，投影不能反向再造（否则循环放大）。为此把 create() 的消息+trace 写入拆出共享函数 `insert_message_and_trace`。
- `heal_pending_tool_calls()`：**启动自愈**（挂在 lib.rs 恢复链，紧随 `recover_orphan_dag_tasks`）——扫描两侧悬挂 tool_call 取并集：events 侧（有 tool_call 事件无 tool_result 事件）+ **messages 侧存量**（迁移前的旧悬挂，事件表里没有）；逐个经 `create()` 补占位 tool_result（同步落事件，I1 配对闭环，存量悬挂从此纳入事件管理）。幂等。

**语义升级**：Step 1 前的防护是内存态消毒（`sanitize_tool_messages`，发给 LLM 前修）；Step 2 起变为落库态修复——修完即持久，下次读历史天然干净。kill -9 后重启，启动链自动闭环。

**验证**：`cargo test --lib` **384 passed**（+3：rebuild 投影等价复原、heal 双侧配对归零+幂等、legacy 存量悬挂覆盖）；check:kernel 通过；dev 新内核重启（启动自愈已挂载）。

**Step 3 候选（默认不做，有真实需求再启动）**：LLM 历史读路径切事件源 / messages 降纯缓存；I1 观察期告警收紧为硬失败（先积累一段观察期告警数据）；run_begin/run_end 事件补充（runs 表 RunLedger 已可靠，收益有限）。
