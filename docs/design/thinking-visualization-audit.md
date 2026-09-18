# OneDesktop 思考过程可视化 — 架构审计与设计

> 日期：2026-08-10 · 状态：设计稿（不含实现）
> 输入：外部方法论《Agent 思考可视化的真正难点》
> 输出：现状对照评分 + 缺口清单 + 三份规范 + 分阶段路线

---

## 0. 一句话结论

OneDesktop **已经跨过了"协议归一"这道最容易翻车的坎**（Rust 内核充当本机 BFF，五种推理方言在 `llm/providers/openai.rs` 就被拍平），
但**栽在了下一道坎：状态层没有身份标识**。事件没有 `seq`、工具没有 `call_id`、持久化没有 `kind`，
于是前端只能靠 **名字反查 + 位置启发式** 还原语义 —— 这正是方法论里点名禁止的"用 DOM 顺序反推逻辑"。

短期不会炸，因为单机串行执行掩盖了大部分竞态。一旦引入**并行工具、子 Agent 嵌套、回放导出**，
现在这套推断会成片失效。

---

## 1. 五大难点 · 现状对照评分

| # | 难点 | OneDesktop 现状 | 评分 |
|---|---|---|---|
| 1 | 多路并发时序 | 事件流完整（13 种），但**无 seq / 无 call_id**，靠 `tool_name` 反查配对 | ⚠️ 4/10 |
| 2 | 协议层字段不统一 | 已在 Rust 层归一：`ReasoningDialect` 五方言 → 单一 `reasoning_content`；前端只认 `AgentEvent` | ✅ 9/10 |
| 3 | 可展开 / 可回溯 | 密度三档 + PEEK 已有；回放**靠位置启发式重建**，DB 不存语义 | ⚠️ 5/10 |
| 4 | 性能与截断 | rAF 合帧已做；无虚拟化、Markdown 未分段、无长度截断 | ⚠️ 5/10 |
| 5 | 隐私与合规边界 | **完全没有策略层**。CoT 全量落库 + 全量渲染 + 全量导出 | ❌ 2/10 |

---

## 2. 难点逐条实测

### 2.1 时序模型 —— 事件够全，身份缺失

内核 `AgentEvent`（`src-tauri/src/types.rs:6`）共 13 种，已覆盖方法论要求的全部语义：

```
Token / Thinking / ToolCall / ToolResult / Done / Error
ApprovalRequest / Proposal        ← 人在回路
Progress / Paused                 ← 长任务
TodoUpdate                        ← 自动规划
```

事件通道有两条：旧 `agent-event` + 新统一总线 `onedesktop-event`（Envelope，`services/eventBus.ts:28`），兼容期双发。

**缺口 A（P0）：ToolCall / ToolResult 没有 call_id。**

内核**明明有** `call_ids[i]`（`engine_toolrun.rs:250 / 336`，用于拼 `ChatMessage::tool_result`），
但 emit 事件时只带了 `tool_name`（`engine_toolrun.rs:197 / 242 / 328 / 444`）。
前端只能反查：

```ts
// hooks/agentState.ts:110  updateToolResult()
for (let i = items.length - 1; i >= 0; i--) {
  if (item.kind === "tool" && item.name === toolName) { /* 命中第一个同名 */ }
}
```

同一回合连调两次 `run_command`，结果回填靠"从后往前第一个同名"。串行执行时侥幸正确，
**并行工具 / 重试 / 折叠（`ToolItem.hidden`）三个场景任一落地即错配**。

**缺口 B（P1）：thinking 没有 start / end 边界。**

`reasoningBuf.current += content` 持续累加（`useAgent.ts:211`），**只有 ToolCall 或 Done 才清空**。
后果：同一轮里模型的两段独立思考被粘成一个 `ThinkingItem`，中间的语义断点丢失。
方法论里的 `thinking_start` / `thinking_end` 在这里是真需求，不是过度设计。

**缺口 C（P2）：Waiting 是前端伪造的。**

内核从不发"我在等模型"。前端在 ToolResult 后自己塞（`useAgent.ts:320`）：

```ts
if (isStreaming) { return [...updated, createWaitingItem("等待模型响应")]; }
```

这里的 `isStreaming` 是**订阅闭包捕获的 state**，不是 ref —— 存在读到陈旧值的隐患。
更根本的问题是：等待态属于运行时事实，应由内核声明，不该前端猜。

### 2.2 协议归一 —— 这块做对了

方法论担心的分支地狱：

```ts
if (data.thinking) ... else if (data.type === 'reasoning') ... // ❌
```

OneDesktop 前端**不存在这种代码**，因为归一化发生在 Rust：

- `llm/providers/openai.rs:25-33` 定义 `ReasoningDialect`，覆盖
  DeepSeek（`thinking.type`）/ Qwen（`enable_thinking`）/ GLM / Kimi（`reasoning_effort`）/ MiniMax（`reasoning_details[]` 数组聚合）
- 请求侧：每家按自己方言拼参数；响应侧：统一吐 `reasoning_content` 单字符串
- `openai.rs:582` 有专门注释：「MiniMax 独一份的数组格式；聚合成统一 reasoning_content，**UI 层零改动**」

**这是本项目最健康的一层。** 新接模型只改 dialect 枚举，渲染层不动。

单机形态下的映射关系值得记一笔：**方法论说的 BFF 归一层 = OneDesktop 的 Rust 内核**。
不需要另建服务，但内核必须持续承担这个职责 —— 任何"前端按模型名做 if 分支"的提案都应被拒绝。

### 2.3 可展开 / 可回溯 —— 回放是纸糊的

产品形态已定（`types/index.ts:239`）：`ThinkDensity = collapsed | peek | expanded`，
外加状态级折叠（live 平铺 / done 收起）。这部分是清楚的。

**问题在回放。** `messages` 表（`storage/connection.rs:74`）字段：

```sql
id, session_id, role, content,
tool_name, tool_args, tool_result,
token_usage, reasoning_content, created_at
```

没有 `seq`、没有 `item_kind`、没有 `call_id`、没有 narration 标记。
于是切会话 / 重启后重建 UI 只能靠**位置启发式**（`hooks/agentState.ts:65`）：

```ts
// markNarrations()：同一 user 轮内，位于最后一个 tool 之前的 assistant 必是观察
```

这个规则在"模型跑完最后一个工具后又吐了一段观察、再吐答案"时**直接失效** ——
那段观察会被误判成答案，答案被误判成……取决于谁在最后。

排序也脆：`ORDER BY created_at`（字符串）+ 自增 id 兜底，同秒批量插入时顺序依赖 id 单调性。

方法论原话「不要在前端用 DOM 顺序反推逻辑」—— 我们现在**正是**在这么干。

### 2.4 性能 —— 做了合帧，没做别的

已有：

- rAF 合帧（`useAgent.ts:185` `scheduleStreamFlush`），长回复从"每 token 一次 render"降到 ≤60fps
- live 滑窗固定 220px + 顶部渐隐遮罩（`App.css` `.process-panel--live`）

缺：

- **无虚拟化**。10k token 思考链 = 全量 diff，滚动时整列表参与协调
- **Markdown 未分段解析**。流式过程中代码块 / 表格反复重解析，闪缩（CLS）
- **无截断策略**。超长 CoT 既不折叠也不省略
- **React key 不稳**：观察行用 `obs-${idx}`（`ProcessPanel.tsx:297`）—— 数组前部插入会让 key 整体漂移，
  React 复用错组件，表现为"展开态跳到别的行上"。`ThinkingItem.id` 用 `Date.now()`（`agentState.ts:136`），同毫秒创建撞 key。

### 2.5 隐私边界 —— 这块是空白

当前：`reasoning_content` 全量落 SQLite、全量渲染、全量导出。**没有任何过滤或分级。**

单机应用容易误以为"就我一个人用，无所谓"。但外泄面真实存在：

1. **system prompt 里注入了三块记忆**（`agent/tools/memory.rs::read_memory_block()`）：
   `USER.md`（用户画像）/ `PROJECT.md` / `MEMORY.md`。模型在 CoT 里复述这些内容 → 原样上屏
2. **回放导出功能已存在**（IX-14），导出物会携带完整 CoT，包含内部工具名、system prompt 片段
3. **截图分享**是这类工具最高频的传播路径
4. 我们**主动强制**模型写 `intent` 字段（`engine.rs::REASONING_PROTOCOL`），内容不可控

结论：可见性策略层不是"以后可能要"，是**已经欠着**。

---

## 3. 缺口清单（按优先级）

| ID | 缺口 | 严重度 | 落点 |
|---|---|---|---|
| G1 | ToolCall/ToolResult 无 `call_id`，靠名字反查 | **P0** | `types.rs:10/16` + `engine_toolrun.rs:197/242/328/444` + `agentState.ts:110` |
| G2 | 持久化丢语义（无 seq / kind / call_id），回放靠位置推断 | **P0** | `storage/connection.rs:74` + `agentState.ts:65` |
| G3 | 无可见性策略层，CoT 全量落库+渲染+导出 | **P0** | 新增策略模块 |
| G4 | 状态是扁平数组，非节点树；嵌套需求已出现（群 Worker） | P1 | `types/index.ts:206` + `MessageList.tsx:21` |
| G5 | thinking 无 start/end，多段思考被粘连 | P1 | `types.rs:23` + `useAgent.ts:211` |
| G6 | React key 不稳（`obs-${idx}` / `Date.now()`） | P1 | `ProcessPanel.tsx:297` + `agentState.ts:136` |
| G7 | 无虚拟化 / Markdown 未分段 / 无截断 | P2 | `ProcessPanel.tsx` |
| G8 | Waiting 前端伪造 + stale closure 隐患 | P2 | `useAgent.ts:320` |

---

## 4. 规范一：《思考区交互规范》

方法论要求先填的那张表，按 OneDesktop 单机形态定稿：

| 维度 | 选项 | **本项目定为** | 理由 |
|---|---|---|---|
| 默认可见性 | 始终 / 折叠 / 仅调试 | **执行中全展开，完成即折叠** | 已定，2026-08-09 用户硬指令 |
| 与正文关系 | 内联气泡 / 侧栏 / 折叠块 | **内联无卡片流** | 用户明确反对卡片壳；层次靠缩进+竖线+字重 |
| 是否可交互 | 不可点 / 可展开 / 可编辑 / 可终止 | **可展开 + 可终止 + 人在回路** | 已有 approval 四态 / Proposal 多选 / Paused 续跑；**不做可编辑** |
| 是否持久化 | 不存 / 服务端 / 本地 | **本地 SQLite 全量** | 单机第一性约束；但需补语义字段 |
| 多轮关系 | 每轮独立 / 跨轮串链 | **每轮独立**（分组见 `buildTurns`） | 跨轮串链无产品需求，暂不做 |
| 敏感内容 | 无策略 / 分级 | **待建（G3）** | 当前空白，需补 |

补一条方法论没列、但单机场景特有的维度：

| 维度 | 本项目定为 |
|---|---|
| **嵌套 Agent 过程** | 群协作 Worker 走独立 `rt:` 会话，主会话**不内嵌**其过程流 —— 保持主时间轴单层，避免深树 |

### 4.1 三类文本的归属（已固化，不可回退）

一个回合模型产出的文字分三类，渲染归属不可混：

| 类型 | 来源 | 去向 |
|---|---|---|
| **思考** CoT | `reasoning_content` | `ThinkingItem` → ProcessPanel |
| **观察** | 两次工具之间的自然语言（判断上一步 + 声明下一步） | `AssistantItem.narration=true` → ProcessPanel |
| **最终答案** | 所有工具跑完后的收尾文本 | `AssistantItem` → AnswerBubble |

新增任何 assistant 文字路径前，先想清它属于哪一类。

---

## 5. 规范二：《统一 Agent 事件协议》— 现状 + 增补

前端只认一种协议（这点已达成），需要补的是**身份与边界字段**：

```rust
// 增补项以 ★ 标记（均为 additive，符合 ADR-006）
AgentEvent {
  Token        { session_id, ★seq, token }
  Thinking     { session_id, ★seq, ★thought_id, content }
  ★ThinkingEnd { session_id, ★seq, ★thought_id }        // 显式边界，解决 G5
  ToolCall     { session_id, ★seq, ★call_id, tool_name, tool_args }
  ToolResult   { session_id, ★seq, ★call_id, tool_name, result, is_error }
  Done / Error / Progress / Paused / TodoUpdate / Proposal / ApprovalRequest  // 同样加 ★seq
}
```

三个字段的作用：

- **`seq`**（单调递增，会话内唯一）：排序真值源，替代 `created_at` 字符串比较；也是重放的断点标记
- **`call_id`**：工具配对真值源，替代名字反查（内核已有 `call_ids[i]`，**只是没往外传**，改动量极小）
- **`thought_id`** + `ThinkingEnd`：思考段落边界，让多段思考不再粘连

**注意**：不新增端口（内核端口计数硬约束 = 8），这些都是既有事件的字段增补。

---

## 6. 规范三：《节点树状态模型》

### 6.1 双结构

| 结构 | 用途 | 派生自 |
|---|---|---|
| **时间轴**（扁平，按 `seq`） | 滚动渲染、虚拟化、断点重放 | 事件流原序 |
| **节点树**（嵌套） | 思考→工具→子思考的展开折叠 | 同一 `session_id + seq` 派生 |

两者由同一份数据派生，**不允许渲染层反向推断结构**。

### 6.2 节点类型

```ts
type AgentNode =
  | ThoughtNode   // CoT 段落，有明确 start/end
  | ObserveNode   // 工具间观察（当前的 narration）
  | ToolNode      // 含 call_id、args、result、status、elapsed、diff 统计
  | AnswerNode    // 最终答案
  | NoticeNode    // 错误 / 暂停 / 模型切换
  | ApprovalNode  // 人在回路

interface NodeBase {
  id: string;        // 稳定 id，非 Date.now()、非数组下标 → 解决 G6
  seq: number;       // 排序真值
  parentId?: string; // 嵌套（预留，当前主时间轴不用）
  visibility: "visible" | "collapsed" | "devOnly" | "redacted";  // 解决 G3
}
```

`visibility` 直接挂在节点上，**渲染前就已决定**，视图层不做判断 —— 这是策略层与视图层的分界。

### 6.3 三层分工（方法论第 4 条）

| 层 | 职责 | 禁止 |
|---|---|---|
| **数据层** | 收事件 → 按 seq 写入 store（不可变、可重放） | 不做展示判断 |
| **策略层** | 计算 `visibility`、脱敏、导出过滤 | 不碰 DOM |
| **视图层** | 订阅 store → 折叠、节流、Markdown 分段 | **不拼字符串、不反推语义** |

当前 `useAgent.ts` 一个 590 行的 hook 同时干了三层的活 —— 这是重构的主要目标。

### 6.4 持久化增补（G2）

```sql
ALTER TABLE messages ADD COLUMN seq        INTEGER;  -- 排序真值
ALTER TABLE messages ADD COLUMN item_kind  TEXT;     -- thought|observe|tool|answer|notice
ALTER TABLE messages ADD COLUMN call_id    TEXT;     -- 工具配对
```

additive 迁移，符合 ADR-006。旧数据 `item_kind` 为 NULL 时**回落到现有启发式**（`markNarrations`），
保证历史会话不炸 —— 启发式从"唯一手段"降级为"兼容兜底"。

---

## 7. 单机形态的裁剪

方法论面向的是"前端 + BFF + 云端模型"，OneDesktop 是单机 Tauri，几项需要重新映射：

| 方法论条目 | OneDesktop 映射 | 结论 |
|---|---|---|
| BFF 归一层 | Rust 内核 = 本机 BFF | **已存在，无需新建** |
| 断网重连续传 | 不存在网络断连；但**应用重启 / 切会话 / Worker 崩溃**是等价问题 | **同等重要，靠 seq 解决** |
| 服务端快照重放 | 本机 SQLite 就是快照源 | 已有，缺语义字段 |
| 开发者模式 vs 普通用户 | 单机只有一个人，模式切换意义不大 | **降级**；但导出/截图外泄面仍需策略层 |
| 多用户权限过滤 | 无第二个人 | **不做**（产品第一性约束） |
| SSE 乱序压测 | 本机 IPC 有序 | **降级为低优先级** |

---

## 8. 分阶段路线（不含实现）

### Phase 1 — 身份补全（P0，改动小、收益大）

1. `AgentEvent` 加 `seq` + `call_id`（内核已有 `call_ids`，仅透传）
2. `updateToolResult()` 改按 `call_id` 匹配，名字反查降级为兜底
3. `messages` 表 additive 加三列；`markNarrations` 降级为 NULL 兜底
4. 稳定 id：`ThinkingItem.id` 改 `${sessionId}-${seq}`；观察行 key 改 `obs-${seq}`

验收：连续两次同名工具调用，结果回填正确；重启后回放与实时渲染逐项一致。

### Phase 2 — 策略层（P0，当前空白）

1. 新增 `visibilityPolicy(node) → visibility`
2. 规则起步集：CoT 中命中 `<user_profile>` / `<project_memory>` / system prompt 片段 → `redacted`；
   内部工具名 → `collapsed`
3. 导出（IX-14 回放导出）接策略层，导出物默认剔除 `redacted`

验收：导出物不含 USER.md 内容；截图场景下敏感段落默认不可见。

### Phase 3 — 节点树重构（P1）

1. 抽 `AgentNode` 树 + 三层分工，`useAgent` 从 590 行拆成 数据/策略/视图
2. `ThinkingEnd` 事件落地，多段思考分离
3. ProcessPanel 只消费树，不再 filter 原始 Item

### Phase 4 — 性能（P2）

1. 过程流虚拟化（阈值：>50 节点）
2. Markdown 分段解析 + 稳定高度占位，消 CLS
3. 超长 CoT 截断 + "展开全部"

---

## 9. 最小可痛验证清单

方法论第 5 条要求"故意做脏活"。落到单机：

| 场景 | 验证点 | 当前预期结果 |
|---|---|---|
| 同一回合连调 3 次 `run_command` | 三条结果分别回填对应行 | ❌ **会错配**（名字反查） |
| 一轮内模型吐两段独立思考 | 渲染为两个思考段 | ❌ **粘成一段** |
| 5k token CoT 连喷 30s | 滚动帧率 ≥ 50fps | ⚠️ 未测，无虚拟化 |
| 跑到一半切会话再切回 | 时间轴与切走前完全一致 | ⚠️ 依赖启发式，边界会歪 |
| 模型在最后一个工具后先观察再答 | 观察进过程，答案进气泡 | ❌ **判反**（位置启发式失效） |
| 回放导出 | 导出物不含 USER.md 画像 | ❌ **会带出去** |

**建议：先把这 6 条写成回归用例，再动代码。** 前 2 条和第 5 条是 Phase 1 的直接验收标准。

---

## 10. 给决策者的三句话

1. **协议层不用动** —— Rust 内核的方言归一是这个项目做得最对的一层，继续守住"前端不按模型名分支"这条线。
2. **优先补身份，不优先补 UI** —— `seq` + `call_id` 两个字段能一次性拆掉名字反查和位置启发式两处地雷，改动量以行计。
3. **策略层是欠账不是新功能** —— CoT 里已经在流用户画像，而导出和截图是这类工具最高频的传播路径。
