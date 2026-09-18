# 架构调整方案审视报告（2026-08-03 复核）

> 复核对象：`docs/architecture-adjustment-plan.md`（2026-08-03 版）
> 复核方法：逐条把文档的「现状 / 问题」断言与 `src-tauri/src` 实际代码 `grep + 读源码` 对齐。
> 结论：文档方向正确、问题定位 **~85% 准确**，但与 **2026-08-02 已落地的两处修复** 存在实质性脱节，
> 导致文档 (1) 误把已存在的安全网当「待删补丁」，(2) 高估了 filesystem 的越权风险。另有一处逻辑不自洽、一处 A2A 范围需收敛。

---

## 一、已核实：文档「现状」描述准确的条目

| 文档断言 | 代码实证 | 判定 |
|---------|---------|------|
| `engine.run()` 返回 `()` | engine.rs:117-132 无返回类型 | ✅ 准确 |
| `AgentProfile.skills/mcp/tools` 存在但未注入 Worker | agent_profile.rs:16-18 字段存在；roundtable.rs 仅用 `profile.system_prompt`（438/482），`[Capabilities]` 注入不存在 | ✅ 准确（真实缺口） |
| `ExecutableTool::execute` 同步签名 | tool_registry.rs:33 `fn execute(...) -> Result<String,String>` | ✅ 准确 |
| shell 用 `thread::spawn + join` 阻塞 | shell.rs:47 `std::thread::spawn(...).join()`；45 行注释自承 `TODO: async timeout` | ✅ 准确 |
| 圆桌「每回合新 session id + 序号」绕并发 | roundtable.rs:53 `RT_TURN_SEQ`、432-433 `rt:<g>:<w>::<turn>` | ✅ 准确 |
| Worker 回贴靠 `get_messages` 读最后一条 assistant | roundtable.rs:503-504 | ✅ 准确 |
| scheduler「引擎跑完再查 DB 是否 InProgress」竞态规避 | scheduler.rs:393-399 `if cur.status == InProgress { mark_completed }` | ✅ 准确 |
| `max_concurrency` 字段存在但未用于限制 | worker.rs:27/39/77 存字段；`acquire()`（108）仅切 status，无计数检查 | ✅ 准确 |
| `create_provider("deepseek", ...)` 硬编码 | roundtable.rs:193/470、scheduler.rs:351 | ✅ 准确 |
| 四通道事件（agent/group/roundtable-message/roundtable-summary） | engine.rs、group.rs、scheduler.rs、roundtable.rs 均 `app.emit` 各通道 | ✅ 准确 |
| 无 compaction，仅 `token_budget` 硬截断 | 全仓无 compaction.rs；仅 `token_budget` 截断 | ✅ 准确 |

---

## 二、关键脱节：文档未计入 2026-08-02 已落地的修复

### 2.1 悬空 tool_call 消毒已存在（🔴 CRITICAL）

- **代码实证**：`engine.rs:259-311` 已有历史消毒逻辑——沿 `messages` 扫描，给「无匹配 tool 结果」的悬空 `tool_call` 补合成 `tool_result`，遍历结束再进入 agent loop。这正是 working memory 记录的 2026-08-02 修复（解决 DeepSeek 400 + Worker 中途挂死）。
- **文档问题**：纲领 A(13)「去 dangling 修复」与 一.1(54)「dangling tool_call 靠合成占位结果修复」把该消毒列为**待删补丁**。
- **风险**：P0-2 若只修并发根因（固定 session + 每 worker Mutex）就「去 dangling 修复」，则**崩溃中途调工具**会重新产生悬空 `tool_call`、重新触发 400；而该消毒在 happy path 零影响（working memory 已记）。
- **建议**：保留消毒为防御安全网；P0-2 的表述改为「修并发根因」，而非「去 dangling 修复」。

### 2.2 filesystem 隔离已强制（🔴 CRITICAL — 文档高估了风险）

- **代码实证**：`filesystem.rs:152-183` `resolve_fs_path` 在 `workspace_root` 激活时：
  - 相对路径 join 到 root 后 `canonicalize()`；
  - **`if !canonical.starts_with(root)` 直接拒绝**（183 行 `Path escapes workspace root`）。
  这**正是文档 P1-6 想新增的 canonicalize + 前缀校验**。
- **群 Worker 已传 `ws_root`**：scheduler.rs:389、roundtable 调用点均传入 workspace_root → 群场景 filesystem **已强制隔离**。
- **文档问题**：P1-6「filesystem 工具 `../x` 均可逃逸」不准确。真实缺口**只在 shell 工具**（shell.rs:41 `current_dir(ctx.workspace_root)` 仅设 cwd，命令内 `cd ..` 即可逃逸，且无命令级管控）。普通用户会话 `enforce_root=false` 时 filesystem 走 legacy 仅防 `..` 分量（147 行），这部分按文档设计本就保持自由。
- **建议**：P1-6 的 filesystem 部分**已基本完成**，工作量重估并转移到 shell 命令级管控 + 危险命令拒绝（`rm -rf` 等默认拒绝）。

> **共性根因**：文档（2026-08-03）写于 2026-08-02 修复之后，却把这两处已落地的修复当成「尚未处理的补丁/缺口」，导致建议方向出现偏差。文档应新增「与 2026-08-02 修复的关系」小节。

---

## 三、内部逻辑不自洽 / 口径错误

### 3.1 P0-2 与 P0-3 矛盾

- P0-2 让 Worker 改用**固定 session id**（不再每回合新 id）。
- 但 P0-3 称「群 Worker 会话（固定 id + 快照注入）天然短，不触发 compaction」。
- **矛盾**：固定 session 会跨回合累积消息 → 必然触发 compaction。两者必须对齐：compaction 必须覆盖 Worker 复用的 session，否则长群会话同样膨胀。

### 3.2 task_board 状态机口径

- 文档 340 行文字称「4 态」，但同段列表与实际代码（task_board.rs:10-15）均为 **5 态**（Pending/InProgress/Completed/Failed/Cancelled）。内部口径不一致，统一为「5 态」。

---

## 四、范围 / 风险需收敛

### 4.1 A2A 原生建模（P2-14）成本 vs 收益失衡

- **现状**：全仓**无任何 A2A 或私有模型**——文档所担忧的「本地私有模型 + 翻译层 / 双重模型维护」目前是**理论性**的，没有既成负担可证伪。
- **代价**：把 Task/Message/Part/Artifact + 9 态机 + 事件 schema + AgentCard 全部替换存储 schema（`task_board`/`storage`）、前端事件总线、所有 group 调用点，对价仅是一个**「远期独立立项」**才会用到的远程互操作。
- **建议（保留可逆性）**：
  - M1-M3 只**采用 A2A 的结构体 / 命名约定**——用 Rust struct 复用 Task/Message 形状，用 `references: Vec<task_id>` 字段实现「思考复用」（P0-5 层级 2/3），**不替换存储 schema 与状态机**。
  - A2A 传输绑定（JSON-RPC 2.0 出/入向）按文档所说「独立立项」，届时再评估是否值得 native 建模。
  - 这样「思考复用」等核心增量今天就能落地，且不锁死未来远程互操作的选择。

### 4.2 P0-1 与 P0-4 的依赖

- `AgentRunOutcome` 的 `Cancelled / TimedOut` 分支，只有在 P0-4（异步工具 + 真超时 + cancel 透传到工具执行中）落地后**才能真正产出**。当前 cancel 仅在 LLM 调用间隙生效（engine.rs:318-319），工具执行中不可取消。
- **建议**：M1 实现 outcome 枚举时，标注 `Cancelled / TimedOut` 为「前瞻字段，依赖 P0-4 后生效」，避免验收标准（M1 列表）误判这两项已可验证。

---

## 五、文档的亮点（肯定部分）

- **双目标纲领（A 单 Agent 正确性 / B 多 Agent 复用+并行 / C A2A 互操作）**分层清晰，且明确「只修底座三短板，不动群协作骨架」——纪律好，避免架构天文。
- **P0-1（AgentRunOutcome）** 让调用方拿到确定性终止原因，消除两处补丁，设计干净。
- **P0-5（skills 从未注入 Worker）** 已核实确未注入，是多 Agent「复用」增量的真实高价值改动。
- **第六节「与 pi 架构的取舍」** 务实（借鉴 compaction/权限/配额，不抄扩展系统/模型路由全套），符合「底座只修到正确+安全+可取消」的边界。

---

## 六、修订建议清单（可执行）

1. **纲领 A(13) / 一.1(54)**：把「去 dangling 修复」改为「保留消毒安全网（engine.rs:259-311）+ 修并发根因」。
2. **P1-6**：标注 filesystem 隔离已落地（filesystem.rs:152-183），工作量移至 shell 命令级管控 + 危险命令拒绝；普通会话 `enforce_root=false` 维持自由。
3. **P0-2 / P0-3**：统一口径——固定 session 会累积，compaction 必须覆盖 Worker session；修正「4 态」为「5 态（含 Cancelled）」。
4. **P2-14**：降级为「采用 A2A 结构体命名 + references 字段」，native 建模留待远程互操作立项时再评估。
5. **P0-1**：标注 `Cancelled / TimedOut` 依赖 P0-4。
6. **新增「与 2026-08-02 修复的关系」小节**，明确：dangling 消毒、auto_approve_override（engine.rs:131/480-481 已解锁 Worker 挂死）均已落地，避免后续实施者误删/误判。

---

### 附：复核所用的代码锚点
- engine.rs:117-132（run 签名）、259-311（dangling 消毒）、318-319（cancel 间隙）、480-481（auto_approve_override）
- agent_profile.rs:10-42（skills/mcp/tools 字段）
- tool_registry.rs:33（同步 execute）、shell.rs:41-50（current_dir + thread::spawn）
- filesystem.rs:144-183（resolve_fs_path 已强制隔离）
- roundtable.rs:53/432-433/503-504（RT_TURN_SEQ、每回合新 session、读回 final_text）
- scheduler.rs:351/393-399（hardcode deepseek、InProgress 竞态规避）
- task_board.rs:10-15（5 态）、worker.rs:27/39/77/108（max_concurrency 未强制）
