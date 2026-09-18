# OneDesktop 协作 Agent 架构设计 —— M2「打通与看见」

| 项 | 内容 |
|----|------|
| 文档类型 | 架构设计（Architecture Design + ADR 集） |
| 版本 | v1.0 |
| 日期 | 2026-08-03 |
| 依据 | 《PRD：协作 Agent 增强 M2》（R1–R7）、《架构调整方案》（P0/P1/P2 已落地基线） |
| 作用域 | 后端内核重构 + 前端结构分解 + UI/UX 交互模型 |
| 状态 | 待评审 |

---

## 〇、设计纲领（读这一节就够）

### 0.1 双目标，一个手段

用户要的是两件事：**UI/UX 足够简单** + **内核足够模块化**。这不是两个独立任务，
它们由**同一个架构手段**同时达成：

> **把"内核向 UI 推送什么"收敛成一条稳定的事件契约，把"UI 向内核请求什么"收敛成一组窄接口。**
> 契约稳定后，内核可以随便重构（扩展性），UI 可以随便简化（体验），两边互不牵制。

当前恰恰相反：内核直接持有 `AppHandle`、UI 直接摊平 60+ 个 invoke 函数，
两边**通过实现细节耦合**。所以每加一个 PRD 需求，两边都要改，且改动会互相牵连。

### 0.2 三条不可违反的架构约束（继承 PRD §0）

| 约束 | 架构含义 |
|------|---------|
| **1 人 × N Agent，无服务端** | 不引入消息路由层、不引入寻址、不引入身份主体。审批「推给唯一窗口」即可 |
| **零基础设施（NG-S2）** | 不引 Matrix/MinIO/PG/网关。并发用**进程内 Tokio + SQLite WAL**，不用外部 broker |
| **单机 ≠ 离线** | 网络失败必须是**一等公民错误类型**，与工具执行失败区分（FR1.3） |

### 0.3 本设计的五个动作（全部可独立回滚）

| # | 动作 | 解决 | 可逆性 |
|---|------|------|--------|
| **A-1** | 内核去 Tauri 化：`RunObserver` 替代 `AppHandle` | 27 处泛型污染、内核不可测 | 高（加 trait，旧路径保留） |
| **A-2** | `run()` 参数对象 + 阶段化 | 727 行单函数、13 参数 | 高（纯 extract method） |
| **A-3** | `ToolPlane`：Provider 组合 + 席位作用域 | R1 MCP、NG3 白名单 | 高（Registry 变组合根） |
| **A-4** | `ApprovalBroker`：四态 + ApprovalId 为键 | R3 四态、Worker 只读、键覆盖隐患 | 中（改审批协议） |
| **A-5** | `RunLedger`：runs/run_steps 落库 | R2/R4/R5/R6 数据底座 | 高（纯新增表） |

---

## 一、现状架构诊断（代码级事实，非印象）

### 1.1 分层现状

```
commands/*.rs (7 个)          ← 适配层，基本干净
    ↓
session/manager · group/{manager,roundtable,scheduler} · skill · scheduler
    ↓
agent/{engine, tool_registry, permission, executor} · llm/* · mcp/*
    ↓
storage/{connection, *_repo} → SQLite(WAL)
```

Repository 模式、ToolRegistry 多态、统一事件信封、三态权限——**骨架是对的**。
问题不在分层，在于**两个上帝对象**和**一处反向依赖**。

### 1.2 诊断项（按危害排序）

| # | 问题 | 证据 | 危害 |
|---|------|------|------|
| **D1** | **内核反向依赖 UI 框架** | `<R: Runtime>` 出现在 **8 个模块 27 处**；`engine.rs:142 run<R: Runtime>(app: &AppHandle<R>, …)` | 内核无法单测、无法复用；泛型沿 engine→roundtable→scheduler→commands 传染，`TaskScheduler<R>`/`RoundtableBus<R>` 全被迫泛型化 |
| **D2** | **`run()` 是 727 行单函数、13 个参数** | `engine.rs:142–869`，带 `#[allow(clippy::too_many_arguments)]` | R1/R2/R3 全都要改这一个函数；合并冲突高发；新增一个能力就加一个参数 |
| **D3** | **审批协议结构性不足** | `pending_approvals: HashMap<String, oneshot::Sender<bool>>`（`engine.rs:72`）；`insert(session_id, tx)`（`engine.rs:679`）；`approve_tool(session_id, bool)`（`engine.rs:96`） | ① **`bool` 无法表达四态**（R3 直接受阻）；② 键是 session_id，是**潜在覆盖缺陷**（见下方"可达性核实"） |
| **D3′** | **Worker 被一行代码阉割** | `engine.rs:665-669`：`if perm == Ask && session_kind == Worker { perm = Deny }` | 这是 PRD「Worker 退化为只读」的**精确成因**。R3 的第一刀就落在这五行 |
| **D4** | **MCP 是"探活工具"不是"客户端"** | `mcp/client.rs:23 test()` → spawn → handshake → list → `child.kill()`；全仓无 `tools/call` | R1 无法在此之上实现；且 `test_http` 在 async 上下文里 `Builder::new_current_thread().block_on()`（`client.rs:32-36`）是嵌套运行时隐患 |
| **D5** | **工具结果类型无法表达"工具失败"** | `ExecutableTool::execute → Result<String, String>` | FR1.3 要求「协议错误 ≠ 工具执行错误」，当前二者都塌缩成 `Err(String)` |
| **D6** | **指标纯内存** | `telemetry/metrics.rs` 95 行全是 `AtomicU64`，无持久化 | R2/R4/R5/R6 全部无数据源 |
| **D7** | **工具注册表是启动期静态表** | `ToolRegistry{ tools: HashMap<String,(ToolDef,Arc<dyn ExecutableTool>)> }`，无运行时增删、无作用域 | MCP 工具动态发现、NG3 席位白名单都无处安放 |
| **D8** | **前端上帝组件** | `GroupsPage.tsx` **2327 行**，内联 10 个子组件，顶层 **18 个 useState** | R4/R5/R6/R7 四个需求都要往这里加 UI |
| **D9** | **前端审批单槽** | `useAgent.ts:18 useState<PendingApproval \| null>` | 与 D3 呼应：多 Worker 并发 Ask 时 UI 只能显示一个 |
| **D10** | **服务层与事件层样板化** | `tauri.ts` 381 行 60+ 扁平函数；`eventBus.ts` 6 个近乎逐字重复的 subscribe（各 ~25 行） | 每加一个命令/事件都要抄一遍样板 |

#### D3 可达性核实（避免夸大问题）

我一开始把 D3② 判成"正在发作的 bug"，核实代码后**必须修正为潜在缺陷**：

| 触发条件 | 当前是否成立 | 依据 |
|---------|------------|------|
| 单轮内多个 tool_call 并发 Ask | ❌ 否，**串行执行** | 工具调用在 `for` 循环内逐个处理 |
| 多个 Worker 并发 Ask 撞键 | ❌ 否，**键天然不同** | 每 Worker 独立 session_id（`rt:{group}:{worker}`） |
| Worker 会话产生 Ask | ❌ 否，**被降级掉了** | `engine.rs:665-669` 强制 `Ask → Deny`（即 D3′） |
| 同一 session 并发两次 run | ⚠️ 理论可能 | 调度器可对活跃会话触发；无 per-session 运行互斥 |

**结论**：D3② **今天基本打不中**，但它会在两种情况下立刻变成真 bug——
① R3 拿掉 D3′ 的降级后，若同时引入**单轮内并行工具执行**（很可能的性能优化）；
② 调度任务命中一个正在跑的会话。
**同样的 session_id 键模式也存在于 `cancel_tokens`（`engine.rs:74/171`）**，是同一类隐患。

> 修正后的判断：**D3① 是硬阻塞**（`bool` 表达不了四态，R3 做不了）；
> **D3② 是要在改审批协议时"顺手根治"的隐患**，不该拿它当紧急事故来卖。
> 真正"现在就在损害产品"的是 **D3′**——它让群协作里的 Worker 只能读不能写。

---

## 二、目标架构

### 2.1 依赖方向（唯一硬规则）

```
┌──────────────────────────────────────────────────────┐
│  adapters   commands/*  ·  TauriObserver  ·  tray    │  ← 只有这一层知道 Tauri
├──────────────────────────────────────────────────────┤
│  use-cases  session/  group/{manager,roundtable,      │
│             scheduler}  ·  skill/                     │
├──────────────────────────────────────────────────────┤
│  kernel     runtime(engine)  toolplane  approval      │  ← 纯 Rust，零 Tauri
│             ledger  permission                        │     可单测、可复用
├──────────────────────────────────────────────────────┤
│  infra      storage/  llm/  mcp/transport  events     │
└──────────────────────────────────────────────────────┘
              依赖只能向下，禁止向上或跨层回指
```

**唯一新增的硬规则**：`kernel/` 下任何文件 **不得 `use tauri::`**。
这一条可以用 CI 里一行 grep 守住，成本几乎为零，收益是内核永久可测。

### 2.2 有界上下文与职责边界

| 上下文 | 职责（一句话） | 不负责 |
|--------|--------------|--------|
| **Runtime** | 跑 ReAct 循环，产出 `AgentRunOutcome` | 不知道 UI、不知道群、不落审批 UI |
| **ToolPlane** | 解析工具名 → 找到执行者 → 执行 → 返回 `ToolOutcome` | 不判权限、不落账 |
| **Approval** | 判定 gate（Allow/Deny/Ask）+ 托管 pending 请求 + 四态应答 | 不知道工具怎么执行 |
| **Ledger** | 记录 run/step、算成本、提供聚合查询 | 不参与决策 |
| **Collaboration** | 群/席位/任务/圆桌编排 | 不直接调 LLM（走 Runtime） |
| **Delivery** | 事件外发、命令路由 | 不含业务逻辑 |

**高内聚判据**：上表每一行的"职责"都能用一句话说完，且不含"和"。
**低耦合判据**：Runtime 只通过 4 个 trait 与外界交互——`LlmProvider`、`ToolPlane`、`ApprovalGate`、`RunObserver`+`RunLedger`。

### 2.3 内核的五个出向端口（Ports）

内核**只认 trait，不认实现**。这五个端口是整个设计的承重墙：

```rust
// kernel/ports.rs —— 零 Tauri 依赖

/// 出向 1：把过程说出去（替代 AppHandle.emit，供 Agent 引擎）
pub trait RunObserver: Send + Sync {
    fn on(&self, ev: RunEvent);
}

/// 出向 2：把活干了（替代 ToolRegistry 直查）
#[async_trait]
pub trait ToolPlane: Send + Sync {
    fn list(&self, scope: &ToolScope) -> Vec<ToolDef>;
    async fn invoke(&self, scope: &ToolScope, call: ToolCall) -> ToolOutcome;
}

/// 出向 3：问人（替代内联的 pending_approvals + oneshot<bool>）
#[async_trait]
pub trait ApprovalGate: Send + Sync {
    async fn request(&self, req: ApprovalRequest) -> ApprovalDecision;
}

/// 出向 4：记账（替代 AtomicU64）
pub trait RunLedger: Send + Sync {
    fn begin(&self, r: RunBegin) -> RunId;
    fn step(&self, id: &RunId, s: RunStep);
    fn finish(&self, id: &RunId, f: RunFinish);
}

/// 出向 5：发领域事件（替代 AppHandle.emit，供 scheduler/group/roundtable 各自 bounded context）
/// T2 新增：内核事件不再带 session_id（统一为 None），仅按 legacy_channel + type + group_id 双发。
pub trait EventBus: Send + Sync {
    fn emit(&self, legacy_channel: &str, r#type: &str, group_id: Option<&str>, payload: serde_json::Value);
}
```

> **为什么是 5 个而不是 1 个大 trait**：这五者的**变更频率完全不同**——
> `RunObserver` 随 UI 改，`ToolPlane` 随生态改，`ApprovalGate` 随安全策略改，`RunLedger` 随报表改，
> `EventBus` 随调度/群/圆桌的事件契约改。合并成一个 trait 会让任何一侧的变更都震动其余几侧。
> `RunObserver` 与 `EventBus` 的边界：前者是 Agent 引擎的过程事件（delta/tool/approval），
> 后者是协作编排层的业务事件（batch_completed / roundtable-message / worker-status）。

---

## 三、内核详细设计

### 3.1 A-1：内核去 Tauri 化

**问题**：`run<R: Runtime>(app: &AppHandle<R>, …)` 让 `<R>` 传染 8 个模块 27 处。

**做法**——把「发事件」这件事从**具体能力**降级为**抽象端口**：

```rust
// kernel/events.rs —— 内核自己的事件类型，不依赖 tauri
pub enum RunEvent {
    Delta      { run: RunId, text: String },
    ToolStart  { run: RunId, name: String, args_digest: String },
    ToolEnd    { run: RunId, name: String, outcome: ToolOutcomeKind, ms: u64 },
    Approval   { run: RunId, req: ApprovalRequest },
    SeatState  { seat: SeatId, state: SeatState },   // R4 数据源
    Finished   { run: RunId, outcome: RunOutcomeKind },
}

// adapters/observer.rs —— 唯一知道 Tauri 的地方
pub struct TauriObserver<R: Runtime> { app: AppHandle<R>, session: String }
impl<R: Runtime> RunObserver for TauriObserver<R> {
    fn on(&self, ev: RunEvent) {
        let _ = self.app.emit(topic_of(&ev), Envelope::new(&self.session, ev));
    }
}
```

**泛型收敛效果**：

| | 改造前 | 改造后 |
|---|---|---|
| `<R: Runtime>` 出现处 | 27 处 / 8 模块 | **≤3 处 / 1 模块**（仅 adapters） |
| `TaskScheduler` | `TaskScheduler<R>` | `TaskScheduler`（持 `Arc<dyn RunObserver>`） |
| `RoundtableBus` | `RoundtableBus<R>` | `RoundtableBus` |
| 内核单测 | 不可能（要造 AppHandle） | `RecordingObserver` 收事件即可断言 |

**取舍**：多一次 `Arc` 动态派发 + 一次事件结构体构造。Agent 循环里每秒事件量是**个位数到几十**，
这点开销相对一次 LLM 网络往返（数百 ms）**可忽略**。换来的是内核可测——值。

**迁移策略（不破坏现网）**：
1. 先加 `RunObserver` + `TauriObserver`，`run()` 新增参数 `observer: Arc<dyn RunObserver>`；
2. 内部把 `app.emit(...)` 逐个换成 `observer.on(...)`；
3. 全部换完后删掉 `app` 参数，`<R>` 自然消失；
4. CI 加守卫：`grep -rn "use tauri::" src-tauri/src/kernel/ && exit 1`。

每一步都能独立编译通过、独立回滚。

### 3.2 A-2：`run()` 从 727 行单函数改为阶段化流水线

**问题**：`engine.rs:142–869` 一个函数 727 行、13 个参数，R1/R2/R3 都要动它。

**第一刀——参数对象**（消灭 13 参数与 `#[allow(clippy::too_many_arguments)]`）：

```rust
pub struct RunRequest {
    pub session:  SessionRef,          // id + 会话种类（主会话 / rt:{group}:{worker}）
    pub input:    UserInput,
    pub persona:  PersonaSpec,         // system prompt / SOUL / 席位人设
    pub policy:   RunPolicy,           // max_iters, auto_approve_override, budget
    pub scope:    ToolScope,           // 席位可见工具集（R1 / NG3）
}

pub struct RunDeps {                   // 四个端口一次注入
    pub llm:      Arc<dyn LlmProvider>,
    pub tools:    Arc<dyn ToolPlane>,
    pub approval: Arc<dyn ApprovalGate>,
    pub observer: Arc<dyn RunObserver>,
    pub ledger:   Arc<dyn RunLedger>,
    pub store:    Arc<dyn MessageStore>,
}

pub async fn run(req: RunRequest, deps: &RunDeps) -> Result<AgentRunOutcome, RunError>;
```

**第二刀——按阶段切函数**（纯 extract method，行为不变）：

```
run()  ≈ 80 行编排
 ├─ prepare_history()      载入历史 + 悬空 tool_call 消毒（现有逻辑，独立成函）
 ├─ loop {
 │    ├─ call_llm()        请求构造 + 流式 delta + 用量统计
 │    ├─ parse_tool_calls() ← 570 行 JSON 修复搬去 llm/json_repair.rs
 │    ├─ gate()            权限判定 → 可能 await ApprovalGate
 │    ├─ execute()         ToolPlane.invoke → ToolOutcome
 │    └─ record()          observer.on + ledger.step
 │  }
 └─ finalize()             落 outcome + ledger.finish
```

**关键搬迁**：`engine.rs` 里那 **570 行 JSON 修复**（截断补全、单引号、尾逗号等）
与 Agent 循环**毫无关系**，属于 LLM 输出适配。搬到 `llm/json_repair.rs` 后：
- `engine.rs` 从 1449 行降到 **≈500 行**；
- JSON 修复可以**独立跑属性测试**（喂畸形 JSON 断言恢复率），这是现在做不到的。

**取舍**：这一刀**不改任何行为**，只搬代码。风险极低但收益是后续 R1/R2/R3 能**并行改**
（分别落在 `execute()` / `record()` / `gate()`，互不冲突）。

**验收**：`engine.rs` ≤600 行；`run()` 主体 ≤100 行；无 `too_many_arguments` 豁免。

### 3.3 A-3：ToolPlane —— 工具从"静态表"变为"可组合平面"（R1）

**问题**：`ToolRegistry` 是启动期构造的 `HashMap<String, (ToolDef, Arc<dyn ExecutableTool>)>`，
**无运行时增删、无作用域、无来源区分**。MCP 工具（动态发现）和席位白名单（NG3）都无处安放。

**做法**——引入 **Provider 概念**，Registry 降级为组合根：

```rust
#[async_trait]
pub trait ToolProvider: Send + Sync {
    fn origin(&self) -> ToolOrigin;                    // Builtin | Mcp(server_id) | Skill
    async fn list(&self) -> Result<Vec<ToolDef>, ProviderError>;
    async fn invoke(&self, call: ToolCall) -> ToolOutcome;
    async fn health(&self) -> Health;                  // R1 可用率 / 未来 F11 诊断
}

pub struct ToolPlaneImpl {
    providers: RwLock<Vec<Arc<dyn ToolProvider>>>,     // 运行时可增删（MCP 热插拔）
    cache:     RwLock<ToolCatalog>,                    // name → (provider_idx, ToolDef)
}
```

**命名冲突与作用域**：

- **全限定名**：MCP 工具统一命名为 `mcp__{server}__{tool}`（与内置工具天然隔离，
  且用户在 UI 上一眼能看出工具来源）。冲突时**内置优先**，并发 `ToolConflict` 事件供 UI 提示。
- **ToolScope**：席位可见工具白名单。`list(scope)` 只返回 scope 允许的工具
  —— 这正面解决报告 §9 的「单 Agent 可选动作超 30–40 个即退化」（Copilot Studio 阈值）。

```rust
pub struct ToolScope {
    pub seat:  Option<SeatId>,
    pub allow: ToolAllow,      // All | Only(HashSet<String>) | AllExcept(HashSet<String>)
}
```

**D5 修复——工具结果三态**（FR1.3 要求「协议错误 ≠ 工具执行错误」）：

```rust
pub enum ToolOutcome {
    Ok      { content: String, ms: u64 },
    Failed  { message: String, retryable: bool },   // 工具跑了但失败（喂回 LLM 让它换招）
    Unavailable { reason: UnavailableReason },      // 根本没跑起来（不该让 LLM 反复重试）
}
pub enum UnavailableReason {
    Network(String),        // 单机≠离线：断网提示「网络不可达」而非「Agent 失败」
    NotFound, Timeout, Denied, ProviderDown(String),
}
```

> 这个区分是**语义刚需**：`Failed` 应该喂回 LLM（它可以改参数重试），
> `Unavailable` 不应该——让 LLM 对着一个挂掉的 MCP Server 重试 5 次纯属烧钱。

**D4 修复——MCP 从"探活"到"客户端"**：

| | 现状 | 目标 |
|---|------|------|
| 生命周期 | `test()` → spawn → handshake → list → **kill** | `McpSession` 常驻，引用计数空闲 N 分钟后回收 |
| 能力 | 仅 `initialize` + `tools/list` | `+ tools/call`、`notifications/tools/list_changed` |
| 运行时隐患 | `test_http` 在 async 里 `block_on`（`client.rs:32-36`） | 全链路 async，删除嵌套 runtime |
| 失败表达 | `Err(String)` | `UnavailableReason::{Network, ProviderDown, Timeout}` |

**取舍**：常驻会话意味着**要管理进程生命周期**（stdio 子进程可能僵死）。
对策是**空闲回收 + 首次调用前 preflight**，而不是引入 supervisor 框架——单机场景不值得。

### 3.4 A-4：ApprovalBroker —— 解锁 R3（含 D3′ / D3 根治）

**先看清楚现状的三个问题，并区分严重性**：

```rust
// engine.rs:72
pending_approvals: HashMap<String /* session_id */, oneshot::Sender<bool>>

// engine.rs:665-669 —— 这才是当下真正在损害产品的一行
if perm == Permission::Ask && session_kind == SessionKind::Worker {
    perm = Permission::Deny;      // Worker 永远问不出口 → 只能读不能写
}
```

| 问题 | 严重性 | 后果 |
|------|-------|------|
| **D3′** Worker 的 `Ask` 被强降为 `Deny` | **正在损害产品** | 群协作里 Worker 工具被阉割（PRD R3 的核心痛点） |
| **D3①** 决策类型是 `bool` | **硬阻塞 R3** | `accept/edit/respond/ignore` 四态无法表达 |
| **D3②** 以 session_id 为键 | **潜在** | 拿掉 D3′ 且引入并行工具执行后会变成永久挂起 |

**为什么 D3′ 当初要那么写**（不能只骂前人）：Worker 会话没有审批面，
若 Ask 挂起就永久挂死——**降级为 Deny 是当时唯一安全的选择**（fail-closed，是对的）。
所以 R3 不能简单删掉这五行，**必须先有审批冒泡通路，再拿掉降级**，顺序不能反。

**做法**——审批变成**独立的有身份的请求**：

```rust
pub struct ApprovalRequest {
    pub id:    ApprovalId,          // ← 键改为它，天然支持并发
    pub run:   RunId,
    pub seat:  Option<SeatId>,      // 单机下用于「这是哪个 Agent 要的」，不是权限主体
    pub tool:  String,
    pub args:  serde_json::Value,
    pub risk:  RiskLevel,
    pub expire_at: Option<Instant>, // 单机特有风险：用户可能不在屏幕前
}

pub enum ApprovalDecision {
    Accept,
    Edit    { args: serde_json::Value },   // 改参放行 —— PRD 判定价值最高
    Respond { feedback: String },          // 不执行，把反馈喂回 LLM 让它换做法
    Ignore,                                // = 拒绝且不解释
}

pub struct ApprovalBroker {
    pending: Mutex<HashMap<ApprovalId, oneshot::Sender<ApprovalDecision>>>,
}
```

**四态如何回到 Agent 循环**（这是设计要点，不是实现细节）：

| 决策 | 循环里发生什么 | 喂给 LLM 的 tool result |
|------|--------------|----------------------|
| `Accept` | 原参执行 | 真实结果 |
| `Edit` | **用新参执行** | 真实结果 + 「参数已被用户调整」注记 |
| `Respond` | **不执行** | `"用户未执行该操作，反馈：{feedback}"` |
| `Ignore` | 不执行 | `"用户拒绝执行该操作"` |

> `Respond` 是四态里最有产品价值的一个：它把审批从**闸门**变成**对话**——
> 用户不必想清楚"正确参数是什么"，只需说"别删文件，先给我看看列表"。

**超时策略（fail-closed）**：`expire_at` 到期 → `Ignore` + `ApprovalOutcome::Timeout` 落账。
**理由**：单机没有"推给同事代批"的退路（竞品有），静默挂起比拒绝更糟——
拒绝至少 Agent 会继续走并告诉用户，挂起是完全无声的。

**兼容旧协议**：保留 `approve_tool(session_id, bool)` 一个版本（映射到 `Accept`/`Ignore`），
标 `#[deprecated]`，前端切换完成后删除。

### 3.5 A-5：RunLedger —— 所有可视化的唯一数据底座（R2）

**问题**：`telemetry/metrics.rs` 96 行全是 `AtomicU64`，进程重启即清零。
R2/R4/R5/R6 四个需求**全部**依赖它，是本次架构的**关键路径**。

**分工**（不要把两者混为一谈）：

| | Metrics（保留） | Ledger（新增） |
|---|---|---|
| 形态 | 进程内计数器 | SQLite 表 |
| 用途 | 健康探针、当下速率 | 历史查询、成本、甘特、回放 |
| 生命周期 | 随进程 | 持久 |

**写入点唯一**：只有 `run()` 的 `record()` / `finalize()` 阶段写 Ledger。
禁止在 commands / group / scheduler 层旁路写入——**多写入点必然导致口径不一致**。

**成本计算的架构位置**：`ledger` 存**原始 token 数 + model 名**，
`¥` 由**查询期**按单价表折算，**不在写入期固化**。
理由：单价会变、用户可能改 provider，写死金额会让历史数据永久错误且不可修。

**性能护栏**：step 写入走 `mpsc` 异步批量落盘（≤200ms 或 ≤32 条触发一次事务），
避免每个工具调用都同步 fsync 拖慢 Agent 循环。SQLite WAL 下这足够，**不需要引入外部时序库**。

---

## 四、数据模型演进

**原则：只加表、不改既有表**（sessions / messages / settings / groups / seats / tasks 全部不动），
迁移风险降到最低，回滚 = drop 新表。

```sql
-- 迁移 v{N+1}：R2 数据底座
CREATE TABLE runs (
  id            TEXT PRIMARY KEY,          -- RunId (uuid)
  session_id    TEXT NOT NULL,
  group_id      TEXT,                      -- NULL = 主会话
  seat_id       TEXT,                      -- NULL = 用户直连 Agent
  kind          TEXT NOT NULL,             -- chat | worker | scheduled | roundtable
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  status        TEXT NOT NULL,             -- running | ok | failed | cancelled | timeout
  model         TEXT,
  prompt_tokens  INTEGER DEFAULT 0,
  output_tokens  INTEGER DEFAULT 0,
  iterations    INTEGER DEFAULT 0,
  error_kind    TEXT                       -- network | provider | tool | internal
);
CREATE INDEX idx_runs_session ON runs(session_id, started_at DESC);
CREATE INDEX idx_runs_group   ON runs(group_id, started_at DESC);

CREATE TABLE run_steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL,             -- llm | tool | approval
  name          TEXT,                      -- 工具名 / 模型名
  origin        TEXT,                      -- builtin | mcp:{server} | skill
  args_digest   TEXT,                      -- 摘要，非全量（隐私 + 体积）
  outcome       TEXT NOT NULL,             -- ok | failed | unavailable
  unavailable_reason TEXT,                 -- network | not_found | timeout | denied | provider_down
  approval_source   TEXT,                  -- human | auto_approve | timeout_deny   ← 单机口径
  approval_decision TEXT,                  -- accept | edit | respond | ignore
  duration_ms   INTEGER,
  started_at    INTEGER NOT NULL
);
CREATE INDEX idx_steps_run ON run_steps(run_id, seq);
```

**三处刻意的设计选择**：

| 选择 | 理由 | 放弃了什么 |
|------|------|-----------|
| `args_digest` 而非全量入参 | 入参可能含密钥/大文本；库体积可控 | 无法完整回放，只能审计"调了什么" |
| 不存 `cost_cny` 字段 | 单价会变，写死则历史永久错 | 查询时要 join 单价表（可忽略） |
| `approval_source` 而非 `approved_by` | **单机只有一个人**，要区分的是人批/自动/超时，不是"谁" | 无（这正是 PRD §0 的修正） |

**保留期**：`run_steps` 默认保留 90 天，`runs` 保留 1 年，启动时后台清理。
单机磁盘是用户自己的，不能无限涨。

---

## 五、前端架构与 UI/UX 设计

### 5.1 UI/UX 的第一性原则

用户要求"操作简单方便"。在 Agent 产品里，简单**不等于功能少**，而是：

> **默认路径零决策，复杂能力藏在渐进披露之后。**

三条落地规则：

| 规则 | 反面（当前/竞品） | 本设计 |
|------|-----------------|--------|
| **R-1 不让用户先做架构决策** | "先建群 → 配席位 → 才能说话"（AgentTeams 要写 CRD） | **先聊，需要时一键升级为群**（R7） |
| **R-2 信息按需展开，不堆砌** | 2327 行页面把所有面板平铺 | 三层递进：状态点 → 摘要条 → 详情抽屉 |
| **R-3 阻塞性操作必须闭环** | 审批弹窗被埋在某个 tab 里 | 就地卡片 + 全局聚合 + 系统级角标（三层送达） |

### 5.2 前端目标分层

```
App.tsx                     路由与全局壳（NavKey: chat | tasks）
  ├─ features/chat/         会话 | 圆桌（ChatMode: session | group）
  ├─ features/collab/       群视图（由 GroupsPage 分解而来）
  ├─ features/approval/     ★ 新增：跨页面的审批中心
  ├─ features/insight/      ★ 新增：席位仪表 / 甘特 / 成本（R4/R5）
  ├─ shared/components/     设计系统原子（已有 Icons/Modal/Toggle…）
  ├─ shared/hooks/          useRunStream / useApprovalQueue / useSeatState
  └─ services/              ipc（分域）· eventBus（泛型化）
```

### 5.3 拆掉 D8：`GroupsPage.tsx` 2327 行 / 18 个 useState

**不做"大爆炸重写"**（那会连带 E2E 全挂）。按**状态归属**切，分三步：

```
第 1 步  抽状态：18 个 useState → 3 个 reducer
         useGroupSession (会话/消息/流)  ← 服务器状态
         useGroupComposer (输入/模式/选中席位)  ← 表单状态
         useGroupView (展开/抽屉/tab)  ← 纯 UI 状态

第 2 步  抽子组件：内联的 10 个 → shared/ 或 features/collab/components/
         SeatCard · TaskCard · MessageList · Composer · AltsCompare …

第 3 步  GroupsPage 退化为 ≤300 行的编排壳
```

**判据**：切完后 R4/R5/R6/R7 各自**只碰 1–2 个文件**，不再全部挤进同一个组件。
这就是「模块化」在前端的可验证含义。

### 5.4 D9 + R3：三层递进式审批 UI

D9（`useState<PendingApproval | null>` 单槽）与 D3 是同一个问题的两端：
后端并发 Ask 会互相覆盖，前端也只能显示一个。修完后端后，前端必须能承接**队列**。

```
第 1 层  就地卡片    审批出现在触发它的那条消息下方（上下文最强）
第 2 层  聚合条      顶部常驻 "3 个待审批" → 点开抽屉批量处理（多 Worker 场景）
第 3 层  系统送达    托盘/Dock 角标 + 通知（用户不在屏幕前时的唯一退路）
```

```ts
// shared/hooks/useApprovalQueue.ts —— 替代单槽
const { queue, current, decide } = useApprovalQueue();
// queue: ApprovalRequest[]   按 risk 降序 + 到期时间升序
// decide(id, ApprovalDecision)  四态
```

**四态在 UI 上的呈现**（关键：不要做成四个同权重按钮）：

```
┌─ Worker「数据分析」请求执行 run_shell ────────── 剩余 4:32 ┐
│  rm -rf ./tmp/cache                                      │
│                                                          │
│  [ 允许 ]  [ 改参数后允许 ]         [ 拒绝 ]              │
│            └ 点开变成可编辑参数框                          │
│  ┌ 或者告诉它换个做法 ─────────────────────┐  [发送]      │
│  └────────────────────────────────────────┘              │
└──────────────────────────────────────────────────────────┘
```

- **允许**是主按钮（最高频）；
- **改参数**是次级按钮，点击**就地展开**参数编辑，不弹新窗；
- **反馈**是一个输入框而非按钮 —— 因为它天然需要打字，做成按钮反而多一次点击；
- **倒计时可见**，让用户知道不处理会发生什么（fail-closed 到 `Ignore`）。

> 这个布局把 PRD 的"四态"翻译成了用户视角的**"一个主动作 + 两个补救 + 一个兜底"**，
> 而不是让用户在四个陌生名词里做选择题。

### 5.5 R7「单聊升级为群」的架构含义

这是报告判定**竞品结构上做不到**的独家能力，架构上要保证它**真的很轻**：

```
点击「升级为群」
 ├─ 不新建会话、不搬迁消息  ← 关键：同一 session_id 原地转视图
 ├─ 复用 build_worker_seed 把当前上下文作为群共享种子
 ├─ 一次 LLM 调用预填「建议席位 + 任务拆解」，用户只增删改
 └─ UI 从 ChatMode::session 切到 group，历史消息原样在场
```

**架构上唯一的新增是一个 `session.mode` 字段**，不是一套新实体。
之所以竞品做不到——AgentTeams 要建 `Team` CRD + 分配 Matrix 房间 + 起 Worker 容器，
AgentSpace 要建多租户 workspace 实体；**它们的"群"是重资源，我们的"群"是一个视图状态**。

**回退保护**：升级后若用户不满意可**降回单聊**（`mode` 改回即可，消息不动）。
PRD 的替代指标「升级后没退回的比例 ≥60%」正是靠这个字段采集。

### 5.6 收敛 D10：服务层与事件层的样板

```ts
// services/eventBus.ts —— 6 个 ~25 行的重复 subscribe → 1 个泛型工厂
export function createSubscription<T>(topic: string) {
  return (sessionId: string, cb: (payload: T) => void) =>
    listen<Envelope<T>>(topic, e => {
      if (e.payload.session_id === sessionId) cb(e.payload.data);
    });
}
export const onDelta    = createSubscription<DeltaPayload>('run:delta');
export const onToolEnd  = createSubscription<ToolEndPayload>('run:tool_end');
export const onApproval = createSubscription<ApprovalRequest>('run:approval');
```

`services/tauri.ts`（381 行 / 60+ 扁平函数）按域拆为
`ipc/{session,group,tool,approval,insight,settings}.ts`，
**每个域的函数签名与后端 commands 模块一一对应**——出问题时能直接对上。

---

## 六、需求 → 架构映射（每条 PRD 需求的落点）

| 需求 | 依赖动作 | 后端落点 | 前端落点 | 解决的诊断 |
|------|---------|---------|---------|-----------|
| **R1** MCP 工具打通 | A-3 | `mcp/session.rs`(新)、`McpToolProvider`、`ToolPlane` | 扩展页工具列表 + 席位白名单 | D4 D5 D7 |
| **R2** 运行记账落库 | A-5 | `kernel/ledger`、迁移 v{N+1} | — （数据底座） | D6 |
| **R3** Worker 审批四态 | A-4 | `ApprovalBroker`、`gate()` 阶段、拆 `engine.rs:665-669` | `useApprovalQueue` + 三层 UI | **D3′** D3 D9 |
| **R4** 席位运行仪表 | A-1 A-5 | `RunEvent::SeatState` + ledger 查询 | `features/insight/SeatDashboard` | D8 |
| **R5** 运行摘要条+甘特 | A-5 | ledger 聚合查询 | `features/insight/RunGantt` | D8 |
| **R6** 竞速备选并排 | — | 已有 `roundtable_alternatives` | `features/collab/AltsCompare` | D8 |
| **R7** 单聊升级为群 | — | `session.mode` 字段 + `build_worker_seed` | `ChatMode` 切换 | D8 |

**并行性**：A-1/A-2 是**前置重构**（必须先做，但不改行为）；
A-3/A-4/A-5 完成后，**R1、R3、R4/R5/R6、R7 四条线可并行开发**——
这正是拆 `run()` 和拆 `GroupsPage` 的直接收益。

**R6 是性价比之王**：数据已在库、无需后端改动，只差一个对比 UI。建议**第一个交付**，
用最小成本验证 insight 层的组件约定。

---

## 七、架构决策记录（ADR）

### ADR-001：内核通过 `RunObserver` 端口外发事件，不持有 `AppHandle`

**Status**：Proposed

**Context**：`<R: Runtime>` 已污染 8 个模块 27 处，内核反向依赖 UI 框架，导致无法单测、
无法复用；每加一个需要发事件的能力，泛型就再传染一层。

**Decision**：内核定义 `RunEvent` 与 `trait RunObserver`；`TauriObserver` 作为唯一适配器住在
adapters 层。CI 守卫 `kernel/` 禁止 `use tauri::`。

**Consequences**
- ✅ 内核可单测（`RecordingObserver` 断言事件序列）；泛型收敛到 ≤3 处
- ✅ 未来换 UI 框架 / 加 CLI 模式，内核零改动
- ⚠️ 多一次动态派发与结构体构造（相对 LLM 往返可忽略）
- ⚠️ 事件类型需在内核与前端间保持同步（用 `ts-rs` 或手工契约测试兜住）

---

### ADR-002：审批以 `ApprovalId` 为键，决策为四态枚举，并按序拆除 Worker 降级

**Status**：Accepted（M2.5 T0 / T0.5 / T1 已落地）

**Context**：三件事绑在一起——
① `engine.rs:665-669` 把 Worker 的 `Ask` 强降为 `Deny`，**这是 Worker 只读的成因**
（但它当初是正确的 fail-closed 选择，因为 Worker 没有审批通路）；
② 决策类型 `bool` 无法表达 PRD 的四态；
③ `HashMap` 以 session_id 为键，是并发覆盖的潜在隐患（当前基本打不中，见 §1.2 可达性核实）。

**Decision**：`ApprovalBroker` 以 `ApprovalId` 为键；决策改为四态枚举；带 `expire_at`，
超时 **fail-closed** 到 `Ignore` 并落账 `timeout_deny`。
**严格按序执行**：先建审批冒泡通路 → 再拿掉 D3′ 降级 → 最后才允许并行工具执行。

> **顺序不可颠倒**：若先删降级、后建通路，Worker 会从"只读"退化成"挂死"，
> 这比现状更糟。这是本 ADR 最重要的一条约束。

**实现落地（M2.5 T0 / T0.5 / T1）**：
- **第一划分是「人在不在场」而非「是否 Worker」**：`SessionKind` 三态
  `User` / `AttendedWorker`（人在 → Mediated 工具走 Ask 冒泡）/ `UnattendedWorker`（无人 → Mediated 走 Deny）。
- **权限判定从白名单改为 `RiskClass` 谓词**：`Safe`（`read_file`/`write_file`/`list_dir`/`get_weather`）
  → 直接放行；`Mediated`（`mcp__*`/`skill__*`）→ Ask 冒泡；`Dangerous`（`run_shell`/`update_memory`）
  → 拦截。取代了原 `WORKER_DEFAULT_ALLOWED` 静态白名单。
- **D3′ 降级已拆除**：Worker 的 Mediated 工具走 `ApprovalGate` 冒泡（全局 `ApprovalTray`：
  键盘 Y/N/E + 本轮全部批准 + 本次会话豁免）；主会话审批仍走内联卡片，按 `rt:` 前缀分流互不重复。
- 群协作 Worker 审批（`session_id` 以 `rt:` 开头）由全局 `ApprovalTray` 接管，与单人主会话审批并行不悖。

**Alternatives considered**
| 方案 | 否决理由 |
|------|---------|
| 键改为 `(session_id, tool_call_id)` | 能修并发，但仍无法表达四态；且元组键不利于前端引用 |
| 队列化串行审批（一次只允许一个） | 会让并行 Worker 退化成串行，与群协作目的冲突 |

**Consequences**
- ✅ **Worker 从只读恢复为可执行**（拿掉 D3′ 后仍安全，因为已有冒泡通路）
- ✅ 四态可承载 `Edit`（PRD 判定价值最高）与 `Respond`（把审批变成对话）
- ✅ 超时有确定行为，杜绝静默停滞（单机无"推给同事代批"退路）
- ✅ 顺带根治 D3② 的键覆盖隐患，为将来"单轮内并行工具执行"扫清障碍
- ⚠️ 审批协议破坏性变更 → 保留一版 `#[deprecated]` 旧命令过渡
- ⚠️ 前端必须从单槽改为队列（D9），不能只改后端
- ⚠️ **安全面扩大**：Worker 从"不能写"变成"可申请写"，
  必须配合 `ToolScope` 白名单（ADR-003 / NG3），否则是净负向

---

### ADR-003：工具结果区分 `Ok / Failed / Unavailable` 三态

**Status**：Proposed

**Context**：`Result<String, String>` 把「工具跑了但失败」与「工具根本没跑起来」
塌缩成同一种错误，导致 LLM 对着挂掉的 MCP Server 反复重试烧钱，
也无法满足 FR1.3「断网时提示网络不可达而非 Agent 失败」。

**Decision**：三态 `ToolOutcome`；`Failed` 喂回 LLM 允许重试，`Unavailable` 直接中止该工具路径
并向用户呈现原因。

**Consequences**
- ✅ 省钱（避免无效重试）；错误提示准确；`run_steps.unavailable_reason` 可统计 MCP 可用率（D3 指标）
- ⚠️ 所有 `ExecutableTool` 实现需迁移返回类型（一次性机械改动）

---

### ADR-004：MCP 会话常驻 + 空闲回收，而非每次调用重连

**Status**：Proposed

**Context**：现状 `test()` 每次 spawn→handshake→list→kill。若 `tools/call` 沿用此模式，
每次工具调用都要付一次冷启动（stdio 进程启动 + 握手），延迟不可接受。

**Decision**：`McpSession` 常驻，引用计数 + 空闲 N 分钟回收；首次调用前 `preflight()`；
删除 `test_http` 中的嵌套 runtime（`block_on`）。

**Alternatives considered**：连接池 / supervisor 框架 —— 单机场景下 server 数量是**个位数**，
引入池化是过度设计（违反"no architecture astronautics"）。

**Consequences**
- ✅ 调用延迟从"每次冷启动"降到"仅首次"
- ⚠️ 需管理子进程生命周期（僵死检测），这是新增的失败模式
- ⚠️ 长驻进程占内存 —— 用空闲回收兜住

---

### ADR-005：成本在查询期折算，不在写入期固化

**Status**：Accepted（M2.5 T4 已落地）

**Context**：R2 要显示成本。若写入时就把 `¥` 算好存库，模型单价调整后历史数据永久错误且不可修。

**Decision**：`run_steps` 只存 `model` + token 数；单价表独立可编辑；`¥` 在查询期 join 折算。

**实现落地（M2.5 T4）**：
- 单价表落地为 `settings` 表的 `cost_table` 键（JSON 字符串），**复用既有 settings 表，不新建表**（ADR-006 只加表原则在此以「加键不建表」落实）。
- `CostTable { entries: Vec<CostEntry> }`，`CostEntry { pattern, in_price, out_price }`；
  `lookup` 按模型名子串匹配、`"*"` 兜底。
- `CostTable::builtin_default()` 提供内建默认（deepseek / gpt-4 等），当 `settings.cost_table`
  缺失或解析失败时回退，**零行为变更**。
- `cost_yuan(table, model, prompt_tokens, output_tokens)` 取代原硬编码 `match`，
  由 `InsightQueries::cost_table()` 在查询期载入——恪守「写入期不固化金额」初衷。

**Consequences**
- ✅ 单价可回溯修正；用户换 provider 不污染历史
- ✅ 单价表用户可改（settings 表），无需改代码或加表
- ⚠️ 查询期需载入并解析 `cost_table`（失败有 builtin 兜底，不阻断）

---

### ADR-006：只加新表，不改既有表

**Status**：Accepted

**Context**：sessions/messages/settings/groups/seats/tasks 已有生产数据，
用户本机数据库无法"重建"（单机无服务端迁移窗口）。

**Decision**：R2 只新增 `runs` / `run_steps`；R7 仅给 session 加一个可空 `mode` 字段。

**Consequences**：✅ 回滚 = drop 新表，零数据风险；⚠️ 无法顺手清理历史遗留字段。

---

### ADR-007：前端按状态归属分层，禁止"大爆炸重写"

**Status**：Proposed

**Context**：`GroupsPage.tsx` 2327 行 / 18 useState，四个新需求都要往里加 UI。
但重写会连带 E2E 全挂（现有 30/30 绿）。

**Decision**：按**状态归属**三步切分（服务器状态 / 表单状态 / UI 状态 → 3 个 reducer），
每步保持 E2E 绿。目标：`GroupsPage` ≤300 行编排壳。

**Consequences**
- ✅ 四个需求各自只碰 1–2 个文件，可并行
- ⚠️ 过程中会短暂存在"新旧两套状态并存"，需严格控制窗口期

---

### ADR-008：群是视图状态，不是重资源实体

**Status**：Proposed（**战略性**）

**Context**：竞品的"群"是重资源（AgentTeams 的 `Team` CRD + Matrix 房间 + Worker 容器；
AgentSpace 的多租户 workspace 实体），因此它们**结构上无法做到"单聊一键升级为群"**。

**Decision**：OneDesktop 的群 = `session.mode` 的一个取值。
升级不新建会话、不搬迁消息、不起容器；可无损降回单聊。

**Consequences**
- ✅ R7 成立，且是竞品结构性做不到的差异化
- ✅ 升级/降级都无损，用户敢试（这直接影响 PRD 的采用率替代指标）
- ⚠️ 放弃了"群有独立生命周期/独立资源配额"的可能性 —— 单人场景下不需要
- ⚠️ 若未来真要做多设备同步，这个选择会成为约束（但那已被 PRD §0 列为永不做）

---

### ADR-009：结构化黑板采用版本化 CAS 一致性模型

**Status**：Accepted（M3a 开工前定，F7 落地）

**Context**：F7 让多个 Worker 共享中间产物/状态（替代"文件传话"）。并发写同一块
（如两个 Worker 都想更新同一汇总键）必须有一致性模型。三选一：
① 最后写入胜出（LWW）；② 版本化 CAS（compare-and-swap with version）；③ 事件溯源。

**Decision**：**版本化 CAS**。每条目带 `version: u64`；写入须携带期望版本，版本不匹配则
拒绝并返回当前版本，调用方按返回版本重试。

**Alternatives considered**
| 方案 | 否决理由 |
|------|---------|
| LWW（最后写入胜出） | 静默覆盖、难排查；一个慢 Worker 会无声覆盖快 Worker 的结果 |
| 事件溯源（全量事件重放） | 单机单群场景过度设计，违反"no architecture astronautics" |

**Consequences**
- ✅ 与 `roundtable_alternatives` 竞速思路一致（已验证），崩溃可重放、可观测
- ✅ 无分布式锁——单机红利，Agent×Agent 冲突只需版本化即可
- ⚠️ 调用方需处理 `Conflict` 重试（架构提供 `BlackboardError::Conflict(current_version)` 直接给当前版本，重试成本低）

---

### ADR-010：MessageBus 为独立内核端口（不并入 RunObserver）

**Status**：Accepted（2026-08-04 决议 #3 已拍板）

**Context**：F5 Worker 间通信需要**双向点对点投递**（Worker↔Worker，需寻址、需回执、
丢了任务就断）。而 `RunObserver` 是**单向出向广播**（内核 → UI，无回执、无路由、
丢了不影响正确性）。二者**失败语义完全相反**——把它们塞进一个 trait，必然出现
"这个方法在这个实现里没意义"的空实现，典型接口污染。

**Decision**：新增独立内核端口 `MessageBus`（进程内投递 + Tauri Event 上行），
**不并入 `RunObserver`**。端口计数随 T2 `EventBus`、F7 `Blackboard` 之后再次 +1（既独立端口）。

**Consequences**
- ✅ 接口不污染——`RunObserver` 永远不需要"投递回执"这类无意义方法
- ⚠️ 内核出向端口再 +1（与 T2 去 Tauri 化新增的 `EventBus`、F7 `Blackboard` 同理，是独立端口而非并入既有），
  `ToolRunDeps`（原 `RunDeps`）结构体 +1 字段
- ⚠️ 缓解：M2.5 已把散装参数收进 `ToolRunDeps` 参数对象，新增端口只是加字段而非加参数
- 📌 **F5 实现注记（SQLite 邮件箱，非进程内 channel）**：MVP 选 SQLite 持久化邮件箱
  （`message_log` 表 + 索引，ADR-006 只加新表）而非路线图 §3.1 字面写的"进程内 channel"。
  理由：① 与 F7 黑板 / R2 账本同库同源，崩溃可恢复、统一观测；② 离线可测（临时 DB round-trip）；
  ③ 内核端口 trait 与存储解耦，后续若需低延迟可加 in-memory 快路径适配器而不改调用方。
  代价：投递为轮询模型（Worker 取 `pending_for` + 显式 `mark_delivered`），延迟高于 mpsc，
  但 Agent 协调场景延迟非瓶颈。**可逆**——端口契约不变，换存储只换适配器。

---

### ADR-011：拓扑策略求值时机 = 建群时固化 + 运行期可热更

**Status**：Accepted（M3a 开工前定）

**Context**：F12 定义"谁能跟谁说话"，F5 路由时需按拓扑策略求值。时机三选一：
① 路由时动态求值（灵活，但每次路由都算、策略变更影响进行中任务）；
② 建群时静态固化（可预测，但改策略需重建群）；
③ 混合。

**Decision**：**建群时固化（拓扑快照）+ 运行期可热更**。建群时确定拓扑快照给可预测性
（默认最小权限：Worker 默认不可互访，需显式授权）；运行期允许显式热更（重算路由表）
以适应策略调整。

**Alternatives considered**
| 方案 | 否决理由 |
|------|---------|
| 纯路由时动态 | 进行中任务路由随策略飘忽，难复现、难排查 |
| 纯建群时静态 | 调策略必须解散重建群，用户体验差 |

**Consequences**
- ✅ 进行中任务路由稳定可预测；策略调整走显式热更，不惊扰存量任务
- ⚠️ 热更需要广播失效旧路由表（F12 落地时实现，本 ADR 仅定时机）
- 📌 MVP 阶段 F5 可先用占位策略（默认最小权限 → 全不通，需显式授权），
  F12 成熟后接管求值——端口与时机已定，策略引擎可晚到

---

### ADR-012：黑板持久化采用 SQLite（复用 RunLedger 连接）

**Status**：Accepted（M3a 开工前定，F7 落地）

**Context**：黑板数据存哪。两选一：① 纯内存（快，但崩溃丢、与 R2 观测割裂）；
② SQLite。

**Decision**：**SQLite**，复用 RunLedger 的 `DbConnection`（A-5 底座），新建 `blackboard`
表（遵守 ADR-006 只加新表，回滚 = `DROP TABLE blackboard`，零数据风险）。

**Consequences**
- ✅ 崩溃可恢复 + 与 R2 统一观测（同库、同一连接、同一迁移体系）
- ✅ 与 ADR-005「查询期折算」一致：磁盘存原始、查询期派生
- ⚠️ 多一次落盘（黑板读写非热路径，可接受；后续可走事件总线 + 批量刷盘优化，见路线图 §7）

---

### ADR-013：任务心跳与卡死回收（F6 防死锁）

**Status**：Accepted（M3a 地基三件套收尾，2026-08-04 落地）

**Context**
- 群协作任务 dispatch 后置 `InProgress`，由 Worker 引擎执行。若引擎卡死（单轮 LLM hang）或进程崩溃，任务永久停 `InProgress`，成为**僵尸任务**：阻塞 `depends_on` 其的下游任务，且占用 Worker 席位（`Busy` 不释放）。
- `workers` 表已有 `last_heartbeat`（Worker 级存活信号），但**任务级**执行活跃度无信号——Worker 空闲 ≠ 任务没卡死，层级不对。
- 本环境 `integration_test` 与历史故障均出现过「任务静默挂起无回收」现象，印证缺回收机制。
- 路线图 F6：心跳由 executor 周期写状态位；scheduler 超时回收；fail-closed 不丢 run 数据。

**Decision**
1. **状态位**：`tasks` 表加 `last_heartbeat INTEGER`（additive：CREATE 直接含列 + `run_migrations` 末尾 ALTER 兼容旧库，遵守 ADR-006）。
2. **端口**：新增 tauri-free 内核端口 `TaskHeartbeat`（`beat(task_id)`），由 `executor` 层在任务活跃期启动**后台心跳 ticker**（每 `HEARTBEAT_INTERVAL_SECS` 写一次），`engine.run` 完成后 ticker 自动 abort。**不侵入引擎循环**（外科手术式，可逆）。
3. **回收**：`TaskBoardRepository` 加 `beat` / `find_stale(timeout_secs)`；`TaskScheduler` 加 `sweep_stale_tasks(timeout_secs)`——扫 `status='InProgress' AND (last_heartbeat IS NULL OR last_heartbeat < now-timeout)` 的任务，转 `Failed`（fail-closed，**保留 `runs`/`run_steps` 数据不丢**，供事后诊断）。
4. **触发（MVP）**：`sweep_stale_tasks` 暴露为可调用纯方法（命令/定时后续接），先落纯逻辑 + 单测；MVP **不引入后台定时扫描**（避免异步生命周期复杂度）。

**Consequences**
- ✅ 卡死任务可回收，无僵尸残留（路线圖 M3a 验收项达成）；fail-closed 不丢 run 数据。
- ✅ 心跳在 executor 层、端口 tauri-free，不污染引擎、不破内核纯净度（T2 去 Tauri 化成果）。
- ⚠️ +1 概念（心跳 ticker）+ `tasks` 加列；**所有 `tasks` SELECT 需同步加 `last_heartbeat` 列**（机械改动，漏改会列 index 错位）。
- ⚠️ 回收为 `Failed` 而非自动重试——重试/重调度归 F12 拓扑策略（避免 MVP 瞎重试放大故障）。
- ⚠️ 频率（`HEARTBEAT_INTERVAL_SECS`）与超时（`sweep` 入参）为经验参数，后续按 dogfooding 调；MVP 取 5s / 60s。

**Alternatives（被否）**
- 引擎循环内插桩 beat：侵入引擎签名、需把 `task_id` 传播到 `ToolRunDeps`，MVP 成本过高。
- 复用 `workers.last_heartbeat`：层级错，Worker 存活 ≠ 任务执行活跃。
- 回收即自动重试：坏数据风险（部分完成的副作用难回滚），违背 fail-closed。
- 后台常驻定时 sweep：引入异步调度生命周期，MVP 不必要。

---

### ADR-014：通信拓扑策略 —— 声明式默认拒绝 + 显式授权边

**Status**：Accepted（M3b 开工 F12 落地）

**Context**
F5 `MessageBus::post` 当前**无任何路由校验**——任意 Worker 可向任意 Worker 发消息（`AgentMessage` 注释已预留「消息语义由 F12 拓扑策略约束」）；F7 黑板同样存在"谁可读写哪块"的授权缺口。PRD §6 硬约束：拓扑策略**必须先于 F5 的规模化使用**。ADR-011 已锁定求值**时机**（建群时固化快照 + 运行期热更），本 ADR 锁定**策略模型本身**。

**Decision**
1. **模型**：声明式 `TopologyPolicy { version, default, edges[] }`。`default` 默认 `Deny`（最小权限）；`edges[]` 为**显式授权 allow 列表**（无显式 deny——默认拒绝已覆盖"拒绝"语义，双语义徒增评估歧义）。
2. **端点** `Endpoint::{All, Worker(id)}`；**通道** `Channel::{Message, Blackboard, Mention}`，策略按通道分别授权。
3. **纯求值** `evaluate_topology(policy, from, to, channel)`：`from==to` 恒 `Allow`（自语无害）；否则遍历边，命中 `from/to` 匹配且 channel 命中（边 `channels` 空=全通道）则 `Allow`；无匹配回退 `default`（Deny）。复杂度 O(edges)，Worker 个位数无需预计算路由表（那会是过度设计）。
4. **快照载体**：additive `topology_policies` 表（`group_id, version, policy_json, created_at`，`UNIQUE(group_id, version)`，索引按 version DESC）。建群落 v1；热更落更高版本，`latest_for_group` 取生效版。回滚 = `DROP TABLE`，零数据风险（ADR-006）。
5. **建群即固化**：`GroupRepository::create` 在落群后写一条 v1 默认策略（deny-all），使每个群自带拓扑快照，契合 ADR-011「建群时固化」。
6. **本切片不接入路由**：`MessageBus` / `Blackboard` 维持占位策略，求值器独立存在、完全可逆。路由层（F12 成熟期）调用 `evaluate_topology` 做放行判定；调用方对无快照群用 `TopologyPolicy::default()` 兜底（同 deny-all）。

**Alternatives considered**
| 方案 | 否决理由 |
|------|---------|
| 策略嵌入 `groups.seat_config` JSON | 该列已承载席位配置，混用难版本化/热更；新表 additive 更干净（ADR-006） |
| allow + deny 双语义边 | MVP 不需要；默认拒绝已表达"拒绝"，双语义徒增评估歧义与边界 case |
| 预计算路由表（邻接矩阵） | Worker 个位数，O(edges) 遍历足够；矩阵是过度设计（违反"no architecture astronautics"） |

**Consequences**
- ✅ 默认最小权限落地：Worker 间默认不通，杜绝"一个 Worker 擅自指挥另一个"的自组织失控（PRD §8 护栏：人始终保中断权）
- ✅ 纯函数可单测、零 Tauri 依赖，不破内核纯净度；后续路由接入只是"调一个纯函数 + 取快照"
- ✅ 快照版本化 + 热更通道已预留，运行期调策略不惊扰存量任务（呼应 ADR-011）
- ✅ 每个群自带 v1 deny-all 快照，路由层接入时有确定默认行为
- ⚠️ 本切片仅为地基：真正的"路由时拦截"需后续把 `evaluate_topology` 接进 `MessageBus::post` / `Blackboard::cas_write` 的调用方（届时补路由层单测）
- ⚠️ 群主席位（主会话，非 `rt:` 前缀）不在拓扑域内——路由层接入时需单独约定 owner 可达性（本 ADR 不覆盖）

---

### ADR-015：拓扑策略路由层接入（F12 生效点）

**Status**：Accepted（M3b F12 路由层落地）

**Context**
ADR-014 锁定了声明式拓扑模型与纯求值器 `evaluate_topology`，但 `MessageBus::post` / `Blackboard::cas_write` 仍是占位、零校验，F12 尚未真正生效。用户拍板走选项 A：把 `evaluate_topology` 接进这两个端口的调用方，并补路由层单测。

**Decision**
1. **enforcement 落点 = 端口适配器内部、落库前**（单一 chokepoint，无法旁路）。不新增内核端口、不改 `MessageBus` / `Blackboard` trait 签名（完全可逆）。
2. **仅约束 `rt:{group}:{worker}` Worker 会话**；主会话（非 `rt:` 前缀）不在拓扑域内，旁路放行（呼应 ADR-014「主会话天然可达」）。判定逻辑收束到 `group/topology_router.rs::enforce_topology(db, from_session, to_endpoint, channel)`。
3. **通道映射**：`MessageBus::post` 固定 `Channel::Message`，`to` 取自收件方 session（非 Worker 收件方→旁路）；`Blackboard::cas_write` 固定 `Channel::Blackboard`，`to = Endpoint::All`（共享空间）。
4. **fail-closed**：Worker↔Worker 无策略快照 / 读取失败 → 默认拒绝（`RoutingDenied`）。错误变体 `MessageBusError::RoutingDenied(String)` / `BlackboardError::RoutingDenied(String)` 仅携带原因文本，**不**让 `agent::ports` 反向依赖 `group`（保持内核端口纯净）。
5. **自语恒放行**：`evaluate_topology` 的 `from==to` 规则天然覆盖 Worker 写自己黑板、给自己发消息。

**Alternatives considered**
| 方案 | 否决理由 |
|------|---------|
| 在 `commands/group.rs` 等调用方强制 | 调用点零散（当前虽仅 roundtable 命令，但后期 Worker 引擎内也会写黑板），易漏接旁路；适配器内部强制是唯一点 |
| 在 `agent::ports` 端口 trait 内嵌 `RouteDecision` | 会让内核端口反向依赖 `group` 模块，污染承重墙；错误用 `String` 原因即可满足 MVP 观测 |
| 预计算路由表 / 独立 RoutingService 端口 | Worker 个位数，调一个纯函数足够；新增端口是过度设计 |

**Consequences**
- ✅ F12 真正生效：Worker↔Worker 消息与 Worker 写黑板受默认拒绝 + 显式授权约束
- ✅ 完全可逆：未改 trait 签名、未新增端口；撤回 = 删 `enforce_topology` 调用两处
- ✅ 主会话 / CLI 等非 `rt:` 通道不受 Worker 拓扑误伤（避免单机单人多 Agent 场景自锁）
- ✅ 零 Tauri 依赖、内核纯净度不破；路由层单测 6 例 + 适配器单测 6 例全绿
- ⚠️ 群创建已固化 v1 deny-all，故未配置边的群 Worker 间默认全不通——需配套拓扑编辑 UI / 命令（后续 F12 热更面）才能放开
- ⚠️ `Mention` 通道（roundtable @ 扇出）尚未接入路由层，留待 roundtable 调用方成熟

---

### ADR-016：roundtable Mention 路由 + 拓扑编辑入口

**Status**：Accepted（M3b F12 收口，2026-08-04 落地）

**Context**
- ADR-014 §6 明载「群主席位（主会话，非 `rt:` 前缀）不在拓扑域内——路由层接入时需**单独约定** owner 可达性（本 ADR 不覆盖）」。`Channel::Mention` 已在模型中定义（注释「roundtable @ 扇出 / 群内广播可达性」），但 `RoundtableBus::post` 的 @ 扇出**尚未接路由**，且 deny-all 群无法被放开（缺编辑入口）——ADR-015 末尾两条 ⚠️ 正待解决。
- 用户拍板：先给 roundtable 接 `Mention` 路由 + 配套拓扑编辑入口。

**Decision**
1. **@ 扇出源视作群（Endpoint::All）**：`RoundtableBus::post` 对每个被 @ 的 `worker_id` 调
   `enforce_mention(db, group_id, worker_id)`（群组 `GROUP_SOURCE=""` 哨兵匹配 `Endpoint::All` 的
   `from` 边，`Channel::Mention`）。判定 deny → **跳过该 Worker（不扇出）+ `tracing::warn!`**，
   owner 消息仍正常落库 + 广播事件；非硬错误（避免一次误配让整条发言失败）。
2. **`broadcast`（全员竞速）不门控**：它是群主对「全体 Worker」的指挥权（呼应 PRD §8「人始终保
   中断权」），保持开箱即用，不受 deny-all 影响。仅 `post` 的**定向 @** 走 Mention 拓扑。
3. **fail-closed**：无策略快照 / 读取失败 → 默认拒绝（@ 不到任何 Worker）。群创建已固化 v1
   deny-all，故**默认 @ 不到 Worker，需经编辑入口显式授权 `[All → Worker(w)] Mention`**。
4. **拓扑编辑入口（Tauri 命令，不新增内核端口）**：
   - `group_topology_get(group_id) -> TopologyPolicy`：取当前生效版本，无快照回退 `default()`。
   - `group_topology_set(group_id, policy) -> u64`：全量替换式热更，`repo.commit_next` 以
     `next_version` 落更高版本（保留历史、可回滚）。`policy.version` 被忽略、按 `next_version` 重算。
   - 前端编辑 UI / CLI 读 `get` → 本地增删改边 → 回传 `set`，即完成授权。

**Alternatives considered**
| 方案 | 否决理由 |
|------|---------|
| @ 扇出源视作群主 session（非 rt: 旁路） | 会让 Mention 拓扑恒放行、整条 feature 空转，与「编辑入口才有意义」矛盾 |
| @ 与 broadcast 同时门控 | 开箱 deny-all 下 broadcast 也失效，群主「指挥全体」权被误伤，违背「人保中断权」 |
| 编辑入口用「增量 grant 命令」 | 全量 `set` 已覆盖增/删/改，前端编辑更直观；增量命令是 `set` 的特例，MVP 不另造 |
| 改群创建 seed 为「Mention 全开」 | 违背 ADR-014 §5「建群即固化 deny-all」，最小权限默认不可退 |

**Consequences**
- ✅ `Mention` 通道真正生效：群→Worker 定向 @ 受最小权限约束，deny-all 默认不可 @ 召唤
- ✅ 编辑入口落地：deny-all 不再「死锁」——可显式授权 `[All → Worker(w)] Mention` / `[All → All] Mention`
- ✅ 完全可逆：`post` 删 `enforce_mention` 调用即退回无路由；撤两命令即关编辑入口；均不破 trait / 不破端口
- ✅ 不新增内核端口、零 Tauri 依赖（`enforce_mention` 住 `group/`，命令住 adapters 层），内核纯净度不破
- ⚠️ 开箱 deny-all 下**定向 @ 默认无响应**（设计预期，非 bug）——靠编辑入口放开；`broadcast` 不受影响
- ⚠️ 仅门控 `post` 的 @；未来 Worker↔Worker 互相 @（协作中派活）复用同一 `enforce_mention` 即可，无需新机制
- ✅ 路由层单测补 3 例（deny-by-default / All 边放行 / 指定 Worker 作用域），全绿

---

### ADR-017：F4 声明式群 Manifest（与 F12 同源 schema）

- **状态**：Accepted
- **日期**：2026-08-04

#### Context
路线图 M3b 把 F4 定为「声明式文件定义群/Agent 拓扑，与 F12 同源」；用户拍板取此语义（非竞品研究里的「`.claude/agents` Agent 可移植」分支）。现状：建群只能靠 UI 逐步填 `CreateGroupPayload`，拓扑在工程层被强制 `TopologyPolicy::default()`（deny-all），无法一次声明「这群有哪些席位、谁许跟谁说话」。ADR-011 已锁「建群固化 + 运行期热更」时机，ADR-014/015/016 已把拓扑词汇（端点/通道/边）与路由层铺好——F4 只需复用，不该另造一套拓扑表达。

#### Decision
1. **`GroupManifest` 纯结构**（`group/manifest.rs`，零 Tauri 依赖、可单测）：`{ name, goal, owner_agent_ref?, seats[], topology: TopologyPolicy }`。`topology` 字段**即 F12 的 `TopologyPolicy`**——端点/通道/边词汇完全一致，单一事实源，无第二套拓扑语言。
2. **Manifest 是「建群种子」，优先级低于 F12 运行期编辑**：建群时 `GroupRepository::create_with_topology` 经 `TopologyPolicyRepository::commit_next` 把 manifest 拓扑落 **v1**；后续 `group_topology_set`（ADR-016）在其上叠 v2+。manifest 文件本身不锁定群——运行期改拓扑后文件会过期（导出/重同步留待后续）。
3. **席位复用既有 spawn 路径**：`seats[].agent_ref` 映射进 `seat_config.static`（约定 `{"static":[...]}`），`GroupManager::create_group_from_manifest` 抽出 `spawn_static_seats` 与 `create_group` 共用，不新造 Worker 注册逻辑。
4. **入口**：纯 `GroupManifest::from_json`（仅 `serde_json`，不新增 YAML 依赖）+ 命令 `group_create_from_manifest(manifest_json: String)`（前端读文件传原文）。位置：编排层 `GroupManager` + adapters 层命令，内核端口计数不变（仍 8）。
5. **格式 = JSON（MVP）**；`SeatSpec.role`/`max_instances` 已解析但暂不消费（前向兼容，避免过度抽象）。

#### Consequences
- ✅ 一键可复现建群：群结构 + 拓扑进版本库（JSON 即文本，可 diff/PR），契合「单机、数据零外传」基线
- ✅ 拓扑词汇唯一：F4 与 F12 同构，编辑入口 / 路由层 / manifest 三者共用 `TopologyPolicy`，无漂移
- ✅ 完全可逆：`create_with_topology` 与 `create` 并列（旧 UI 路径零改动）；撤命令/模块即关 feature，不破 trait / 端口 / 既有 `create_group`
- ⚠️ **明确不做**（本切片边界）：① 不导入 `.claude/agents` AgentProfile（竞品研究那条 F4 分支，留待 Agent Catalog 任务）；② 不 spawn `role`/`max_instances` 语义（WorkerPool 当前不支持）；③ 不导出群→manifest（运行期改拓扑后文件会过期，需 `export_manifest` 反向能力，留待后续）；④ YAML 导入未做（避免新依赖，JSON 已够）
- ⚠️ manifest 是种子非契约：运行期 `group_topology_set` 改过的群，其 manifest 文件不再反映真值——这是「优先级低于 F12」的必然代价，需在 UI/文档明示

---

### ADR-018：F8 Skill 预算护栏（最小可逆切片）

- **状态**：Accepted
- **日期**：2026-08-04

#### Context
路线图 M3b 把 F8 定为「按 skill 设 token/时间/成本上限，扩展 R2 成本模型，复用 RunLedger 成本折算，超限自动转审批」；验收标准即「skill 超预算自动转审批」。竞品研究（F8 段）进一步拆出两半：① **Skill 三级预算加载**（progressive disclosure，仅 L1 元数据进上下文）与 ② **调度 skill action 接通**（scheduler/engine.rs 当前 `ActionType::Skill => "Skill 执行暂未接通"`）。用户本次明确只取「**预算护栏**」这一半，未要求做加载分级或接通 skill 执行。现状约束：**skill 执行链路尚未接通**，故「已消耗成本」无实时数据源；权限层 `permission::decide()` 是纯函数、不感知消耗。护栏必须焊在 `engine_toolrun.rs:161` 的 `decide()` 调用点，且不能改 `decide` 签名（保持可逆）。

#### Decision
1. **模型**（`skill/budget.rs`，零 Tauri 依赖、可单测）：`SkillBudget { token_limit / cost_cents_limit / time_secs_limit: Option<u64> }`——三者皆 `Option`，`None` = 不限（护栏自动 no-op，**对存量 skill 零行为变更**）；`SkillUsage { tokens, cost_cents, elapsed_ms }`；`BudgetVerdict { Within, Exceeded(reason) }`。
2. **纯求值器** `SkillBudgetGuard::evaluate(budget, usage) -> BudgetVerdict`：任一维度超限即 `Exceeded`；全 `None` 预算 → `Within`。无 I/O、无 DB，单测可全盖。
3. **内核端口** `SkillBudgetTracker: Send + Sync`：`get_budget` / `get_usage` / `set_budget` / `record_usage` / 默认方法 `check(run_id, skill_id) -> BudgetVerdict`（内部拼预算+用量交 `evaluate`）。SQLite 实现 `SqliteSkillBudgetTracker` 住 `skill/budget_repo.rs`。
4. **存储**（additive，ADR-006）：`skill_budgets(skill_id PK, token_limit, cost_cents_limit, time_secs_limit, version)` + `skill_budget_usage(run_id, skill_id, tokens, cost_cents, elapsed_ms, PK(run_id,skill_id))`。
5. **注入（复用既有模式）**：`AgentLoopEngine` 加 `skill_budget: Arc<dyn SkillBudgetTracker>`（与 `ledger`/`approval` 同款），沿 `LoopCtx → ToolRunDeps` 透传为 `&'a dyn`，在 `engine_toolrun.rs:161` 落库前应用护栏：skill 工具 `decide` 后取 `skill_id_of(call.name)`，若 `check` 为 `Exceeded` → `perm = Permission::Ask`（升级人工审批，不静默放行）+ `tracing::warn!` 记原因。
6. **用量记录**：skill 工具**成功执行**路径（`record_tool_step` 成功后，`step_start` 在作用域内）调 `record_usage(run_id, skill_id, {elapsed_ms: step_start.elapsed(), tokens:0, cost_cents:0})`。时间维度立即生效；token/cost 维度字段已就位，待 skill 执行接通 + 逐步成本记账回填（见后果 ⚠️）。

#### Consequences
- ✅ 护栏真实可触发：skill 工具在预算内走原 `decide` 矩阵，超预算即升级 Ask——满足「超预算自动转审批」验收
- ✅ 完全可逆：`decide` 签名未动；不接 tracker 时 `get_budget` 返回全 `None` → 恒 `Within` → 行为与今日一致；撤模块/字段即关 feature
- ✅ 零基线破坏：存量 skill 无预算配置 → 护栏恒 no-op；内核端口计数仍 8（tracker 非第 9 端口，住 `skill/` 策略模块）
- ✅ 可测：`evaluate` 纯函数 + `budget_repo` 往返 + 用 mock tracker 测 `check`，三处单测不依赖引擎/网络
- ⚠️ **已知数据缺口（本切片刻意不补）**：token/cost 维度目前记录 0，因 skill 执行未接通、RunLedger 无逐步 token 记账。护栏在**时间维度**立即有效；token/cost 维度的真实生效需：(a) scheduler skill action 接通（F8 另一半）+ (b) `RunStep` 携带逐步 token，`origin_of` 返回 `skill:{id}`。这两项列为后续，不混入本切片以免过度抽象
- ⚠️ 不做 Skill 三级预算加载（L1/L2/L3 progressive disclosure）——那是 F8 的另一半，范围更大且依赖 skill 执行接通，本切片不碰
- ⚠️ 不做 scheduler `ActionType::Skill` 执行接通——同上，超出「预算护栏」边界

---

### ADR-019：F11 CLI 诊断 + IX-16 能力体检面板（统一诊断子系统）

- **状态**：Accepted
- **日期**：2026-08-04

#### Context
路线图 M3b 把 **F11（CLI 诊断 / tool approval bridge）** 与 **IX-16（能力体检面板）** 同批。竞品研究明确：**IX-16 与 F11 共用同一份诊断数据**（`competitive-research` §IX-16/§M3 补录）。F11 的 CLI 执行器 preflight / 失败分类 / 会话回退，与 IX-16 的「把『为什么这个席位干不了活』变成可枚举清单」本质是同一件事的两端——前者是诊断的**触发与分类**，后者是诊断的**呈现**。竞品（AgentSpace Diagnostics）枚举四类问题：`missing grants`（缺授权）/ `revoked credentials`（凭证已吊销）/ `orphaned grants`（授权指向已不存在的对象）/ `unavailable providers`（运行时不可用）。

现状痛点：多 Agent 系统失败时最典型的用户体验是「它没反应 / 它说它做不了」，而真实原因藏在配置、凭证、网络、版本兼容里——纯黑盒。本产品单机、1 人、无 RBAC，但「启用却连不上的 MCP 服务」「指向已删技能的孤立预算」这类**可由本机状态确定性判定**的问题完全可见，做成可枚举清单即用最低成本兑现 IX-16 的产品价值。

关于 FR3.6（外部 CLI 席位的权限请求走冒泡）：当前 `permission::decide()` + `ApprovalBroker` + `ApprovalTray` 已让**所有** Worker（含 CLI/run_shell 触发的执行）的 Ask 冒泡到唯一审批窗口，不存在「外部席位成权限黑洞」的缺口。**结论：tool approval bridge 已被 ADR-002/015 基础设施覆盖，本切片不再为「外部 CLI 席位」新建独立路由**——否则会引入一个本产品不存在的「第二方」概念，违背单机 1 人约束。

#### Decision
1. **纯模块** `diagnostics.rs`（零 Tauri 依赖、可单测）：
   - `DiagnosticClass` 枚举六类（与竞品同构，预留 `MissingGrant`/`RevokedCredential` 位；新增 `CliExecutorMissing` / `CliExecutorLaunchFailed` 服务 F11 失败分类）。
   - `CapabilityDiagnostic { class, scope, title, detail, fix_hint }`——可枚举、可点击修复的清单项。
   - `DiagnosticInput`（MCP 健康快照 + skill id 集合 + 已配预算 skill id 集合 + CLI 执行器健康快照）+ 纯函数 `evaluate(input) -> Vec<CapabilityDiagnostic>`。
2. **MVP 落地四类可由现有状态确定性检测的问题**：
   - `UnavailableProvider`：已启用但 `McpManager::test_connection` 健康检查失败的 MCP server。
   - `OrphanedGrant`：`skill_budgets` 中存在、但 `skills` 表已无对应技能的孤立预算（给 `SkillBudgetTracker` 加 `list_budget_skill_ids()`，additive 查询）。
   - `CliExecutorMissing`：外部 CLI 执行器本机**未安装**（PATH 无二进制）。**F11 核心「失败分类」之一**。
   - `CliExecutorLaunchFailed`：外部 CLI 执行器已安装但**启动失败**（`--version` 非 0 或其他 spawn 错误）。**F11 核心「失败分类」之一**。
   - 上述两类把「派发到不存在/起不来的执行器才失败」前移为可诊断清单，且给出不同修复路径。
3. **CLI 执行器 preflight（F11 本体）复用既有 `agent/executor/cli.rs` 的 `CliExecutor::probe_detail()`**：
   - 给统一接口 `AgentExecutor` 加 `probe_available() -> ExecutorAvailability`（三态：`Available`/`NotFound`/`LaunchFailed`；`InternalExecutor` 恒 `Available`；`CliExecutor` 复用新增的 `probe_detail()`，按 `std::io::Error::kind() == NotFound` 区分「未安装」与其余「启动失败」）。命令层经 `ExtensibilityState.cli_executors`（=`default_cli_executors()` 注册表，含 cli:codex/cli:pi/cli:opencode/cli:claude）逐个 `probe_available().await`，把三态映射到诊断纯模块的 `CliExecutorState`，产出 `CliExecutorHealth { id, binary, state }` 喂入 `evaluate`。
   - 注册表经 `ExtensibilityState` 暴露，**不新增内核端口**（端口计数仍 8）；`diagnose_capabilities` 在 `spawn_blocking` **外**先异步预检 CLI（probe 是 tokio 进程，不可进阻塞闭包），再在闭包内采集 MCP/预算交纯 `evaluate`。
4. **命令** `diagnose_capabilities`（住 `commands/extensibility.rs`，复用 `ExtensibilityState` 的 `mcp`/`skill`/`skill_budget`/`cli_executors`）：命令只做采集，判别全在纯模块——保持内核纯净、可单测。
5. **预留两类**：`MissingGrant`（席位工具作用域不足以调用所需工具）、`RevokedCredential`（凭证失效）——均需接入席位作用域/凭证有效性校验后才填，作为 `evaluate` 的纯函数扩展点，不混入本切片。
6. **F11 的「会话回退」MVP 仅诊断不执行**：只暴露「该 seat 是否配置了 fallback 执行器」的事实（由 `AgentProfile.executor` 可知），**动作侧（自动回退到主会话/换执行器）留作下一步**——避免无人值守下意外行为，也防 scope creep。

#### Consequences
- ✅ 「诊断不黑洞」兑现：用户一键 `diagnose_capabilities` 即得可枚举清单（MCP 不可用 / 孤儿预算 / CLI 执行器未安装 / CLI 执行器启动失败），黑盒失败变明确操作
- ✅ F11 与 IX-16 共用数据：一个纯 `evaluate` 同时服务 CLI preflight（F11）与能力体检面板（IX-16），零重复
- ✅ **F11 核心「失败分类」已落地**：外部 CLI 执行器（codex/pi/opencode/claude）经 `probe_detail()` 廉价三态分类（未安装 / 启动失败 / 可用），无需每工具适配；缺则诊断清单直接点名并给不同修复路径，无需等到派发失败
- ✅ 零基线破坏：纯只读诊断，不写状态、不动端口计数（仍 8）；新增仅 1 个 trait 方法（返回三态枚举）+ 1 张查询方法 + 1 个命令
- ✅ 可测：`evaluate` 单测（健康不报/不可用报/禁用不报/孤立报/有效不报/CLI 未安装报/CLI 启动失败报/CLI 可用不报）不依赖引擎/网络；`cargo test --lib -- --skip integration_test::` 全绿
- ✅ 完全可逆：命令未被任何调用方强制依赖；撤 `diagnose_capabilities` 即关 feature，纯模块可保留无害
- ⚠️ **MVP 范围取舍（明确告知）**：CLI 执行器落地 2/3 细分（未安装 / 启动失败），**鉴权缺失（`AuthMissing`）仍延迟**——需 key + 联网试探，通用抽象拿不到，强行分类是空壳。其余 `MissingGrant`/`RevokedCredential` 仍预留（需席位作用域与凭证校验的运行时事实源）。补这些是纯函数扩展，不影响现有结构
- ⚠️ `diagnose_capabilities` 对每个已启用 MCP 服务做真实连接试探（8s 超时）、对每个 CLI 执行器跑一次 `--version`——均属用户主动触发的按需诊断，成本可接受；非轮询、不常驻
- ⚠️ tool approval bridge（FR3.6）判定为「已覆盖、不重建」，避免为「外部 CLI 席位」虚构实体而污染单机 1 人模型
- ⚠️ F11「会话回退」动作侧未做（仅诊断），理由见 Decision 6

---

## 八、实施顺序与回滚

### 8.1 五个阶段（每阶段结束都必须可编译、可运行、E2E 绿）

```
S0  地基（不改行为）
    A-2 第一刀：570 行 JSON 修复 → llm/json_repair.rs
    A-2 第二刀：RunRequest/RunDeps 参数对象 + 阶段化切函数
    ✅ 门槛：engine.rs ≤600 行；E2E 30/30 绿；无行为变更

S1  去 Tauri 化
    A-1：RunObserver + TauriObserver，逐个替换 app.emit
    删除 app 参数 → <R> 消失；内核纯净度守卫落地为
    `scripts/check-kernel-purity.sh` + pre-push hook（`npm run check:kernel`，扫描 agent/group/scheduler，豁免 agent/ports.rs）
    ✅ 门槛：kernel/ 零 tauri 引用；新增内核单测 ≥10 个

S2  数据底座（关键路径，须前移）
    A-5：迁移 v{N+1} + RunLedger + 异步批量落盘
    ✅ 门槛：一次群协作后 runs/run_steps 有完整记录；写入不拖慢循环（P95 增量 <5ms）

S3  能力面（可并行两条线）
    线 a：A-3 ToolPlane + McpToolProvider  → R1
    线 b：A-4 ApprovalBroker + 前端队列    → R3
          顺序：建冒泡通路 → 四态落地 → 最后才拆 engine.rs:665-669 的降级
    ✅ 门槛：MCP 真实 tools/call 成功；Worker 写工具能冒泡审批且 ToolScope 生效

S4  体验面（可并行三条线）
    R6 竞速对比（最先，验证 insight 组件约定）
    R4 席位仪表 + R5 甘特
    R7 单聊升级为群
    ✅ 门槛：GroupsPage ≤300 行；四个需求各自只碰 1–2 个文件
```

### 8.2 回滚矩阵

| 动作 | 回滚方式 | 数据影响 |
|------|---------|---------|
| A-1 RunObserver | 恢复 `app.emit` 调用（trait 保留不删） | 无 |
| A-2 参数对象/阶段化 | git revert（纯结构改动） | 无 |
| A-3 ToolPlane | Provider 列表清空 → 退化为原内置表 | 无 |
| A-4 ApprovalBroker | 旧 `approve_tool` 命令仍在，前端切回单槽 | 无 |
| A-5 RunLedger | `DROP TABLE run_steps, runs` | 仅丢历史统计 |
| R7 session.mode | 字段置空，退回单聊 | 消息不动 |

**每个动作都是可逆的**——这是本设计刻意保持的属性（"Reversibility matters"）。
唯一半不可逆的是 A-4 的审批协议变更，用 deprecated 过渡期兜住。

---

## 九、质量属性分析

| 属性 | 当前 | 目标 | 手段 | 代价 |
|------|------|------|------|------|
| **可测试性** | 内核不可单测（要造 AppHandle） | 内核 100% 可单测 | A-1 端口化 + `RecordingObserver` | 一次性重构 |
| **可扩展性** | 加工具改 Registry；加事件传染泛型 | 加 Provider 不动内核；加事件不动泛型 | A-3 + A-1 | 多一层抽象 |
| **可观测性** | 内存计数器，重启清零 | 全量运行历史 + 成本 + 甘特 | A-5 | 磁盘占用（90 天保留兜住） |
| **可靠性** | Worker 写操作被静默 Deny；MCP 无 tools/call | 冒泡审批 + 超时 fail-closed；并发独立应答 | A-4 A-3 | 审批协议变更、安全面扩大 |
| **可维护性** | 两个上帝对象（1449 / 2327 行） | 均 ≤600 / ≤300 行 | A-2 + ADR-007 | 文件数增多 |
| **性能** | — | Agent 循环不受记账拖累 | 异步批量落盘 | 崩溃可能丢最后一批 step（可接受） |

### 9.1 失败模式分析（"What happens when X fails?"）

| 失败场景 | 当前行为 | 目标行为 |
|---------|---------|---------|
| Worker 想调写工具 | **直接 Deny（D3′），任务做不完** | 冒泡审批 → 用户可 Accept/Edit/Respond |
| 用户不在屏幕前，Worker 请求审批 | 现状不会发生（被 Deny 了） | 托盘角标 + 倒计时 → 超时 `Ignore` 落账 |
| 同一会话并发两个 Ask | 后者覆盖前者 → 前者挂起（D3②，当前不可达） | 两个独立 `ApprovalId`，各自应答 |
| MCP Server 进程僵死 | 无此路径（只有探活） | `preflight` 失败 → `Unavailable::ProviderDown` → 不喂 LLM 重试 |
| 断网 | 塌缩成"Agent 失败" | `Unavailable::Network` → UI 提示"网络不可达" |
| Agent 循环崩溃 | 消息已逐条落库，可恢复 | 同上 + `runs.status = failed` 有据可查 |
| Ledger 写入积压 | — | mpsc 有界，满则丢弃 step 并计数（**绝不阻塞 Agent 循环**） |

> 最后一条是刻意的取舍：**记账是辅助能力，不能反过来拖垮主流程**。
> 丢 step 会被计数并在健康面板暴露，比卡住 Agent 好得多。

---

## 十、验收清单

**架构层（可自动化校验）**
- [ ] `npm run check:kernel` 通过——内核层（agent/group/scheduler）无 `use tauri::` 与
      `R: Runtime` / `AppHandle<R>`，仅适配层 `agent/ports.rs` 允许（pre-push 自动守门）
- [ ] `grep -rn "R: Runtime" src-tauri/src/` 全在 `agent/ports.rs`（适配器），内核零泛型
- [ ] `engine.rs` ≤600 行，`run()` 主体 ≤100 行，无 `too_many_arguments` 豁免
- [ ] `GroupsPage.tsx` ≤300 行
- [ ] 内核单测 ≥10 个且不依赖 Tauri
- [ ] E2E 保持 30/30 绿（chromium + webkit）

**功能层**
- [ ] **Worker 调写工具能冒泡出审批**，不再被静默 Deny（**D3′ 回归**）
- [ ] 同一会话并发两个 Ask，两者都能独立获得应答（**D3② 前瞻测试**，需临时开启并行工具执行验证）
- [ ] Worker 的 `ToolScope` 白名单生效——放开审批的同时未放大攻击面
- [ ] 审批四态各自产生正确的 tool result（尤其 `Edit` 用新参执行、`Respond` 不执行）
- [ ] 审批超时 → `Ignore` + `run_steps.approval_source = timeout_deny`
- [ ] MCP `tools/call` 真实成功，工具名为 `mcp__{server}__{tool}`
- [ ] 断网时得到 `Unavailable::Network`，UI 提示"网络不可达"
- [ ] 一次群协作后 `runs` / `run_steps` 记录完整，可算出成本
- [ ] 单聊升级为群：消息不丢、session_id 不变、可降回

---

## 附：与既有文档的关系

| 文档 | 关系 |
|------|------|
| 《竞品调研与差距分析》（2026-08-03） | 提供 F1–F14 / IX-1–17 的问题域 |
| 《PRD 协作 Agent M2》（v1.1） | 提供 R1–R7 与 §0 产品形态约束 |
| 《架构调整方案》 | 本文的 P0/P1/P2 基线，**不冲突**：那份收敛了分层与 Repository，本文继续收敛内核端口与前端结构 |
| 《圆桌群协作 PRD》（v1.0） | 已落地部分，本文只在其上做非破坏性演进 |

**一句话总结本设计**：
> 用四个端口（Observer / ToolPlane / ApprovalGate / Ledger）把内核与 UI 解耦，
> 借这次改造把 Worker 从"只能读"解放为"可申请写"（并同时补上白名单，不放大攻击面），
> 并让"群"保持为一个**视图状态**而非重资源——这是竞品结构上追不上的地方。

---

## 附二：本文档的自我修正记录

写作过程中我把 D3 的 session_id 键覆盖判成了"正在发作的 bug"，
核实 `engine.rs` 后发现三个前提都不成立（工具串行、Worker 各有独立 session_id、
Worker 的 Ask 被降级为 Deny），已修正为"潜在缺陷"。

**真正在损害产品的是 D3′**（`engine.rs:665-669` 的 `Ask → Deny`），
而它当初是**正确的 fail-closed 选择**——没有审批通路时，挂死比拒绝更糟。

保留这段记录是因为它包含一条对实施顺序的硬约束：
**先建通路，再拆降级**。顺序反了，Worker 会从"只读"退化成"挂死"。
