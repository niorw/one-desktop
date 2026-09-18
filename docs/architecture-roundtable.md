# 系统架构设计：OneDesktop Agent 群协作系统（圆桌 Roundtable）

> 版本 v1.0 · 2026-07-31 · 状态：待评审
> 文档定位：**架构蓝图（Architecture Blueprint）**，承接 PRD（`docs/prd-roundtable-group.md`）的"做什么/为什么"，被技术 Spec（`docs/superpowers/specs/2026-07-31-roundtable-group-spec.md`）细化为"怎么实现"。
> 本文不重复写数据模型 / 命令清单 / 测试计划（见 Spec），只回答 **"为什么是这种结构、模块怎么拓扑、关键决策如何权衡、质量属性如何保障、未来如何演进"**。

---

## 0. 本文在文档体系中的位置

```
PRD（产品语言：目标/范围/用户故事）
        │ 承接
        ▼
架构设计（本文：范式/分层/ADR/质量属性/演进）  ◀── 你在这里
        │ 指导
        ▼
技术 Spec（实现语言：模块/数据模型/命令/状态机/测试）
        │ 落地
        ▼
UI 设计 + Mockup（交互语言）
```

三者约束一致、视角不同：PRD 锁定"价值边界"，本文锁定"结构边界"，Spec 锁定"实现边界"。

---

## 1. 架构目标与质量属性（非功能需求）

架构决策以这些质量属性为优先级排序（从高到低）：

| 优先级 | 质量属性 | 含义 | 在架构中的体现 |
|--------|----------|------|----------------|
| P0 | **零侵入（Isolation）** | 群模块故障/升级不影响单 Agent 核心 | 群是 opt-in 并列入口；复用 `AgentLoopEngine::run` 而非 fork 引擎 |
| P0 | **治理可审计（Governance）** | 谁派活、谁执行、谁验收全程可追溯 | 事件日志 + 双状态机（群/任务）+ 人类在环 |
| P1 | **确定性可复现（Determinism）** | 派活/调度/join 不依赖 LLM 随机性 | 控制面（LLM）与数据面（确定性调度器）分离 |
| P1 | **故障隔离（Fault Isolation）** | 单个 worker / 群崩溃不污染全局 | per-worker session + per-worker 沙箱 + 资源 RAII |
| P1 | **可观测（Observability）** | 并行度/失败率/泄漏实时可见 | 复用 AtomicU64 Metrics + 群级事件日志 |
| P2 | **可演进（Evolvability）** | 跨群/混合模式未来可加不重构 | 数据面独立成层，预留跨群接口 |

> 关键取舍：**治理与确定性优先于灵活度**。这正是前面锁定的"角色治理为纲、三席位全支持、混合编排"在架构层的落地——灵活度通过"数据面独立"事后补足，而非牺牲治理换灵活。

---

## 2. 架构范式（为什么选这种结构）

### 2.1 主范式：控制面 / 数据面分离（参考 SDN、K8s Controller-Worker）

把"**决策/意图的产生**"（非确定性，LLM）与"**意图的执行/编排**"（确定性，状态机）拆成两个平面：

- **控制面**：群主 LLM（拆解需求、产出 SubTask、最终验收）。非确定性、token 重、可成为瓶颈。
- **数据面**：WorkerPool + TaskScheduler + TaskBoard + WorkspaceManager。确定性、无 LLM、可并发、可复现。

> 这一选择直接化解 PRD R2/R4 与文档现状的两大风险：**群主 LLM 成瓶颈 / prompt 超 token**。fan-out 与 join 的执行不再过群主 LLM。

### 2.2 编排范式：混合编排（Hybrid Orchestration）

```
群主 LLM  ──只做──▶  拆解（非确定性判断） + 最终验收（非确定性判断）
确定性调度器 ──只做──▶  fan-out（并发派活） + join（等全部完成） + 触发验收
```

这区别于两种极端：
- **纯 LLM 编排**（群主逐轮 `@`）：灵活但瓶颈、不可复现、并行度受限 → 否决。
- **纯自主 Agent 网络**（worker 自协商）：灵活但治理真空、不可审计 → 与 NG3（仅群主模式）冲突，否决。

混合编排 = "非确定性判断交给 LLM，确定性执行交给状态机"，是治理与效率的平衡点。

### 2.3 协作范式：中心化规划 + 分布式执行

- 规划权**唯一**收敛于群主（中心化），执行权**分散**于各 Worker（分布式）。
- 这是 PRD NG3"仅群主模式、规划/执行分离"的架构承诺。

---

## 3. 系统分层与模块拓扑（C4：容器 → 组件）

### 3.1 分层视图

```
┌─────────────────────────────────────────────────────────────────────┐
│                      OneDesktop 应用（Tauri 2.x）                       │
│                                                                       │
│  ┌─────────────────────── 控制面（Control Plane）──────────────────┐ │
│  │  群主 LLM（拆解 / 验收）    Dispatcher    ModeHandler            │ │
│  │  （聊天消息流，不变）      （识别派活意图）（群命名空间路由）     │ │
│  └───────────────────────────────┬───────────────────────────────┘ │
│                                   │ SubTask[]（结构化意图）           │
│  ┌───────────────────────────────▼ 数据面（Data Plane）──────────┐ │
│  │  GroupManager   WorkerPool   TaskScheduler   TaskBoard         │ │
│  │  （群状态/路由） （席位/状态机） （depends_on/join） （DAG+批） │ │
│  │  WorkspaceManager（目录/沙箱/只读）                             │ │
│  └───────────────────────────────┬───────────────────────────────┘ │
│                                   │ run(session) / cancel / approve   │
│  ┌───────────────────────────────▼ 核心引擎（Reused, 零侵入）────┐ │
│  │  AgentLoopEngine::run   ToolRegistry   LLM Client   agent-event │ │
│  └───────────────────────────────┬───────────────────────────────┘ │
│                                   │ 读写                              │
│  ┌───────────────────────────────▼ 持久化（Persistence）─────────┐ │
│  │  SQLite（groups/workers/tasks 表）   文件系统（groups/{id}/）   │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

**依赖方向（单向、不可逆）**：控制面 → 数据面 → 核心引擎 → 持久化。
数据面**绝不**反向调用 LLM；群模块**绝不**修改核心引擎代码。

### 3.2 模块依赖与边界

| 模块 | 职责 | 依赖 | 被依赖 | 改动风险域 |
|------|------|------|--------|-----------|
| `group/manager.rs` | 群级状态、成员、引用池/板/空间 | WorkerPool / TaskBoard / Workspace | Dispatcher / 命令层 | 仅群内 |
| `group/worker.rs` | Worker 实体 + WorkerPool（选人/状态机） | — | GroupManager / Scheduler | 仅群内 |
| `group/task.rs` | TaskBoard + TaskScheduler（fan-out/join） | WorkerPool | GroupManager / Dispatcher | 仅群内 |
| `group/workspace.rs` | 目录生命周期、沙箱、只读 | paths（复用） | GroupManager / Scheduler | 仅群内 |
| `group/dispatcher.rs` | 识别派活意图 → 生成 SubTask | 群主输出解析 | 命令层 | 仅群内 |
| 核心引擎 | ReAct 循环、工具、LLM | — | 群模块（只读复用） | **不改动** |

> 所有新增模块局限在 `src-tauri/src/group/`，形成一个**自包含的边界上下文（Bounded Context）**——这是零侵入的架构保证。

---

## 4. 关键架构决策（ADR）

> 每条 ADR 给出：上下文 → 决策 → 备选 → 后果。这是架构师文档的灵魂。

### ADR-1：Worker 作为一等运行时实体（而非 role 标签）

- **上下文**：现有 Worker 仅是 `members` 里的 `AgentRole::Worker`，无状态/能力/并发控制，群主无法掌握"谁在忙、谁能接"。
- **决策**：引入 `Worker` 实体（`status` / `max_concurrency` / `capabilities` / `current_task_id`），由 `WorkerPool` 统一管理。
- **备选**：A) 仅增强 role 标签（轻但解决不了状态/并发）；B) 每个 Worker 独立 Agent 进程（重且难治理）。
- **后果**：✅ 状态可观测、并发可封顶、能力可匹配；❌ 新增 `workers` 表与状态机维护成本（可接受）。

### ADR-2：复用 Session 而非新建引擎实例

- **上下文**：OneDesktop 引擎以 `session_id` 为并发单元，cancel/approve 令牌按 session 存于 `HashMap<session_id>`。
- **决策**：每个 Worker = 一个 `grp:{gid}:{wid}` session，直接调现有 `AgentLoopEngine::run(app, session_id, …)`。
- **备选**：为群新建独立引擎循环（需重写 ReAct/工具/事件，违背零侵入）。
- **后果**：✅ 核心引擎一行不改，事件总线/工具/HITL 全复用；❌ worker 生命周期须与 session 生命周期严格绑定（靠 Archiving RAII 兜底）。

### ADR-3：控制面 / 数据面分离

- **上下文**：群主 LLM 既拆解又派活又 join，成瓶颈且不可复现。
- **决策**：LLM 只产意图（SubTask[]）+ 验收；确定性 `TaskScheduler` 消费 `depends_on` 做 fan-out/join。
- **备选**：纯 LLM 编排（否决，见 §2.2）/ 纯状态机无 LLM（否决，拆解与验收需判断）。
- **后果**：✅ 真并行、可复现、群主 token 下降；❌ 需保证"聊天流意图"与"TaskBoard 结构化状态"双源对齐（靠 Dispatcher 解析 + 校验）。

### ADR-4：文件系统级工作空间隔离

- **上下文**：并行 worker 若共享目录会"串台"；仅靠约定不可靠。
- **决策**：每群 `~/.one-desktop/groups/{id}/`，per-worker 沙箱 `workers/{wid}/`，filesystem 工具 base 注入 + `sanitize_path` 越界拦截；Archiving 整目录只读。
- **备选**：共享根 + 文件名前缀（易冲突，否决）。
- **后果**：✅ 隔离变硬约束、崩溃可恢复（state/ 快照 + logs/）；❌ 磁盘占用增长（靠 Archiving 只读 + 删除确认 + 配额 P2 控）。

### ADR-5：双状态机（群生命周期 × 任务闭环）

- **上下文**：单状态机无法同时表达"群何时存在"与"一轮任务何时闭环"，易漏资源/漏验收。
- **决策**：群级 `Draft→Active↔Paused→Archiving→Archived` + 任务级 `Received→Decomposed→Executing→Reviewing→Accepted`，两者正交。
- **后果**：✅ 每条出口可审计、资源与任务解耦；❌ 状态转移组合需仔细测试（靠 Spec §11 测试计划覆盖）。

### ADR-6：分级问责闭环（架构级容错策略）

- **上下文**：并行失败若全上报群主 → 群主瓶颈；若全自治 → 治理真空。
- **决策**：瞬时失败调度器自治重试（≤N）→ 结构性失败上报群主 → 连续 2 次上报人类。
- **后果**：✅ 效率与治理平衡；❌ 需定义"结构性 vs 瞬时"判定规则（能力不匹配/越权=结构性；超时/网络=瞬时）。

---

### ADR-7：引入 Agent Catalog 作为 Worker 的种源

- **上下文**：Worker 必须有"基因"来源。核对 `src-tauri/src` 代码发现：当前 OneDesktop **无 `agents` 表、无 `AgentProfile` 结构**；`AgentLoopEngine::run`（engine.rs:108）所需的 agent 配置（provider/model、preamble、tools、mcp）来自**全局单一配置**——`sessions` 表的 `model/preamble` + `settings` 表的全局 `preamble` + 内置工具。即"单 Agent 配置运行时"，无法支撑不同专长的 Worker 并行。PRD 里"从候选 Agent 库选席位"的候选库此前未定义来源。
- **决策**：新增 **Agent Catalog（Agent 预设库）**——用户可创建/编辑预设 `{name, model, system_prompt, skills[], mcp[], tools[], capabilities[]}`，持久化为新增 `agents` 表（additive，不碰现有 session/settings）。Worker 的 `agent_ref` 指向 Catalog 中的预设 ID；**群只引用、不拥有预设**。
- **备选**：A) 复用现有 session 的 model/preamble 当 worker 配置（无法表达专长/能力，否决）；B) 预设内联进 `workers` 表（模板与实例耦合、无法多群复用，否决）。
- **后果**：✅ Worker 可被多群/多实例复用，能力席位天然支持按需匹配；✅ 与 session/settings 零冲突（additive 新表）；❌ 需新增"Agent 预设管理"UI + `agents` 表 + 预设→worker 实例化时的配置组装逻辑（**Phase A 前置任务**）。

**Worker 的"有"分两层（解耦）**：
1. **Agent Catalog 的从无到有**（产品前置）：新增 `agents` 表 + 预设管理 UI。这是 Worker 的基因库。
2. **Worker 实例的从无到有**（群层运行时）：
   - **注册（逻辑 Worker）**：建群 `create_group` → 从 Catalog 选预设 → `WorkerPool.register(worker{status:Idle, agent_ref})`。**不建 session、不占 LLM 资源**，只是池里一个"座位"。
   - **实例化（运行时 session）**：派活 `acquire(worker_id)` → 用 `agent_ref` 指向的预设组装 `provider+preamble+tools` → `AgentLoopEngine::run(session=grp:{gid}:{wid})`。**session 在此刻才诞生**。
   - **回收**：`release` → `Idle`；session 保留（复用省重建）或超时回收。
   - **销毁**：群 Archiving → `cancel` 所有 session + 从池移除；Catalog 预设不删（模板永生）。
   - 三种席位差异仅在"何时从 Catalog 取预设注册"：静态=建群选死；动态=运行时加人；能力=派活时 `match_by_capability` 当场注册+acquire。

### ADR-8：圆桌为统一多方消息总线（作者无关路由，协调层与执行层正交）

- **上下文**：用户明确"不同 worker 或成员之间可以相互对话和聊天"——圆桌不是"群主广播、worker 听令"的单向频道，而是多方对等聊天室。现有 `dispatch_to_mentioned` 已能"解析 @提及 → 给 target spawn 任务"，但仅假设人类/群主为作者。
- **决策**：将 Dispatcher 路由升级为**作者无关**：人类、群主、各 worker 发出的 @提及统一路由到目标 session。明确区分「协调层（chat，纯消息、不改 TaskBoard）」与「执行层（DAG，由群主+TaskScheduler 驱动）」两个正交平面。开启方式 = **自由对等**（任意成员可主动 @ 其他成员）；委派边界 = **纯协调**（运行时不经对话新建任务，handoff 走 `depends_on` 预规划）。防死循环靠 `coordination_budget` 轮次预算。
- **备选**：A) 仅响应（worker 只在被 @ 时回复，不主动发起）——最省 token 但失去自发协作（否决，与"相互对话"诉求冲突）；B) 群主中转（worker 找 peer 先 @群主，由群主转达）——治理最严但群主成瓶颈（否决）；C) 对话可自由新建任务（worker @peer 直接 spawn subtask）——失控风险高，与 NG3/治理冲突（否决）。
- **后果**：✅ 复用现有 @提及路由、改动极小、协作自然；✅ 协调与执行正交，群主不被架空、无治理真空；❌ 需 `coordination_budget` 兜住死循环/token 爆（默认 2×在场成员数，可配）。

### ADR-9：圆桌消息采用「阈值+超时混合 + 增量游标」的批处理分发

- **上下文**：ADR-8 解决了"谁能对话"，但没解决"如何保证所有会话内容及时分发给所有 worker"。若每条消息都即时喂给每个 worker，token 爆炸且易死循环；若完全无同步，worker 失去圆桌认知、沦为空壳。用户原案为"自由发言 + 固定 20/50s 同步"，是合理基线但属"平均值陷阱"（热闹延迟高、冷清空转）。
- **决策**：引入 `RoundtableBroadcaster` 传输层，三层路由 + 混合触发 + 增量游标：
  1. **三层路由**：@提及即时 `send_message` 路由（强信号，不进缓冲）；非@自由发言进广播缓冲区带全局 `seq`（弱信号）；系统消息由调度器/群管直投（不经缓冲）。
  2. **混合触发（已定）**：缓冲区累积 ≥ `sync_threshold`（默认 **3** 条）立即同步，或距上次 > `sync_timeout`（默认 **30s**，可配 10–120s）也同步，取先到者。
  3. **增量游标（delta）**：每 worker 维护 `last_seen_seq`，只投递 `(last_seen_seq, current_seq]` 新区间、排除作者自己、新成员首次全量 catch-up。
  4. **唤醒-轻量决策（已定）**：同步 = 调 `send_message` 唤醒 worker session + 附"需回应吗？不需回 `[NO_RESPONSE]`"，平衡主动协作与成本。
  5. **用户可控**：`group_sync_now` 跳过等待手动同步；UI 显「已同步至 HH:MM / 正在同步给 N 位 worker」。
- **备选**：A) 固定间隔（用户原案 20/50s）——简单但平均值陷阱（否决为唯一策略，吸收为超时兜底）；B) 每条即时广播——实时但 token 爆+死循环（否决）；C) 加注意力过滤（按内容×职责推送给相关 worker）——更省 token，但 v1 复杂度高，定为 Phase 2 可选。
- **后果**：✅ 复用 `send_message` 唤醒机制、零侵入核心；✅ 实时性与成本平衡、可观测可配；✅ worker 认知不脱节、群主不被架空；❌ 引入 `group/broadcaster.rs` 与 `roundtable.json`/`broadcaster.json` 两份状态；❌ 注意力过滤留待 Phase 2（v1 全量广播，worker 数不多时成本可控）。

## 5. 数据流与控制流

### 5.1 控制流（意图闭环）

```
人类 ──需求──▶ 群主LLM ──SubTask[]──▶ TaskScheduler ──fan-out──▶ Worker(s)
  ▲                                                              │ 完成
  │                                                           join
  │                                                        @群主验收
  │                                                               ▼
  └──group_accept── 人类 ◀── 验收结论 ◀── 群主LLM ◀──────────────┘
```

> 此外，成员间可经圆桌总线**自由 @ 对话**（协调层，纯消息、不改 TaskBoard），详见 ADR-8。它属于控制流之外的"横向协调"，不进入上面的意图闭环。

### 5.2 事件流（agent-event 总线 + session 路由）

- 所有 worker 执行事件经统一的 `agent-event`，每条带 `session_id = grp:{gid}:{wid}`。
- 前端 `useGroupChat` 复用 `useAgent` 的过滤逻辑（`if event.data.session_id !== sessionId return`），按 session 路由到对应执行卡片。
- **扇入治理**：N 路并发事件 → 列表虚拟化 + 按 session_id 对账，避免渲染抖动（PRD R2）。

### 5.3 双源真相对齐（关键不变量）

聊天流（人类可见的"对话"）与 TaskBoard（确定性"状态"）必须一致：
- 群主每产出一个 SubTask，Dispatcher 解析并**写 TaskBoard** 为唯一真相源。
- 聊天气泡是 TaskBoard 状态的**投影**（可读不可写意图）。
- 不一致时以 TaskBoard 为准，聊天流仅承载讨论与验收结论。

---

## 6. 并发与状态模型

### 6.1 并发单元

- **单元 = session**（`grp:{gid}:{wid}`）。每个 worker 执行 = 一个 tokio 任务，由 `AgentLoopEngine::run` 驱动。
- **fan-out** 用 `tokio::task::JoinSet`（非 `wait_first_success` 竞速），保证"全部完成"而非"任一完成"。

### 6.2 Worker 状态机

```
        acquire                  release
 Idle ─────────▶ Busy ───────────▶ Idle
  │               │                │
  │ Offline(崩溃/取消)             │
  └───────────────┴────────────────┘
```
- `max_concurrency` 封顶单 worker 并行子任务数（v1 多数 =1，能力席位可 >1）。
- `WorkerPool.pick()` 仅从 `Idle` 中选，避免重复派活。

### 6.3 一致性边界

- **at-least-once + 幂等**：调度器可能因崩溃重放 tick，SubTask 状态转移须幂等（同状态重复写入无副作用）。
- **exactly-once 不强行保证**：产物落盘用"先写临时、accept 后移入 artifacts"两阶段，避免半完成产物。
- **崩溃恢复**：`state/taskboard.json` 每状态转移落盘；重启后从快照恢复，未完成的 InProgress 子任务重入 `Recovering`。

---

## 7. 容错与一致性（架构层落地）

| 失败类型 | 架构处理 | 升级路径 |
|----------|----------|----------|
| 瞬时（超时/网络/429） | 调度器自治重试 ≤ N（acquire 同 worker 或 pick 同类换人） | 超 N → 结构性 |
| 结构性（能力不匹配/越权/产出不可用） | 立即上报群主 | 群主拍板重试/换人/上报人类 |
| 连续 2 次失败 | 上报人类（系统消息） | 人类介入 |
| worker 崩溃 | session cancel → release → 重派或换人 | 群级不影响其他 worker |
| 群解散中断 | Archiving 强制 cancel 所有 session + release pool | 无残留（RAII） |

**资源生命周期 = RAII 式**：群进入 Archiving 即触发"cancel 所有 worker session + release pool + 工作空间只读"，保证 G6（泄漏=0）。

---

## 8. 可观测性与治理

- **Metrics**：复用现有 `AtomicU64`（agent_loops / tool_calls / tokens），新增群级维度：并行 worker 数、fan-out 批大小、失败/重试率、验收闭环率。
- **事件日志**：每次状态转移写 `groups/{id}/logs/`，形成审计轨迹（谁派活/谁执行/谁验收/谁解散）。
- **治理强制（架构层）**：群主权限在 `Dispatcher` 边界收敛——只能调用"拆解/验收"类命令，改席位/解散命令**强制要求人类 session 二次确认**，从接口层杜绝 R4（群主失控）。

---

## 9. 集成契约（零侵入的保证）

### 9.1 复用契约（核心不改动）

| 能力 | 复用点 | 群模块如何使用 |
|------|--------|----------------|
| 引擎 | `AgentLoopEngine::run(app, session_id, …)` | 每个 worker 一次调用，session 前缀 `grp:` |
| 工具 | `ToolRegistry` | 直接复用；filesystem 工具注入 `workdir` |
| 事件 | `agent-event`（带 session_id） | 监听 + 按 session 路由 |
| 控制命令 | `send_message` / `approve_tool` / `cancel_agent` | 群命令内部转调（additive） |
| 前端 | `useAgent` 过滤逻辑 / `sendMessage` | `useGroupChat` 复用 |
| 路径 | `paths.rs::data_dir` | `groups_dir()` 复用根 |

### 9.2 新增契约（扩展点，不影响核心）

- **命令命名空间**：`group_*` 前缀（additive，现有命令签名不变）。
- **session 命名空间**：`grp:{gid}:{wid}` / `grp:{gid}:roundtable`，从个人 session 列表过滤隔离。
- **事件命名空间**：复用 `agent-event`，仅新增 group session 来源；不新增事件类型。

> **反脆弱性**：核心引擎升级（如换 LLM client）时，群模块因只通过稳定契约复用，无需改动 → 零侵入成立。

---

## 10. 演进路线与扩展点

### 10.1 架构成熟度对应交付阶段

| 阶段 | 架构成熟度 | 范围 |
|------|------------|------|
| Phase A（P0） | 双状态机 + 混合编排 + 三席位静态优先 | 创建/圆桌/并行/闭环/问责/生命周期 |
| Phase B（P1） | 动态席位 + HITL + 归档浏览 | 运行时加人/换人、人工批准、只读归档 |
| Phase C（P2） | 自动上报 + **跨群就绪** | 连续失败上报、数据面预留跨群接口 |

### 10.2 跨群编排如何"不重构"接入

因数据面（WorkerPool / TaskScheduler / TaskBoard）已独立成层，未来跨群只需：
- 在 `GroupManager` 之上加 `FederationManager`，消费各群 TaskBoard 暴露的"可委派子任务"接口；
- 调度器支持 `cross_group: true` 的 SubTask（pick 跨群选 worker）。
- **核心引擎、Worker 实体、工作空间模型均不变** → 验证 ADR-2/ADR-4 的演进性。

### 10.3 混合模式（平权）预留

当前仅群主模式（NG3）。未来若需平权协作，因"群主 LLM"仅是控制面的一个**可替换角色 Agent**，可在不改动数据面前提下，将控制面从"单群主"切换为"共识/协商协议"——这是控制面/数据面分离范式的最大红利。

---

## 11. 架构权衡总结

| 决策 | 得到 | 付出 |
|------|------|------|
| 控制面/数据面分离 | 真并行、可复现、群主减负 | 双源对齐复杂度 |
| 复用 session | 零侵入、全能力复用 | session 生命周期绑定严格 |
| Worker 一等实体 | 状态/并发/能力可控 | 状态机维护成本 |
| 文件系统隔离 | 硬隔离、可恢复 | 磁盘增长（配额控） |
| 双状态机 | 资源/任务解耦、可审计 | 状态组合测试成本 |
| 混合编排 | 治理+效率平衡 | 需定义失败分级规则 |

> 总体判断：这套结构以"治理优先、零侵入、可演进"为锚，**没有为灵活度牺牲核心约束**，且为文档 Phase 4 的跨群/混合模式留了干净的接入口。是一份可长期承载产品演进的架构。

---

## 12. 待架构层确认项（非阻塞）

- **A1** fan-out 默认并发上限：建议 = 建群 Worker 数（受 `max_concurrency` 与 LLM 限流共同约束）。
- **A2** TaskBoard 快照落盘频率：每状态转移 vs 批量（建议每转移，简单可靠）。
- **A3** 跨群接口在 Phase C 是否仅留 trait 桩（建议留桩不实现，防止过度设计）。
