import { useCallback, useMemo, useState } from "react";
import { useDialogA11y } from "../common/useDialogA11y";
import { Icons } from "../common/Icons";
import { ChipMultiSelect } from "./ChipMultiSelect";
import type { AgentProfile, ModelProviderConfig, ProviderId } from "../../types";
import { createAgentPreset, updateAgentPreset } from "../../services/groupCommands";
import "./agentEditor.css";
import { friendlyError } from "../../services/errors";
import { useI18n } from "../../i18n/I18nProvider";
import type { DictKey } from "../../i18n/dict";
import {
  AGENT_TOOL_CANDIDATES,
  AGENT_SKILL_CANDIDATES,
  AGENT_MCP_CANDIDATES,
  AGENT_PLUGIN_CANDIDATES,
} from "../../constants/agentCapabilities";

const PERMISSION_MODES = ["default", "plan", "bypass", "ask"];
const ISOLATIONS = ["none", "sandbox"];

/** 「可用工具」下拉语义对位——选 default/plan/bypass/ask 这些 policy_mode 选项，
 *  让用户用一个集中控件决定 agent 的执行策略；不留「全部/无/自选」类无字段概念。 */
const TOOL_ACCESS_OPTIONS = [
  { value: "default", i18nKey: "default" },
  { value: "plan", i18nKey: "plan" },
  { value: "ask", i18nKey: "ask" },
  { value: "bypass", i18nKey: "bypass" },
] as const;

const PERM_MODE_LABEL_KEY: Record<string, string> = {
  default: "default",
  plan: "plan",
  ask: "ask",
  bypass: "bypass",
};

const permissionModeHint = (t: (k: DictKey) => string, mode: string): string =>
  t(`agent.permHint.${mode}` as DictKey);

const isolationHint = (t: (k: DictKey) => string, iso: string): string =>
  t(`agent.isoHint.${iso}` as DictKey);

type AgentPatch = Partial<{
  name: string;
  provider: string;
  model: string;
  system_prompt: string;
  capabilities: string[];
  skills: string[];
  mcp: string[];
  tools: string[];
  disallowed_tools: string[];
  permission_mode: string;
  max_turns: number;
  isolation: string;
  plugins: string[];
}>;

/** 顺序无关比较两组标签。 */
const sameSet = (a: string[], b: string[]) =>
  [...a].sort().join(" ") === [...b].sort().join(" ");

/**
 * Agent 自定义配置编辑器（新建 / 编辑双态）。
 *
 * R-8（2026-09-02）：**模型/provider 选项必须从设置页 settings.providers 拉取**，
 * 不再硬编码 MODEL_OPTIONS / PROVIDERS / PROVIDER_DEFAULT_MODEL —— 任何"模型调整"
 * 入口都要从设置页（ModelProvidersPanel）配置的 providers 拿真值，去重 + 唯一来源。
 * 调用方务必传 `providers` prop（来自 settings.providers 或 buildDefaultProviders 兜底）。
 */
export function AgentEditorModal({
  mode,
  profile,
  providers,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  profile?: AgentProfile;
  /** 设置页 settings.providers（必填；决定 provider/model 下拉数据源）。 */
  providers: ModelProviderConfig[];
  onCancel: () => void;
  onSaved: (p: AgentProfile) => void;
}) {
  const { t } = useI18n();
  const isEdit = mode === "edit";

  // ── provider 下拉数据源：去重 settings.providers，按用户配置的顺序 ──
  const providerOptions = useMemo(() => {
    const seen = new Set<string>();
    return providers.reduce<
      { value: string; label: string; id: string }[]
    >((acc, p) => {
      if (seen.has(p.provider)) return acc;
      seen.add(p.provider);
      acc.push({ value: p.provider, label: p.name || p.provider, id: p.id });
      return acc;
    }, []);
  }, [providers]);

  // ── model 下拉数据源：来自 settings.providers（按 provider × model 平铺）──
  // 选项带 "ProviderName · modelId" 前缀，让用户清楚看到来源；key 携带 provider.id 避免 React key 警告。
  const modelOptions = useMemo(() => {
    return providers.flatMap((p) =>
      p.models.map((m) => ({
        value: m,
        label: `${p.name || p.provider} · ${m}`,
        key: `${p.id}:${m}`,
      })),
    );
  }, [providers]);

  const initialProviderValue =
    (profile?.provider as ProviderId | undefined) ??
    providerOptions[0]?.value ??
    "deepseek";
  const initialModelValue = profile?.model ?? modelOptions[0]?.value ?? "";

  const [name, setName] = useState(profile?.name ?? "");
  const [provider, setProvider] = useState<string>(initialProviderValue);
  const [model, setModel] = useState<string>(initialModelValue);
  const [systemPrompt, setSystemPrompt] = useState(profile?.system_prompt ?? "");

  /**
   * 选 model 时反推 provider：在 settings.providers 里查找包含该 model 的 provider。
   * 完全用 settings 真值反查 —— 不再用硬编码 MODEL_TO_PROVIDER 映射
   * （硬编码映射不会反映用户实际配置）。
   */
  const onModelChange = useCallback(
    (v: string) => {
      setModel(v);
      const matched = providers.find((p) => p.models.includes(v));
      if (matched) setProvider(matched.provider);
      // 找不到说明 model 是历史遗留值或自定义输入 —— 保持当前 provider，不报错。
    },
    [providers],
  );

  const onProviderChange = useCallback(
    (v: string) => {
      setProvider(v);
      // 在 settings.providers 里找该 provider 的 models 列表
      const matched = providers.find((p) => p.provider === v);
      const opts = matched?.models ?? [];
      if (opts.length > 0 && !opts.includes(model)) {
        // 当前 model 不在新 provider 的列表里 → 切到该 provider 的第一个 model
        setModel(opts[0]);
      }
    },
    [providers, setProvider, setModel, model],
  );
  const [capabilities, setCapabilities] = useState<string[]>(profile?.capabilities ?? []);
  const [skills, setSkills] = useState<string[]>(profile?.skills ?? []);
  const [mcp, setMcp] = useState<string[]>(profile?.mcp ?? []);
  const [tools, setTools] = useState<string[]>(profile?.tools ?? []);
  const [plugins, setPlugins] = useState<string[]>(profile?.plugins ?? []);
  const [disallowedTools, setDisallowedTools] = useState<string[]>(profile?.disallowed_tools ?? []);
  const [permissionMode, setPermissionMode] = useState(profile?.permission_mode ?? "default");
  const [maxTurns, setMaxTurns] = useState<number>(profile?.max_turns ?? 0);
  const [isolation, setIsolation] = useState(profile?.isolation ?? "none");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modalRef = useDialogA11y<HTMLDivElement>(true, onCancel);

  // 已废（删除时一并去 MODEL_OPTIONS 硬编码 —— provider/model 选项统一从 settings.providers 拿）
  void modelOptions;

  const canSave =
    name.trim().length > 0 && model.trim().length > 0 && systemPrompt.trim().length > 0;

  const save = async () => {
    if (!canSave || saving) return;
    setError(null);
    setSaving(true);
    try {
      if (!isEdit) {
        const created = await createAgentPreset({
          name: name.trim(),
          model: model.trim(),
          system_prompt: systemPrompt.trim(),
          capabilities,
          skills,
          mcp,
          tools,
          ext: {
            provider,
            disallowed_tools: disallowedTools,
            permission_mode: permissionMode,
            max_turns: maxTurns,
            isolation,
            plugins,
          },
        });
        onSaved(created);
        return;
      }
      if (!profile) return;
      const patch: AgentPatch = {};
      if (name.trim() !== profile.name) patch.name = name.trim();
      if (provider !== (profile.provider ?? "deepseek")) patch.provider = provider;
      if (model.trim() !== profile.model) patch.model = model.trim();
      if (systemPrompt.trim() !== profile.system_prompt) patch.system_prompt = systemPrompt.trim();
      if (!sameSet(capabilities, profile.capabilities)) patch.capabilities = capabilities;
      if (!sameSet(skills, profile.skills)) patch.skills = skills;
      if (!sameSet(mcp, profile.mcp)) patch.mcp = mcp;
      if (!sameSet(tools, profile.tools)) patch.tools = tools;
      if (!sameSet(plugins, profile.plugins ?? [])) patch.plugins = plugins;
      if (!sameSet(disallowedTools, profile.disallowed_tools ?? [])) patch.disallowed_tools = disallowedTools;
      if (permissionMode !== profile.permission_mode) patch.permission_mode = permissionMode;
      if (maxTurns !== (profile.max_turns ?? 0)) patch.max_turns = maxTurns;
      if (isolation !== profile.isolation) patch.isolation = isolation;
      const updated = await updateAgentPreset(profile.id, patch);
      onSaved(updated);
    } catch (e) {
      console.error("[agent-editor] save failed", e);
      setError(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal modal-agent-editor"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? t("agent.editTitle") : t("agent.createTitle")}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 面包屑 + 帮助 + 关闭（参考图顶部一行）── */}
        <nav className="ae-breadcrumb" aria-label="breadcrumb">
          <span className="ae-breadcrumb-step">{t("settings.agent")}</span>
          <span className="ae-breadcrumb-sep">›</span>
          <span className="ae-breadcrumb-step current">
            {isEdit ? t("agent.editTitle") : t("agent.createTitle")}
          </span>
          <div className="ae-breadcrumb-actions">
            <button
              type="button"
              className="ae-help-btn"
              aria-label={t("common.cancel")}
              title="?"
            >
              ?
            </button>
            <button
              type="button"
              className="ae-close-btn"
              onClick={onCancel}
              aria-label={t("common.cancel")}
            >
              <Icons.Close size={16} />
            </button>
          </div>
        </nav>

        <div className="ae-header">
          <h2>{isEdit ? t("agent.editTitle") : t("agent.createTitle")}</h2>
          <p className="ae-subtitle">{t("agent.headerHelper") /* 见 dict */}</p>
        </div>

        {/* ── 大白卡片（参考图整页主体）── */}
        <section className="ae-card">
          {/* 第 1 行：名称 + 模型（参考图第 1 行是「名称 / 颜色 / 模型」，色板不引入） */}
          <div className="ae-row ae-row-2col">
            <div className="ae-field">
              <label htmlFor="ae-name">{t("agent.name")}</label>
              <input
                id="ae-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("agent.namePh")}
                autoFocus
              />
            </div>
            <div className="ae-field">
              <label htmlFor="ae-model">{t("agent.model")}</label>
              <select
                id="ae-model"
                value={model}
                onChange={(e) => onModelChange(e.target.value)}
              >
                {modelOptions.length > 0 ? (
                  modelOptions.map((m) => (
                    <option key={m.key} value={m.value}>
                      {m.label}
                    </option>
                  ))
                ) : (
                  <option value={model}>{model}</option>
                )}
              </select>
            </div>
          </div>

          {/* 第 2 行：可用工具下拉 + 描述（参考图这里是 system prompt 描述行） */}
          <div className="ae-field">
            <label htmlFor="ae-tools-access">{t("agent.toolsAccess")}</label>
            <select
              id="ae-tools-access"
              value={permissionMode}
              onChange={(e) => setPermissionMode(e.target.value)}
            >
              {TOOL_ACCESS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(`agent.toolsAccessOptions.${o.i18nKey}` as DictKey)}
                </option>
              ))}
            </select>
            <p className="ae-helper">{t("agent.toolsAccessHelper")}</p>
          </div>

          {/* 第 3 行：系统提示词 textarea（参考图大输入框） */}
          <div className="ae-field">
            <label htmlFor="ae-prompt">{t("agent.prompt")}</label>
            <textarea
              id="ae-prompt"
              className="ae-textarea-lg"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t("agent.promptPh")}
              rows={5}
            />
          </div>

          {/* 可视化工具选择（用户核心诉求「能选择可使用的工具和skills」）—— 替代 TagInput */}
          <div className="ae-field">
            <label>{t("agent.toolsField")}</label>
            <ChipMultiSelect
              candidates={AGENT_TOOL_CANDIDATES}
              selected={tools}
              onChange={setTools}
            />
            <p className="ae-helper">{t("agent.toolsHint")}</p>
          </div>

          <div className="ae-field">
            <label>{t("agent.skillsField")}</label>
            <ChipMultiSelect
              candidates={AGENT_SKILL_CANDIDATES}
              selected={skills}
              onChange={setSkills}
            />
            <p className="ae-helper">{t("agent.skillsHint")}</p>
          </div>

          <div className="ae-row ae-row-2col ae-row-advanced">
            <div className="ae-field">
              <label>{t("agent.mcpField")}</label>
              <ChipMultiSelect
                candidates={AGENT_MCP_CANDIDATES}
                selected={mcp}
                onChange={setMcp}
              />
            </div>
            <div className="ae-field">
              <label>{t("agent.pluginsField")}</label>
              <ChipMultiSelect
                candidates={AGENT_PLUGIN_CANDIDATES}
                selected={plugins}
                onChange={setPlugins}
              />
            </div>
          </div>

          {/* 高级折叠（disallowedTools / provider / permission / isolation / maxTurns 等） */}
          <button
            type="button"
            className="ae-advanced-toggle"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
          >
            <Icons.ChevronRight size={10} className={showAdvanced ? "rot" : ""} />
            {t("agent.advanced")}
          </button>
          {showAdvanced && (
            <div className="ae-advanced-body">
              <div className="ae-field">
                <label htmlFor="ae-provider">{t("agent.provider")}</label>
                <select
                  id="ae-provider"
                  value={provider}
                  onChange={(e) => onProviderChange(e.target.value)}
                >
                  {/* provider 下拉：来自 settings.providers，按用户配置顺序 */}
                  {providerOptions.map((p) => (
                    <option key={p.id} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <p className="ae-helper">{t("agent.providerHint")}</p>
              </div>
              <div className="ae-field">
                <label htmlFor="ae-disallowed">{t("agent.disallowedField")}</label>
                <ChipMultiSelect
                  candidates={AGENT_TOOL_CANDIDATES}
                  selected={disallowedTools}
                  onChange={setDisallowedTools}
                />
                <p className="ae-helper">{t("agent.disallowedHint")}</p>
              </div>
              <div className="ae-row ae-row-2col">
                <div className="ae-field">
                  <label htmlFor="ae-perm">{t("agent.permField")}</label>
                  <select
                    id="ae-perm"
                    value={permissionMode}
                    onChange={(e) => setPermissionMode(e.target.value)}
                  >
                    {PERMISSION_MODES.map((m) => (
                      <option key={m} value={m}>
                        {PERM_MODE_LABEL_KEY[m]}
                      </option>
                    ))}
                  </select>
                  <p className="ae-helper">{permissionModeHint(t, permissionMode)}</p>
                </div>
                <div className="ae-field">
                  <label htmlFor="ae-iso">{t("agent.isoField")}</label>
                  <select
                    id="ae-iso"
                    value={isolation}
                    onChange={(e) => setIsolation(e.target.value)}
                  >
                    {ISOLATIONS.map((i) => (
                      <option key={i} value={i}>
                        {i}
                      </option>
                    ))}
                  </select>
                  <p className="ae-helper">{isolationHint(t, isolation)}</p>
                </div>
              </div>
              <div className="ae-field">
                <label htmlFor="ae-turns">{t("agent.turnsField")}</label>
                <input
                  id="ae-turns"
                  type="number"
                  min={0}
                  value={maxTurns}
                  onChange={(e) =>
                    setMaxTurns(Math.max(0, parseInt(e.target.value || "0", 10) || 0))
                  }
                />
                <p className="ae-helper">{t("agent.turnsHint")}</p>
              </div>
              <div className="ae-field">
                <label>{t("agent.capsField")}</label>
                <ChipMultiSelect
                  candidates={AGENT_SKILL_CANDIDATES}
                  selected={capabilities}
                  onChange={setCapabilities}
                />
                <p className="ae-helper">{t("agent.capsHint")}</p>
              </div>
            </div>
          )}
        </section>

        {error && <div className="ae-error" role="alert">{error}</div>}

        <div className="ae-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={saving}
          >
            {t("common.cancel")}
          </button>
          <button
            className="btn btn-primary"
            disabled={!canSave || saving}
            onClick={() => void save()}
          >
            {saving ? t("agent.saving") : t("agent.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
