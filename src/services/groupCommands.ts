// Group (multi-agent roundtable) mode command layer.
//
// This module owns every Tauri command used by the group / roundtable mode:
// group lifecycle, communication topology, shared blackboard, worker seats,
// parallel task dispatch, roundtable message bus, collaboration insights,
// deliverables, and runtime pause/resume/dissolve.
//
// It is intentionally separate from `chatCommands.ts` so the two interaction
// modes do not share a command surface. Chat code must not import from here and
// vice-versa; `tauri.ts` re-exports both for legacy callers.
import { invoke } from "@tauri-apps/api/core";

// ── Agent Group Collaboration ──

export async function listGroups(): Promise<import("../types").Group[]> {
  return invoke("list_groups");
}

export async function getGroup(id: string): Promise<import("../types").Group | null> {
  return invoke("get_group", { id });
}

export async function createGroup(p: import("../types").CreateGroupInput): Promise<import("../types").Group> {
  // Rust 命令签名是单 struct 参数 payload —— 必须包 { payload }（playbook_save 同款）。
  // 之前展开传参 → "missing required key payload" → 建群静默失败。
  return invoke("create_group", { payload: p });
}

// ── F12 通信拓扑策略（读/写群拓扑快照） ──

/** 读取群最新拓扑策略快照；无快照时后端回退 deny-all。 */
export async function groupTopologyGet(groupId: string): Promise<import("../types").TopologyPolicy> {
  return invoke("group_topology_get", { groupId });
}

/** 提交完整策略文档，返回新版本号。 */
export async function groupTopologySet(
  groupId: string,
  policy: import("../types").TopologyPolicy,
): Promise<number> {
  return invoke("group_topology_set", { groupId, policy });
}

// ── F7 共享黑板（命名空间 bb:{group_id}）──

/** F7 读取群共享黑板全量。 */
export async function groupBlackboardGet(groupId: string): Promise<import("../types").BlackboardSnapshot> {
  return invoke("group_blackboard_get", { groupId });
}

/**
 * F7 由群主声明/更新黑板键（命名空间 `bb:{group_id}`）。
 * `expectedVersion` 传 0 表示新建，传读取到的版本号表示更新（版本化 CAS）。
 * 返回写入后的新版本号。
 */
export async function groupBlackboardSet(
  groupId: string,
  key: string,
  value: string,
  expectedVersion: number,
): Promise<number> {
  return invoke("group_blackboard_set", {
    groupId,
    key,
    value,
    expectedVersion,
  });
}

export async function groupAddWorker(
  groupId: string,
  agentRef: string,
  capabilities?: string[],
  maxConcurrency?: number,
): Promise<import("../types").Worker> {
  return invoke("group_add_worker", {
    groupId,
    agentRef,
    capabilities: capabilities ?? null,
    maxConcurrency: maxConcurrency ?? null,
  });
}

export async function listAgentPresets(): Promise<import("../types").AgentProfile[]> {
  return invoke("list_agent_presets");
}

export async function createAgentPreset(p: {
  name: string;
  model: string;
  system_prompt: string;
  capabilities: string[];
  skills: string[];
  mcp: string[];
  tools: string[];
  /** F4 扩展字段（可选）：provider / 禁用工具 / 权限模式 / 单轮回合 / 隔离级别 / 插件。 */
  ext?: {
    provider?: string;
    disallowed_tools?: string[];
    permission_mode?: string;
    max_turns?: number;
    isolation?: string;
    plugins?: string[];
  };
}): Promise<import("../types").AgentProfile> {
  const { ext, ...base } = p;
  return invoke("create_agent_preset", { payload: base, ext: ext ?? null });
}

/** 部分更新 Agent 预设（编辑态）：仅传入需变更的字段，其余沿用当前值。 */
export async function updateAgentPreset(
  id: string,
  p: {
    name?: string;
    provider?: string;
    model?: string;
    system_prompt?: string;
    capabilities?: string[];
    skills?: string[];
    mcp?: string[];
    tools?: string[];
    disallowed_tools?: string[];
    permission_mode?: string;
    max_turns?: number;
    isolation?: string;
    plugins?: string[];
  },
): Promise<import("../types").AgentProfile> {
  return invoke("update_agent_preset", { id, payload: p });
}

export async function deleteAgentPreset(id: string): Promise<void> {
  return invoke("delete_agent_preset", { id });
}

// ── F4 Agent 定义可移植（扫描 / 导入 / 导出 .claude/agents）──

/** 扫描本机 ~/.claude/agents 与项目内 .claude/agents，返回候选 Agent 定义。 */
export async function scanLocalAgents(): Promise<import("../types").LocalAgentEntry[]> {
  return invoke("scan_local_agents");
}

/** 从本地 .md 文件导入一个 Agent 定义为 AgentProfile（落库）。 */
export async function importAgent(path: string): Promise<import("../types").AgentProfile> {
  return invoke("import_agent", { path });
}

/**
 * 把一个 AgentProfile 导出为 .md 文件。
 * dir 为空时默认写到数据目录下的 agent-exports/；redact=true 时系统提示词脱敏。
 */
export async function exportAgent(id: string, dir: string, redact: boolean): Promise<string> {
  return invoke("export_agent", { id, dir, redact });
}

export async function groupListWorkers(groupId: string): Promise<import("../types").Worker[]> {
  return invoke("group_list_workers", { groupId });
}

/** 运行时加能力席位：声明式空槽（不绑定预设），仅声明需要的 capabilities。 */
export async function groupAddCapabilitySeat(
  groupId: string,
  capabilities: string[],
  maxConcurrency?: number,
): Promise<import("../types").Worker> {
  return invoke("group_add_capability_seat", {
    groupId,
    capabilities,
    maxConcurrency: maxConcurrency ?? null,
  });
}

/* 以下三个是**展开式参数命令**（Rust 签名为多个独立参数，非单个 payload struct）
   → Tauri 对展开式参数一律转 camelCase，invoke 的 key 必须写 camelCase。
   此前误按 snake_case 传（group_id / worker_id / agent_ref），会报
   `missing required key groupId` —— 与 2026-09-02 create_scheduled_task 的
   `missing required key actionType` 属同一类契约错误。 */

/** 手动切换 Worker 在线状态：仅 "idle" | "offline"（Busy 态不允许手动改）。 */
export async function groupSetWorkerStatus(
  groupId: string,
  workerId: string,
  status: "idle" | "offline",
): Promise<void> {
  return invoke("group_set_worker_status", {
    groupId,
    workerId,
    status,
  });
}

/** 重绑席位来源 Agent：校验 catalog 存在并同步能力（运行时换 agent / 填充能力席位）。 */
export async function groupSetWorkerAgent(
  groupId: string,
  workerId: string,
  agentRef: string,
): Promise<import("../types").Worker> {
  return invoke("group_set_worker_agent", {
    groupId,
    workerId,
    agentRef,
  });
}

/** 移除席位：若在跑会取消其 session 并把当前任务标 Cancelled，再删库。 */
export async function groupRemoveWorker(
  groupId: string,
  workerId: string,
): Promise<void> {
  return invoke("group_remove_worker", {
    groupId,
    workerId,
  });
}

export async function groupListTasks(
  groupId: string,
  batchId?: string,
): Promise<import("../types").Task[]> {
  return invoke("group_list_tasks", { groupId, batchId: batchId ?? null });
}

/** 并行派活：提交一个 SubTask 批次，返回 batch_id。 */
export async function groupAssignTasks(
  groupId: string,
  tasks: import("../types").SubTask[],
): Promise<string> {
  return invoke("group_assign_tasks", { groupId, tasks });
}

/** 群主取消一个派活批次：运行中任务优雅中止、未派发任务置 Cancelled。 */
export async function groupCancelBatch(
  groupId: string,
  batchId: string,
): Promise<void> {
  return invoke("group_cancel_batch", { groupId, batchId });
}

/** 群主审批一个 coordinator 自动提交的批次：AwaitingApproval → Pending 并触发调度（fail-closed 闸门的放行入口）。 */
export async function groupApproveBatch(
  groupId: string,
  batchId: string,
): Promise<void> {
  return invoke("group_approve_batch", { groupId, batchId });
}

/** F6 恢复动作①：重试任务（回到 Pending + retry_count+1 + 清空心跳）。 */
export async function taskRetry(taskId: string): Promise<import("../types").Task> {
  return invoke("task_retry", { taskId });
}

/** F6 恢复动作②：改派他人。workerId 为 null 时回退按能力匹配空闲席位。 */
export async function taskReassign(
  taskId: string,
  workerId?: string | null,
): Promise<import("../types").Task> {
  return invoke("task_reassign", { taskId, workerId: workerId ?? null });
}

/** F6 恢复动作③：跳过依赖（清空 depends_on + 回到 Pending）。 */
export async function taskSkipDependency(taskId: string): Promise<import("../types").Task> {
  return invoke("task_skip_dependency", { taskId });
}

/** 看板人工改状态：拖拽卡片跨列即调用，后端直接改写 status，自由拖拽、不校验白名单。 */
export async function taskSetStatus(
  taskId: string,
  status: import("../types").TaskStatus,
): Promise<import("../types").Task> {
  return invoke("task_set_status", { taskId, status });
}

/** 管理员在环交接棒：把 Worker 产出物文件关联到任务（合并写 outputs）+ 标 Completed + 推进依赖链。 */
export async function taskAttachOutputs(
  taskId: string,
  paths: string[],
): Promise<import("../types").Task> {
  return invoke("task_attach_outputs", { taskId, paths });
}

/** 管理员在环交接棒：显式「启动就绪任务」——扫描批次内 Pending 且依赖已满足的任务并派发。 */
export async function taskLaunch(groupId: string, batchId: string): Promise<void> {
  return invoke("task_launch", { groupId, batchId });
}

/** 看板卡片列内拖拽重排：将 taskId 移到 beforeId 之前（null=该列末尾）。 */
export async function taskReorder(
  taskId: string,
  beforeId: string | null,
): Promise<import("../types").Task> {
  return invoke("task_reorder", { taskId, beforeId });
}

/** 全局看板：列出全部个人任务（batch_id 为 NULL，不绑定任何群）。 */
export async function taskListAll(): Promise<import("../types").Task[]> {
  return invoke("task_list_all", {});
}

/** 编辑手动任务：仅更新可写字段（description / reasoning），其余列不动。 */
export async function taskUpdate(
  taskId: string,
  p: { description?: string; reasoning?: string },
): Promise<import("../types").Task> {
  return invoke("task_update", { taskId, description: p.description ?? null, reasoning: p.reasoning ?? null });
}

/** 手动新建任务（看板「新建任务」入口）。个人任务，不绑定任何群。 */
export async function taskCreate(p: {
  description: string;
  depends_on?: string[];
  capability?: string | null;
  reasoning?: string | null;
  /** 看板「某列 +」快捷新建携带的目标状态；省略则后端默认 Pending。 */
  status?: import("../types").TaskStatus;
}): Promise<import("../types").Task> {
  return invoke("task_create", { payload: p });
}

/** 返回群/Worker 的隔离工作目录路径（按需创建目录）。 */
export async function groupGetWorkspace(
  groupId: string,
  workerId?: string,
): Promise<string> {
  return invoke("group_get_workspace", { groupId, workerId: workerId ?? null });
}

/** V5 群控制台：在系统文件管理器中高亮显示工作目录（reveal in Finder）。 */
export async function workspaceReveal(path: string): Promise<void> {
  return invoke("workspace_reveal", { path });
}

// ── Roundtable message bus ──

/** 群主发言：可带 mentions（被 @ 的 worker id）与 attachments（附件本地路径）做协作扇出；返回落库后的消息。 */
export async function groupPostMessage(
  groupId: string,
  content: string,
  mentions?: string[],
  attachments?: string[],
): Promise<import("../types").RoundtableMessage> {
  return invoke("group_post_message", {
    groupId,
    content,
    mentions: mentions ?? null,
    attachments: attachments ?? null,
  });
}

/** 广播：群内全部 Worker 竞速，第一个有效回复胜出；可带 attachments。 */
export async function groupRoundtableBroadcast(
  groupId: string,
  content: string,
  attachments?: string[],
): Promise<import("../types").RoundtableMessage> {
  return invoke("group_roundtable_broadcast", { groupId, content, attachments: attachments ?? null });
}

/** 拉取某群全部圆桌消息（按时间升序）。 */
export async function groupListMessages(
  groupId: string,
): Promise<import("../types").RoundtableMessage[]> {
  return invoke("group_list_messages", { groupId });
}

/** R6：列出某群全部竞速落选方案（trigger_seq 升序）。 */
export async function groupListAlternatives(
  groupId: string,
): Promise<import("../types").RoundtableAlternative[]> {
  return invoke("group_list_alternatives", { groupId });
}

/** R6：改选某落选方案为后续任务种子（落一条 system 消息标记）。 */
export async function groupPickAlternative(
  groupId: string,
  altId: number,
): Promise<import("../types").RoundtableMessage> {
  return invoke("group_pick_alternative", { groupId, altId });
}

/**
 * IX-7：从任意一条圆桌消息重跑（`rerun`）或分叉（`fork`）。
 *
 * - `rerun` 仅对席位发言可用：用触发它的原指令 + 原上下文窗口再跑一遍（可换席位）。
 * - `fork` 对任意消息可用：回到该消息发生的时刻另开一支，指令可改写、席位可改选
 *   （`workerId` 传 null 表示全员）。
 *
 * 无损：后端不删除任何既有消息，仅收窄本轮上下文窗口。返回落库的 system 审计标注。
 */
export async function groupRerunFromMessage(
  groupId: string,
  seq: number,
  mode: "rerun" | "fork",
  workerId?: string | null,
  prompt?: string | null,
): Promise<import("../types").RoundtableMessage> {
  return invoke("group_rerun_from_message", {
    groupId,
    seq,
    mode,
    workerId: workerId ?? null,
    prompt: prompt ?? null,
  });
}

// ── R4/R5 运行洞察（features/insight 数据源）──

/** R5「运行」视图：群级摘要条 + 甘特明细（一次返回）。 */
export async function insightGroupRuns(
  groupId: string,
): Promise<import("../types").GroupInsight> {
  return invoke("insight_group_runs", { groupId });
}

/** R4 席位仪表：历史聚合 + 最近运行。 */
export async function insightSeatRuns(
  seatId: string,
  limit?: number,
): Promise<import("../types").SeatInsight> {
  return invoke("insight_seat_runs", { seatId, limit: limit ?? null });
}

/** IX-14：导出群运行回放为自包含 HTML，返回文件绝对路径。 */
export async function exportRunReplay(groupId: string): Promise<string> {
  return invoke("export_run_replay", { groupId });
}

// ── IX-10 变更集审阅（群级汇总）──

/** 群级变更集汇总：改了哪些文件、谁改的、可回滚。 */
export async function groupChangesets(
  groupId: string,
  limit?: number,
): Promise<import("../types").ChangesetRowDto[]> {
  return invoke("group_changesets", { groupId, limit: limit ?? null });
}

/** 圆桌讨论摘要聚合：把群内已有圆桌消息聚合成结构化群级摘要。 */
export async function groupRoundtableSummarize(
  groupId: string,
): Promise<import("../types").RoundtableSummary> {
  return invoke("group_roundtable_summarize", { groupId });
}

/** 拉取某群全部圆桌摘要（按生成时间升序）。 */
export async function groupListSummaries(
  groupId: string,
): Promise<import("../types").RoundtableSummary[]> {
  return invoke("group_list_summaries", { groupId });
}

/** 群内产出物一览：聚合圆桌 Worker 回复、任务产出与群摘要，按时间倒序。 */
export async function groupListDeliverables(
  groupId: string,
): Promise<import("../types").Deliverable[]> {
  return invoke("group_list_deliverables", { groupId });
}

/** 拉取某群各 Worker 的累计协作指标（token / 耗时 / 执行次数 / 上下文快照）。 */
export async function groupListWorkerMetrics(
  groupId: string,
): Promise<import("../types").WorkerMetric[]> {
  return invoke("group_list_worker_metrics", { groupId });
}

// ── Group lifecycle control (runtime pause / resume) ──

/** 暂停群：冻结新派活与依赖推进，不取消在跑任务。 */
export async function groupPause(groupId: string): Promise<void> {
  return invoke("group_pause", { id: groupId });
}

/** 恢复群：重新触发被暂停冻结的有 Pending 任务的批次。 */
export async function groupResume(groupId: string): Promise<void> {
  return invoke("group_resume", { id: groupId });
}

/** 解散群：取消所有 Worker 运行时 session 并转入归档中（需人类二次确认）。 */
export async function groupDissolve(groupId: string): Promise<void> {
  return invoke("group_dissolve", { id: groupId });
}

// ── 产出物预览（docs/design/deliverable-preview-arch.md，ADR-027）──

/**
 * 受控读取文件文本内容（HTML/CSV/Markdown 渲染的内容通道）。
 * 后端 `artifact_read_text` 内部校验路径落在工作区目录，scope 外拒绝。
 * 可选 `sessionId`：LLM 答案文本里的路径常因 hallucinate 而失效（错把
 * `workspaces` 写成 `tmp`、UUID 字符错位），提供 sessionId 后后端会按
 * `<basename>` 在该 session 的 changeset product 行里做精确兜底——唯一
 * 匹配则回退到真实产物文件，避免用户被幻觉路径卡死。
 */
export async function artifactReadText(path: string, sessionId?: string): Promise<import("../types").ArtifactText> {
  return invoke("artifact_read_text", { path, sessionId });
}

/**
 * 受控读取文件二进制（图片/PDF 内嵌通道）。
 * 后端 `artifact_read_base64` 内部校验路径落在任一工作区根目录（含用户自选工作区），
 * scope 外拒绝。返回 base64 + mime，前端拼 `data:<mime>;base64,<data>` 内嵌。
 * sessionId 兜底语义同 `artifactReadText`。
 */
export async function artifactReadBase64(path: string, sessionId?: string): Promise<import("../types").ArtifactBytes> {
  return invoke("artifact_read_base64", { path, sessionId });
}

/**
 * 全局「产出文件」浏览器数据：列出所有工作区根目录（默认 + 用户自选）内
 * 模型产出的文件，按修改时间倒序。返回路径均在前端预览 scope 内，
 * 点击即调 `openPreview({ filePath })`。
 */
export async function listModelFiles(): Promise<import("../types").ModelFile[]> {
  return invoke("list_model_files");
}

