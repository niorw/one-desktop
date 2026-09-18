import type { DictKey } from "../../../i18n/dict";
import type { DeliverableKind, TaskStatus, Worker, WorkerStatus } from "../../../types";
import { Icons } from "../../common/Icons";

/** 角色 → 图标 + 主题色（侧边栏「智能体工作区」用）。 */
export const AGENT_ROLE_META: Record<
  string,
  { icon: (typeof Icons)[keyof typeof Icons]; color: string; bg: string }
> = {
  调研: { icon: Icons.Search, color: "var(--status-success)", bg: "color-mix(in srgb, var(--status-success) 12%, transparent)" },
  架构: { icon: Icons.Network, color: "var(--status-info)", bg: "color-mix(in srgb, var(--status-info) 12%, transparent)" },
  开发: { icon: Icons.Terminal, color: "var(--status-success)", bg: "color-mix(in srgb, var(--status-success) 12%, transparent)" },
  测试: { icon: Icons.Shield, color: "var(--text-secondary)", bg: "var(--bg-tertiary)" },
  文档: { icon: Icons.FileText, color: "var(--status-warning)", bg: "color-mix(in srgb, var(--status-warning) 12%, transparent)" },
  编辑: { icon: Icons.Edit, color: "var(--status-warning)", bg: "color-mix(in srgb, var(--status-warning) 12%, transparent)" },
  协调: { icon: Icons.Users, color: "var(--status-info)", bg: "color-mix(in srgb, var(--status-info) 12%, transparent)" },
};
export const uid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `st_${crypto.randomUUID()}`
    : `st_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

/** 看板状态 → 统一 SVG 图标（与 app Icons.tsx 同语言，替代旧 Unicode 字形）。 */
export const STATUS_ICON: Record<TaskStatus, (typeof Icons)[keyof typeof Icons]> = {
  Pending: Icons.Hourglass,
  InProgress: Icons.Play,
  Completed: Icons.Check,
  Failed: Icons.AlertTriangle,
  Cancelled: Icons.Ban,
  /** 待审批：协调者已拆解提交，等待群主放行。 */
  AwaitingApproval: Icons.Hand,
};

/** 把毫秒格式化为可读耗时（ms / s / m s）。 */
export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m${rs}s`;
};


export const WORKER_STATUS_KEY: Record<WorkerStatus, DictKey> = {
  Idle: "groups.member.idle",
  Busy: "groups.member.busy",
  Offline: "groups.member.offline",
};

export const AGENT_TYPE_KEY: Record<string, DictKey> = {
  Static: "groups.agentType.Static",
  Dynamic: "groups.agentType.Dynamic",
  Capability: "groups.agentType.Capability",
};

/// 智能体显示名：能力席位（不绑定预设，agent_ref 为空）回退为能力名拼接，避免空白头像/名称。
export const agentDisplayName = (
  w: Worker,
  resolveName: (ref: string) => string,
  t: (k: DictKey) => string,
): string =>
  w.seat_type === "Capability"
    ? w.capabilities.length > 0
      ? w.capabilities.join(" · ")
      : t("groups.agentType.Capability")
    : resolveName(w.agent_ref);

/** 群主视图。`topology` = 建群后的协作拓扑热更面板（2026-09-02 新增，
 *  补上「建群是设拓扑唯一入口」这个架构缺口；后端 `group_topology_set` 早已就绪）。 */
export type MainView = "chat" | "dispatch" | "deliverables" | "runs" | "board" | "topology";

export interface DraftSubTask {
  key: string;
  id: string;
  description: string;
  workerId: string;
  dependsOn: string[];
  capability: string;
  reasoning: string;
}

export const delivKindKey = (k: DeliverableKind): DictKey =>
  `groups.deliverables.type.${k}` as DictKey;

export const delivFilterKey = (f: "all" | DeliverableKind): DictKey => {
  switch (f) {
    case "reply":
      return "groups.deliverables.filterReply";
    case "task_output":
      return "groups.deliverables.filterTask";
    case "summary":
      return "groups.deliverables.filterSummary";
    default:
      return "groups.deliverables.filterAll";
  }
};

export const fmtDelivTime = (ms: number, locale: string) =>
  new Date(ms).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
