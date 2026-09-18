# OneDesktop · Agent 轨迹存储「分流 / 分层」改造最终方案

> 文档定位：架构级改造方案（ADR 候选）。覆盖两块——(A) 切换会话后「查看过程」消失的**根治**；(B) 用户提出的 ReAct 轨迹**统一存储（分流）+ 按场景差异化展示（分层）**重设计。
> 约束：单机 SQLite、additive 迁移（ADR-006）、内核纯净度（kernel 禁 `use tauri::`）、不改第二人语义的第一性约束。

---

## 0. 结论先行

1. **「查看过程」切换会话消失，是存储模型缺陷的临床表现，不是 ProcessPanel 的 bug。** 当前 thinking/执行/观察没有一等公民存储行，靠 `messages` 表超载列（`reasoning_content` 压在 assistant 行、观察只活内存、`call_id` 软配对）+ 前端 `messagesToItems` 启发式重建。切会话时内存 items 被整体丢弃、改为从 DB 重建，重建只要缺一条非 user 行，「查看过程」入口（`groupItems.length > 0`）即整体消失。
2. **根治手段 = 让「过程」成为一等公民存储**。把 ReAct 的思考/意图/工具调用/工具结果/观察/答案全部落成带**稳定身份（seq + call_id + parent_id）**的独立行，显示层从「启发式重建」退化为「1:1 读取投影」。重建失败这一类 bug 从构造上消失。
3. **分流与分层是同一个存储的两面**：一张统一的 `agent_trace` 表存所有场景（chat / worker / group）的 ReAct 轨迹；「分层」是**视图层按 scene 做不同投影**——chat 看全细节，group 把模型输出切成多条拟人气泡、思考/工具默认折叠。同一个存储，多个视图。

---

## 1. 现状架构的核心问题（为什么切换会丢）

### 1.1 当前 messages 表语义超载 + 软配对（已确认代码路径）
- 落库（`engine_toolrun.rs:163-174`）：每个工具调用写一行 `assistant`（`content=""`、`tool_name`、`tool_args`、`reasoning_content=per_reason`、`call_id`），随后写一行独立 `role="tool"` 结果行（`call_id`）。
- 思考（逐工具）压在 assistant 行的 `reasoning_content`；主推理在 `reasoningStream` 变量里、Done 时回填。
- 观察（narration，工具轮之间的自然语言）**多数只活在内存**，不保证落库。
- 工具调用↔结果靠 `call_id` **软配对**（`message_repo.find_by_session` 读出后由 `messagesToItems` 用 `Map` 配对）。

### 1.2 显示入口依赖脆弱重建
- 切会话（`useAgent.ts:145-178` 的 `[sessionId]` effect）：旧 items 整体丢弃 → `getMessages → messagesToItems(msgs)` 重建。
- `messagesToItems`（`agentState.ts:20-100`）：用 `switch(kindOf)` + 两段 `Map` 反推 thinking/tool/answer。这是**启发式**，不是确定性的结构化读取。
- `ProcessPanel` 的「查看过程」按钮出现条件 = `items.length > 0`（`ProcessPanel.tsx:685`）+ 外层 `MessageList.tsx:244` 的 `groupItems.length > 0`（groupItems 由 `buildTurns` 从 items 抽）。
- **结果**：只要切回后 `messagesToItems` 重建出的非 user 行缺失（某行 `reasoning_content` 为空、或 worker 场景落库形态不同、或 `call_id` 配对错位、或该 session 消息走的 session_id 与视图查询不一致），`groupItems` 变空 → 按钮整体消失。这与用户描述的「处理完有、切走再切回没了」完全吻合——live 视图靠内存 items（一定对），切回靠 DB 重建（可能错）。

### 1.3 群/Worker 场景的额外错配风险
- Worker 会话 `mode="worker"`，其 thinking 落进**各自 session 的 messages**；群消息流 `roundtable_messages` 刻意无 reasoning 列（前一轮已厘清）。
- 「任务窗口」渲染 Worker 过程时，若它复用的 `getMessages(sessionId)` 与落库 session_id 不一致，或 worker 落库形态与 chat 不同，切换即丢失——这正是用户「切换任务窗口」复现的路径特征。

> 小结：问题不在 ProcessPanel 渲染逻辑，而在**「过程」没有稳定可重放的存储原语**。任何依赖启发式重建的入口，切换都可能在边界 case 崩。

---

## 2. 分流层：统一的 ReAct 轨迹存储（一张表，区分场景/类型）

### 2.1 设计原则
- **一张表 `agent_trace` 承载所有场景的 ReAct 轨迹**（chat / worker / group），用列区分「场景」「类型」「agent 身份」，而非多张表。符合用户「理论上一表」的直觉，也符合既有「同构单表分态」纪律（connection.rs 注释已确认 runs 单表分态是正确的）。
- **每种轨迹原语 = 一行一等公民**，带**固化稳定身份**，不再靠列重载 + 软配对反推。
- additive 迁移：保留旧 `messages` 只读回放兼容，新写入走 `agent_trace`；灰度期双写，稳定后老表可冻结。

### 2.2 目标表结构（additive，新表，不动旧表）

```sql
CREATE TABLE agent_trace (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT    NOT NULL,   -- 统一身份：chat/worker/group 各自的 session_id
  scene       TEXT    NOT NULL,   -- 'chat' | 'worker' | 'group'  使用场景
  agent_type  TEXT,               -- 'user' | 'owner' | 'worker:<id>' | 'system'
  kind        TEXT    NOT NULL,   -- 见 2.3
  seq         INTEGER NOT NULL,   -- 落库即固化，稳定身份（不再 ROW_NUMBER 派生）
  call_id     TEXT,               -- 工具调用身份；tool_call ↔ tool_result 硬配对（外键到同表 id）
  parent_id   INTEGER,            -- 嵌套：observation→tool_call 行；intent→主 thinking 段
  content     TEXT,               -- 文本：答案/观察/发言/notice
  args        TEXT,               -- tool_call 入参 JSON
  result      TEXT,               -- tool_result 内容
  reasoning    TEXT,               -- 思考内容（thinking / intent 段），不再压在别处
  is_error    INTEGER,
  started_at  INTEGER,            -- epoch ms（统一时间表示，消除现状 TEXT/INTEGER 混用）
  ended_at    INTEGER,
  created_at  TEXT    NOT NULL
);
CREATE INDEX idx_trace_session ON agent_trace(session_id, seq);
CREATE INDEX idx_trace_call    ON agent_trace(call_id, kind);
```

### 2.3 原语（kind）枚举——覆盖思考/执行/观察全链
| kind | 含义 | 来自 |
|---|---|---|
| `user` | 用户输入 | chat 输入 |
| `thinking` | 主推理段（Thought） | Thinking 事件（thought_id=`th_main_*`） |
| `intent` | 逐工具执行前意图思考 | Thinking 事件（thought_id=`th_{call_id}`） |
| `tool_call` | 工具调用请求 | ToolCall 事件 |
| `tool_result` | 工具结果 | ToolResult 事件 |
| `observation` | 工具轮间观察/下一步意图（自然语言） | 流式 narration 落库 |
| `answer` | 最终答案 / 群内发言 | Done 终答；group 场景下即广播内容 |
| `notice` | 系统提示/错误 | Error/notice 事件 |

> 关键：**thinking/intent/observation 现在都是显式行**，不再压列、不再只活内存。`tool_call.id = tool_result.parent_id`（硬配对，替代 `call_id` Map 软配对——`call_id` 仍保留用于跨重启稳定身份，但行内 `parent_id` 才是回放主键）。

### 2.4 场景区分（分流的核心）
- `scene`：简单会话=`chat`；Worker 执行=`worker`；群内广播=`group`。
- `agent_type`：谁产生的（群主 owner / 某 worker / 用户 / 系统）。群消息流天然只含 `answer`/`observation` 行（`scene='group'`），思考/工具调用（thinking/intent/tool_call）`scene` 同为该 worker 的 `worker` 轨迹，**物理隔离、互不串**——延续前一轮已厘清的「群消息=发言流、思考=私有」纪律，但用结构化列而非「表有无某列」来表达。

---

## 3. 分层层：同一份存储、按场景的差异化展示投影

「分层」不是再存一份，而是**视图层根据 scene 对同一份 `agent_trace` 做不同投影**。展示差异是纯前端/投影逻辑，不污染存储。

### 3.1 投影 A — 简单会话（chat）：全细节
- `scene='chat'` 的 session：ProcessPanel 渲染 `thinking + intent + tool_call + tool_result + observation`，全部可见（"查看过程"内）。
- 最终 `answer` → 答案气泡（MessageList 现有逻辑）。
- 与现状体验一致，但数据来自确定性读取，无启发式。

### 3.2 投影 B — 群消息（group）：切条拟人气泡
- 群聊里**不应把长 CoT 铺在群流**。把模型的产出按"人说话习惯"切成多条气泡：
  - 一个 worker 的一轮 = 若干 `answer`/`observation` 行 → 各自一条气泡（可合并短句、按语义断句）。
  - `thinking`/`intent`/`tool_call`/`tool_result` **默认不进群流**，仅在单条气泡提供「查看过程 ▸」展开（展开即从 `agent_trace` 读该 agent 的 thinking/tool 子行）。
- 这样群流是"对话感"的，细节是"按需下钻"的——满足用户「群消息把模型输出按人的习惯切成多条展示」的诉求。
- 复用 `scene='group'` 行的 `parent_id` 串联下钻：气泡点开 → 拉该 answer 的 `parent_id` 链 → 渲染对应 thinking/tool。

### 3.3 投影切换点（单一收敛）
- 显示层新增一个 `projectionOf(scene, rows)` 纯函数：输入 `agent_trace[]`，输出该场景的 UI 模型（chat=扁平过程流+答案；group=气泡流+下钻）。
- 一个 session 的 `scene` 由 session 元数据决定（chat/worker/group），不靠内容猜。

---

## 4. 切换会话「查看过程」消失如何结构性消除

改造后读取路径：
```
useAgent [sessionId] effect
  → getTrace(sessionId)            -- 直接 SELECT agent_trace ORDER BY seq
  → projectionOf(scene, rows)      -- 确定性投影，非启发式
  → items（稳定、完整、含全部过程行）
```
- 因为 thinking/intent/observation/tool 都是**显式行且 seq 固化**，`projectionOf` 读出来一定有 `groupItems.length > 0`（只要有过程发生）。
- 不再有「重建缺一行→入口消失」；不再有 `call_id` Map 错位；不再有 worker/chat 落库形态差异导致的切回空白。
- `ProcessPanel` 的「查看过程」守卫可收紧为「该 turn 存在任一非 user/answer 的 kind」——确定性强。

> 这是从根上消除，而非给 `messagesToItems` 打补丁（前几轮已证明补丁治标）。

---

## 5. 迁移路线（additive，低风险）

| 阶段 | 动作 | 风险 |
|---|---|---|
| P0 | 新增 `agent_trace` 表 + 索引；`getTrace`/`add_trace` 仓储；`seq` 由写入方原子自增（或 `MAX(seq)+1` 事务） | 低 |
| P1 | 内核落库双写：现有 `add_message` 旁同步写 `agent_trace`（thinking/intent/tool_call/tool_result/observation/answer 各自成行，填 `scene`/`agent_type`/`call_id`/`parent_id`） | 低（旧表不变） |
| P2 | 前端 `useAgent` 切到 `getTrace → projectionOf`；旧 `messagesToItems` 仅用于读老库/回放兜底 | 中（需兼容双源） |
| P3 | 群消息「切条气泡」投影 B 落地（group scene） | 中 |
| P4 | 老 `messages` 表冻结（只读），清理 `call_id` Map 配对等启发式代码 | 低 |

> 全程保持老 `messages` 可读，回放旧会话不炸（ADR-006 additive 纪律）。

---

## 6. 短期止血（若不全量改造，先让 bug 不出现）

若 P0–P2 全量改造暂不排期，先用最小改动消除「切回消失」：

1. **`useAgent` 切会话不丢弃内存 items**：把每 session 的 items 缓存到 `Map<sessionId, Item[]>`（store 级），切回时优先用缓存、后台 `getMessages` 仅作校正（而非整体覆盖）。这样 live 正确态被保留，不再依赖脆弱重建。
2. **入口守卫去脆弱**：`ProcessPanel`「查看过程」出现条件从 `items.length > 0` 改为「存在任一 `kind ∈ {thinking, intent, tool_call, tool_result, observation}`」——即便 answer 单独在，过程入口也不丢。
3. **`messagesToItems` 健壮性**：对 worker 场景单独校验落库形态；`call_id` 配对失败时仍保留 thinking/tool 行（不整体丢弃）。

> 短期方案治标、全量方案治本。建议两者并行：先上 6.1/6.2 止血，再走 P0–P2 根治。

---

## 7. 开放决策点（需你拍板）

1. **群消息切条粒度**：按「每个 observation/answer 一行」切，还是按语义断句合并短句？（影响群流密度）
2. **观察（observation）是否全量落库**：现状多在内存。根治需落库（`kind='observation'`），会有存储增长，是否接受？
3. **老 `messages` 表最终命运**：冻结只读 vs 择期归档删除（单机、隐私，建议保留只读无限期）。
4. **本轮先做哪个**：全量 P0–P2 根治 / 仅短期 6.x 止血 / 先出 `agent_trace` 表 + 双写（P0–P1）不打前端。

---

## 8. 与既有纪律的对齐

- 不改第二人语义、单机 SQLite、additive 迁移——均满足。
- 「群消息=发言流、思考=私有」切分纪律——用 `scene`/`agent_type` 显式列化，比"表有无 reasoning 列"更稳、更可查询。
- 内核纯净度——`agent_trace` 仓储在 `storage/`，`use tauri::` 仍只在 `agent/ports.rs`。
- 改动纪律（先设计后改、单一机制、不缝补）——本方案以"一等公民轨迹行 + 投影"替代"超载列 + 启发式重建"，是机制收敛而非打补丁。

---

## 9. 实施状态（2026-08-12 · P0–P2 已落地）

用户拍板 4 决策：①群消息切条=按语义断句合并短句；②观察全量落库（接受存储增长）；③老 `messages` 表保留只读无限期；④本轮做全量 P0–P2。

- **P0**：`connection.rs` 新增 `agent_trace` 表 + 2 索引；`storage/trace_repo.rs`（`TraceRow`/`add_row`/`count_by_session`/`find_by_session`/`message_to_trace_rows`/`backfill_from_messages`）；`types.rs` `TraceDto`；`commands/session.rs` `get_trace` + `lib.rs` 注册；`SessionManager::get_trace`（trace 为空时从 messages 一次性回填，老库兼容）。
- **P1**：`MessageRepository::create` 单一写入拦截点双写——每条 message 按 `scene`（sessions.mode 派生 worker/chat）+ `agent_type` 拆成显式 trace 行（user/thinking/intent/tool_call/tool_result/answer）；`SessionManager::add_observation` + `engine_toolrun::run_tool_calls` 在 `plan_content` 非空时落 `kind='observation'`（观察全量落库）。
- **P2**：前端 `types.ts` `TraceRow`、`chatCommands.ts` `getTrace`、`agentState.ts` `traceToItems`（call_id 配对，思考/意图/观察/答案显式投影，无启发式）、`useAgent [sessionId]` effect 改 `getTrace→traceToItems`，trace 空回退 `messagesToItems`。
- **验证**：`check:ts` ✓ / `check:rust` ✓ / `check:kernel` ✓（内核纯净度通过）。切换会话「查看过程」从构造上不再丢失。
- **未做（后续）**：P3 群消息切条拟人气泡（决策①的投影细节）；P4 冻结老 `messages` 启发式代码清理。老库回填不含 observation（历史消息从未持久化 narration，无回归）。

