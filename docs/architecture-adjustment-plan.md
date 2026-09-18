# one-desktop 架构调整方案（2026-08-03）

> 背景：对照 pi_agent_rust 单 Agent 纵深架构审视 one-desktop 后整理的调整清单。
> 定位：one-desktop 的核心增量是「群协作编排」（pi 没有），单 Agent 循环是复用底座。
> 本方案只修底座的三个结构性短板，不动群协作的设计骨架。

## 〇、核心架构逻辑（双目标纲领）

one-desktop 的架构必须同时满足两条主线，缺一不可：

  A. 单 Agent：架构合理、安全、高效、支持长任务
     - 合理：会话/上下文管理是正解不是补丁（并发根因用「固定 session id + 每 group:worker 串行」修；已有的悬空 tool_call 消毒保留为防御安全网，不删；序号仅留作事件展示字段）
     - 安全：强制隔离不是提示词约定（workspace 逃逸防护、权限分级）
     - 高效：执行模型不阻塞（异步工具、真超时、可取消）
     - 长任务：上下文压缩 + 会话可恢复，历史不无限膨胀

  B. 多 Agent：思考逻辑的复用 + 并行协作
     - 复用：上级 Agent 的思考过程（任务拆解依据、约束、边界）作为
       「任务卡」注入 Worker，而不是只传一行 description；AgentProfile
       的角色思维（system_prompt）与思考技能（skills）按任务类型复用
     - 并行：扇出（协作）/ 竞速（择优）/ DAG（依赖编排）三种派发语义
       已经成立，补「竞速胜者方案回填」让择优结果沉淀为后续任务种子
     - 衔接：单 Agent 长上下文 ↔ 多 Agent 短任务并行，靠「会话上下文」
       与「任务上下文」分离来支撑——Worker 每次回合从干净会话 + 快照
       注入开始，不背负长历史

  C. Agent 互操作：异构执行器 + A2A 协议（核心领域模型，非远期附加）
     - 执行器多态：Worker 的运行时实例不只有内部 AgentLoopEngine，还
       可以是外部 Agent CLI（codex / opencode / pi / claude-code）——
       通过统一 `AgentExecutor` trait 抽象，WorkerPool / 任务卡 / 事件
       总线对执行器类型无感，内部与外部 Agent 同席位竞争、同协议派活
     - A2A 原生（依据官方规范 a2a-protocol.org）：群协作的领域模型直接
       采用 A2A 数据模型——Task(contextId/taskId/status/artifacts/history)、
       Message(role/parts/referenceTaskIds)、Part(text/raw/url/data)、
       9 态状态机、TaskStatusUpdateEvent/TaskArtifactUpdateEvent 事件
       schema、AgentCard 技能发现。本地实现 = A2A 的「内存绑定」，
       远程对接 = 换传输绑定（JSON-RPC / gRPC / HTTP+JSON），协议本体
       只有一份，不存在「本地私有模型 + 翻译层」
     - 复用：A2A 的 contextId 继承 + referenceTaskIds 引用是「思考复用」
       的协议原生机制——任务卡、上级思考、竞速择优全部用 A2A 语义
       实现，不发明私有字段
     - 边界：外部 Agent 的能力不可内省（看不到它的工具调用/HITL），
       安全边界退化为「进程隔离 + workspace 限域 + 超时 kill」；外部
       执行器在 A2A 里是「无内部事件的远程 agent」，状态只能观测
       TaskStatus（polling/streaming），与内部执行器的细粒度事件分离

  本方案所有调整项都挂在这三条主线下；只满足一条的改动不进本方案。

## 一、总体判断

架构骨架健康：Commands 薄路由 -> Manager 编排 -> Repository -> SQLite 分层清晰，
group/ 对 engine 零侵入的设计成立。有三个结构性短板需要调整：

1. 会话/上下文管理有补丁式残留，但部分已落地 —— 圆桌每回合新 session id +
   RT_TURN_SEQ 序号（roundtable.rs:53/432）绕并发、Worker 回贴靠 get_messages
   读最后一条 assistant（roundtable.rs:503）仍是绕过根因的补丁；悬空 tool_call
   的合成占位消毒已于 2026-08-02 落地 engine.rs:259-311，作为防御安全网保留，
   本方案只修并发根因、不删该消毒。另注：Worker 上下文已由「群共享日志灌入」
   （build_worker_seed，2026-08-03 11:19）解决「完全失忆」，故真正残留是
   session 表随序号无限增长 + 无上级思考/skills 复用（见 P0-2/P0-5）。
2. 安全边界是「提示词级」不是「强制级」 —— workspace 隔离只靠 preamble
   告知，shell 用 current_dir 但命令内 `cd ..` 即可逃逸；审批只有 HITL
   一刀切（auto_approve 全局开关），无工具级权限策略。
3. 执行模型是同步阻塞 —— shell 工具 `thread::spawn + join` 阻塞 tokio
   worker；SQLite 单连接 `Mutex<Connection>` 全局串行；工具执行中不可取消
   （cancel 只作用于 LLM 流）。

## 一.5 已落地修复（实施前必读，避免重复劳动 / 误删）

本方案部分「现状/问题」在落笔前已被既有提交修复。实施者务必先读此节，
勿把已上线的防御网当「待删补丁」。

| 修复 | 落地位置 | 本方案如何对待 |
|------|---------|---------------|
| 悬空 tool_call 消毒 | engine.rs:259-311（2026-08-02） | 保留为防御安全网，**不删**；P0-2 只修并发根因 |
| 群协作 HITL 挂死解锁 | engine.rs:131 / 480-481 `auto_approve_override`（2026-08-02） | 现状即文档 P1-7 描述的「群 Worker 全部 `Some(true)`」，P1-7 用三态权限替代 |
| 群共享日志灌入 Worker 上下文 | roundtable.rs:441-466 `build_worker_seed`（2026-08-03 11:19） | 解决「Worker 完全失忆」；P0-2 在其上叠加 A2A referenceTaskIds，不改此机制 |
| filesystem workspace 强制隔离 | filesystem.rs:152-183 `resolve_fs_path` | 群场景已不可越界；P1-6 工作量移至 shell 命令级管控 |

> 结论：真正仍待本方案解决的「补丁式」残留只剩 ① final_text 靠
> `get_messages` 读回（P0-1）、② session 表随 RT_TURN_SEQ 无限增长
> （P0-2）、③ 无上级思考/skills 复用（P0-5）。

## 二、调整项（按优先级）

> **A2A 词汇统一说明**：本方案采用 A2A 官方规范（a2a-protocol.org）的领域模型——
> `contextId`（跨任务共享交互集合）、`referenceTaskIds`（消息引用相关任务）、
> 9 态状态机、`AgentCard`（技能/能力发现）。字段定义与映射见**第五节·调研依据**。
> 后续各项不再逐条复读 A2A 语义，仅标注与 A2A 字段的对应关系。

### P0 正确性（改动集中在 engine / roundtable / scheduler）

> **实施状态（2026-08-03）**：**M1（P0）已全部落地**——P0-1（outcome）、
> P0-4（异步工具+真超时+cancel）、P0-3 v1（run 开始处折叠+落库，增量压缩待续）、
> P0-2 v1（固定 session+Worker 串行+每回合清空）、P0-5 层级 1（[Capabilities]
> 注入）+ 层级 2（task.reasoning 列 + 任务卡 `task_card()` 注入，前端派活表单
> 可填拆解依据）。待续：P0-5 层级 3（竞速备选回填，属 M3）、P0-3 增量压缩。

#### 1. AgentLoopEngine::run 返回结构化结果
- 现状：run() 返回 ()，Worker 回贴靠 `session_manager.get_messages` 找最后
  一条非空 assistant（roundtable.rs:395），任务完成判断靠 task 状态轮询
  （scheduler.rs:393 引擎跑完再查 DB 是否 InProgress）。
- 问题：引擎结束方式有 5 种（Text 完成 / 工具循环后无文本 / 超时 / 取消 /
  token 超限），调用方无法区分「正常回答但内容为空」和「异常终止」。
- 设计：新增
  ```rust
  pub struct AgentRunOutcome {
      pub final_text: String,
      pub stop_reason: StopReason,   // Completed | ToolsExhausted | TimedOut | Cancelled | BudgetExceeded | LlmError
      pub total_tokens: u64,
      pub iterations: u32,
      pub tool_calls: u32,
  }
  pub async fn run(...) -> AgentRunOutcome;   // 不再返回 ()
  ```
- 改动：engine.rs run() 各终止分支构造 outcome；roundtable.rs `run_worker_turn`
  直接取 `outcome.final_text` 回贴（删掉 get_messages 读回逻辑）；
  scheduler.rs `dispatch_task` 用 `outcome.stop_reason` 决定 mark_completed /
  mark_failed（删掉「仅 InProgress 才标记」的竞态规避）。
- 收益：消除两处补丁，调用方拿到确定性终止原因。
- 依赖：outcome 的 `Cancelled` / `TimedOut` 分支需 P0-4（异步工具 + 真超时 +
  cancel 透传）落地后才可真正产出；当前 cancel 仅在 LLM 调用间隙生效
  （engine.rs:318），工具执行中不可取消，故 M1 验收时这两项标注为
  「前瞻字段，P0-4 后生效」。

#### 2. 会话上下文与任务上下文分离 + 任务卡注入
- 现状：圆桌并发已由「每回合一次性 session id（`rt:<group>:<worker>::<RT_TURN_SEQ>`）
  + 群共享日志灌入（build_worker_seed，2026-08-03 11:19）」解决——既避免同
  session 并发写交错，又让 Worker 看到「之前各轮讨论 + 当前问题」。因此
  「Worker 完全失忆」已不成立。真正残留：① session 表随每回合新 id 无限
  增长（RT_TURN_SEQ 只增不清）；② 上级思考（群主拆解 reasoning）与
  AgentProfile.skills 从未注入 Worker（见 P0-5）；③ final_text 仍靠
  get_messages 读回（见 P0-1）。
- 问题：序号方案治标——真正待修的是「session 表膨胀」与「思考复用缺失」。
  不应另造 `[Owner Reasoning]` 字符串协议；群共享日志灌入这一已验证方案保留
  为 context 来源，A2A 的 `contextId` / `referenceTaskIds` 字段在其上叠加。
- 设计（字段映射见文首 A2A 词汇说明）：
  - 双上下文分离（对应纲领 B/C 的衔接原则）：
    - 会话上下文 = `contextId` 维度的历史：group_id 即 contextId，Worker
      回合共享群级上下文集合；
    - 任务上下文 = 单次 Task 维度的输入：
      `ExecutorTask.task_card` 组装群主发言 + 当轮被 @ 消息 + 最近 N 条
      圆桌上下文（截断 4k token）。
  - 任务卡即 A2A Message（role=USER，parts 数组），上级思考通过
    `referenceTaskIds` 引用群主拆解任务（task_board 的 reasoning 落在被引用
    Task 的 metadata/artifacts 上），Worker 端展开引用即得上级思考——不发明私有字段。
  - 并发安全：固定 session id + Worker 级 Mutex per group:worker 回合串行；
    RT_TURN_SEQ 仅保留用于事件消息的 turn_index 展示字段。
- 改动：roundtable.rs run_worker_turn 的 session 创建/注入逻辑；新增
  `build_task_card()`（roundtable.rs 或独立 task_card.rs，输出 A2A
  Message 结构）；task_board 加 `reasoning` 字段（挂被引用 Task 上）。
- 收益：session 表不再随序号无限增长（固定 id + 串行），Worker 能感知当轮
  讨论（群日志注入，沿用现状）+ 上级思考（经 referenceTaskIds）；并发写问题
  从根上消失。
- 注意：固定 session 会跨回合累积消息，compaction（P0-3）必须覆盖 Worker
  复用 session，否则单 session 历史同样膨胀（见 P0-3 修正）。

#### 3. 上下文压缩（compaction）
- 现状：会话历史无限增长，靠 token_budget 硬截断；长会话第二次提问时
  首条消息已不可见。
- 设计（借鉴 pi compaction.rs，但简化）：
  - 阈值：单会话消息数 > 40 或累计 token > 60k 时触发（engine 每次循环
    开始时检查）。
  - 折叠策略：保留 system + 最近 10 条消息 + 首条用户消息，中间历史用
    一次纯文本 LLM 调用（复用 roundtable 的 run_summary_llm 模式，空
    ToolRegistry）压缩成「历史摘要」块注入 system。
  - 压缩结果落库 `messages` 新表 `session_summaries`，同一 session 二次
    触发时增量压缩（只压上次 summary 之后的部分）。
  - 群 Worker 改用固定 session 后单会话会跨回合累积，compaction 必须覆盖
    Worker session（阈值/折叠策略同普通会话）；普通会话与任务 session
    均受影响。
- 改动：新增 `src-tauri/src/agent/compaction.rs`；engine.rs 循环头部加检查；
  storage 加 session_summaries 表 + repo。
- 收益：长会话可用性，token 预算不再白白浪费在过期历史。

#### 4. 工具执行异步化 + 可取消
- 现状：`ExecutableTool::execute(&self, args, ctx) -> Result<String,String>`
  同步签名；shell 工具 `thread::spawn + join` 阻塞；30s 超时形同虚设
  （注释自认 TODO）；工具执行期间 engine.cancel 无效。
- 设计：
  ```rust
  #[async_trait]
  pub trait ExecutableTool: Send + Sync {
      async fn execute(&self, args: Value, ctx: &ToolExecContext) -> Result<String, String>;
  }
  // ToolExecContext 增加：
  pub cancel: Option<CancellationToken>,   // 传入引擎的 cancel_rx 派生
  ```
  - shell 工具改 tokio::process::Command，真正 30s 超时 + cancel 时 kill
    子进程。
  - filesystem/memory 工具签名同步改 async（内部无阻塞则直接 .await 包装）。
  - engine.rs 工具循环 `self.tool_registry.execute(...).await`，循环头部
    检查 cancel_rx（工具返回后立即响应取消）。
- 改动：tool_registry.rs / tools/*.rs 全部签名；engine.rs 调用点。
- 收益：取消真正端到端（广播竞速 cancel 不再失效），shell 超时兑现。

#### 5. 思考逻辑复用层（多 Agent 核心增量）
- 现状：AgentProfile 有 skills / mcp / tools 三个字段（agent_profile.rs:16-18），
  但 roundtable.rs 与 scheduler.rs 只消费了 model / system_prompt /
  capabilities——skills 从未被注入 Worker 的提示词；Worker 每回合都是
  「system_prompt + 一段裸 prompt」重新起跑，上级的思考过程、既有结论
  全部丢失。
- 问题：多 Agent 的价值 = 复用（不重复思考）+ 并行（同时思考）。
  现在只有并行没有复用：每个 Worker 从零理解任务，群主拆解的推理
  过程、其他 Worker 的中间结论都无法传递。
- 设计（三层复用，不进 session 历史；字段映射见文首 A2A 词汇说明）：
  - 层级 1 —— 角色思维复用：
    把 profile.skills（技能清单）、profile.mcp（MCP 能力）、profile.tools
    渲染成 Worker system prompt 的 `[Capabilities]` 块：
    ```
    [Capabilities]
    Skills: <skills 逐条 name: description>
    MCP servers: <mcp 列表>
    Tools: <tools 列表>
    ```
    `AgentCard.skills`（id/name/description/tags/examples）字段结构对齐——
    本地 AgentProfile 即远程 AgentCard 的本地投影，Worker 加入 A2A 网络时
    技能声明零转换。群主建群时按任务类型选 preset
    （research / writer / coder），Worker 即获得对应角色的思维框架。
  - 层级 2 —— 上级思考复用：
    群主拆解出的 SubTask 本身即 A2A Task，`reasoning`（拆解依据、约束、
    验收标准）挂在 Task.metadata；派发给 Worker 的任务卡 Message 用
    `referenceTaskIds` 引用它，Worker 展开引用即见上级思考——不拼
    字符串、不发明私有协议（与 P0-2 同一机制）。
  - 层级 3 —— 平行思考复用（竞速胜者回填）：
    广播竞速（RoundtableBroadcaster）多个 Worker 并行想方案，目前
    只取第一个胜者回贴，其余思考结果全部丢弃。改为：竞速结束后，
    胜者方案 + 落选方案摘要以 A2A Artifact 形式写入被引用 Task
    （`roundtable_alternatives` 表或 Task.artifacts 数组），群主/后续
    任务经 referenceTaskIds 引用——「多方案并行思考 → 择优 → 其余
    作为备选上下文」。
  - 复用边界：只复用「思考结果」（任务卡、方案、摘要），不复用
    「思考过程 token」（不把别的 Worker 的完整推理链塞进上下文），
    避免上下文污染与 token 爆炸。
- 改动：roundtable.rs（capabilities 块渲染 + 竞速备选落库）、scheduler.rs
  （referenceTaskIds 注入）、task_board.rs + repo（reasoning/metadata 列）、
  新表 roundtable_alternatives（或 Task.artifacts）。
- 收益：多 Agent 从「N 个独立 Agent」变成「一个会分工的团队」——
  角色分工（层级1）+ 任务传承（层级2）+ 方案择优（层级3）。

> **P0-5 层级 3 已落地（2026-08-03）**：`roundtable_alternatives` 表 +
> 竞速落选方案落库 + seed 注入「[备选方案]」块（触发轮 < 当前 seq，截断控制
> token），后续 Worker 回合可参考此前落选思路。

### P1 安全边界（改动集中在 tool 层 + 审批）

> **实施状态（2026-08-03）**：P1-6（shell 命令级管控 + 危险命令拒绝 + cd
> 逃逸拦截 + enforce_root）已落地；P1-8（acquire Busy 互斥，max_concurrency
> 语义落地）已落地；P1-7 权限分级已落地（permission.rs 三态 + engine HITL 改造
> + tool_permissions 表 + 设置页「工具权限」tab）；P1-7 日配额（当日 token
> 合计暂停派发）待续。

#### 6. workspace 路径强制隔离
- 现状：
  - filesystem 工具**已强制隔离**：`resolve_fs_path`（filesystem.rs:152-183）
    在 workspace_root 激活时 canonicalize + `starts_with(root)` 拒绝越界，群
    Worker 已传 ws_root（scheduler.rs:389 / roundtable.rs:472），故群场景
    filesystem 不可逃逸；普通用户会话 `enforce_root=false` 时走 legacy 仅防
    `..` 路径分量（设计本就保持自由）。
  - 真正缺口在 **shell 工具**：`current_dir(ctx.workspace_root)` 仅设 cwd，
    命令内 `cd ..` 即可逃逸，且无命令级管控。
- 设计（工作量集中在 shell，filesystem 部分基本已完成）：
  - filesystem 工具：相对路径先 join workspace_root 再 `canonicalize`，
    校验前缀 `== workspace_root`，越界直接返回错误「path escapes workspace」。
  - shell 工具：注入 `cd <ws_root>` 前缀 + 环境变量
    `ONEDESKTOP_WS_ROOT=<ws_root>`，命令内出现 `..` 路径穿越模式时告警
    （P1 先告警，P2 可加拒绝模式）；删除/递归危险命令（rm -rf / 等）默认拒绝。
  - ToolExecContext 增加 `enforce_root: bool`（群 Worker 与圆桌回合强制
    true，普通用户会话 false 保持自由）。
- 改动：tools/filesystem.rs、tools/shell.rs、tool_registry.rs 签名。
- 收益：群内多 Agent 文件产出真正互不污染（workspace.rs 注释声称的
  「confined to this directory」落地）。

#### 7. 权限分级替代 auto_approve 一刀切
- 现状：auto_approve 全局 bool + 按会话 override；群 Worker 全部
  Some(true) 跳过审批，等于群内工具零管控。
- 设计：permission 三态（Allow / Deny / Ask）按 (工具名, 会话类型) 匹配：
  - 普通用户会话：shell / filesystem / memory 默认 Ask（弹 HITL 门，现状保留）；
  - 群 Worker / 定时任务：shell 默认 Deny 高危模式（rm -rf、格式化、
    网络下载）+ Ask 其余；filesystem 限 workspace 内 Allow；
  - 配置表 `tool_permissions` 落库（工具名 + scope + action），UI 设置页可改。
  - auto_approve 降级为「全局 Allow 快捷开关」，不再承担权限决策职责。
- 改动：新增 `src-tauri/src/agent/permission.rs`（纯函数判定，无 DB 依赖，
  策略可测）；engine.rs HITL 分支改为 permission::decide() 后按结果走
  Allow 直执行 / Deny 拒绝 / Ask 挂起；判定结果映射 A2A TaskState
  （Ask 挂起 = input_required，Deny = rejected，授权缺失 = auth_required，
  与 P2-14 状态机一致）。
- 收益：群协作默认安全，高危操作有强制兜底，不再依赖「群内全信任」。

#### 8. 资源治理
- 现状：max_concurrency 字段存在但未用于限制（worker.rs 只有 status 切换）；
  每个 Worker 引擎 token 预算各自独立（Some(100_000)），群内并发 N 个
  Worker 无总预算。
- 设计：
  - WorkerPool::acquire 增加并发检查：Busy 数量 >= 群 max_concurrency 时
    acquire 返回 Err（或排队，P1 先 Err + 前端提示）。
  - scheduler.rs 派发前按群维度查 `worker_metrics` 当日 token 合计，
    超群日配额（配置项，默认 2M token）暂停新派发。
  - 引擎 token 预算改为从 profile 读（agent_profile 加 token_budget 字段，
    默认 100k）。
- 改动：worker.rs acquire 逻辑、scheduler.rs 派发前检查、agent_profile.rs
  模型 + 迁移。
- 收益：群并发有真实上限，成本可控。

### P2 架构演进（独立小项，随时可做）

> **实施状态（2026-08-03）**：P2-9（Provider 路由）已落地；P2-10（事件总线
> 收敛）已落地；P2-11（可观测性）已落地；P2-12（执行器多态）已落地；
> **P2-13 CLI 接入已落地**（CliAdapter trait + codex/pi/opencode/claude 四适配器 +
> CliExecutor（600s 超时 kill + cancel kill + --yolo 高危 flag 拒绝 + JSON 输出
> 宽松解析）+ AgentProfile.executor 字段 + scheduler 按 profile.executor 路由；
> 探测在 run 时进行，缺失则任务标 Failed）；**P2-14 第一步·轻量版已落地**
> （a2a/model.rs）。**P2-14 第二步·roundtable 消息 A2A 化已落地**（roundtable_repo.rs
> `RoundtableMessage::to_a2a_message` + `roundtable_messages_to_a2a_task`，整场圆桌投影为
> `A2aTask`；`RoundtableBus::export_a2a`/`get_a2a_task` 读库投影）。**A2A 传输绑定（进程内）
> 已落地**：`a2a/agent_card.rs`（A2aAgentCard 发现 artifact）+ `RoundtableBus::send_a2a_task`
> （绑定 A2A `message/send`：取任务卡文本 → 按 metadata.broadcast/mentions 路由 post/broadcast，
> 非阻塞返回 Working 态，Worker 回复经既有 `roundtable-message` 事件异步到达，符合 A2A 语义）。
> **网络传输（HTTP/JSON-RPC 端口）仍按方案远期独立立项**——本机无远程互操作需求，进程内绑定
> 已定义完整协议面，联网时 handler 仅做 `serde_json::from_value`，零新依赖、零端口、完全可逆。
> M3 收尾验收已通过（Rust 零警告 / 44→48 单测 / tsc / 真实 DB / 双浏览器 E2E 36/36）。

#### 9. Provider 路由
- 现状：`llm::create_provider("deepseek", ...)` 硬编码在 roundtable.rs /
  scheduler.rs / manager.rs；AgentProfile 只有 model 字段，无 provider。
- 设计：AgentProfile 增加 provider 字段（默认 "deepseek"）；
  `llm::create_provider` 改为按 profile 选择；config 支持 providers 列表
  （名称 -> {base_url, api_key, model}），设置页多 provider 管理。
- 改动：llm/mod.rs 工厂、agent_profile 模型 + 迁移、group 三处调用点、
  前端设置页。

#### 10. 事件总线收敛
- 现状：agent-event / group-event / roundtable-message / roundtable-summary
  四通道，前端 hooks 按事件名硬编码分发。
- 设计：后端统一 `app.emit("onedesktop-event", &EventEnvelope{ type, session_id/group_id, payload })`，前端 eventBus.ts 按 type 分发。
  保留旧事件名一个版本兼容期（双发）。
- 收益：新事件类型免改前端订阅逻辑；为后续 Tauri plugin 或 WebSocket
  远程订阅铺路。

#### 11. 可观测性
- 现状：WorkerMetricRepository 落库 token/耗时，但无链路关联。
- 设计：engine run() 接受可选 `trace_id`（群场景 = group_id:batch_id:task_id），
  tracing span 注入 + 指标 tag；worker_metrics 表加 trace_id 列；
  ES/日志可按批次聚合单个 Worker 回合的完整调用链。

#### 12. 执行器多态（AgentExecutor trait，纲领 C 的地基）
- 现状：Worker 的运行时实例硬编码为内部 `AgentLoopEngine`——scheduler.rs
  dispatch_task 与 roundtable.rs run_worker_turn 里 `llm::create_provider`
  + `engine.run(...)` 写死；AgentProfile 无执行器概念。
- 设计（执行器即本地 task 执行绑定，字段映射见文首 A2A 词汇说明）：
  ```rust
  #[async_trait]
  pub trait AgentExecutor: Send + Sync {
      /// 执行一个 A2A Task（统一输入），产出统一结果
      async fn run(&self, task: A2aTask) -> Result<A2aTaskResult, String>;
      /// 取消正在执行的 run（内部引擎走 cancel token，外部 CLI 走 kill 进程）
      async fn cancel(&self, task_id: &str);
  }

  // A2A Task 本地投影（与规范字段一一对应，见 P2-14）
  pub struct A2aTask {
      pub id: String,              // taskId
      pub context_id: String,      // contextId（群/会话）
      pub message: A2aMessage,     // 任务卡 Message（parts + referenceTaskIds）
      pub workspace_root: Option<PathBuf>,
      pub max_iterations: u32,
      pub token_budget: u64,
  }
  ```
  - `InternalExecutor` 包装 AgentLoopEngine（P0-1 的 run() 签名适配后直接对接）。
  - `CliExecutor` 包装外部 CLI（见 13）。
  - `RemoteExecutor`（远期）：A2A JSON-RPC/HTTP 出向客户端（见 14）。
  - WorkerPool 派发改为 `executor: Arc<dyn AgentExecutor>` 按 profile 解析，
    engine 不再直接出现在 scheduler/roundtable 调用点。
- 改动：新增 `src-tauri/src/a2a/model.rs`（Task/Message/Part 领域模型，
  同时被 executor 与存储复用）；scheduler.rs / roundtable.rs 调用点改为
  executor.run()；worker.rs / agent_profile.rs 加 executor 字段。
- 收益：Worker 对「内部引擎 / 外部 CLI / 远程 A2A」无感，三种派发
  语义（扇出/竞速/DAG）零改动即可驱动异构 Agent——这是 A2A 的前置条件。

#### 13. 外部 Agent CLI 接入（codex / opencode / pi / claude-code）
- 现状：无。外部 CLI 只能靠用户手动起终端跑，无法进入群协作。
- 设计（CliExecutor = A2A 出向的本地进程绑定，一个 CLI 一个适配器）：
  - 适配器注册表：`AgentProfile.executor = "cli:codex" | "cli:opencode" |
    "cli:pi" | "cli:claude"`，每个适配器声明：
    - 探测命令（`codex --version` 等，缺失则 Worker 标 Offline + 原因）；
    - 构造命令模板（codex 必须 git repo → workspace 内自动 git init；
      pi 单发 `pi -p`；opencode `opencode run`）；
    - 输出解析：优先结构化输出（codex exec --json / pi --json /
      opencode run --json），退化为 stdout 文本截断——统一映射为
      A2A TaskResult（final_text 即 A2A Message.artifact）；
    - 会话续跑：codex --continue / pi --continue 映射到 contextId 维度
      （P0-2 的会话/任务上下文分离在此天然复用）。
  - 进程管理：tokio::process + 超时（默认 600s，CLI 无内部迭代预算）+
    cancel 时 kill 进程组；stdout 逐行转发为 A2A TaskStatusUpdateEvent
    （streaming 更新机制）。
  - 运行上下文：cwd = workspace_root（WorkspaceManager 复用），环境变量
    白名单（API key 走 profile 配置，不注入宿主 env）。
  - 安全边界（对应纲领 C 边界）：外部 Agent 无内部工具三态权限可挂——
    只能靠「workspace 限域 + 超时 kill + 事前 profile 授权」；
    CLI 高危 flag 映射拒绝（如 codex --yolo 禁止，只允许 --full-auto
    以内级别）。
- 改动：新增 `src-tauri/src/agent/executor/cli/`（mod.rs + codex.rs +
  opencode.rs + pi.rs + claude.rs）；agent_profile executor 字段解析。
- 收益：codex / opencode / pi 等直接成为群内 Worker 席位，同一 A2A Task
  DAG 编排下与内部 Agent 混合并行——「多 Agent 并行协作」从单引擎
  扩展到异构执行器。

#### 14. A2A 协议原生（依据官方规范，非附加层）
- 现状：task_board 状态机 5 态（Pending/InProgress/Completed/Failed/
  Cancelled）；roundtable 消息是私有结构；事件是自定义 agent-event。
- 问题（调研结论）：A2A 不是「本地私有模型 + HTTP 翻译层」——协议
  本体就是数据模型（Task/Message/Part/Artifact + 9 态状态机 + 标准事件
  schema + AgentCard 发现），绑定（JSON-RPC/gRPC/HTTP+JSON）只是可替换
  的传输层。本地实现应当直接用 A2A 模型，远程只是换绑定。
- **范围与取舍（重要）**：现状**无任何 A2A 或私有模型**，文档所担忧的
  「双重模型维护」目前是理论性的，没有既成负担可证伪。把 Task/Message/Part/
  Artifact + 9 态机 + 事件 schema + AgentCard **全部替换存储 schema、状态机、
  前端事件总线**，对价仅是一个「远期独立立项」才会用到的远程互操作——
  对本地桌面应用成本偏高、可逆性差。故本方案对 A2A 采取**渐进、可逆**策略：
  M1-M3 只采用 A2A 的**结构体形状 / 命名约定 + `references: Vec<task_id>` 字段**
  （用 Rust struct 复用 Task/Message 形状、以 references 实现思考复用，零存储
  变更），**不替换现有 storage schema 与 task_board 状态机**；A2A 传输绑定
  （JSON-RPC 2.0 出/入向）按文档原规划「独立立项」，届时再评估是否有必要做
  native 建模——保留未来选择空间。
- 设计（分三步，第一步即协议本体落地；M1-M3 仅做第一步的「轻量版」）：
  - 第一步（领域模型 A2A 化，M3 做）：
    - 新增 `src-tauri/src/a2a/model.rs`：Task / TaskStatus / TaskState(9 态) /
      Message / Role / Part(text/raw/url/data) / Artifact，字段与规范
      一一对应（含 contextId / referenceTaskIds / metadata）；
    - task_board 状态机升级 9 态：submitted / working / completed /
      failed / canceled / **input_required**（= HITL 审批门挂起）/
      **rejected**（= 权限 Deny 或 Agent 拒绝执行）/
      **auth_required**（= 权限不足需授权）/ unspecified；
    - roundtable 消息重构为 A2A Message（role=USER/AGENT + parts +
      referenceTaskIds），roundtable_alternatives 存 Task.artifacts；
    - 事件规范化为 A2A schema：TaskStatusUpdateEvent（taskId+status+
      message）与 TaskArtifactUpdateEvent（taskId+artifact）替代自定义
      agent-event 状态分支（P2-10 事件总线收敛以此为 schema）；
    - AgentProfile 补 skills 的 AgentCard 结构（id/name/description/tags/
      examples），Worker 即本地 AgentCard。
  - 第二步（内存绑定）：InternalExecutor/CliExecutor 实现 A2A 方法语义
    （SendMessage → ExecutorTask；TaskStatusUpdateEvent → 事件总线），
    本地群协作跑在 A2A 模型上，但无网络（P2-12 已铺）。
  - 第三步（传输绑定，远期独立立项）：实现 JSON-RPC 2.0 绑定
    （SendMessage / SendStreamingMessage / GetTask / ListTasks /
    CancelTask / SubscribeToTask / GetExtendedAgentCard）：
    - 出向：RemoteExecutor（HTTP client 调远程 Agent 的 A2A 端点）；
    - 入向：one-desktop 群暴露 AgentCard（`/.well-known/agent-card.json`
      + supportedInterfaces），其他 A2A 客户端可向群派活（群主接单 →
      TaskScheduler 拆解 → Worker 执行 → TaskStatusUpdateEvent 回传）。
    - 安全：HTTPS + OAuth2/APIKey（规范 SecurityScheme），profile 级；
      P1-7 权限策略对入向任务同样生效（rejected/auth_required 状态
      承接权限判定结果）。
- 改动：新增 `src-tauri/src/a2a/`（model.rs → card.rs → rpc.rs → client.rs
  渐进）；task_board / roundtable / storage 类型替换为 A2A 模型。
- 收益：one-desktop 群从「本地多 Agent 桌面应用」升级为「A2A 原生
  域」——数据模型、状态机、事件、发现机制全部与协议本体一致，
  远程对接只写传输绑定，无翻译层、无双重模型维护。

## 三、文件级改动清单

| 文件 | 改动 |
|------|------|
| src-tauri/src/a2a/model.rs | 已有（第一步）：A2A 领域模型（Task/TaskState 9 态/Message/Part/Artifact，规范字段一一对应） |
| src-tauri/src/a2a/agent_card.rs | 新增（第二步）：A2aAgentCard 发现 artifact + A2aCapabilities + `local()`（进程内绑定的 Agent Card，联网时 url 换真实端点） |
| src-tauri/src/a2a/rpc.rs | 远期新增：JSON-RPC 2.0 绑定（SendMessage/GetTask/ListTasks/CancelTask/SubscribeToTask） |
| src-tauri/src/a2a/client.rs | 远期新增：RemoteExecutor 出向客户端 |
| src-tauri/src/group/roundtable_repo.rs | 第二步：为 `RoundtableMessage` 加 `to_a2a_message`（role 映射 owner→user/worker→agent/system→user）；新增纯函数 `roundtable_messages_to_a2a_task`（整场圆桌投影为 A2aTask） |
| src-tauri/src/group/roundtable.rs | 第二步：新增 `export_a2a` / `get_a2a_task`（tasks/get 进程内绑定）、`send_a2a_task`（message/send 进程内绑定：任务卡文本→post/broadcast 路由，非阻塞返回 Working 态） |
| src-tauri/src/agent/executor.rs | 已有（第一步）：AgentExecutor trait + A2aTask（基于 a2a/model.rs） |
| src-tauri/src/agent/engine.rs | run() 返回 AgentRunOutcome；异步工具执行；循环头部 compaction 检查；permission 决策接入 |
| src-tauri/src/agent/tool_registry.rs | ExecutableTool 改 async；ToolExecContext 加 cancel / enforce_root |
| src-tauri/src/agent/tools/shell.rs | tokio::process；真超时 + kill；cd 前缀 + 危险命令拒绝 |
| src-tauri/src/agent/tools/filesystem.rs | canonicalize 前缀校验防逃逸（**已落地**，见一.5；本方案仅回归确认） |
| src-tauri/src/agent/tools/memory.rs | async 签名 |
| src-tauri/src/agent/compaction.rs | 新增：历史折叠摘要 |
| src-tauri/src/agent/permission.rs | 新增：三态权限判定（纯函数） |
| src-tauri/src/group/scheduler.rs | 用 stop_reason 标记完成；派发前资源检查；reasoning 字段拼进任务卡；executor.run() 调用点 |
| src-tauri/src/group/task_board.rs + repo | 状态机升级 9 态；SubTask 加 reasoning/metadata 列（挂 A2A Task.metadata） |
| src-tauri/src/group/worker.rs | acquire 并发上限 |
| src-tauri/src/group/agent_profile.rs | 加 provider / token_budget / executor 字段；skills 补 AgentCard 结构 |
| src-tauri/src/storage/ | session_summaries 表 + repo；tool_permissions 表 + repo；roundtable_alternatives 表（或 Task.artifacts） |
| src-tauri/src/llm/mod.rs | provider 工厂按 profile 路由 |
| src-tauri/src/types.rs | AgentEvent 增加 Outcome/权限事件变体 |
| src/ | eventBus 收敛；设置页权限/多 provider/AgentProfile 技能编辑 |

## 四、实施顺序

- M1（P0，正确性 + 复用骨架，预计 3 天）：1 -> 2 -> 5(层级1/2) -> 4 -> 3。
  跑通 e2e 全链路（engine/roundtable/scheduler 三处调用点全部适配新签名），
  并验证「群主拆解 → 任务卡注入 → Worker 回贴带上级思考上下文」。
  - 注意：P0-2 在现有「群共享日志灌入」机制（一.5）上叠加 referenceTaskIds，
    不推翻该机制；P0-1 的 `Cancelled` / `TimedOut` 为前瞻字段（依赖 P0-4），
    M1 验收时标注「P0-4 后生效」，勿误判为未实现。
- M2（P1，安全，预计 2 天）：6 -> 7 -> 8。重点回归群协作（P1-6 工作量在
  shell 命令级管控 + 危险命令拒绝；filesystem 隔离已落地，仅回归确认）。
- M3（P2 + 复用收尾 + A2A 轻量落地，按需）：5(层级3 竞速回填) -> 9 -> 10 ->
  11 -> 14(第一步轻量版：结构体 + references，不替换存储 schema) -> 12 -> 13。
  顺序依据：
  - 14 第一步（模型 A2A 化）先于 12（Executor 抽象），因为 A2aTask 依赖
    a2a/model.rs 领域模型；
  - 12（Executor 抽象）依赖 1（Outcome）与 2（任务卡），是 13 的前置；
  - 13（CLI 适配器）在 12 之后，直接产出 A2A TaskResult；
  - 14 第二/三步（传输绑定 rpc/client）依赖 12/13 落地后单独立项。

## 五、调研依据（2026-08-03，A2A 官方规范 + 市面主流框架）

### A2A 协议要点（a2a-protocol.org 规范全文）
- 核心对象：Task（id/contextId/status/artifacts/history/metadata）、
  Message（messageId/contextId/taskId/role/parts/referenceTaskIds）、
  Part（text/raw/url/data 四选一）、Artifact（任务输出，parts 数组）
- 状态机 9 态：submitted / working / completed / failed / canceled /
  input_required / rejected / auth_required / unspecified
  （interrupted 态：input_required、auth_required；terminal 态：
  completed、failed、canceled、rejected）
- 三种更新机制：polling(GetTask) / streaming(SendStreamingMessage、
  SubscribeToTask) / push notification(WebHook)，由 AgentCard.capabilities
  声明（streaming / pushNotifications）
- 三种协议绑定：JSON-RPC 2.0 / gRPC / HTTP+JSON REST，可替换传输层，
  协议本体唯一
- AgentCard 发现：/.well-known/agent-card.json，含 skills
  （id/name/description/tags/examples/inputModes/outputModes）、
  capabilities、securitySchemes（OAuth2/APIKey/mTLS/OpenIDConnect）
- 多轮交互：contextId 继承上下文，referenceTaskIds 显式引用相关任务
- 关键结论：A2A 的「数据模型即协议」，绑定只是传输——本地用同一模型
  则远程零翻译；「状态机映射 + HTTP 端点」是错误理解，会造出双重模型

### 市面主流 Agent 框架对照（one-desktop 群协作的定位）
| 框架 | 多 Agent 模式 | one-desktop 对应 |
|------|--------------|------------------|
| OpenAI Agents SDK | handoffs（任务移交）、agents-as-tools（agent 注册成工具）、guardrails、sessions、tracing | 群主@派活=handoff；Worker=注册工具；权限分级=guardrails；P2-11 可观测性=tracing |
| CrewAI | Process.hierarchical（manager 拆解委派）、sequential（链式） | 群主=manager；DAG 依赖=sequential |
| LangGraph | supervisor 模式、handoff 拓扑、网络/层级结构 | 群主=supervisor；扇出/竞速=网络拓扑 |
| pi_agent_rust | 单 Agent 纵深（权限/资源/压缩），swarm 仅遥测 | 底座借鉴对象（P0-3/P1-6/P1-7） |
- 定位结论：one-desktop 的群协作（群主拆解 + Worker 并行 + DAG 编排）
  与 CrewAI hierarchical / LangGraph supervisor 同一流派，方向正确；
  差异点是 A2A 原生数据模型——市面框架多私有协议，one-desktop 用
  开放标准，这是差异化优势

## 六、与 pi 架构的取舍说明

- 借鉴：compaction（P0-3）、权限策略（P1-6）、资源配额（P1-7）——这三个
  是 pi 的纵深精华，one-desktop 群协作场景同样需要。
- 不抄：扩展系统（54k 行 extensions.rs，桌面应用编译期注册足够）、
  模型路由全套（one-desktop 单用户单 key，P2 只需 profile 级 provider）、
  VCR 回放 / swarm SLO（测试基建，非产品功能）。
- 原则：one-desktop 的差异化在群协作编排，底座只修到「正确 + 安全 +
  可取消」，不做 pi 那样的执行引擎大而全。

## 七、验收标准
- M1：长会话（>40 条消息）第二次提问能答出首条消息内容；圆桌 3 Worker
  并发回贴无交错；shell 工具 30s 超时真实生效；广播竞速 cancel 后赢家
  回贴唯一；Worker 的 system prompt 含 [Capabilities] 块（skills 渲染）；
  任务卡含上级思考（经 referenceTaskIds 展开，见 P0-2/P0-5 层级2）。
- M2：Worker 的 filesystem 工具尝试 `../` 逃逸被拒；shell 危险命令被拒；
  群 max_concurrency=1 时第二个任务 acquire 失败；Worker 日 token 超配额
  后暂停派发。
- M3：竞速落选方案可查（Task.artifacts）；task_board 9 态状态机落地
  （input_required 承接 HITL 挂起、rejected 承接权限拒绝）；事件总线
  收敛为 A2A TaskStatusUpdateEvent/TaskArtifactUpdateEvent schema；
  AgentProfile 可指定不同 provider 的模型；前端事件订阅改单通道后
  全功能回归通过。
- M4（执行器互操作，13/14）：codex / pi 作为群内 Worker 可被同一 A2A
  Task 派发并回贴；外部 CLI 超时被 kill；高危 flag（codex --yolo）被
  映射拒绝；A2A JSON-RPC 出向/入向打通（远程 Agent 接单 → 群拆解 →
  Worker 执行 → TaskStatusUpdateEvent 回传）。
