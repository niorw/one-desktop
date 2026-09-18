import type { DictKey } from "../../../i18n/dict";

/** 群协作中单个席位的「身份 + 职责」表达（V4 调研类长任务改造）。 */
export interface AgentRole {
  /** 语义角色（调研 / 架构 / 开发 / 测试 / 文档 / 编辑 / 协调）。 */
  role: string;
  /** 职责描述（需求分析与资料收集 …）。 */
  duty: string;
  /**
   * 是否为协调者（统筹与分工）。
   * 显式固化「产品经理(PM) = coordinator」语义：PM 预设即群内协调席位，
   * 负责把模糊目标拆成结构化 SubTask 批次并提交（见 TaskScheduler 审批闸门）。
   * 前端据此渲染协调徽标，区别于普通执行席位。
   */
  coordinator?: boolean;
}

/**
 * Agent 身份 + 职责启发式派生（前端兜底，后端无 duty 字段）。
 * 按 agent 名 / 能力关键词命中语义规则；未命中则 role=名字、duty=能力拼接。
 */
/**
 * 角色识别规则。最后一条为「协调者」固化规则：PM / 产品经理 / 管理 / lead /
 * 协调 / Scrum 等一律归 coordinator，并显式打 `coordinator: true` 标记。
 * 顺序即优先级（靠前的先命中）。
 */
const ROLE_RULES: Array<{ test: RegExp; role: string; dutyKey: DictKey; coordinator?: boolean }> = [
  { test: /research|调研|分析|analyst|研究|情报/i, role: "调研", dutyKey: "groups.role.research" },
  { test: /architect|架构|设计|design|方案/i, role: "架构", dutyKey: "groups.role.architect" },
  { test: /coder|开发|engineer|实现|dev|程序/i, role: "开发", dutyKey: "groups.role.coder" },
  { test: /qa|测试|verify|验证|test|质量/i, role: "测试", dutyKey: "groups.role.qa" },
  { test: /doc|文档|writer|写作|汇报|summary/i, role: "文档", dutyKey: "groups.role.docs" },
  { test: /edit|编辑|润色|copy/i, role: "编辑", dutyKey: "groups.role.editor" },
  { test: /(^|\s)(pm|scrum|lead)|\b管理\b|负责|owner|协调|coordinat|产品\s*经理|经理/i, role: "协调", dutyKey: "groups.role.coordinator", coordinator: true },
];

export function workerRole(
  name: string,
  capabilities: string[],
  t: (k: DictKey, v?: Record<string, string | number>) => string,
): AgentRole {
  for (const rule of ROLE_RULES) {
    if (rule.test.test(name)) {
      return { role: rule.role, duty: t(rule.dutyKey), coordinator: rule.coordinator };
    }
  }
  // 能力里也兜底命中一次（有些 preset 名不含角色词，但能力含）。
  for (const cap of capabilities) {
    for (const rule of ROLE_RULES) {
      if (rule.test.test(cap)) {
        return { role: rule.role, duty: t(rule.dutyKey), coordinator: rule.coordinator };
      }
    }
  }
  return {
    role: name,
    duty: capabilities.length > 0 ? capabilities.join(" · ") : t("groups.role.generic"),
  };
}

