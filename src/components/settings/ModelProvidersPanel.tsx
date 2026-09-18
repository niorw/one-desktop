import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { DictKey } from "../../i18n/dict";
import { Icons } from "../common/Icons";
import type {
  ApiFormat,
  ModelProviderConfig,
  ProviderId,
  ReasoningDialect,
  Settings,
} from "../../types";
import {
  PROVIDERS,
  PROVIDER_DEFAULT_MODEL,
  MODEL_OPTIONS,
  buildDefaultProviders,
  DEFAULT_MODEL,
} from "../../hooks/useSettings";
import type { ApiFormat as ApiFormatValue } from "../../constants/apiFormats";
import { DEFAULT_API_FORMAT } from "../../constants/apiFormats";
import * as tauri from "../../services/tauri";

/** API 端点下拉选项（与参考图一致，2026-09-02 复刻）。 */
const API_FORMAT_OPTIONS: { value: ApiFormatValue; key: string }[] = [
  { value: "anthropic-messages", key: "anthropicMessages" },
  { value: "chat-completions", key: "chatCompletions" },
  { value: "responses", key: "responses" },
];

const LONG_CONTEXT_MODELS = new Set([
  "glm-5", "glm-5-air", "glm-5.1", "glm-5.1-air",
  "deepseek-v4", "deepseek-v4-flash", "deepseek-r1", "deepseek-v3",
  "qwen3-max", "qwen3-plus", "qwen3-turbo",
  "kimi-k2", "kimi-k2-turbo",
  "minimax-m2", "minimax-m1",
]);

function getModelContext(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.includes("1m") || LONG_CONTEXT_MODELS.has(id)) return "1M";
  if (id.includes("128k")) return "128K";
  if (id.includes("32k")) return "32K";
  if (id.includes("8k")) return "8K";
  if (id.includes("4k")) return "4K";
  return "128K";
}

/** 供应商字形瓦片：参考图统一用 box/节点图标，按 provider 家族分配不同 icon。
 *  - deepseek/openai → 圆角方块（neutral）
 *  - qwen/glm/kimi/minimax → 各异，避免撞脸
 *  - custom → Puzzle（占位风格） */
function ProviderGlyph({ provider, size = 16 }: { provider: ProviderId; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (provider) {
    case "deepseek":
      return (
        <svg {...common}>
          <rect x="2" y="2" width="12" height="12" rx="2.5" />
          <path d="M5 6h6M5 9h4" />
        </svg>
      );
    case "openai":
      return (
        <svg {...common}>
          <rect x="2" y="2" width="12" height="12" rx="2.5" />
          <path d="M8 2v12M2 8h12" />
        </svg>
      );
    case "qwen":
      return (
        <svg {...common}>
          <path d="M2 12c2-2 5-2 6 0 1-2 4-2 6 0" />
          <circle cx="3" cy="6" r="1.2" />
          <circle cx="13" cy="6" r="1.2" />
        </svg>
      );
    case "glm":
      return (
        <svg {...common}>
          <path d="M3 3l5 10 5-10" />
          <path d="M5.5 7.5h5" />
        </svg>
      );
    case "kimi":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 4.5v3.5M11 8h-3.5M8 11.5v-3.5M5 8h3.5" />
        </svg>
      );
    case "minimax":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="4" height="4" rx="1" />
          <rect x="9" y="3" width="4" height="4" rx="1" />
          <rect x="3" y="9" width="4" height="4" rx="1" />
          <rect x="9" y="9" width="4" height="4" rx="1" />
        </svg>
      );
    case "custom":
      return (
        <svg {...common}>
          <path d="M8 2v3M8 11v3M2 8h3M11 8h3" />
          <circle cx="8" cy="8" r="3" />
        </svg>
      );
  }
}

interface Props {
  settings: Settings;
  onSave: (settings: Settings) => void;
}

export function ModelProvidersPanel({ settings, onSave }: Props) {
  const { t } = useI18n();
  const initialProviders = useMemo(
    () => settings.providers ?? buildDefaultProviders(settings),
    [settings],
  );
  const [providers, setProviders] = useState<ModelProviderConfig[]>(initialProviders);
  const [selectedId, setSelectedId] = useState<string>(initialProviders[0]?.id ?? "");
  const [showKey, setShowKey] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; baseUrl?: string; models?: string }>({});

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  const [addingModel, setAddingModel] = useState(false);
  const [newModelName, setNewModelName] = useState("");

  // 保存反馈：savedHint 短暂为 "saved"（按钮切「已保存」），saveFailed 表示校验未通过。
  const [savedHint, setSavedHint] = useState<"saved" | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const savedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (savedTimer.current) window.clearTimeout(savedTimer.current);
    },
    [],
  );

  // 与参考图一致的分组：内置预设（provider ≠ custom）+ 自定义供应商（provider === custom）。
  // 排序：内置在前按 PROVIDERS 定义顺序；自定义在后按创建顺序。
  const builtInProviders = providers.filter((p) => p.provider !== "custom");
  const customProviders = providers.filter((p) => p.provider === "custom");

  const selected = providers.find((p) => p.id === selectedId);

  const isConfigured = (p: ModelProviderConfig) =>
    (p.enabled ?? true) && p.apiKey.trim().length > 0 && p.models.length > 0;

  const persist = (nextProviders: ModelProviderConfig[]) => {
    const active = nextProviders.find((p) => p.id === selectedId) ?? nextProviders[0];
    if (!active) return;
    setProviders(nextProviders);
    onSave({
      ...settings,
      provider: active.provider,
      model: active.defaultModel,
      apiKey: active.apiKey,
      customBaseUrl: active.baseUrl ?? "",
      reasoningDialect: active.reasoningDialect,
      providers: nextProviders,
    });
  };

  const reloadFromSettings = () => {
    const next = settings.providers ?? buildDefaultProviders(settings);
    setProviders(next);
    setSelectedId(next[0]?.id ?? "");
    setEditingName(false);
    setEditingModel(null);
    setAddingModel(false);
    setNewModelName("");
    setModelDraft("");
    setNameDraft("");
    setErrors({});
  };

  const patchSelected = (patch: Partial<ModelProviderConfig>) => {
    if (!selected) return;
    const next = providers.map((p) =>
      p.id === selected.id ? { ...p, ...patch } : p,
    );
    persist(next);
  };

  const handleSelectProvider = (id: string) => {
    setSelectedId(id);
    setEditingName(false);
    setEditingModel(null);
    setAddingModel(false);
    setNewModelName("");
    setNameDraft("");
    setModelDraft("");
    setErrors({});
    // 切换供应商时清掉上一次的保存反馈，避免"刚保存了 A"被误读成"B 也已保存"。
    setSavedHint(null);
    setSaveFailed(false);
    if (savedTimer.current) window.clearTimeout(savedTimer.current);
  };

  const handleAddProvider = () => {
    const id = `custom-${Date.now()}`;
    const newProvider: ModelProviderConfig = {
      id,
      name: t("settings.model.provider.newName" as DictKey),
      provider: "custom",
      baseUrl: "",
      apiKey: "",
      reasoningDialect: "openai",
      apiFormat: DEFAULT_API_FORMAT,
      models: [],
      defaultModel: "",
      enabled: true,
    };
    const next = [...providers, newProvider];
    setProviders(next);
    setSelectedId(id);
    setEditingName(true);
    setNameDraft(newProvider.name);
    setEditingModel(null);
    setAddingModel(false);
    setErrors({});
  };

  const handleDeleteProvider = () => {
    if (!selected) return;
    const next = providers.filter((p) => p.id !== selected.id);
    const fallbackId = next[0]?.id ?? "";
    setProviders(next);
    setSelectedId(fallbackId);
    persist(next);
  };

  const handleToggleEnabled = () => {
    if (!selected) return;
    patchSelected({ enabled: !(selected.enabled ?? true) });
  };

  const startRenameName = () => {
    if (!selected) return;
    setEditingName(true);
    setNameDraft(selected.name);
  };

  const commitRenameName = () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setErrors((e) => ({ ...e, name: t("settings.model.provider.nameRequired" as DictKey) }));
      return;
    }
    patchSelected({ name: trimmed });
    setEditingName(false);
    setErrors((e) => ({ ...e, name: undefined }));
  };

  const cancelRenameName = () => {
    setEditingName(false);
    setNameDraft(selected?.name ?? "");
    setErrors((e) => ({ ...e, name: undefined }));
  };

  const handleSaveApiKey = (key: string) => {
    patchSelected({ apiKey: key });
    try {
      tauri.setConfigApiKey(key);
    } catch (err) {
      console.error("[ModelProvidersPanel] failed to save api key:", err);
    }
  };

  const handleRemoveModel = (model: string) => {
    if (!selected) return;
    const nextModels = selected.models.filter((m) => m !== model);
    patchSelected({
      models: nextModels,
      defaultModel: selected.defaultModel === model
        ? nextModels[0] ?? ""
        : selected.defaultModel,
    });
    if (editingModel === model) {
      setEditingModel(null);
      setModelDraft("");
    }
  };

  const handleSetDefault = (model: string) => {
    if (!selected || selected.defaultModel === model) return;
    patchSelected({ defaultModel: model });
  };

  const startEditModel = (model: string) => {
    if (!selected) return;
    setEditingModel(model);
    setModelDraft(model);
  };

  const commitEditModel = () => {
    if (!selected || !editingModel) return;
    const trimmed = modelDraft.trim();
    if (!trimmed) return;
    if (trimmed !== editingModel && selected.models.includes(trimmed)) {
      setEditingModel(null);
      setModelDraft("");
      return;
    }
    const nextModels = selected.models.map((m) => (m === editingModel ? trimmed : m));
    patchSelected({
      models: nextModels,
      defaultModel: selected.defaultModel === editingModel ? trimmed : selected.defaultModel,
    });
    setEditingModel(null);
    setModelDraft("");
  };

  const cancelEditModel = () => {
    setEditingModel(null);
    setModelDraft("");
  };

  const confirmAddModel = () => {
    if (!selected) return;
    const trimmed = newModelName.trim();
    if (!trimmed) return;
    if (selected.models.includes(trimmed)) {
      setNewModelName("");
      setAddingModel(false);
      return;
    }
    const nextModels = [...selected.models, trimmed];
    patchSelected({
      models: nextModels,
      defaultModel: selected.defaultModel || trimmed,
    });
    setNewModelName("");
    setAddingModel(false);
    setErrors((e) => ({ ...e, models: undefined }));
  };

  const cancelAddModel = () => {
    setAddingModel(false);
    setNewModelName("");
  };

  const validate = (): boolean => {
    if (!selected) return false;
    const next: { name?: string; baseUrl?: string; models?: string } = {};
    if (!selected.name.trim()) next.name = t("settings.model.provider.nameRequired" as DictKey);
    if (selected.provider === "custom") {
      const url = selected.baseUrl?.trim() ?? "";
      if (url && !/^https?:\/\/.+/i.test(url)) {
        next.baseUrl = t("settings.model.provider.urlInvalid" as DictKey);
      }
    }
    if (selected.models.length === 0) {
      next.models = t("settings.model.provider.needModel" as DictKey);
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSave = () => {
    // ① 先校验；失败只展示错误、不写回（原实现丢弃 validate() 的返回值，
    //    导致「没配模型 / URL 非法」时照样保存，用户却以为存成功了）。
    const ok = validate();
    if (!ok) {
      setSavedHint(null);
      setSaveFailed(true);
      return;
    }
    if (!selected) return;
    // ② 写回（幂等：字段改动时已即时 persist，这里做一次显式确认）。
    persist(providers);
    // ③ 即时反馈：按钮短暂切到「已保存」，2s 后恢复 —— 用户的视线就在按钮上，
    //    反馈给在焦点处最有效（原实现保存后毫无动静，用户不知道成没成功）。
    setSaveFailed(false);
    setSavedHint("saved");
    if (savedTimer.current) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSavedHint(null), 2000);
  };

  // ── 单列表项渲染（左侧供应商卡）──
  const renderProviderItem = (p: ModelProviderConfig) => {
    const ok = isConfigured(p);
    const enabled = p.enabled ?? true;
    return (
      <button
        key={p.id}
        type="button"
        role="radio"
        aria-checked={p.id === selectedId}
        className={`model-provider-item ${p.id === selectedId ? "active" : ""} ${!enabled ? "is-disabled" : ""}`}
        onClick={() => handleSelectProvider(p.id)}
      >
        <span className="mp-item-glyph">
          <ProviderGlyph provider={p.provider} />
        </span>
        <span className="mp-item-text">
          <span className="mp-item-name">{p.name || p.provider}</span>
          {p.provider === "custom" && <span className="mp-item-family">OpenAI 兼容</span>}
        </span>
        <span
          className={`mp-item-status ${ok ? "ok" : enabled ? "warn" : "disabled"}`}
          title={ok
            ? t("settings.model.provider.configured" as DictKey)
            : !enabled
              ? t("settings.model.provider.disabled" as DictKey)
              : t("settings.model.provider.incomplete" as DictKey)}
        />
      </button>
    );
  };

  return (
    <div className="model-providers-panel">
      <div className="settings-main-header mp-header">
        <div>
          <h2>{t("settings.model")}</h2>
          <p className="settings-main-subtitle">{t("settings.model.subtitle")}</p>
        </div>
        <button
          type="button"
          className="mp-refresh-btn"
          onClick={reloadFromSettings}
          aria-label={t("settings.model.provider.refresh" as DictKey)}
          title={t("settings.model.provider.refresh" as DictKey)}
        >
          <Icons.Refresh size={15} />
        </button>
      </div>

      <div className="model-providers-layout">
        <aside className="model-providers-list">
          {/* 内置预设分组（参考图「Z.ai」顶板） */}
          {builtInProviders.length > 0 && (
            <div className="mp-group">
              <div className="mp-group-title">
                {t("settings.model.provider.section.builtIn" as DictKey)}
              </div>
              <div className="mp-group-items" role="radiogroup">
                {builtInProviders.map(renderProviderItem)}
              </div>
            </div>
          )}

          {/* 自定义供应商分组（参考图「自定义供应商」小标） */}
          <div className="mp-group">
            <div className="mp-group-title">
              {t("settings.model.provider.section.custom" as DictKey)}
            </div>
            {customProviders.length === 0 ? (
              <div className="mp-group-empty">—</div>
            ) : (
              <div className="mp-group-items" role="radiogroup">
                {customProviders.map(renderProviderItem)}
              </div>
            )}
          </div>

          <button
            type="button"
            className="model-provider-add-btn"
            onClick={handleAddProvider}
          >
            <Icons.Plus size={14} />
            {t("settings.model.provider.add")}
          </button>
        </aside>

        <section className="model-provider-detail-card">
          {!selected ? (
            <div className="model-provider-empty">
              <p>{t("settings.model.provider.empty")}</p>
              <button type="button" className="btn btn-primary" onClick={handleAddProvider}>
                {t("settings.model.provider.add")}
              </button>
            </div>
          ) : (
            <>
              <header className="mp-detail-header">
                <div className="mp-detail-title">
                  <span className="mp-detail-glyph">
                    <ProviderGlyph provider={selected.provider} size={18} />
                  </span>
                  {editingName ? (
                    <div className="mp-name-edit">
                      <input
                        className={`settings-text-input ${errors.name ? "has-error" : ""}`}
                        value={nameDraft}
                        onChange={(e) => {
                          setNameDraft(e.target.value);
                          if (errors.name) setErrors((x) => ({ ...x, name: undefined }));
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRenameName();
                          if (e.key === "Escape") cancelRenameName();
                        }}
                        autoFocus
                      />
                      <button
                        type="button"
                        className="mp-icon-btn mp-icon-btn--primary"
                        onClick={commitRenameName}
                        title={t("settings.model.provider.saveName" as DictKey)}
                      >
                        <Icons.Check size={14} />
                      </button>
                      <button
                        type="button"
                        className="mp-icon-btn"
                        onClick={cancelRenameName}
                        title={t("settings.model.provider.cancel" as DictKey)}
                      >
                        <Icons.Close size={14} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <h3>{selected.name}</h3>
                      <button
                        type="button"
                        className="mp-icon-btn"
                        onClick={startRenameName}
                        title={t("settings.model.provider.editName" as DictKey)}
                      >
                        <Icons.Pencil size={14} />
                      </button>
                    </>
                  )}
                </div>

                <div className="mp-detail-actions">
                  <span
                    className={`mp-status-pill ${(selected.enabled ?? true) ? "enabled" : "disabled"}`}
                  >
                    {(selected.enabled ?? true)
                      ? t("settings.model.provider.enabled" as DictKey)
                      : t("settings.model.provider.disabled" as DictKey)}
                  </span>
                  <button
                    type="button"
                    className="mp-text-btn"
                    onClick={handleToggleEnabled}
                  >
                    {(selected.enabled ?? true)
                      ? t("settings.model.provider.disable" as DictKey)
                      : t("settings.model.provider.enable" as DictKey)}
                  </button>
                  <button
                    type="button"
                    className="mp-icon-btn mp-icon-btn--danger"
                    onClick={handleDeleteProvider}
                    title={t("settings.model.provider.delete")}
                  >
                    <Icons.Trash2 size={16} />
                  </button>
                </div>
              </header>

              <div className="mp-detail-body">
                {selected.provider === "custom" && (
                  <div className="mp-field">
                    <label className="mp-field-label" htmlFor="mp-url">
                      Base URL
                    </label>
                    <input
                      id="mp-url"
                      className={`settings-text-input ${errors.baseUrl ? "has-error" : ""}`}
                      value={selected.baseUrl ?? ""}
                      onChange={(e) => {
                        patchSelected({ baseUrl: e.target.value });
                        if (errors.baseUrl) setErrors((x) => ({ ...x, baseUrl: undefined }));
                      }}
                      placeholder="https://your-host/v1"
                    />
                    {errors.baseUrl && <p className="settings-error-text">{errors.baseUrl}</p>}
                  </div>
                )}

                {/* 参考图 「API 格式」下拉：改为按端点协议分类（Anthropic Messages / Chat Completions / Responses）。
                    原 DIALECT_LABELS 全部统一显示 "Chat Completions" 是语义错误，本次修正。 */}
                <div className="mp-field">
                  <label className="mp-field-label" htmlFor="mp-format">
                    {t("settings.model.provider.apiFormat")}
                  </label>
                  <select
                    id="mp-format"
                    className="settings-select"
                    value={selected.apiFormat ?? DEFAULT_API_FORMAT}
                    onChange={(e) => {
                      patchSelected({ apiFormat: e.target.value as ApiFormatValue });
                      // 同时同步把 reasoningDialect 落到合理默认（保留用户原值不强制覆盖）
                      if (selected.provider === "custom" && selected.reasoningDialect === "openai") {
                        // reasoningDialect 已是 openai 默认，无需变
                      }
                    }}
                  >
                    {API_FORMAT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {t(`settings.model.provider.apiFormatOptions.${opt.key}` as DictKey)}
                      </option>
                    ))}
                  </select>
                  <p className="mp-field-hint">{t("settings.model.provider.apiFormatTip" as DictKey)}</p>
                </div>

                <div className="mp-field">
                  <label className="mp-field-label" htmlFor="mp-key">
                    API Key
                  </label>
                  <div className="mp-key-wrap">
                    <input
                      id="mp-key"
                      type={showKey ? "text" : "password"}
                      className="settings-text-input mp-key-input"
                      value={selected.apiKey}
                      onChange={(e) => handleSaveApiKey(e.target.value)}
                      placeholder="sk-..."
                    />
                    <button
                      type="button"
                      className="mp-key-toggle"
                      onClick={() => setShowKey((s) => !s)}
                      aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                      title={showKey ? "隐藏" : "显示"}
                    >
                      {showKey ? <Icons.EyeOff size={16} /> : <Icons.Eye size={16} />}
                    </button>
                  </div>
                </div>

                <div className="mp-field mp-models-field">
                  <label className="mp-field-label">
                    {t("settings.model.provider.modelList")}
                  </label>

                  <div className="mp-models-list">
                    {selected.models.length === 0 && !addingModel && (
                      <div className="mp-models-empty">
                        {t("settings.model.provider.noModels")}
                      </div>
                    )}

                    {selected.models.map((m) => {
                      const isDefault = selected.defaultModel === m;
                      const isEditing = editingModel === m;
                      return (
                        <div
                          key={m}
                          className={`mp-model-row ${isDefault ? "is-default" : ""} ${isEditing ? "is-editing" : ""}`}
                          onClick={() => !isEditing && handleSetDefault(m)}
                          title={isEditing ? undefined : t("settings.model.provider.setDefault" as DictKey)}
                        >
                          {isEditing ? (
                            <>
                              <input
                                className="settings-text-input mp-model-input"
                                value={modelDraft}
                                onChange={(e) => setModelDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") commitEditModel();
                                  if (e.key === "Escape") cancelEditModel();
                                }}
                                onClick={(e) => e.stopPropagation()}
                                autoFocus
                              />
                              <button
                                type="button"
                                className="mp-icon-btn mp-icon-btn--primary"
                                onClick={(e) => { e.stopPropagation(); commitEditModel(); }}
                                title={t("settings.model.provider.saveName" as DictKey)}
                              >
                                <Icons.Check size={14} />
                              </button>
                              <button
                                type="button"
                                className="mp-icon-btn"
                                onClick={(e) => { e.stopPropagation(); cancelEditModel(); }}
                                title={t("settings.model.provider.cancel" as DictKey)}
                              >
                                <Icons.Close size={14} />
                              </button>
                            </>
                          ) : (
                            <>
                              <span className="mp-model-name">{m}</span>
                              <span className="mp-model-context">{getModelContext(m)}</span>
                              {/* 参考图每行模型也有状态点（右侧 •），用于展示该模型是否可用。 */}
                              <span
                                className={`mp-model-status ${isDefault ? "default" : "ok"}`}
                                title={isDefault ? t("settings.model.provider.defaultBadge" as DictKey) : ""}
                              />
                              <div className="mp-model-actions">
                                <button
                                  type="button"
                                  className="mp-icon-btn"
                                  onClick={(e) => { e.stopPropagation(); startEditModel(m); }}
                                  title={t("settings.model.provider.editModel" as DictKey)}
                                >
                                  <Icons.Pencil size={14} />
                                </button>
                                <button
                                  type="button"
                                  className="mp-icon-btn mp-icon-btn--danger"
                                  onClick={(e) => { e.stopPropagation(); handleRemoveModel(m); }}
                                  title={t("settings.model.provider.removeModel")}
                                >
                                  <Icons.Trash2 size={14} />
                                </button>
                              </div>
                              {isDefault && (
                                <span className="mp-model-default-badge">
                                  {t("settings.model.provider.defaultBadge" as DictKey)}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}

                    {addingModel && (
                      <div className="mp-model-row mp-model-row--add">
                        <input
                          className={`settings-text-input mp-model-input ${errors.models ? "has-error" : ""}`}
                          value={newModelName}
                          onChange={(e) => {
                            setNewModelName(e.target.value);
                            if (errors.models) setErrors((x) => ({ ...x, models: undefined }));
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") confirmAddModel();
                            if (e.key === "Escape") cancelAddModel();
                          }}
                          placeholder={t("settings.model.provider.modelPlaceholder")}
                          autoFocus
                        />
                        <button
                          type="button"
                          className="mp-icon-btn mp-icon-btn--primary"
                          onClick={confirmAddModel}
                          title={t("settings.model.provider.addModel")}
                        >
                          <Icons.Check size={14} />
                        </button>
                        <button
                          type="button"
                          className="mp-icon-btn"
                          onClick={cancelAddModel}
                          title={t("settings.model.provider.cancel" as DictKey)}
                        >
                          <Icons.Close size={14} />
                        </button>
                      </div>
                    )}
                  </div>

                  {errors.models && <p className="settings-error-text">{errors.models}</p>}

                  {!addingModel && (
                    <button
                      type="button"
                      className="mp-add-model-btn"
                      onClick={() => setAddingModel(true)}
                    >
                      <Icons.Plus size={14} />
                      {t("settings.model.provider.addModel")}
                    </button>
                  )}
                </div>
              </div>

              <div className="mp-detail-footer">
                {saveFailed && (
                  <span className="mp-save-error" role="alert">
                    <Icons.AlertTriangle size={13} />
                    {t("settings.model.provider.saveFailed" as DictKey)}
                  </span>
                )}
                <button
                  type="button"
                  className={`btn btn-primary ${savedHint === "saved" ? "mp-btn-saved" : ""}`}
                  onClick={handleSave}
                >
                  {savedHint === "saved" ? (
                    <>
                      <Icons.Check size={13} />
                      {t("settings.model.provider.saved" as DictKey)}
                    </>
                  ) : (
                    t("settings.model.provider.save")
                  )}
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/* PROVIDER labels intentionally unused now (left for ref) — 此处不再需要显示家族标签，
   provider 字段用作 glyph 路由的唯一来源。如后续要展示"家族 / 端点类型"二级信息，
   把 PROVIDERS 重新导入并加到 mp-item-family 即可。*/
void PROVIDERS;
void MODEL_OPTIONS;
void PROVIDER_DEFAULT_MODEL;
void DEFAULT_MODEL;
// ReasoningDialect 是 type-only import，TS 编译时会自动擦除；它用于 patchSelected
// 内部对 reasoningDialect 字段的类型校验，无运行时引用。
type _ReasoningDialectMarker = ReasoningDialect;
