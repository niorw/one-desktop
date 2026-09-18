// Chat mode command layer — single-user ↔ agent interactions only.
//
// This module owns every Tauri command used by the chat (main session) mode:
// session lifecycle, agent run, HITL approval, R7 single-chat→group upgrade
// (chat-initiated), memory / playbook / user-profile, settings, MCP / skills /
// budget / diagnostics, scheduled tasks, and the chat-side
// changeset rollback utility.
//
// Group (multi-agent roundtable) commands live in `groupCommands.ts` so the two
// interaction modes stay independent — chat code must not reach into group
// commands and vice-versa. `tauri.ts` re-exports both for legacy callers.
import { invoke } from "@tauri-apps/api/core";
import type { Session, Message, ToolPermission, CalendarEvent } from "../types";

// ── Session operations ──

// Readiness probe for the splash screen. Resolves to the backend reply, or
// null when not running inside Tauri (e.g. plain `vite` dev in a browser), so
// the splash can fall back to a timed fade rather than hanging.
export async function ping(): Promise<string | null> {
  try {
    return await invoke("ping");
  } catch {
    return null;
  }
}

// 启动进度（0-100）。SplashScreen 轮询以驱动 determinate 进度条；非 Tauri 环境返回
// null，由前端用模拟进度走完，保证浏览器 dev 体验一致。
export async function startupProgress(): Promise<number | null> {
  try {
    return await invoke<number>("startup_progress");
  } catch {
    return null;
  }
}

export async function createSession(
  title: string,
  model: string,
  preamble: string,
  workspaceId?: string | null,
): Promise<Session> {
  return invoke("create_session", { title, model, preamble, workspaceId: workspaceId ?? null });
}

export async function listSessions(): Promise<Session[]> {
  return invoke("list_sessions");
}

export async function getSession(sessionId: string): Promise<Session | null> {
  return invoke("get_session", { sessionId });
}

export async function deleteSession(sessionId: string): Promise<void> {
  return invoke("delete_session", { sessionId });
}

export async function getMessages(sessionId: string): Promise<Message[]> {
  return invoke("get_messages", { sessionId });
}

/** 分流/分层：读取整段一等公民 ReAct 轨迹（agent_trace），前端确定性投影「查看过程」。 */
export async function getTrace(sessionId: string): Promise<import("../types").TraceRow[]> {
  return invoke("get_trace", { sessionId });
}

/** reconcile 用：查询该 session 在后端是否仍有 running 的 run（失联后判断是否该解锁输入区）。 */
export async function hasActiveRun(sessionId: string): Promise<boolean> {
  return invoke("has_active_run", { sessionId });
}

/** 后台任务同步：拉取后端 runs 表中当前所有 running 状态的记录，用于校正前端 TaskDrawer 状态。 */
export async function listActiveRuns(): Promise<
  { run_id: string; session_id: string; kind: string; started_at: number }[]
> {
  return invoke("list_active_runs");
}

// ── Agent operations ──

export async function sendMessage(sessionId: string, content: string): Promise<void> {
  return invoke("send_message", { sessionId, content });
}

// ── Config operations (file-based secrets) ──

export async function getConfigApiKey(): Promise<string> {
  return invoke("get_config_api_key");
}

export async function setConfigApiKey(apiKey: string): Promise<void> {
  return invoke("set_config_api_key", { apiKey });
}

// ── HITL approval ──

/** A-4：按 approval_id 四态应答（accept | edit | respond | ignore）。 */
export async function decideApproval(
  approvalId: string,
  action: "accept" | "edit" | "respond" | "ignore",
  args?: unknown,
  feedback?: string,
): Promise<void> {
  return invoke("decide_approval", { approvalId, action, args, feedback });
}

/** 能力②：按 proposal_id 应答方案确认。
 * - selected：必须带 optionId；
 * - custom：必须带 customText（用户不选任何预置项，自己写方向）；
 * - rejected：本回合直接终止（内核 StopReason::Cancelled）。
 * 内核 fail-closed：5 分钟无应答自动按 rejected 处理，不会永久挂死。 */
export async function decideProposal(
  proposalId: string,
  decision: "selected" | "custom" | "rejected",
  optionId?: string,
  customText?: string,
): Promise<void> {
  return invoke("decide_proposal", { proposalId, decision, optionId, customText });
}

/** 旧协议（bool → accept/ignore），前端全量切到 decideApproval 后删除。 */
export async function approveTool(sessionId: string, approved: boolean): Promise<void> {
  return invoke("approve_tool", { sessionId, approved });
}

/** T1：批量四态应答（前端"本轮全部批准"）。服务端护栏自动排除高危工具，
 * 返回实际被决策的 id 列表（高危项仍 pending，前端据此不误删）。 */
export async function decideApprovalBatch(
  ids: string[],
  action: "accept" | "edit" | "respond" | "ignore",
  args?: unknown,
  feedback?: string,
): Promise<string[]> {
  return invoke<string[]>("decide_approval_batch", { ids, action, args, feedback });
}

/** T1：会话级工具豁免（"此工具本次会话不再问"）。不落库，重启应用后恢复询问。 */
export async function exemptToolForSession(
  sessionId: string,
  tool: string,
): Promise<void> {
  return invoke("exempt_tool_for_session", { sessionId, tool });
}

export async function setAutoApprove(enabled: boolean): Promise<void> {
  return invoke("set_auto_approve", { enabled });
}

export async function listToolPermissions(): Promise<ToolPermission[]> {
  return invoke("list_tool_permissions");
}

export async function setToolPermission(
  toolName: string,
  scope: string,
  action: "allow" | "deny" | "ask",
): Promise<void> {
  return invoke("set_tool_permission", { toolName, scope, action });
}

export async function resetToolPermissions(): Promise<void> {
  return invoke("reset_tool_permissions");
}

export async function clearToolPermission(
  toolName: string,
  scope: string,
): Promise<void> {
  return invoke("clear_tool_permission", { toolName, scope });
}

export async function cancelAgent(sessionId: string): Promise<void> {
  return invoke("cancel_agent", { sessionId });
}

/** R-steer：中途引导正在运行的循环（下一步 LLM 请求前合入）；未在跑返回 false。 */
export async function steerAgent(sessionId: string, text: string): Promise<boolean> {
  return invoke("steer_agent", { sessionId, text });
}

export async function getSetting(key: string): Promise<string> {
  return invoke("get_setting", { key });
}

export async function setSetting(key: string, value: string): Promise<void> {
  return invoke("set_setting", { key, value });
}

// ── Extensibility: MCP servers ──

export async function listMcpServers(): Promise<import("../types").McpServerDto[]> {
  return invoke("list_mcp_servers");
}

export async function addMcpServer(p: {
  name: string;
  transport: string;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  enabled: boolean;
}): Promise<import("../types").McpServerDto> {
  return invoke("add_mcp_server", p);
}

export async function setMcpEnabled(id: string, enabled: boolean): Promise<void> {
  return invoke("set_mcp_enabled", { id, enabled });
}

export async function deleteMcpServer(id: string): Promise<void> {
  return invoke("delete_mcp_server", { id });
}

export async function testMcpConnection(id: string): Promise<import("../types").McpConnectionResult> {
  return invoke("test_mcp_connection", { id });
}

// ── Extensibility: Skills ──

export async function listSkills(): Promise<import("../types").SkillDto[]> {
  return invoke("list_skills");
}

export async function addSkill(p: {
  name: string;
  description: string;
  version: string;
}): Promise<import("../types").SkillDto> {
  return invoke("add_skill", p);
}

export async function importSkillLocal(path: string): Promise<import("../types").SkillDto> {
  return invoke("import_skill_local", { path });
}

export async function importSkillUrl(url: string): Promise<import("../types").SkillDto> {
  return invoke("import_skill_url", { url });
}

export async function setSkillEnabled(id: string, enabled: boolean): Promise<void> {
  return invoke("set_skill_enabled", { id, enabled });
}

export async function deleteSkill(id: string): Promise<void> {
  return invoke("delete_skill", { id });
}

// ── Skill 预算护栏（F8 / ADR-018）──
// 三个维度皆可选；`null` 透传为 Rust 侧 `None`（不限制该维度）。
export async function getSkillBudget(id: string): Promise<import("../types").SkillBudgetDto> {
  return invoke("get_skill_budget", { id });
}

/** 展开式参数命令 → key 必须 camelCase：
 *  Rust `token_limit` / `cost_cents_limit` / `time_secs_limit`
 *  → JS `tokenLimit` / `costCentsLimit` / `timeSecsLimit`。 */
export async function setSkillBudget(
  id: string,
  tokenLimit: number | null,
  costCentsLimit: number | null,
  timeSecsLimit: number | null,
): Promise<void> {
  return invoke("set_skill_budget", {
    id,
    tokenLimit,
    costCentsLimit,
    timeSecsLimit,
  });
}

// ── 能力体检（IX-16 / ADR-019）──
// 环境级诊断：MCP 不可用 / 孤儿预算 / 外部 CLI 执行器缺失或启动失败。
export async function diagnoseCapabilities(): Promise<import("../types").CapabilityDiagnosticDto[]> {
  return invoke("diagnose_capabilities");
}

// ── Scheduled tasks ──

export async function listScheduledTasks(): Promise<import("../types").ScheduledTaskDto[]> {
  return invoke("list_scheduled_tasks");
}

// ⚠️ 展开式参数命令（Rust 签名为 8 个独立参数，非单个 payload struct）→
// Tauri 对展开式参数一律转 **camelCase**，invoke 时 key 必须写成 camelCase：
//   - Rust `type_`（避关键字的尾下划线）→ JS **`type`**（剥掉尾下划线）
//   - Rust `action_type`              → JS **`actionType`**（snake_case → camelCase）
//   - Rust `action_payload`           → JS **`actionPayload`**
// 传 snake_case 会报 `missing required key actionType`（2026-09-02 实际踩到）。
export async function createScheduledTask(p: {
  title: string;
  description?: string;
  type: string;
  schedule: import("../types").TaskScheduleDto;
  source: string;
  actionType: string;
  actionPayload: string;
}): Promise<import("../types").ScheduledTaskDto> {
  return invoke("create_scheduled_task", p);
}

export async function setTaskPaused(id: string, paused: boolean): Promise<void> {
  return invoke("set_task_paused", { id, paused });
}

export async function deleteScheduledTask(id: string): Promise<void> {
  return invoke("delete_scheduled_task", { id });
}

// 同 createScheduledTask：展开式参数命令，key 必须 camelCase（见上方注释）。
export async function updateScheduledTask(p: {
  id: string;
  title: string;
  description?: string;
  type: string;
  schedule: import("../types").TaskScheduleDto;
  source: string;
  actionType: string;
  actionPayload: string;
}): Promise<import("../types").ScheduledTaskDto> {
  return invoke("update_scheduled_task", p);
}

export async function runTaskNow(id: string): Promise<void> {
  return invoke("run_task_now", { id });
}

// ── F14 记忆分层（会话蒸馏 + 跨档检索）──

/** F14：把一次会话的消息蒸馏成要点，追加到项目记忆（PROJECT.md）。 */
export async function memoryDistill(sessionId: string): Promise<string> {
  return invoke("memory_distill", { sessionId });
}

/** F14：跨 user/project/memory 三档记忆文件检索，返回命中明细。 */
export async function memorySearch(
  query: string,
): Promise<import("../types").MemoryHitDto[]> {
  return invoke("memory_search", { query });
}

/** F14：读取某档记忆文件的完整内容（user | project | memory）。 */
export async function memoryRead(
  tier: string,
): Promise<import("../types").MemoryFileDto> {
  return invoke("memory_read", { tier });
}

/** F14：覆盖写某档记忆文件（content 为空串即清空该档）。 */
export async function memoryWrite(
  tier: string,
  content: string,
): Promise<void> {
  return invoke("memory_write", { tier, content });
}

// ── 用户画像（设置 → 个性化 → USER.md 哨兵区块）──

/** 读取 USER.md 中由 UI 维护的画像区块正文（不含哨兵）。 */
export async function readUserProfileMemory(): Promise<string> {
  return invoke("user_profile_read");
}

/** 写入画像区块；区块外由 Agent 自主追加的记忆原样保留。空串表示移除该区块。 */
export async function writeUserProfileMemory(section: string): Promise<void> {
  return invoke("user_profile_write", { section });
}

// ── F9 Playbook（可复用任务拆解库）──

/** 列出全部 Playbook（新 → 旧）。 */
export async function playbookList(): Promise<import("../types").PlaybookDto[]> {
  return invoke("playbook_list");
}

/** 保存（新建）一个 Playbook。 */
export async function playbookSave(
  payload: import("../types").SavePlaybookInput,
): Promise<import("../types").PlaybookDto> {
  return invoke("playbook_save", { payload });
}

/** 删除一个 Playbook。 */
export async function playbookDelete(id: string): Promise<void> {
  return invoke("playbook_delete", { id });
}

// ── IX-10 变更集审阅（共享工具：chat 会话级 + 群级均复用，按 changeId 回滚）──

/** 一键回滚一条变更（before_content 写回 / 新建文件删除）。
 * 这是 chat 与 group 变更集面板共用的工具命令，故留在 chat 命令层由两侧按需引用。 */
export async function changesetRollback(changeId: string): Promise<string> {
  return invoke("changeset_rollback", { changeId });
}

/** ADR-021 §6.3：run 级产物/变更（过滤 auto_snapshot 存档行，默认 200 条）。 */
export async function runChangesets(
  runId: string,
  limit?: number,
): Promise<import("../types").ChangesetRowDto[]> {
  return invoke("run_changesets", { runId, limit: limit ?? null });
}

/** ADR-021 §6.3：版本历史（同文件被同一 run 多次写入的快照序列）。 */
export async function runChangesetVersions(
  runId: string,
  file: string,
): Promise<import("../types").ChangesetRowDto[]> {
  return invoke("run_changeset_versions", { runId, file });
}

// ── 输入框触发器数据源 ──

export interface WorkspaceFile {
  name: string;
  is_dir: boolean;
  path: string;
}

/** 列出工作区目录下的文件（@ 触发器用）。 */
export async function listWorkspaceFiles(workspaceId?: string | null): Promise<WorkspaceFile[]> {
  return invoke("list_workspace_files", { workspaceId: workspaceId ?? null });
}

// ── R7 单聊升级为群（ADR-008 session.mode，由 chat 侧发起）──

/** FR7.2②/FR7.4：一次 LLM 调用预填建议席位 + 任务拆解 + 成本预估。 */
export async function sessionUpgradePropose(
  sessionId: string,
): Promise<import("../types").UpgradeProposal> {
  return invoke("session_upgrade_propose", { sessionId });
}

/** FR7.2：确认升级——建群 + 历史灌为群共享种子 + 派活 + session.mode="group"。 */
export async function sessionConfirmUpgrade(
  sessionId: string,
  title: string,
  goal: string,
  ownerAgentRef: string,
  seatRefs: string[],
  tasks: import("../types").SubTask[],
): Promise<import("../types").Group> {
  return invoke("session_confirm_upgrade", {
    sessionId,
    title,
    goal,
    ownerAgentRef,
    seatRefs,
    tasks,
  });
}

/** FR7.3：折叠回单聊（mode 置空，群保留含产出物）。 */
export async function sessionFoldToChat(sessionId: string): Promise<void> {
  return invoke("session_fold_to_chat", { sessionId });
}
