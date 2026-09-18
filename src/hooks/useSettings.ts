import { useState, useCallback, useEffect } from "react";
import * as tauri from "../services/tauri";
import type {
  ModelProviderConfig,
  ProviderId,
  ReasoningDialect,
  Settings,
  ThinkDensity,
  ThinkMode,
  TokenConfig,
} from "../types";

/** Default chat model — single source of truth, mirrored in Rust `defaults::DEFAULT_MODEL`. */
export const DEFAULT_MODEL = "deepseek-v4-pro";
/** Default LLM provider. */
export const DEFAULT_PROVIDER: ProviderId = "deepseek";

export interface ModelOption {
  value: string;
  label: string;
}

/** Selectable DeepSeek models — shared by Settings and the chat model picker. */
export const DEEPSEEK_MODELS: ModelOption[] = [
  { value: "deepseek-v4-flash", label: "DeepSeek-V4 Flash" },
  { value: "deepseek-v4-pro", label: "DeepSeek-V4 Pro" },
  { value: "deepseek-v4", label: "DeepSeek-V4" },
];

/** 各供应商的常用模型预设。仅作快捷入口——模型名迭代极快，
 * 列表里没有的可直接在下拉后的输入框改（`custom` 供应商则纯手填）。 */
export const MODEL_OPTIONS: Record<ProviderId, ModelOption[]> = {
  openai: [
    { value: "gpt-4o", label: "GPT-4o" },
    { value: "gpt-4o-mini", label: "GPT-4o Mini" },
    { value: "gpt-4-turbo", label: "GPT-4 Turbo" },
  ],
  deepseek: DEEPSEEK_MODELS,
  qwen: [
    { value: "qwen3-max", label: "Qwen3-Max" },
    { value: "qwen3-plus", label: "Qwen3-Plus" },
    { value: "qwen3-turbo", label: "Qwen3-Turbo" },
  ],
  glm: [
    { value: "glm-5", label: "GLM-5" },
    { value: "glm-5-air", label: "GLM-5-Air" },
    { value: "glm-4-plus", label: "GLM-4-Plus" },
  ],
  kimi: [
    { value: "kimi-k2", label: "Kimi K2" },
    { value: "kimi-k2-turbo", label: "Kimi K2 Turbo" },
  ],
  minimax: [
    { value: "MiniMax-M2", label: "MiniMax-M2" },
    { value: "MiniMax-Text-01", label: "MiniMax-Text-01" },
  ],
  custom: [],
};

/** 可选供应商 —— 与 Rust `create_provider_full` 的方言路由一一对应。 */
export const PROVIDERS: { value: ProviderId; label: string }[] = [
  { value: "deepseek", label: "DeepSeek" },
  { value: "openai", label: "OpenAI" },
  { value: "qwen", label: "千问" },
  { value: "glm", label: "智谱 GLM" },
  { value: "kimi", label: "月之暗面 Kimi" },
  { value: "minimax", label: "MiniMax" },
  { value: "custom", label: "自定义（OpenAI 兼容）" },
];

/** 各家族的推荐默认模型 —— 切换供应商时自动带入，省得用户对着空输入框发呆。 */
export const PROVIDER_DEFAULT_MODEL: Record<ProviderId, string> = {
  deepseek: DEFAULT_MODEL,
  openai: "gpt-4o",
  qwen: "qwen3-max",
  glm: "glm-5",
  kimi: "kimi-k2",
  minimax: "MiniMax-M2",
  custom: "",
};

/** 模型值 → 供应商，用于模型选择器跨供应商切换时同步 provider。 */
export const MODEL_TO_PROVIDER: Record<string, ProviderId> = (() => {
  const map: Record<string, ProviderId> = {};
  for (const [provider, models] of Object.entries(MODEL_OPTIONS)) {
    models.forEach((m) => {
      map[m.value] = provider as ProviderId;
    });
  }
  return map;
})();

const REASONING_DIALECTS: ReasoningDialect[] = [
  "openai",
  "deepseek",
  "qwen",
  "glm",
  "kimi",
  "minimax",
];

export const DEFAULT_TOKEN_CONFIG: TokenConfig = {
  promptKey: "prompt_tokens",
  outputKey: "completion_tokens",
  reasoningKey: "reasoning_tokens",
  totalKey: "total_tokens",
};

/** 前端 camelCase ↔ 后端 snake_case（Rust `TokenConfig` 字段名）。 */
function tokenConfigToJson(tc: TokenConfig): string {
  return JSON.stringify({
    prompt_key: tc.promptKey,
    output_key: tc.outputKey,
    reasoning_key: tc.reasoningKey,
    total_key: tc.totalKey,
  });
}

function tokenConfigFromJson(raw: string): TokenConfig {
  if (!raw || !raw.trim()) return DEFAULT_TOKEN_CONFIG;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const pick = (k: string, fb: string) =>
      typeof o[k] === "string" ? (o[k] as string) : fb;
    return {
      promptKey: pick("prompt_key", DEFAULT_TOKEN_CONFIG.promptKey),
      outputKey: pick("output_key", DEFAULT_TOKEN_CONFIG.outputKey),
      reasoningKey: pick("reasoning_key", DEFAULT_TOKEN_CONFIG.reasoningKey),
      totalKey: pick("total_key", DEFAULT_TOKEN_CONFIG.totalKey),
    };
  } catch {
    // 脏 JSON 不阻塞加载，回落默认映射（与 Rust `parse_token_config` 同口径）。
    return DEFAULT_TOKEN_CONFIG;
  }
}

const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
  preamble: "",
  temperature: 0.7,
  maxTokens: 0,
  maxIterations: 20,
  thinkingDensity: "collapsed",
  thinkingMode: "default",
  customBaseUrl: "",
  reasoningDialect: "deepseek",
  tokenConfig: DEFAULT_TOKEN_CONFIG,
};

/** 由当前单 provider 运行时字段生成一个默认供应商列表（向后兼容旧数据）。 */
export function buildDefaultProviders(settings: Settings): ModelProviderConfig[] {
  const isCustom = settings.provider === "custom";
  const builtIn = PROVIDERS.find((p) => p.value === settings.provider);
  const presetModels = MODEL_OPTIONS[settings.provider] ?? [];
  const models = presetModels.length > 0 ? presetModels.map((m) => m.value) : [settings.model || DEFAULT_MODEL];
  return [
    {
      id: settings.provider,
      name: builtIn?.label ?? settings.provider,
      provider: settings.provider,
      baseUrl: isCustom ? settings.customBaseUrl : undefined,
      apiKey: settings.apiKey,
      reasoningDialect: isCustom ? settings.reasoningDialect : (settings.provider as ReasoningDialect),
      models,
      defaultModel: settings.model || DEFAULT_MODEL,
      enabled: true,
    },
  ];
}

function providersToJson(providers: ModelProviderConfig[] | undefined): string {
  if (!providers || providers.length === 0) return "";
  return JSON.stringify(providers);
}

function providersFromJson(raw: string): ModelProviderConfig[] | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as ModelProviderConfig[];
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter(
      (p): p is ModelProviderConfig =>
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        typeof p.provider === "string" &&
        typeof p.apiKey === "string" &&
        Array.isArray(p.models) &&
        typeof p.defaultModel === "string",
    );
  } catch {
    return undefined;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showModal, setShowModal] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const [
        model,
        provider,
        preamble,
        apiKey,
        temp,
        maxTok,
        density,
        mode,
        baseUrl,
        dialect,
        tokenCfg,
        providersCfg,
      ] = await Promise.all([
        tauri.getSetting("model"),
        tauri.getSetting("provider").catch(() => "deepseek"),
        tauri.getSetting("preamble"),
        tauri.getConfigApiKey().catch(() => ""),
        tauri.getSetting("temperature").catch(() => "0.7"),
        tauri.getSetting("max_tokens").catch(() => "0"),
        tauri.getSetting("thinking_density").catch(() => "collapsed"),
        tauri.getSetting("thinking_mode").catch(() => "default"),
        tauri.getSetting("custom_base_url").catch(() => ""),
        tauri.getSetting("reasoning_dialect").catch(() => "deepseek"),
        tauri.getSetting("token_config").catch(() => ""),
        tauri.getSetting("model_providers").catch(() => ""),
      ]);
      const providersRaw = providersFromJson((providersCfg as string) || "");
      const effDensity: ThinkDensity =
        density === "peek" || density === "expanded" ? density : "collapsed";
      const effMode: ThinkMode =
        mode === "off" || mode === "on" || mode === "high" ? mode : "default";
      // 未知 provider（旧库残留 / 手改数据库）一律回落 deepseek，避免打到不存在的方言。
      const effProvider: ProviderId = PROVIDERS.some((p) => p.value === provider)
        ? (provider as ProviderId)
        : "deepseek";
      const effDialect: ReasoningDialect = REASONING_DIALECTS.includes(
        dialect as ReasoningDialect,
      )
        ? (dialect as ReasoningDialect)
        : "deepseek";
      // 未显式存过多供应商配置（旧数据 / 从未打开过设置）时，
      // 用当前单 provider 字段回落出一份默认供应商列表，保证输入框至少能选到当前激活模型，
      // 不会因 providers 为空而显示「未配置」。
      const effProviders: ModelProviderConfig[] =
        providersRaw ?? buildDefaultProviders({
          ...DEFAULT_SETTINGS,
          provider: effProvider,
          model: model || PROVIDER_DEFAULT_MODEL[effProvider] || DEFAULT_MODEL,
          apiKey: apiKey || "",
          customBaseUrl: baseUrl || "",
          reasoningDialect: effDialect,
        });
      setSettings({
        apiKey: apiKey || "",
        provider: effProvider,
        model: model || PROVIDER_DEFAULT_MODEL[effProvider] || DEFAULT_MODEL,
        preamble: preamble || "",
        temperature: parseFloat(temp) || 0.7,
        maxTokens: parseInt(maxTok) || 0,
        maxIterations: 20,
        thinkingDensity: effDensity,
        thinkingMode: effMode,
        customBaseUrl: baseUrl || "",
        reasoningDialect: effDialect,
        tokenConfig: tokenConfigFromJson(tokenCfg),
        providers: effProviders,
      });
      setLoaded(true);
    } catch (err) {
      console.error("[useSettings] Failed to load settings:", err);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const saveSettings = useCallback(async (newSettings: Settings) => {
    try {
      await Promise.all([
        tauri.setSetting("model", newSettings.model),
        tauri.setSetting("provider", newSettings.provider),
        tauri.setSetting("preamble", newSettings.preamble),
        tauri.setSetting("temperature", String(newSettings.temperature)),
        tauri.setSetting("max_tokens", String(newSettings.maxTokens)),
        tauri.setSetting("thinking_density", newSettings.thinkingDensity),
        tauri.setSetting("thinking_mode", newSettings.thinkingMode),
        tauri.setSetting("custom_base_url", newSettings.customBaseUrl),
        tauri.setSetting("reasoning_dialect", newSettings.reasoningDialect),
        tauri.setSetting("token_config", tokenConfigToJson(newSettings.tokenConfig)),
        tauri.setSetting("model_providers", providersToJson(newSettings.providers)),
        tauri.setConfigApiKey(newSettings.apiKey),
      ]);
      setSettings(newSettings);
    } catch (err) {
      console.error("[useSettings] Failed to save settings:", err);
    }
  }, []);

  return {
    settings,
    loaded,
    showModal,
    setShowModal,
    saveSettings,
    loadSettings,
  };
}
