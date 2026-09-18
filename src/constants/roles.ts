// 角色目录与「按功能建群」模板常量（纯前端，零后端改动）。
//
// 职能角色 / 聊天人格的 name 必须与内核 seed 完全一致：
//   - 职能角色  → src-tauri/src/group/functional_presets.rs
//   - 聊天人格  → src-tauri/src/group/persona_presets.rs
// 建群弹窗据此对 Agent Catalog 做分组展示，并把模板里的角色名反查为 agent_ref。

import type { GroupKind } from "../types";

/** 职能角色 name（内核 functional_presets 种子，顺序即展示顺序）。 */
export const FUNCTIONAL_ROLE_NAMES: string[] = [
  "产品经理",
  "UI 设计师",
  "研发工程师",
  "系统架构师",
  "测试工程师",
  "运营策划",
  "HR 顾问",
  "数据分析师",
];

/** 聊天人格 name（内核 persona_presets 种子）。 */
export const CHAT_PERSONA_NAMES: string[] = [
  "理性分析师",
  "创意鬼才",
  "毒舌评审",
  "协调主持",
  "落地执行",
  "气氛担当",
];

export type RoleCategory = "functional" | "chat" | "other";

/** 按 name 归类 Agent Catalog 中的预设（前端分组展示用）。 */
export function roleCategory(name: string): RoleCategory {
  if (FUNCTIONAL_ROLE_NAMES.includes(name)) return "functional";
  if (CHAT_PERSONA_NAMES.includes(name)) return "chat";
  return "other";
}

/** 「按功能建群」模板：点击即预填群名 / 目标 / 性质 / 所选角色。 */
export interface GroupTemplate {
  key: string;
  label: string;
  description: string;
  kind: GroupKind;
  goal: string;
  /** 职能 / 聊天角色 name 列表，用于反查 agent_ref。 */
  roles: string[];
  /** 建议群主角色名（可选）。 */
  ownerRole?: string;
}

export const GROUP_TEMPLATES: GroupTemplate[] = [
  {
    key: "product-rd",
    label: "产品研发群",
    description: "产品 → 设计 → 架构 → 研发 → 测试 全流程",
    kind: "Dev",
    goal: "围绕产品需求，完成从产品定义、设计、架构到研发与测试验证的全流程协作。",
    roles: ["产品经理", "UI 设计师", "系统架构师", "研发工程师", "测试工程师"],
    ownerRole: "产品经理",
  },
  {
    key: "ops",
    label: "运营群",
    description: "运营策划 + 数据分析驱动增长",
    kind: "Research",
    goal: "围绕产品运营目标，制定活动策略、度量增长指标并复盘。",
    roles: ["运营策划", "数据分析师", "产品经理"],
    ownerRole: "运营策划",
  },
  {
    key: "hr",
    label: "人事群",
    description: "HR + 协调 + 分析的人事协作",
    kind: "Chat",
    goal: "围绕团队人事与组织效能，做角色分工、招聘与协作协调。",
    roles: ["HR 顾问", "协调主持", "理性分析师"],
    ownerRole: "HR 顾问",
  },
  {
    key: "chat",
    label: "聊天群",
    description: "多人格自由讨论与头脑风暴",
    kind: "Chat",
    goal: "多角色自由讨论、头脑风暴与观点碰撞。",
    roles: CHAT_PERSONA_NAMES,
    ownerRole: "协调主持",
  },
];
