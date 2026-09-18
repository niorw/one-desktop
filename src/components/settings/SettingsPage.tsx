import { useState, useMemo, useEffect } from "react";
import type { ReactNode } from "react";
import type { Theme } from "../../hooks/useTheme";
import { DEFAULT_TOKEN_CONFIG } from "../../hooks/useSettings";
import { useI18n } from "../../i18n/I18nProvider";
import { SegmentedControl, Toggle } from "../common/Controls";
import type { DictKey } from "../../i18n/dict";
import { Icons } from "../common/Icons";
import { ExtensibilityPage } from "../extensibility/ExtensibilityPage";
import { PermissionsPanel } from "./PermissionsPanel";
import { MemoryPane } from "./MemoryPane";
import { useDialogA11y } from "../common/useDialogA11y";
import { ModelProvidersPanel } from "./ModelProvidersPanel";
import * as tauri from "../../services/tauri";
import type {
  Settings,
  EmailConfig,
  EmailServerConfig,
  EmailEncryption,
  ThinkDensity,
  ThinkMode,
  ProviderId,
  ReasoningDialect,
  TokenConfig,
} from "../../types";
import { EMPTY_EMAIL_CONFIG } from "../../types";
import {
  applyGlassEffect,
  loadGlassLevel,
  saveGlassLevel,
  GLASS_LEVELS,
  DEFAULT_GLASS_LEVEL,
  type GlassLevel,
} from "../../services/glass";
import {
  loadUserProfile,
  saveUserProfile,
  renderProfileMarkdown,
  EMPTY_USER_PROFILE,
  TONE_TAGS,
  type UserProfile,
  type ToneTag,
  type ReplyLanguage,
} from "../../services/userProfile";
import { friendlyError } from "../../services/errors";

type SettingsTab =
  | "general"
  | "personalization"
  | "model"
  | "email"
  | "skill"
  | "agent"
  | "mcp"
  | "command"
  | "hook"
  | "index"
  | "stats"
  | "memory"
  | "permissions";

interface SettingsPageProps {
  isOpen: boolean;
  onClose: () => void;
  settings: Settings;
  onSave: (settings: Settings) => void;
  theme: Theme;
  onSetTheme: (t: Theme) => void;
  /** 打开时直接定位到的标签页（如从输入框「管理模型」进入应跳到 model）。 */
  initialTab?: SettingsTab;
}


const TAB_SECTIONS: {
  sectionKey: DictKey;
  tabs: { id: SettingsTab; labelKey: DictKey; icon: ReactNode }[];
}[] = [
  {
    sectionKey: "settings.section.basic",
    tabs: [
      { id: "personalization", labelKey: "settings.personalization", icon: <Icons.Sparkles /> },
      { id: "memory", labelKey: "settings.memory", icon: <Icons.Bookmark /> },
      { id: "general", labelKey: "settings.general", icon: <Icons.Sliders /> },
      { id: "email", labelKey: "settings.email", icon: <Icons.Mail /> },
      { id: "model", labelKey: "settings.model", icon: <Icons.Brain /> },
    ],
  },
  {
    sectionKey: "settings.section.agent",
    tabs: [
      { id: "skill", labelKey: "settings.skill", icon: <Icons.Wrench /> },
      { id: "agent", labelKey: "settings.agent", icon: <Icons.Users /> },
      { id: "mcp", labelKey: "settings.mcp", icon: <Icons.Plug /> },
      { id: "permissions", labelKey: "settings.permissions.title", icon: <Icons.Shield /> },
      { id: "command", labelKey: "settings.command", icon: <Icons.Terminal /> },
      { id: "hook", labelKey: "settings.hook", icon: <Icons.Hook /> },
    ],
  },
  {
    sectionKey: "settings.section.data",
    tabs: [
      { id: "index", labelKey: "settings.index", icon: <Icons.Database /> },
      { id: "stats", labelKey: "settings.stats", icon: <Icons.BarChart /> },
    ],
  },
];

const MANAGEMENT_TABS = new Set<SettingsTab>(["mcp", "skill", "agent"]);


export function SettingsPage({ isOpen, onClose, settings, onSave, theme, onSetTheme, initialTab = "general" }: SettingsPageProps) {
  const { t, locale, setLocale } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  // 每次打开时定位到指定标签页（管理模型 → model 等），关闭再开也可重新定位。
  useEffect(() => {
    if (isOpen) setActiveTab(initialTab);
  }, [isOpen, initialTab]);

  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [provider, setProvider] = useState<string>(settings.provider);
  const [model, setModel] = useState(settings.model);
  const [preamble, setPreamble] = useState(settings.preamble);
  const [temperature, setTemperature] = useState(settings.temperature ?? 0.7);
  const [maxTokens, setMaxTokens] = useState(settings.maxTokens ?? 0);
  const [maxIterations, setMaxIterations] = useState(settings.maxIterations ?? 20);
  const [thinkingDensity, setThinkingDensity] = useState<ThinkDensity>(settings.thinkingDensity || "collapsed");
  const [thinkingMode, setThinkingMode] = useState<ThinkMode>(settings.thinkingMode || "default");
  const [customBaseUrl, setCustomBaseUrl] = useState(settings.customBaseUrl || "");
  const [reasoningDialect, setReasoningDialect] = useState<ReasoningDialect>(
    settings.reasoningDialect || "deepseek",
  );
  const [tokenConfig, setTokenConfig] = useState<TokenConfig>(
    settings.tokenConfig || DEFAULT_TOKEN_CONFIG,
  );
  const [filesPath, setFilesPath] = useState("~/OneDesktop");
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const [keepAwake, setKeepAwake] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceLang, setVoiceLang] = useState("zh-CN");

  // 崩溃遗留自动清理（§7）：保留期设置 independent of 模型/长任务档位，独立落键。
  const [crashClean, setCrashClean] = useState(true);
  const [retentionDays, setRetentionDays] = useState(14);

  // 个人邮件配置（IMAP/SMTP），以 JSON 存于本地设置 `email_config`，与模型设置解耦。
  const [emailCfg, setEmailCfg] = useState<EmailConfig>(EMPTY_EMAIL_CONFIG);
  const [emailSaved, setEmailSaved] = useState(false);

  // 毛玻璃强度：从本地设置 `glass_effect` 读取，改动即时应用到全局 CSS 变量。
  const [glassLevel, setGlassLevel] = useState<GlassLevel>(DEFAULT_GLASS_LEVEL);

  // 用户画像（个性化）：结构化字段存设置，渲染结果写 USER.md 供模型读取。
  const [profile, setProfile] = useState<UserProfile>(EMPTY_USER_PROFILE);
  const [profileSaved, setProfileSaved] = useState(false);
  const profilePreview = useMemo(() => renderProfileMarkdown(profile), [profile]);

  const patchProfile = (patch: Partial<UserProfile>) => {
    setProfile((p) => ({ ...p, ...patch }));
    setProfileSaved(false);
  };

  const toggleTone = (tag: ToneTag) =>
    setProfile((p) => {
      setProfileSaved(false);
      return {
        ...p,
        tone: p.tone.includes(tag) ? p.tone.filter((x) => x !== tag) : [...p.tone, tag],
      };
    });

  const handleSaveProfile = async () => {
    try {
      await saveUserProfile(profile);
      setProfileSaved(true);
      window.setTimeout(() => setProfileSaved(false), 2500);
    } catch (err) {
      console.error("[Settings] failed to save user profile:", err);
    }
  };

  const patchImap = (patch: Partial<EmailServerConfig>) =>
    setEmailCfg((c) => ({ ...c, imap: { ...c.imap, ...patch } }));
  const patchSmtp = (patch: Partial<EmailServerConfig>) =>
    setEmailCfg((c) => ({ ...c, smtp: { ...c.smtp, ...patch } }));

  const handleSaveEmail = async () => {
    try {
      await tauri.setSetting("email_config", JSON.stringify(emailCfg));
      setEmailSaved(true);
      window.setTimeout(() => setEmailSaved(false), 2500);
    } catch (err) {
      console.error("[Settings] failed to save email config:", err);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setApiKey(settings.apiKey);
    setProvider(settings.provider);
    setModel(settings.model);
    setPreamble(settings.preamble);
    setTemperature(settings.temperature ?? 0.7);
    setMaxTokens(settings.maxTokens ?? 0);
    setMaxIterations(settings.maxIterations ?? 20);
    setThinkingDensity(settings.thinkingDensity || "collapsed");
    setThinkingMode(settings.thinkingMode || "default");
    setCustomBaseUrl(settings.customBaseUrl || "");
    setReasoningDialect(settings.reasoningDialect || "deepseek");
    setTokenConfig(settings.tokenConfig || DEFAULT_TOKEN_CONFIG);
  }, [settings, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    tauri
      .getSetting("email_config")
      .then((raw) => {
        try {
          const parsed = JSON.parse(raw) as EmailConfig;
          setEmailCfg({
            ...EMPTY_EMAIL_CONFIG,
            ...parsed,
            imap: { ...EMPTY_EMAIL_CONFIG.imap, ...parsed.imap },
            smtp: { ...EMPTY_EMAIL_CONFIG.smtp, ...parsed.smtp },
          });
        } catch {
          setEmailCfg(EMPTY_EMAIL_CONFIG);
        }
      })
      .catch(() => setEmailCfg(EMPTY_EMAIL_CONFIG));
    loadGlassLevel().then(setGlassLevel);
    loadUserProfile().then(setProfile);
    // 崩溃遗留自动清理设置。
    tauri.getSetting("interrupted_auto_clean").then((v) => setCrashClean(v !== "0" && v !== "off")).catch(() => setCrashClean(true));
    tauri.getSetting("interrupted_retention_days").then((v) => setRetentionDays(parseInt(v) || 14)).catch(() => setRetentionDays(14));
  }, [isOpen]);

  const handleCrashCleanChange = async (v: boolean) => {
    setCrashClean(v);
    try {
      await tauri.setSetting("interrupted_auto_clean", v ? "1" : "0");
    } catch (err) {
      console.error("[Settings] failed to save crash-clean setting:", err);
    }
  };

  const handleRetentionChange = async (v: number) => {
    setRetentionDays(v);
    try {
      await tauri.setSetting("interrupted_retention_days", String(v));
    } catch (err) {
      console.error("[Settings] failed to save retention setting:", err);
    }
  };

  const handleGlassChange = (lvl: GlassLevel) => {
    setGlassLevel(lvl);
    applyGlassEffect(lvl); // live preview
    void saveGlassLevel(lvl);
  };

  const handleSave = () => {
      onSave({
        ...settings,
        apiKey,
        provider: provider as ProviderId,
        model,
        preamble,
        temperature,
        maxTokens,
        maxIterations,
        thinkingDensity,
        thinkingMode,
        customBaseUrl,
        reasoningDialect,
        tokenConfig,
      });
    onClose();
  };

  const dialogRef = useDialogA11y<HTMLDivElement>(isOpen, onClose);

  if (!isOpen) return null;

  return (
    <div className="settings-page" onClick={onClose}>
      <div
        className="settings-modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="settings-sidebar">
          <div className="settings-sidebar-header" data-tauri-drag-region>
            <h1>{t("settings.title")}</h1>
          </div>
          <nav className="settings-nav" aria-label={t("settings.title")}>
            {TAB_SECTIONS.map((section) => (
              <div key={section.sectionKey} className="settings-nav-group">
                <div className="settings-nav-section">{t(section.sectionKey)}</div>
                {section.tabs.map((tab) => (
                  <button
                    key={tab.id}
                    className={`settings-nav-item ${activeTab === tab.id ? "active" : ""}`}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    <span className="settings-nav-icon">{tab.icon}</span>
                    <span className="settings-nav-label">{t(tab.labelKey)}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </aside>

        <main className="settings-main">
          <button
            className="settings-close-btn"
            onClick={onClose}
            aria-label={t("settings.close")}
            title={t("settings.close")}
          >
            ×
          </button>

          {activeTab === "general" && (
            <>
              <div className="settings-main-header">
                <h2>{t("settings.general")}</h2>
                <p className="settings-main-subtitle">{t("settings.general.subtitle")}</p>
              </div>
              <div className="settings-cards">
                {/* 外观三项（语言/主题/毛玻璃）都是「一次选一个」的短枚举，
                    合并成一张卡的紧凑行（标签在左、分段控件在右），对齐 macOS
                    系统设置的密度；「个性化」留给要喂给模型的用户画像。 */}
                <SettingsCard
                  title={t("settings.appearance")}
                  description={t("settings.appearance.desc")}
                >
                  <div className="settings-field-row">
                    <span className="settings-field-label" id="settings-lang-label">
                      {t("lang.title")}
                    </span>
                    <SegmentedControl
                      ariaLabelledBy="settings-lang-label"
                      value={locale}
                      onChange={(v) => setLocale(v as "zh" | "en")}
                      options={[
                        { value: "zh", label: t("lang.zh") },
                        { value: "en", label: t("lang.en") },
                      ]}
                    />
                  </div>
                  <div className="settings-field-row">
                    <span className="settings-field-label" id="settings-theme-label">
                      {t("settings.theme")}
                    </span>
                    <SegmentedControl
                      ariaLabelledBy="settings-theme-label"
                      value={theme}
                      onChange={(v) => onSetTheme(v as Theme)}
                      options={[
                        { value: "light", label: t("theme.day"), icon: <Icons.Sun /> },
                        { value: "dark", label: t("theme.night"), icon: <Icons.Moon /> },
                      ]}
                    />
                  </div>
                  <div className="settings-field-row">
                    <span className="settings-field-label" id="settings-glass-label">
                      {t("settings.glass")}
                    </span>
                    <SegmentedControl
                      ariaLabelledBy="settings-glass-label"
                      value={glassLevel}
                      onChange={handleGlassChange}
                      options={GLASS_LEVELS.map((lvl) => ({
                        value: lvl,
                        label: t(`settings.glass.${lvl}` as DictKey),
                      }))}
                    />
                  </div>
                </SettingsCard>

                {/* P1-4：快捷键展示卡 */}
                <SettingsCard title={t("settings.shortcuts")} description={t("settings.shortcuts.desc")}>
                  <div className="shortcut-rows">
                    <div className="shortcut-row">
                      <span className="shortcut-label">{t("settings.shortcuts.command")}</span>
                      <span className="shortcut-keys"><kbd className="kbd">⌘</kbd><kbd className="kbd">K</kbd></span>
                    </div>
                    <div className="shortcut-row">
                      <span className="shortcut-label">{t("settings.shortcuts.sidebar")}</span>
                      <span className="shortcut-keys"><kbd className="kbd">⌘</kbd><kbd className="kbd">B</kbd></span>
                    </div>
                    <div className="shortcut-row">
                      <span className="shortcut-label">{t("settings.shortcuts.send")}</span>
                      <span className="shortcut-keys"><kbd className="kbd">Enter</kbd></span>
                    </div>
                    <div className="shortcut-row">
                      <span className="shortcut-label">{t("settings.shortcuts.newline")}</span>
                      <span className="shortcut-keys"><kbd className="kbd">⇧</kbd><kbd className="kbd">Enter</kbd></span>
                    </div>
                  </div>
                </SettingsCard>

                <SettingsCard title="Files" description="Where generated files are stored.">
                  <div className="settings-path-row">
                    <input
                      type="text"
                      value={filesPath}
                      onChange={(e) => setFilesPath(e.target.value)}
                      className="settings-path-input"
                      readOnly
                      aria-label="Generated files storage path"
                    />
                    <button className="btn btn-secondary" onClick={() => alert("Tauri folder picker placeholder")}>
                      Browse
                    </button>
                  </div>
                </SettingsCard>
                <SettingsCard title="Always-on" description="Keep OneDesktop ready in the background.">
                  <Toggle
                    checked={openAtLogin}
                    onChange={setOpenAtLogin}
                    label="Open at login"
                    description="Launch automatically when you sign in."
                  />
                  <Toggle
                    checked={keepAwake}
                    onChange={setKeepAwake}
                    label="Keep this system awake"
                    description="Prevent idle sleep so scheduled tasks fire on time."
                  />
                </SettingsCard>
                <SettingsCard title={t("settings.general.crashClean")} description={t("settings.general.crashClean.desc")}>
                  <Toggle
                    checked={crashClean}
                    onChange={handleCrashCleanChange}
                    label={t("settings.general.crashClean.toggle")}
                    description={t("settings.general.crashClean.toggleDesc")}
                  />
                  {crashClean && (
                    <div className="settings-field-row">
                      <label className="settings-field-label" htmlFor="crash-retention">
                        {t("settings.general.retention")}
                      </label>
                      <select
                        id="crash-retention"
                        value={String(retentionDays)}
                        onChange={(e) => void handleRetentionChange(parseInt(e.target.value) || 14)}
                        className="settings-select"
                      >
                        <option value="7">7 {t("settings.general.days")}</option>
                        <option value="14">14 {t("settings.general.days")}</option>
                        <option value="30">30 {t("settings.general.days")}</option>
                      </select>
                    </div>
                  )}
                </SettingsCard>
                <SettingsCard title="Voice input" description="Dictate messages instead of typing.">
                  <Toggle
                    checked={voiceEnabled}
                    onChange={setVoiceEnabled}
                    label="Enable voice input"
                    description="Show the microphone button in the input bar."
                  />
                  <div className="settings-field-row">
                    <label className="settings-field-label" htmlFor="set-lang">Language</label>
                    <select
                      id="set-lang"
                      value={voiceLang}
                      onChange={(e) => setVoiceLang(e.target.value)}
                      className="settings-select"
                    >
                      <option value="zh-CN">中文（简体）</option>
                      <option value="en-US">English (US)</option>
                      <option value="ja-JP">日本語</option>
                    </select>
                  </div>
                </SettingsCard>
              </div>

              <div className="settings-footer-actions">
                <button className="btn btn-secondary" onClick={onClose}>
                  {t("settings.cancel")}
                </button>
                <button className="btn btn-primary" onClick={handleSave}>
                  {t("settings.save")}
                </button>
              </div>
            </>
          )}

          {activeTab === "personalization" && (
            <>
              <div className="settings-main-header">
                <h2>{t("settings.personalization")}</h2>
                <p className="settings-main-subtitle">{t("profile.subtitle")}</p>
              </div>
              <div className="settings-cards">
                <SettingsCard title={t("profile.identity")} description={t("profile.identityDesc")}>
                  <div className="settings-field-row">
                    <label className="settings-field-label" htmlFor="profile-nickname">
                      {t("profile.nickname")}
                    </label>
                    <input
                      id="profile-nickname"
                      className="settings-text-input"
                      value={profile.nickname}
                      onChange={(e) => patchProfile({ nickname: e.target.value })}
                      placeholder={t("profile.nicknamePlaceholder")}
                    />
                  </div>
                  <div className="settings-field-row">
                    <label className="settings-field-label" htmlFor="profile-role">
                      {t("profile.role")}
                    </label>
                    <input
                      id="profile-role"
                      className="settings-text-input"
                      value={profile.role}
                      onChange={(e) => patchProfile({ role: e.target.value })}
                      placeholder={t("profile.rolePlaceholder")}
                    />
                  </div>
                  <div className="settings-field-row">
                    <label className="settings-field-label" htmlFor="profile-location">
                      {t("profile.location")}
                    </label>
                    <input
                      id="profile-location"
                      className="settings-text-input"
                      value={profile.location}
                      onChange={(e) => patchProfile({ location: e.target.value })}
                      placeholder={t("profile.locationPlaceholder")}
                    />
                  </div>
                </SettingsCard>

                <SettingsCard title={t("profile.expertise")} description={t("profile.expertiseDesc")}>
                  <input
                    className="settings-text-input"
                    value={profile.expertise}
                    onChange={(e) => patchProfile({ expertise: e.target.value })}
                    placeholder={t("profile.expertisePlaceholder")}
                    aria-label={t("profile.expertise")}
                  />
                </SettingsCard>

                <SettingsCard title={t("profile.comm")} description={t("profile.commDesc")}>
                  <div className="settings-field-row">
                    <label className="settings-field-label">{t("profile.replyLang")}</label>
                    <SegmentedControl
                      value={profile.replyLanguage}
                      onChange={(v) => patchProfile({ replyLanguage: v as ReplyLanguage })}
                      options={[
                        { value: "auto", label: t("profile.replyLang.auto") },
                        { value: "zh", label: t("profile.replyLang.zh") },
                        { value: "en", label: t("profile.replyLang.en") },
                      ]}
                    />
                  </div>
                  <div className="profile-tone-block">
                    <span className="settings-field-label">{t("profile.tone")}</span>
                    <p className="field-hint">{t("profile.toneDesc")}</p>
                    <div className="profile-chips" role="group" aria-label={t("profile.tone")}>
                      {TONE_TAGS.map((tag) => {
                        const active = profile.tone.includes(tag);
                        return (
                          <button
                            key={tag}
                            type="button"
                            className={`profile-chip ${active ? "active" : ""}`}
                            aria-pressed={active}
                            onClick={() => toggleTone(tag)}
                          >
                            {t(`profile.tone.${tag}` as DictKey)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </SettingsCard>

                <SettingsCard title={t("profile.custom")} description={t("profile.customDesc")}>
                  <textarea
                    className="settings-textarea"
                    rows={4}
                    value={profile.custom}
                    onChange={(e) => patchProfile({ custom: e.target.value })}
                    placeholder={t("profile.customPlaceholder")}
                    aria-label={t("profile.custom")}
                  />
                </SettingsCard>

                {/* 透明性：让用户看见「到底给模型喂了什么」，而不是黑箱写入。 */}
                <SettingsCard title={t("profile.preview")} description={t("profile.previewDesc")}>
                  {profilePreview ? (
                    <pre className="profile-preview">{profilePreview}</pre>
                  ) : (
                    <p className="field-hint">{t("profile.previewEmpty")}</p>
                  )}
                </SettingsCard>
              </div>

              <div className="settings-footer-actions">
                <button className="btn btn-secondary" onClick={() => setProfile(EMPTY_USER_PROFILE)}>
                  {t("profile.clear")}
                </button>
                <button className="btn btn-primary" onClick={handleSaveProfile}>
                  {t("settings.save")}
                </button>
                {profileSaved && <span className="settings-saved-hint">{t("profile.saved")}</span>}
              </div>
            </>
          )}

          {activeTab === "model" && (
            <ModelProvidersPanel settings={settings} onSave={onSave} />
          )}

          {activeTab === "email" && (
            <>
              <div className="settings-main-header">
                <h2>{t("settings.email")}</h2>
                <p className="settings-main-subtitle">{t("settings.email.subtitle")}</p>
              </div>
              <div className="settings-cards">
                <SettingsCard title={t("settings.email.account")} description={t("settings.email.accountDesc")}>
                  <div className="settings-field-row">
                    <label className="settings-field-label" htmlFor="email-display">{t("settings.email.displayName")}</label>
                    <input
                      id="email-display"
                      className="settings-text-input"
                      value={emailCfg.displayName}
                      onChange={(e) => setEmailCfg((c) => ({ ...c, displayName: e.target.value }))}
                      placeholder="张三"
                    />
                  </div>
                  <div className="settings-field-row">
                    <label className="settings-field-label" htmlFor="email-address">{t("settings.email.address")}</label>
                    <input
                      id="email-address"
                      type="email"
                      className="settings-text-input"
                      value={emailCfg.address}
                      onChange={(e) => setEmailCfg((c) => ({ ...c, address: e.target.value }))}
                      placeholder="you@example.com"
                    />
                  </div>
                </SettingsCard>

                <EmailServerCard
                  title={t("settings.email.imap")}
                  description={t("settings.email.imapDesc")}
                  cfg={emailCfg.imap}
                  onChange={patchImap}
                  t={t}
                />
                <EmailServerCard
                  title={t("settings.email.smtp")}
                  description={t("settings.email.smtpDesc")}
                  cfg={emailCfg.smtp}
                  onChange={patchSmtp}
                  t={t}
                />
              </div>

              <div className="settings-footer-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setEmailCfg(EMPTY_EMAIL_CONFIG);
                    setEmailSaved(false);
                  }}
                >
                  {t("settings.email.clear")}
                </button>
                <button className="btn btn-primary" onClick={handleSaveEmail}>
                  {t("settings.save")}
                </button>
                {emailSaved && <span className="settings-saved-hint">{t("settings.email.saved")}</span>}
              </div>
            </>
          )}

          {activeTab === "permissions" && <PermissionsPanel />}

          {activeTab === "command" && (
            <PlaceholderPane
              title={t("settings.command")}
              subtitle="自定义斜杠命令与快捷指令。"
              description="该模块开发中，后续将支持注册、编辑与禁用命令。"
            />
          )}

          {activeTab === "hook" && (
            <PlaceholderPane
              title={t("settings.hook")}
              subtitle="配置事件钩子与外部触发器。"
              description="该模块开发中，后续将支持文件、邮件、日程等事件钩子。"
            />
          )}

          {activeTab === "index" && (
            <PlaceholderPane
              title={t("settings.index")}
              subtitle="管理本地知识库与索引。"
              description="该模块开发中，后续将支持文档索引、向量库与检索策略。"
            />
          )}

          {activeTab === "stats" && (
            <PlaceholderPane
              title={t("settings.stats")}
              subtitle="查看使用统计与资源消耗。"
              description="该模块开发中，后续将展示 Token、调用次数与任务统计。"
            />
          )}

          {activeTab === "memory" && <MemoryPane />}

          {MANAGEMENT_TABS.has(activeTab) && (
            <div className="settings-management-pane">
              <ExtensibilityPage
                kind={activeTab as "mcp" | "skill" | "plugin" | "agent"}
                providers={settings.providers ?? []}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function PlaceholderPane({
  title,
  subtitle,
  description,
}: {
  title: string;
  subtitle: string;
  description: string;
}) {
  return (
    <>
      <div className="settings-main-header">
        <h2>{title}</h2>
        <p className="settings-main-subtitle">{subtitle}</p>
      </div>
      <div className="settings-cards">
        <section className="settings-card">
          <div className="settings-card-body">
            <p className="field-hint">{description}</p>
          </div>
        </section>
      </div>
    </>
  );
}

function SettingsCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="settings-card">
      <div className="settings-card-header">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

function EmailServerCard({
  title,
  description,
  cfg,
  onChange,
  t,
}: {
  title: string;
  description: string;
  cfg: EmailServerConfig;
  onChange: (patch: Partial<EmailServerConfig>) => void;
  t: (key: DictKey) => string;
}) {
  return (
    <SettingsCard title={title} description={description}>
      <div className="settings-field-row">
        <label className="settings-field-label" htmlFor={`${title}-host`}>
          {t("settings.email.host")}
        </label>
        <input
          id={`${title}-host`}
          className="settings-text-input"
          value={cfg.host}
          onChange={(e) => onChange({ host: e.target.value })}
          placeholder="imap.example.com"
        />
      </div>
      <div className="settings-field-row">
        <label className="settings-field-label" htmlFor={`${title}-port`}>
          {t("settings.email.port")}
        </label>
        <input
          id={`${title}-port`}
          type="number"
          className="settings-number-input"
          value={cfg.port}
          onChange={(e) => onChange({ port: parseInt(e.target.value, 10) || 0 })}
        />
      </div>
      <div className="settings-field-row">
        <label className="settings-field-label" htmlFor={`${title}-enc`}>
          {t("settings.email.encryption")}
        </label>
        <select
          id={`${title}-enc`}
          className="settings-select"
          value={cfg.encryption}
          onChange={(e) => onChange({ encryption: e.target.value as EmailEncryption })}
        >
          <option value="none">{t("settings.email.enc.none")}</option>
          <option value="ssl">{t("settings.email.enc.ssl")}</option>
          <option value="starttls">{t("settings.email.enc.starttls")}</option>
        </select>
      </div>
      <div className="settings-field-row">
        <label className="settings-field-label" htmlFor={`${title}-user`}>
          {t("settings.email.username")}
        </label>
        <input
          id={`${title}-user`}
          className="settings-text-input"
          value={cfg.username}
          onChange={(e) => onChange({ username: e.target.value })}
          placeholder="you@example.com"
        />
      </div>
      <div className="settings-field-row">
        <label className="settings-field-label" htmlFor={`${title}-pass`}>
          {t("settings.email.password")}
        </label>
        <input
          id={`${title}-pass`}
          type="password"
          className="settings-text-input"
          value={cfg.password}
          onChange={(e) => onChange({ password: e.target.value })}
          placeholder="••••••••"
          autoComplete="new-password"
        />
      </div>
    </SettingsCard>
  );
}
