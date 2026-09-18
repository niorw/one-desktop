/**
 * 用户画像（设置 → 个性化）。
 *
 * 语义边界：这里存的是**关于「你这个人」的长期事实**——称呼、角色、领域、
 * 沟通偏好——是要持续喂给模型的记忆；桌面外观（主题 / 语言 / 毛玻璃）属于
 * 「常规」，两者不要混。
 *
 * 双写设计（各司其职，互不耦合）：
 * 1. 结构化字段以 JSON 存本地设置 `user_profile` —— 只服务于表单回填；
 * 2. 由 {@link renderProfileMarkdown} 渲染出的 Markdown 片段写入
 *    `~/.one-desktop/memory/USER.md` 的哨兵区块 —— 这才是模型真正读到的东西。
 *
 * 之所以不把 JSON 直接丢给模型：模型对自然语言 bullet 的遵循度远高于裸 JSON，
 * 且 USER.md 已被引擎在每次 run 注入 system prompt（`<user_profile>` 段），
 * 主会话 / 定时任务 / 群 Worker 三条路径零改动全覆盖。
 */

import * as tauri from "./tauri";

const SETTING_KEY = "user_profile";

/** 与模型对话时使用的语言（独立于界面语言）。 */
export type ReplyLanguage = "auto" | "zh" | "en";

/** 沟通风格标签（多选）。 */
export const TONE_TAGS = [
  "concise",
  "detailed",
  "examples",
  "stepByStep",
  "noFluff",
  "cite",
] as const;

export type ToneTag = (typeof TONE_TAGS)[number];

export interface UserProfile {
  /** 希望 AI 怎么称呼你。 */
  nickname: string;
  /** 职业 / 角色，决定回答的专业基线。 */
  role: string;
  /** 所在城市 / 时区，影响时间与本地化表述。 */
  location: string;
  /** 熟悉的领域与技术栈，避免解释你已经会的东西。 */
  expertise: string;
  /** 回复语言偏好。 */
  replyLanguage: ReplyLanguage;
  /** 沟通风格标签。 */
  tone: ToneTag[];
  /** 其他任何想让 AI 长期记住的话。 */
  custom: string;
}

export const EMPTY_USER_PROFILE: UserProfile = {
  nickname: "",
  role: "",
  location: "",
  expertise: "",
  replyLanguage: "auto",
  tone: [],
  custom: "",
};

/**
 * 给模型看的措辞集中在这里 —— 单一数据源。
 * UI 上的中文标签走 i18n dict，两者刻意分开：前者是 prompt 语义，后者是界面文案，
 * 改 UI 文案不应该悄悄改变模型行为。
 */
const TONE_PROMPT_TEXT: Record<ToneTag, string> = {
  concise: "回答尽量简洁直接，先给结论",
  detailed: "回答要详尽，把背景和推理讲清楚",
  examples: "多给可运行的示例或代码",
  stepByStep: "复杂问题分步骤说明",
  noFluff: "不要客套话和免责声明，直接进入正题",
  cite: "给出依据、来源或引用出处",
};

const REPLY_LANGUAGE_PROMPT_TEXT: Record<Exclude<ReplyLanguage, "auto">, string> = {
  zh: "始终使用简体中文回复",
  en: "Always reply in English",
};

/** 判断画像是否整体为空（决定是否要把 USER.md 里的区块整段移除）。 */
export function isProfileEmpty(p: UserProfile): boolean {
  return (
    !p.nickname.trim() &&
    !p.role.trim() &&
    !p.location.trim() &&
    !p.expertise.trim() &&
    !p.custom.trim() &&
    p.tone.length === 0 &&
    p.replyLanguage === "auto"
  );
}

/**
 * 渲染成注入 system prompt 的 Markdown 片段。
 * 空字段一律跳过 —— 宁可少给，也不要用 "未填写" 之类的噪音占用上下文。
 */
export function renderProfileMarkdown(p: UserProfile): string {
  if (isProfileEmpty(p)) return "";

  const lines: string[] = ["## 用户档案（由「设置 → 个性化」维护）", ""];
  const bullet = (label: string, value: string) => {
    const v = value.trim();
    if (v) lines.push(`- **${label}**：${v}`);
  };

  bullet("称呼", p.nickname);
  bullet("角色", p.role);
  bullet("所在地 / 时区", p.location);
  bullet("专业领域", p.expertise);

  if (p.replyLanguage !== "auto") {
    bullet("回复语言", REPLY_LANGUAGE_PROMPT_TEXT[p.replyLanguage]);
  }
  if (p.tone.length > 0) {
    bullet("沟通偏好", p.tone.map((t) => TONE_PROMPT_TEXT[t]).join("；"));
  }

  const custom = p.custom.trim();
  if (custom) {
    lines.push("", "### 其他需要长期记住的", custom);
  }

  return lines.join("\n").trim();
}

/** 读取表单数据。任何解析异常都退化为空画像，绝不让设置页打不开。 */
export async function loadUserProfile(): Promise<UserProfile> {
  try {
    const raw = await tauri.getSetting(SETTING_KEY);
    const parsed = JSON.parse(raw) as Partial<UserProfile>;
    return {
      ...EMPTY_USER_PROFILE,
      ...parsed,
      // 数组字段单独兜底：历史数据或手工编辑可能给出非数组。
      tone: Array.isArray(parsed.tone)
        ? parsed.tone.filter((t): t is ToneTag => (TONE_TAGS as readonly string[]).includes(t))
        : [],
    };
  } catch {
    return EMPTY_USER_PROFILE;
  }
}

/**
 * 保存：结构化 JSON 落设置（回填用）+ 渲染结果落 USER.md（模型用）。
 * 两次写入都失败才抛，避免「表单存了但模型没记住」的静默不一致。
 */
export async function saveUserProfile(p: UserProfile): Promise<void> {
  await tauri.setSetting(SETTING_KEY, JSON.stringify(p));
  await tauri.writeUserProfileMemory(renderProfileMarkdown(p));
}
