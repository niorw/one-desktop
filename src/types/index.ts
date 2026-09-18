// ── Session ──
export interface Session {
  id: string;
  title: string;
  model: string;
  preamble: string;
  created_at: string;
  updated_at: string;
  /** R7：NULL=单聊；"group"=已升级为群（ADR-008 视图状态）。 */
  mode?: string | null;
  /** R7：升级后关联的群 id。 */
  group_id?: string | null;
  /** 工作区 id（docs/design/workspace-design.md v2）。NULL = 默认工作区（资源共享/隔离边界）。 */
  workspace_id?: string | null;
}

// ── Message (database model) ──
export interface Message {
  id: number;
  session_id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
  tool_args?: string;
  tool_result?: string;
  reasoning_content?: string;
  token_usage: number;
  created_at: string;
  /**
   * 会话内单调序号（G1）。由内核读取时 `ROW_NUMBER()` 派生，**不是**数据库列。
   * 这是排序与回放定位的真值源，替代脆弱的 `created_at` 字符串比较。
   */
  seq?: number;
  /** 工具调用身份（G1）。assistant(tool_call) 与 tool(result) 共享同一值，重启后仍能配对。 */
  call_id?: string | null;
  /** 落库时固化的语义类型（G2）：user | assistant | tool。老行为 null，读取侧退回启发式。 */
  item_kind?: string | null;
  /** R8：本回合运行 id（与 changeset 关联，供「查看所有变更」入口）。 */
  run_id?: string | null;
  /** R8：本回合写入文件清单 JSON（outcome.written_files），供「查看所有产物」计数。 */
  artifacts?: string | null;
}

// ── Agent Trace（分流/分层：一等公民 ReAct 轨迹，agent_trace 表投影）──
// 每种原语 = 独立行：user | thinking | intent | tool_call | tool_result |
// observation | answer | notice。前端按此确定性投影「查看过程」，无需启发式重建。
export interface TraceRow {
  id: number;
  session_id: string;
  scene: string;
  agent_type?: string | null;
  kind: string;
  name?: string | null;
  seq: number;
  call_id?: string | null;
  parent_id?: number | null;
  content?: string | null;
  args?: string | null;
  result?: string | null;
  reasoning?: string | null;
  is_error?: boolean | null;
  started_at?: number | null;
  ended_at?: number | null;
  created_at: string;
}

// ── Agent Events (from Rust backend) ──
/**
 * 所有事件共有的身份字段（G1）。
 *
 * `seq` 由内核 `TauriObserver` 在出口统一按会话赋号——发射端不关心，前端拿到的
 * 一定是单调递增值。旧内核不带该字段，故为可选：消费侧必须能在缺省时退化工作。
 */
export interface EventIdentity {
  seq?: number;
}

export type AgentEvent =
  | { type: "Token"; data: EventIdentity & { session_id: string; token: string } }
  | { type: "ToolCall"; data: EventIdentity & { session_id: string; call_id?: string; tool_name: string; tool_args: string } }
  | { type: "ToolResult"; data: EventIdentity & { session_id: string; call_id?: string; tool_name: string; result: string; is_error: boolean } }
  /** `thought_id` 标识思考段落；同段多次流式推送共享同一 id。 */
  | { type: "Thinking"; data: EventIdentity & { session_id: string; thought_id?: string; content: string } }
  /** 思考段落显式闭合（G5）：收到即封存该段，后续 Thinking 另起一段，不再粘连。 */
  | { type: "ThinkingEnd"; data: EventIdentity & { session_id: string; thought_id: string } }
  | { type: "Done"; data: { session_id: string; final_response: string; token_usage: number } }
  | { type: "Error"; data: { session_id: string; message: string; error_code?: string; retriable?: boolean } }
  | { type: "ApprovalRequest"; data: { session_id: string; approval_id: string; tool_name: string; tool_args: string; seat?: string | null; risk?: string } }
  /** 长任务进度心跳（§5.1）。每轮完成后推一次，percent 为轮次进度（iteration/max_iterations），非语义完成度。 */
  | { type: "Progress"; data: { session_id: string; task_id?: string | null; iteration: number; max_iterations: number; percent: number; tokens_used: number; token_budget: number } }
  /** 长任务被挂起（§6.4）：非错误非完成，前端据此收成「已暂停 · 可继续」而非失败/成功态。 */
  | { type: "Paused"; data: { session_id: string; task_id?: string | null; iteration: number; tokens_used: number } }
  /** 能力①：回合待办清单快照。每次状态跃迁全量重推（幂等覆盖，前端不做增量合并）。 */
  | { type: "TodoUpdate"; data: { session_id: string; run_id: string; todos: TodoEntry[] } }
  /** 能力②：方案多选项确认。内核 fail-closed 阻塞等待 `decide_proposal`，超时按 rejected 收。 */
  | { type: "Proposal"; data: ProposalPayload }
  /** R8：本回合产物/变更汇入清单。run 收尾后下发，前端据此渲染「查看所有产物/变更」入口。 */
  | { type: "RunArtifacts"; data: { session_id: string; run_id: string; artifacts: string[] } };

/** 单条待办（与内核 `types::TodoEntry` 同构）。 */
export interface TodoEntry {
  id: string;
  title: string;
  /** pending（未开始） | active（进行中） | done（已完成） | failed（失败） */
  status: TodoStatus;
  /** 进行中时的现在分词文案（"正在分析依赖"），缺省则回落 title。 */
  active_form?: string | null;
}

export type TodoStatus = "pending" | "active" | "done" | "failed";

/** 方案里的一个可选项（与内核 `types::ProposalOption` 同构）。 */
export interface ProposalOption {
  id: string;
  label: string;
  description: string;
  /** low | medium | high —— 驱动选项卡右上角风险点颜色。 */
  risk?: string;
  /** 内核推荐项，前端高亮 + 默认选中。 */
  recommended?: boolean;
}

/** 待人工确认的方案（Proposal 事件载荷；也作为前端 pendingProposal 状态）。 */
export interface ProposalPayload {
  session_id: string;
  proposal_id: string;
  title: string;
  summary: string;
  options: ProposalOption[];
  risk?: string;
  /** 群协作场景下的席位（由 `rt:{group}:{worker}` 前缀拆出），主会话为 null。 */
  seat?: string | null;
}

// ── UI Items (unified message model inspired by openworker) ──

/** Tool execution status */
export type ToolStatus = "pending" | "running" | "done" | "error";

/** A single tool call step */
export interface ToolItem {
  kind: "tool";
  id: string;
  name: string;
  args: string;
  status: ToolStatus;
  result?: string;
  isError?: boolean;
  /** Number of hidden tool calls collapsed into this one */
  hidden?: number;
  /** Whether this tool was auto-approved (standing rule) */
  autoApproved?: boolean;
  /**
   * 内核下发的工具调用身份（G1）。并发多工具时，结果回填靠它精确命中；
   * 缺省（旧内核/历史消息）时回落到「按 name 找最后一个 running」的启发式。
   */
  callId?: string;
  /** 事件序号，用于稳定排序与回放定位。 */
  seq?: number;
  /** 节点树父节点（Phase 3 / G4）：思考→工具→子思考的嵌套承载；主时间轴多为 undefined。 */
  parentId?: string;
  /** 事件时间戳（epoch ms），用于 ProcessPanel 计算回合耗时（缺省靠父级 elapsed prop）。 */
  ts?: number;
}

/** Assistant message (may contain reasoning) */
export interface AssistantItem {
  kind: "assistant";
  /**
   * 稳定 React key（G1）。缺省时渲染侧只能退回数组下标，而过程流里
   * waiting 会被移除、thinking 会被插入——下标一漂，React 就复用错 DOM 节点，
   * 表现为观察文字闪烁或串行。创建时赋一次，此后随 spread 一路带下去。
   */
  id?: string;
  text: string;
  reasoning?: string;
  isStreaming?: boolean;
  /**
   * 过程观察（narration）标记。
   *
   * 多轮工具调用时，模型会在两次工具之间吐一段自然语言——通常是对上一步
   * 结果的观察 + 下一步意图（例：「语法 ✓，17/18 断言通过，接下来修…」）。
   * 这类文字属于「思考-执行-观察」循环的一环，**不是最终答案**，必须留在
   * 过程流里，不能被提升进答案气泡（2026-08-10 用户硬指令）。
   *
   * true  = 工具轮之间的观察，由 ProcessPanel 渲染；
   * 缺省/false = 收尾的最终答案，由 AnswerBubble 渲染。
   */
  narration?: boolean;
  /** 节点树父节点（Phase 3 / G4）。 */
  parentId?: string;
  /** 事件时间戳（epoch ms），用于 ProcessPanel 计算回合耗时。 */
  ts?: number;
  /** R8：本回合运行 id（与 changeset 关联，驱动「查看所有产物/变更」入口）。 */
  runId?: string;
  /** R8：本回合写入文件清单（落库 artifacts 列 + RunArtifacts 事件下发）。 */
  artifacts?: string[];
}

/** User message */
export interface UserItem {
  kind: "user";
  text: string;
  /** 事件时间戳（epoch ms），用于 ProcessPanel 计算回合耗时。 */
  ts?: number;
}

/** Tool approval request */
export interface ApprovalItem {
  kind: "approval";
  name: string;
  args: string;
  resolved?: "approved" | "rejected";
}

/** Plan approval request */
export interface PlanItem {
  kind: "plan";
  plan: string;
  resolved?: "approved" | "rejected";
}

/** Agent asks user a question */
export interface QuestionItem {
  kind: "question";
  question: string;
  options?: string[];
  resolved?: string;
}

/** System notice (error, interrupt, model switch, etc.) */
export interface NoticeItem {
  kind: "notice";
  tone: "info" | "warn" | "error";
  text: string;
  retriable?: boolean;
}

/** Thinking / reasoning step — a first-class timeline entry (not buried in a string). */
export interface ThinkingItem {
  kind: "thinking";
  /** Unique id for React key */
  id: string;
  /** Accumulated reasoning content (streaming when live) */
  content: string;
  /** Whether this thinking burst is still receiving tokens */
  live?: boolean;
  /**
   * 思考段落身份（G5）。主推理为 `th_main_{iteration}`，逐工具意图为 `th_{call_id}`。
   * 同 id 的流式增量往同一段追加；`ThinkingEnd` 到达即封存，杜绝两段思考粘成一坨。
   */
  thoughtId?: string;
  /** 事件序号，用于稳定排序与回放定位。 */
  seq?: number;
  /** 节点树父节点（Phase 3 / G4）。 */
  parentId?: string;
  /** 事件时间戳（epoch ms），用于 ProcessPanel 计算回合耗时。 */
  ts?: number;
}

/** Waiting state — shown between events while the agent is idle (e.g. waiting for LLM response after tool result). */
export interface WaitingItem {
  kind: "waiting";
  id: string;
  /** What we're waiting for: "model_response" | "tool_execution" | "approval" */
  label: string;
  /** 节点树父节点（Phase 3 / G4）。 */
  parentId?: string;
  /** 事件序号（G1），与 AgentNode.seq 同源。 */
  seq?: number;
  /** 事件时间戳（epoch ms），用于 ProcessPanel 计算回合耗时。 */
  ts?: number;
}

/** Connector/source message */
export interface ConnectorItem {
  kind: "connector";
  source: string;
}

/** Union type for all UI items */
export type Item =
  | UserItem
  | AssistantItem
  | ToolItem
  | ThinkingItem
  | WaitingItem
  | ApprovalItem
  | PlanItem
  | QuestionItem
  | NoticeItem
  | ConnectorItem;

/**
 * 节点树模型（Phase 3 / G2·G4）。由扁平 `Item` 序列派生，视图层不再反向推断结构。
 * - 主时间轴为扁平序列（按 `seq` 排序），`parentId` 承载「思考→工具→子思考」的嵌套；
 * - 当前主会话为单层（群 Worker 走独立 `rt:` 会话，不内嵌），`parentId` 多为 undefined；
 * - `children` 是派生出的嵌套视图，供未来层级化渲染（Phase 4）使用。
 */
export type AgentNode = Item & {
  /** 排序真值（G1）。无 seq 的旧数据回落数组下标。 */
  seq: number;
  parentId?: string;
  children: AgentNode[];
};

// ── Legacy types (kept for compatibility during migration) ──

export interface PendingApproval {
  approval_id: string;
  session_id: string;
  tool_name: string;
  tool_args: string;
  seat?: string | null;
  risk?: string;
}

export type PermissionMode = "full_access" | "ask_approval" | "plan_execute" | "auto_edit";

/** Legacy: extended message with streaming state */
export interface UIMessage extends Message {
  isStreaming?: boolean;
  toolCallState?: "pending" | "executing" | "done" | "error";
}

// ── Settings ──
/** 思考层密度偏好（UX 架构重设计）：collapsed=一行默认 / peek=预览窗口 / expanded=完整展开。 */
export type ThinkDensity = "collapsed" | "peek" | "expanded";

/** 模型思考模式（请求级开关，写入 settings 键 `thinking_mode`）。
 *  default=自动（引擎按任务复杂度决定：简单任务关思考省 token、复杂任务开）/
 *  off=强制关闭 / on=标准推理 / high=深度推理。
 *  各家族按自身方言翻译（DeepSeek thinking.type、Qwen enable_thinking、
 *  Kimi reasoning_effort、MiniMax reasoning_split）；标准 OpenAI 忽略。
 *  区别于 thinkingDensity（UX 展示密度）。 */
export type ThinkMode = "default" | "off" | "on" | "high";

/** LLM 供应商。custom = 任意 OpenAI 兼容端点（私有部署 / 未内置家族）。 */
export type ProviderId =
  | "deepseek"
  | "openai"
  | "qwen"
  | "glm"
  | "kimi"
  | "minimax"
  | "custom";

/** 自定义端点的思考参数方言（决定发哪种 thinking 字段 + 读哪个推理字段）。 */
export type ReasoningDialect =
  | "openai"
  | "deepseek"
  | "qwen"
  | "glm"
  | "kimi"
  | "minimax";

/** 自定义端点的 usage token 字段映射。空字符串 = 该端点无此字段，跳过统计。 */
export interface TokenConfig {
  promptKey: string;
  outputKey: string;
  reasoningKey: string;
  totalKey: string;
}

/** API 端点协议（参考图下拉选项，2026-09-02 立）。当前仅 Chat Completions 接入后端，
 *  其它两条存为前端 UI 状态，为后端将来扩展（Anthropic 原生、Responses API）做准备。 */
export type ApiFormat = "anthropic-messages" | "chat-completions" | "responses";

/** 单个模型供应商配置。UI 管理多供应商，运行时激活项同步到顶层单 provider 字段。 */
export interface ModelProviderConfig {
  /** 唯一标识；内置供应商用 ProviderId，自定义供应商用 uuid。 */
  id: string;
  /** 显示名称，如 "智谱 Z.ai"。 */
  name: string;
  /** 内置家族；自定义端点也填 "custom"。决定默认 endpoint / thinking 方言。 */
  provider: ProviderId;
  /** 自定义端点的 Base URL（内置供应商通常为空，走默认 endpoint）。 */
  baseUrl?: string;
  /** 该供应商的 API Key。 */
  apiKey: string;
  /** 思考参数方言（custom 时由用户选；内置供应商由 provider 决定）。 */
  reasoningDialect: ReasoningDialect;
  /** 所选 API 端点协议（参考图下拉）。后端暂不读取，留作扩展位。 */
  apiFormat?: ApiFormat;
  /** 该供应商下的模型 ID 列表。 */
  models: string[];
  /** 默认选用的模型。 */
  defaultModel: string;
  /** 是否启用该供应商；禁用后聊天选择器不再展示其模型。 */
  enabled?: boolean;
}

export interface Settings {
  apiKey: string;
  provider: ProviderId;
  model: string;
  preamble: string;
  temperature: number;
  maxTokens: number;
  maxIterations: number;
  /** 思考层默认密度（chat 模式 ThinkingLayer 读取）。 */
  thinkingDensity: ThinkDensity;
  /** 模型思考模式（发给模型的 thinking 开关），区别于 thinkingDensity（UX 展示密度）。 */
  thinkingMode: ThinkMode;
  /** provider==="custom" 时的 endpoint。可填 base（自动补 /chat/completions）或完整地址。 */
  customBaseUrl: string;
  /** provider==="custom" 时的思考方言。 */
  reasoningDialect: ReasoningDialect;
  /** provider==="custom" 时的 usage 字段映射。 */
  tokenConfig: TokenConfig;
  /** 多供应商配置列表（可选，向后兼容）。 */
  providers?: ModelProviderConfig[];
}

// ── Personal email configuration (IMAP / SMTP), persisted as JSON under `email_config` ──

export type EmailEncryption = "none" | "ssl" | "starttls";

export interface EmailServerConfig {
  host: string;
  port: number;
  encryption: EmailEncryption;
  username: string;
  password: string;
}

export interface EmailConfig {
  displayName: string;
  address: string;
  imap: EmailServerConfig;
  smtp: EmailServerConfig;
}

export const EMPTY_EMAIL_CONFIG: EmailConfig = {
  displayName: "",
  address: "",
  imap: { host: "", port: 993, encryption: "ssl", username: "", password: "" },
  smtp: { host: "", port: 465, encryption: "ssl", username: "", password: "" },
};

// ── Extensibility: MCP / Skill / Scheduled Tasks (mirror Rust DTOs) ──

export interface McpCapabilitiesDto {
  tools: string[];
  resources: string[];
  prompts: string[];
}

export interface McpServerDto {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  enabled: boolean;
  status: string;
  capabilities: McpCapabilitiesDto;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillDto {
  id: string;
  name: string;
  description: string;
  version: string;
  source: string;
  path: string | null;
  url: string | null;
  status: string;
  dependencies: string[];
  created_at: string;
  updated_at: string;
}

// ── Skill 预算护栏（F8 / ADR-018）──
// 三个维度皆可选；`null` = 不限制该维度。全 `null` = 无约束（护栏恒 no-op）。
export interface SkillBudgetDto {
  token_limit: number | null;
  cost_cents_limit: number | null;
  time_secs_limit: number | null;
}

// ── 能力体检（IX-16 / ADR-019）──
export type DiagnosticClass =
  | "MissingGrant"
  | "RevokedCredential"
  | "OrphanedGrant"
  | "UnavailableProvider"
  | "CliExecutorMissing"
  | "CliExecutorLaunchFailed"
  | "CliExecutorAuthMissing";

export interface CapabilityDiagnosticDto {
  class: DiagnosticClass;
  scope: string;
  title: string;
  detail: string;
  fix_hint: string;
}

// ── F14 记忆分层（会话蒸馏 + 跨档检索）──

/** 跨记忆档检索的单条命中。 */
export interface MemoryHitDto {
  /** user | project | memory */
  tier: string;
  path: string;
  line: number;
  text: string;
}

/** 设置页记忆面板：单档记忆文件（tier + 绝对路径 + 完整内容）。 */
export interface MemoryFileDto {
  /** user | project | memory */
  tier: string;
  path: string;
  content: string;
}

// ── F9 Playbook（可复用任务拆解库）──

/** Playbook 内单步（与 GroupDispatch 草稿同构；depends_on 用数组索引）。 */
export interface PlaybookStepDto {
  description: string;
  depends_on: number[];
  capability?: string | null;
  reasoning?: string | null;
}

/** 落库后的 Playbook。 */
export interface PlaybookDto {
  id: string;
  name: string;
  steps: PlaybookStepDto[];
  success_criteria?: string | null;
  guardrails?: string | null;
  source_run_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** 保存 Playbook 载荷。 */
export interface SavePlaybookInput {
  name: string;
  steps: PlaybookStepDto[];
  success_criteria?: string | null;
  guardrails?: string | null;
  source_run_id?: string | null;
}

// ── IX-10 变更集审阅（群级汇总 + 一键回滚）──

/** 单条文件变更（F10 changeset 行；回滚靠 before_content）。 */
export interface ChangesetRowDto {
  id: string;
  file: string;
  /** run_id（谁改的） */
  holder: string;
  run_id: string | null;
  before_hash: string | null;
  after_hash: string;
  before_content: string | null;
  /** 改动后内容快照（写入即落库，不读磁盘）。null = 二进制 / 历史行无快照。 */
  after_content: string | null;
  /** 'normal' = 常规变更；'auto_snapshot' = 存档式回滚时自动保留的被覆盖内容（前端过滤）。 */
  snapshot_type: string;
  created_at: string;
}

export interface TaskScheduleDto {
  cron: string | null;
  once: string | null;
  interval: string | null;
}

export interface ScheduledTaskDto {
  id: string;
  title: string;
  description: string | null;
  type_: string;
  schedule: TaskScheduleDto;
  source: string;
  status: string;
  action_type: string;
  action_payload: string;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
  run_count: number;
}

export interface McpConnectionResult {
  ok: boolean;
  capabilities: McpCapabilitiesDto;
  error: string | null;
}

// ── Agent Group Collaboration (Worker 概念 + 并行派活) ──

export type GroupStatus = "Draft" | "Active" | "Paused" | "Archiving" | "Archived";
/** 群性质：决定 Worker 回答的生成风格与展示强度（内容密度 / Markdown 能力 / 是否拆多条）。 */
export type GroupKind = "Dev" | "Research" | "Chat";
export type SeatType = "Static" | "Dynamic" | "Capability";
export type WorkerStatus = "Idle" | "Busy" | "Offline";

/** 工具权限动作（P1-7）。 */
export type PermissionAction = "allow" | "deny" | "ask";

/** tool_permissions 表的一条配置覆盖。 */
export interface ToolPermission {
  tool_name: string;
  scope: string;
  action: PermissionAction;
}
export type TaskStatus =
  | "Pending"
  | "InProgress"
  | "Completed"
  | "Failed"
  | "Cancelled"
  /** 待审批：coordinator 自动拆解提交的批次落此态，群主批准后才进入 Pending 调度（fail-closed 闸门）。 */
  | "AwaitingApproval";

/** Agent Catalog 预设（Worker 的"种源"）。 */
export interface AgentProfile {
  id: string;
  name: string;
  model: string;
  system_prompt: string;
  capabilities: string[];
  skills: string[];
  mcp: string[];
  tools: string[];
  /** 可配置插件标识符列表（如 Connector/Expert 插件名），与 skills/mcp/tools 平行。 */
  plugins?: string[];
  created_at: number;
  token_budget?: number;
  provider?: string;
  /** P2-13 外部 CLI 执行器：如 "cli:codex" / "cli:pi"；空 = 内部引擎。 */
  executor?: string | null;
  /** F4 Agent 定义可移植：禁止使用的工具。 */
  disallowed_tools?: string[];
  /** F4 权限模式：default / plan / bypass / ask。 */
  permission_mode?: string;
  /** F4 单轮最大回合，0 = 无限制。 */
  max_turns?: number;
  /** F4 隔离级别：none / sandbox。 */
  isolation?: string;
}

/** 扫描本机 ~/.claude/agents 得到的候选 Agent 定义条目（F4）。 */
export interface LocalAgentEntry {
  name: string;
  path: string;
  /** "home" = ~/.claude/agents；"workspace" = 项目内 .claude/agents。 */
  source: string;
}

/** 群运行时席位（Worker）。 */
export interface Worker {
  id: string;
  group_id: string;
  agent_ref: string;
  seat_type: SeatType;
  status: WorkerStatus;
  max_concurrency: number;
  capabilities: string[];
  current_task_id: string | null;
  last_heartbeat: number | null;
}

/** 单个 Worker 的累计协作指标（token / 耗时 / 执行次数 / 上下文快照）。 */
export interface WorkerMetric {
  worker_id: string;
  group_id: string;
  /** 累计 Token（跨回合累加） */
  total_tokens: number;
  /** 累计耗时（毫秒） */
  total_duration_ms: number;
  /** 执行回合数 */
  runs: number;
  /** 最近一次上下文消息数 */
  last_msg_count: number;
  /** 最近一次响应的 Token 数 */
  last_context_tokens: number;
  /** 最近一轮执行的总 Token 消耗 */
  last_total_tokens: number;
  updated_at: number;
}

/** 后端经 `worker-status` 事件推送的 Worker 状态变更。
 *  `current_task_id`：Busy 时携带当前执行的任务 id（DAG 派发场景），圆桌回合与 Idle 为 null。 */
export interface WorkerStatusEvent {
  group_id: string;
  worker_id: string;
  status: WorkerStatus;
  current_task_id: string | null;
}

/**
 * F5：Worker 回合终态通知（`worker-notice` 事件）。
 * - `failed`：某席位回合异常终止，后端同时落库一条 system 圆桌消息。
 * - `idle_all`：本轮全部席位回到 Idle，仅事件不落库。
 */
export interface WorkerNoticeEvent {
  group_id: string;
  worker_id: string;
  worker_name: string;
  kind: "failed" | "idle_all";
  detail: string;
}

/**
 * F7 结构化共享黑板：单条条目（群级命名空间 `bb:{group_id}`）。
 * `version` 为版本化 CAS 版本号，更新时须作为 expected_version 回传。
 */
export interface BlackboardEntry {
  key: string;
  value: string;
  version: number;
}

/** F7 黑板快照（供前端表格实时展示）。 */
export interface BlackboardSnapshot {
  group_id: string;
  entries: BlackboardEntry[];
}

/** 群实体。 */
export interface Group {
  id: string;
  name: string;
  goal: string;
  owner_agent_ref: string;
  status: GroupStatus;
  /** 群性质：研发型 / 调研型 / 聊天型，决定回答的展示强度。 */
  kind: GroupKind;
  seat_config: Record<string, unknown>;
  created_at: number;
  /** 最近活跃时间（最近一条圆桌消息时间；无消息则回退建群时间）。卡片排序与展示用。 */
  updated_at?: number;
  /** 成员（Worker）数量。 */
  member_count?: number;
  /** 最近一条圆桌消息内容预览。 */
  last_message_preview?: string;
}

export type CreateGroupInput = {
  name: string;
  goal: string;
  owner_agent_ref: string;
  seat_config: Record<string, unknown>;
  /** 群性质（建群时选定，决定 Worker 回答风格与展示强度）。 */
  kind: GroupKind;
  /** F12 通信拓扑策略（建群后固化快照）。缺省由后端回退 deny-all。 */
  topology?: TopologyPolicy;
};

// ── F12 通信拓扑策略（与后端 `group::topology` serde 同构，可无损往返） ──

/** 拓扑通道：按通道分别授权。 */
export type TopologyChannel = "Message" | "Blackboard" | "Mention";

/** 路由动作。 */
export type RouteAction = "Allow" | "Deny";

/** 端点：策略边的两端。 */
export type TopologyEndpoint = "All" | { Worker: string };

/** 一条显式授权边：from → to 在指定 channel 上放行。 */
export interface TopologyEdge {
  from: TopologyEndpoint;
  to: TopologyEndpoint;
  channels: TopologyChannel[];
}

/** 拓扑策略文档（声明式，存库即快照）。 */
export interface TopologyPolicy {
  version: number;
  default: RouteAction;
  edges: TopologyEdge[];
}

/** F12 建群弹窗的三选一预设。 */
export type TopologyPreset = "star" | "full" | "custom";

/** 群主拆解后的结构化派活单元（提交给 group_assign_tasks）。 */
export interface SubTask {
  id: string;
  worker_id: string | null;
  description: string;
  input_refs: string[];
  output_spec: string | null;
  depends_on: string[];
  seat_strategy?: SeatType | null;
  /** 能力路由：派活所需能力（agent 无关派活）；为 null 时按 worker_id 直派或任意空闲席位。 */
  capability?: string | null;
  /** 群主拆解依据/约束/验收标准（注入 Worker 任务卡）。 */
  reasoning?: string | null;
}

/** 落库后的任务（带状态机）。 */
export interface Task {
  id: string;
  group_id: string;
  batch_id: string | null;
  worker_id: string | null;
  description: string;
  depends_on: string[];
  input_refs: string[];
  output_spec: string | null;
  status: TaskStatus;
  retry_count: number;
  assigned_worker: string | null;
  outputs: string[];
  reasoning?: string | null;
  /** F6 心跳时间戳（epoch seconds），看板用于卡死判定。 */
  last_heartbeat?: number | null;
  /** 失败原因摘要（executor 失败 / 非 Completed 收尾时回填，「待决策的任务」卡片展示）。 */
  last_error?: string | null;
  /** 能力路由：派活所需能力（agent 无关派活）。 */
  capability?: string | null;
  /** 看板列内排序序号（同 status 内升序），卡片上下拖拽重排时更新。 */
  order_idx?: number;
}

/** 后端经 `group-event` 推送给前端的群协作事件。 */
export type GroupEvent =
  | { type: "batch_completed"; group_id: string; batch_id: string; terminal_count: number }
  | { type: "batch_awaiting_approval"; group_id: string; batch_id: string; task_count: number }
  | { type: "batch_cancelled"; group_id: string; batch_id: string }
  | { type: "group_paused"; group_id: string }
  | { type: "group_resumed"; group_id: string }
  | { type: "worker_removed"; group_id: string; worker_id: string }
  | { type: "task_failed"; group_id: string; task_id: string; description: string; reason: string }
  | { type: "task_reset"; group_id: string; task_id: string; action: string }
  | { type: "task_status_changed"; group_id: string; task_id: string; from: TaskStatus; to: TaskStatus };

/** 圆桌消息（群内多 Agent 协作对话）。author 为 agent_ref；mentions 为被 @ 的 worker id 列表。 */
export interface RoundtableMessage {
  seq: number;
  group_id: string;
  /** owner 与 worker 都存 agent_ref */
  author: string;
  /** 发送该消息的 Worker 唯一 id（owner / system 为空）；用于区分同名 Worker 的回复 */
  worker_id: string;
  author_kind: "owner" | "worker" | "system";
  content: string;
  /** 被 @ 的 worker id 列表 */
  mentions: string[];
  /** 附件本地路径列表（群主发言附带的文件） */
  attachments?: string[];
  /** 毫秒时间戳 */
  created_at: number;
}

/** 后端经 `roundtable-message` 推送给前端的圆桌事件。 */
export interface RoundtableEvent {
  type: "message";
  group_id: string;
  message: RoundtableMessage;
}

/** 后端经 `roundtable:token` 并联分流给群视图的流式 token（F-round-stream）。
 * 与 `agent:token`（chat 用）并行发出，chat 链路不受影响。`aborted=true` 表示
 * 该 Worker 回合落选/取消，前端据此丢弃其半成品流式气泡。 */
export interface RoundtableTokenEvent {
  type: "token";
  group_id: string;
  worker_id: string;
  round: number;
  token: string;
  aborted?: boolean;
}

/** 竞速落选方案（R6）：触发轮为 `trigger_seq`（= 该轮 owner 广播消息 seq）。 */
export interface RoundtableAlternative {
  id: number;
  group_id: string;
  /** 触发该轮竞速的广播消息 seq（seed 按 trigger_seq < 当前 seq 过滤） */
  trigger_seq: number;
  /** 落选 Worker 的唯一 id */
  worker_id: string;
  /** 该 Worker 的完整作答文本 */
  content: string;
  /** 毫秒时间戳 */
  created_at: number;
}

// ── R7 单聊升级为群（ADR-008 session.mode）──

/** 建议席位（LLM 预填，用户可编辑后映射到 Agent 预设）。 */
export interface SuggestedSeat {
  name: string;
  capability: string;
}

/** 建议任务（LLM 预填，用户可编辑）。 */
export interface SuggestedTask {
  description: string;
  depends_on: string[];
}

/** 升级提议（FR7.2② 预填 + FR7.4 成本预估）。 */
export interface UpgradeProposal {
  title: string;
  goal: string;
  seats: SuggestedSeat[];
  tasks: SuggestedTask[];
  /** 预估 LLM 调用次数（FR7.4，仅供参考） */
  est_calls: number;
  /** 预估总 token（FR7.4，仅供参考） */
  est_tokens: number;
}

// ── R4/R5 运行洞察（runs / run_steps 只读查询，features/insight 数据源）──

/** 单次运行（甘特条 / 席位历史行）。 */
export interface RunRecord {
  id: string;
  session_id: string;
  group_id: string | null;
  /** 席位（单机下「哪个 Agent 要的」） */
  seat_id: string | null;
  /** chat | worker | scheduled | roundtable */
  kind: string;
  started_at: number;
  ended_at: number | null;
  /** running | ok | failed | cancelled | timeout */
  status: string;
  model: string | null;
  prompt_tokens: number;
  output_tokens: number;
  iterations: number;
}

/** 步骤（甘特下钻：llm / tool / approval）。 */
export interface StepRecord {
  seq: number;
  kind: string;
  name: string | null;
  origin: string | null;
  /** ok | failed | unavailable */
  outcome: string;
  duration_ms: number | null;
  started_at: number;
  /** IX-8：工具入参摘要（F13 已打码敏感键；LLM 步骤为 null）。 */
  args_digest: string | null;
}

/** 一次运行 + 步骤（甘特条 + 下钻）。 */
export interface RunWithSteps {
  run: RunRecord;
  steps: StepRecord[];
}

/** 群级摘要条（FR5.2）。 */
export interface GroupRunSummary {
  run_count: number;
  prompt_tokens: number;
  output_tokens: number;
  total_duration_ms: number;
  /** 查询期按模型单价折算（元） */
  est_cost_yuan: number;
}

/** 群运行洞察（R5「运行」视图）。 */
export interface GroupInsight {
  summary: GroupRunSummary;
  runs: RunWithSteps[];
}

/** 席位聚合（FR4.1：次数 / 成功率 / token / 耗时 / 成本）。 */
export interface SeatRunSummary {
  total_runs: number;
  success_runs: number;
  total_tokens: number;
  total_duration_ms: number;
  est_cost_yuan: number;
}

/** 席位运行洞察（R4 席位仪表历史部分）。 */
export interface SeatInsight {
  summary: SeatRunSummary;
  /** 最近运行（倒序） */
  recent_runs: RunRecord[];
}

/** 圆桌讨论的结构化摘要（群级聚合结论）。 */
export interface RoundtableSummary {
  id: number;
  group_id: string;
  /** 摘要正文（LLM 聚合产出） */
  content: string;
  /** 本次聚合覆盖的圆桌消息 seq 区间（含端点） */
  source_seq_start: number;
  source_seq_end: number;
  /** 参与聚合的消息条数 */
  message_count: number;
  /** 毫秒时间戳 */
  created_at: number;
}

/** 后端经 `roundtable-summary` 推送给前端的摘要事件。 */
export interface RoundtableSummaryEvent {
  type: "summary";
  group_id: string;
  summary: RoundtableSummary;
}

/** 群内产出物类型：圆桌 Worker 回复 / 任务产出 / 群摘要。 */
export type DeliverableKind = "reply" | "task_output" | "summary";

/** 产出物中的多媒体条目（文件 / 图片），使产出物支持多类型而非纯文本。 */
export interface DeliverableMedia {
  /** 类型：image 用缩略图展示，file 用文件卡 + 打开按钮 */
  type: "image" | "file";
  /** 本地绝对路径，点击用系统程序打开（P0 起也用于站内预览） */
  path: string;
  /** 文件名（用于展示与无障碍） */
  name: string;
  /** 字节数（P2 起由引擎捕获填充；P0 缺省 undefined，侧栏显示「—」） */
  size?: number;
  /** 判定类型（image/png、text/html…）（P2 起有值） */
  mime?: string;
  /** 毫秒时间戳（P2 起有值） */
  mtime?: number;
}

/**
 * 产出物 → 轨迹定位键（P1 起由 `group_list_deliverables` 填充）。
 * key 恒为 session_id（`agent_trace` 唯一查询键）。
 */
export interface TraceRef {
  /** 溯源语义，仅展示用："roundtable" | "run" */
  source: "roundtable" | "run";
  /** 恒为 session_id */
  key: string;
}

/** 群内产出物一览（后端 `group_list_deliverables` 聚合返回）。 */
export interface Deliverable {
  id: string;
  kind: DeliverableKind;
  /** 产出标题（reply: "X 的回复"；task_output: 任务描述；summary: "群摘要 #id"） */
  title: string;
  /** 产出方 agent_ref（owner/worker）；摘要为空 */
  author: string;
  /** 产出方 Worker 唯一 id（用于区分同名 Worker 的产出）；owner/摘要为空 */
  worker_id: string;
  /** 毫秒时间戳（任务产出无时间戳列，为 0） */
  created_at: number;
  /** 列表预览（截断） */
  preview: string;
  /** 完整内容（详情/复制） */
  content: string;
  /** 圆桌消息 seq（reply 类型） */
  ref_seq: number | null;
  /** 任务/摘要 id（task_output / summary 类型） */
  ref_id: string | null;
  /** 额外信息（如 "输出 1/3"、"聚合 N 条消息"） */
  meta: string;
  /** 多媒体附件（图片 / 文件）；纯文本产出为空数组 */
  media: DeliverableMedia[];
  /** 产出物 → 轨迹定位键（P1 起填充；P0 恒 undefined） */
  trace_ref?: TraceRef | null;
}

/** `artifact_read_text` 命令返回：受控文件内容通道（HTML/CSV 渲染用）。 */
export interface ArtifactText {
  /** 文件文本内容（UTF-8） */
  content: string;
  /** 字节数 */
  size: number;
}

/** `artifact_read_base64` 返回结构（图片/PDF 内嵌用）。 */
export interface ArtifactBytes {
  /** MIME 类型 */
  mime: string;
  /** 文件内容 base64 编码 */
  data: string;
  /** 字节数 */
  size: number;
}

/** `list_model_files` 返回结构：跨工作区根的模型产出文件条目。 */
export interface ModelFile {
  /** 绝对路径（点击即唤起通用预览 `artifact_read_*`）。 */
  path: string;
  /** 文件名（含扩展名）。 */
  name: string;
  /** 字节数。 */
  size: number;
  /** 修改时间（毫秒时间戳）。 */
  mtime: number;
  /** MIME 类型（供预览器选择渲染方式）。 */
  mime: string;
}

/** `list_workspace_file_tree` 返回结构：侧栏文件树节点（递归）。 */
export interface FileTreeNode {
  /** 显示名（顶层为工作区名，其余为目录/文件名）。 */
  name: string;
  /** 绝对路径。 */
  path: string;
  /** true=目录，false=文件。 */
  is_dir: boolean;
  /** 字节数（仅文件）。 */
  size?: number;
  /** 修改时间（毫秒时间戳，仅文件）。 */
  mtime?: number;
  /** MIME 类型（仅文件）。 */
  mime?: string;
  /** 子节点（仅目录，空目录为 undefined）。 */
  children?: FileTreeNode[];
}

/** 渲染器注册表的判定结果（纯函数 `rendererFor` 产出）。 */
export type RenderKind =
  | "markdown"
  | "code"
  | "image"
  | "html"
  | "csv"
  | "fallback";

// ── 日历事件（macOS 风格日程：标题 + 时间 + 色条 + 备注）──

export interface CalendarEvent {
  id: string;
  /** 日期键 YYYY-MM-DD */
  date_key: string;
  /** 事件标题（必填） */
  title: string;
  /** 备注内容（可选） */
  content: string;
  /** 开始时间 HH:mm（可选） */
  time_start?: string | null;
  /** 结束时间 HH:mm（可选） */
  time_end?: string | null;
  /** 事件色条颜色（默认 #0a84ff） */
  color: string;
  /** 类型：schedule=日程 / reminder=提醒事项 */
  kind: string;
  created_at: number;
  updated_at: number;
}
