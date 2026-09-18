import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { DictKey } from "../../i18n/dict";
import { Icons } from "../common/Icons";
import {
  listMcpServers,
  addMcpServer,
  setMcpEnabled,
  deleteMcpServer,
  testMcpConnection,
  listSkills,
  addSkill,
  importSkillLocal,
  importSkillUrl,
  setSkillEnabled,
  deleteSkill,
  getSkillBudget,
  setSkillBudget,
  diagnoseCapabilities,
  listAgentPresets,
  deleteAgentPreset,
  createAgentPreset,
  scanLocalAgents,
  importAgent,
  exportAgent,
} from "../../services/tauri";
import type {
  McpServerDto,
  SkillDto,
  SkillBudgetDto,
  CapabilityDiagnosticDto,
  DiagnosticClass,
  AgentProfile,
  LocalAgentEntry,
  ModelProviderConfig,
} from "../../types";
import "./extensibility.css";
import { AgentEditorModal } from "../agents/AgentEditorModal";
import { useDialogA11y } from "../common/useDialogA11y";
import { friendlyError } from "../../services/errors";

type ExtKind = "mcp" | "skill" | "plugin" | "agent";

// Unified single-color icon per extension kind (no colored emoji).
const KIND_ICON: Record<ExtKind, ReactNode> = {
  mcp: <Icons.Plug />,
  skill: <Icons.Wrench />,
  plugin: <Icons.Puzzle />,
  agent: <Icons.Users />,
};
type ExtSource = "local" | "url" | "mcp" | "builtin";
type ExtStatus = "enabled" | "disabled" | "beta" | "deprecated" | "error";

interface ExtItem {
  id: string;
  name: string;
  description: string;
  version: string;
  source: ExtSource;
  status: ExtStatus;
  enabled?: boolean;
  transport?: string;
  error?: string;
  // kind-specific (optional)
  capabilities?: { tools?: string[]; resources?: string[]; prompts?: string[] };
  permissions?: { network?: boolean; fs?: false | "ro" | "rw"; shell?: boolean; db?: boolean };
  dependencies?: string[];
  // F4：agent 种类携带原始 AgentProfile，供详情抽屉渲染扩展字段与导出。
  agent?: AgentProfile;
}

const STATUS_KEY: Record<ExtStatus, DictKey> = {
  enabled: "ext.enabled",
  disabled: "ext.disabled",
  beta: "ext.beta",
  deprecated: "ext.deprecated",
  error: "ext.error",
};

const SOURCE_LABEL: Record<ExtSource, string> = {
  local: "本地",
  url: "URL",
  mcp: "MCP",
  builtin: "内置",
};

// ── DTO → UI mappers ──

function mcpToExt(s: McpServerDto): ExtItem {
  const status: ExtStatus =
    s.status === "error" ? "error" : !s.enabled ? "disabled" : "enabled";
  const source: ExtSource = s.transport === "stdio" ? "local" : "url";
  return {
    id: s.id,
    name: s.name,
    description:
      s.command
        ? `command: ${s.command} ${s.args.join(" ")}`.trim()
        : (s.url ?? "MCP 服务器"),
    version: "—",
    source,
    status,
    enabled: s.enabled,
    transport: s.transport,
    error: s.error ?? undefined,
    capabilities: {
      tools: s.capabilities.tools,
      resources: s.capabilities.resources,
      prompts: s.capabilities.prompts,
    },
  };
}

function skillToExt(s: SkillDto): ExtItem {
  const source = (["local", "url", "builtin"].includes(s.source)
    ? s.source
    : "builtin") as ExtSource;
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    version: s.version,
    source,
    status: s.status as ExtStatus,
    enabled: s.status !== "disabled",
    dependencies: s.dependencies,
  };
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function agentToExt(s: AgentProfile): ExtItem {
  return {
    id: s.id,
    name: s.name,
    description: truncate(s.system_prompt, 120),
    version: "—",
    source: "builtin",
    status: "enabled",
    enabled: true,
    agent: s,
  };
}

export function ExtensibilityPage({
  kind,
  providers,
}: {
  kind: ExtKind;
  /** R-8：设置页 settings.providers —— 子 Agent 编辑弹窗内模型/provider 下拉的唯一真源。
   *  调用方（SettingsPage）从 settings 派生并透传，禁止 AgentEditorModal 内部硬编码。 */
  providers: ModelProviderConfig[];
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<ExtItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"card" | "list">("card");
  const [statusFilter, setStatusFilter] = useState<"all" | ExtStatus>("all");
  const [detail, setDetail] = useState<ExtItem | null>(null);
  const [importing, setImporting] = useState(false);
  const [agentImporting, setAgentImporting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testState, setTestState] = useState<{ id: string; ok: boolean; msg: string } | null>(null);
  const [capOpen, setCapOpen] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [agentEditor, setAgentEditor] = useState<
    { mode: "create" } | { mode: "edit"; profile: AgentProfile } | null
  >(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      let next: ExtItem[] = [];
      if (kind === "mcp") {
        next = (await listMcpServers()).map(mcpToExt);
      } else if (kind === "skill") {
        next = (await listSkills()).map(skillToExt);
      } else if (kind === "agent") {
        next = (await listAgentPresets()).map(agentToExt);
      }
      setItems(next);
    } catch (e) {
      console.error("load extensibility failed", e);
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (statusFilter !== "all" && it.status !== statusFilter) return false;
      if (q && !`${it.name} ${it.description}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, query, statusFilter]);

  const toggleStatus = async (id: string) => {
    const it = items.find((i) => i.id === id);
    if (!it) return;
    // agent 无启用/禁用概念，跳过（详情抽屉也不渲染该按钮）。
    if (kind === "agent") return;
    try {
      if (kind === "mcp") await setMcpEnabled(id, !it.enabled);
      else if (kind === "skill") await setSkillEnabled(id, !it.enabled);
    } catch (e) {
      console.error("toggle failed", e);
    }
    await reload();
  };

  const remove = async (id: string) => {
    try {
      if (kind === "mcp") await deleteMcpServer(id);
      else if (kind === "skill") await deleteSkill(id);
      else if (kind === "agent") await deleteAgentPreset(id);
    } catch (e) {
      console.error("delete failed", e);
    }
    if (detail?.id === id) setDetail(null);
    await reload();
  };

  const handleExport = async (id: string, redact: boolean) => {
    try {
      const path = await exportAgent(id, "", redact);
      setExportMsg(`${t("ext.exportDone")}：${path}`);
    } catch (e) {
      console.error("export agent failed", e);
      setExportMsg(`${t("ext.exportFailed")}：${friendlyError(e)}`);
    }
  };

  const handleAgentSaved = async (p: AgentProfile) => {
    setAgentEditor(null);
    if (detail?.agent?.id === p.id) setDetail(agentToExt(p));
    await reload();
  };

  const addImported = async (value: string, fromUrl: boolean) => {
    if (kind === "plugin") return; // unsupported
    try {
      if (kind === "mcp") {
        if (fromUrl) {
          await addMcpServer({
            name: value,
            transport: "http",
            command: null,
            args: [],
            env: {},
            url: value,
            enabled: true,
          });
        } else {
          await addMcpServer({
            name: value,
            transport: "stdio",
            command: value,
            args: [],
            env: {},
            url: null,
            enabled: true,
          });
        }
      } else if (kind === "skill") {
        if (fromUrl) await importSkillUrl(value);
        else await importSkillLocal(value);
      }
    } catch (e) {
      console.error("import failed", e);
    }
    setImporting(false);
    await reload();
  };

  const testConnection = async (id: string) => {
    setTestingId(id);
    try {
      const res = await testMcpConnection(id);
      setTestState({
        id,
        ok: res.ok,
        msg: res.error ?? (res.ok ? "连接成功" : "连接失败"),
      });
    } catch (e) {
      setTestState({ id, ok: false, msg: friendlyError(e) });
    } finally {
      setTestingId(null);
      await reload();
    }
  };

  const titleKey: DictKey =
    kind === "mcp" ? "nav.mcp" : kind === "skill" ? "nav.skill" : kind === "plugin" ? "nav.plugin" : "nav.agent";

  const detailTest =
    kind === "mcp" && detail && testState?.id === detail.id ? testState : null;

  return (
    <div className="ext-page">
      <header className="page-header">
        <h1>{t(titleKey)}</h1>
        <p className="page-subtitle">
          {kind === "mcp"
            ? "连接 Model Context Protocol 服务器，扩展 Agent 的工具与资源。"
            : kind === "skill"
            ? "通过导入管理 Skill，页面内不支持创建或开发。"
            : kind === "agent"
            ? "管理 Agent 预设（Worker 种源）。可一键导入本机 ~/.claude/agents 定义，或导出为 Claude Code 兼容格式。"
            : "通过导入管理插件，页面内不支持创建或开发。"}
        </p>
      </header>

      {exportMsg && (
        <div className="ext-banner" onClick={() => setExportMsg(null)}>
          <Icons.Check size={14} /> {exportMsg}
        </div>
      )}

      <div className="ext-toolbar">
        <input
          className="tasks-search"
          placeholder={t("ext.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {kind !== "mcp" && kind !== "plugin" && (
          <select className="tasks-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="all">{t("common.all")}</option>
            <option value="enabled">{t("ext.enabled")}</option>
            <option value="disabled">{t("ext.disabled")}</option>
            <option value="beta">{t("ext.beta")}</option>
            <option value="deprecated">{t("ext.deprecated")}</option>
            <option value="error">{t("ext.error")}</option>
          </select>
        )}
        {kind !== "mcp" && kind !== "plugin" && (
          <div className="seg">
            <button className={view === "card" ? "active" : ""} onClick={() => setView("card")}>▦</button>
            <button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>☰</button>
          </div>
        )}
        {kind === "agent" ? (
          <>
            <button className="btn btn-primary" onClick={() => setAgentEditor({ mode: "create" })}>
              + 新建 Agent
            </button>
            <button className="btn btn-secondary" onClick={() => setAgentImporting(true)}>
              + {t("ext.importLocalAgent")}
            </button>
          </>
        ) : kind !== "plugin" ? (
          <button className="btn btn-primary" onClick={() => setImporting(true)}>
            + {t("ext.import")}
          </button>
        ) : null}
        {kind === "mcp" || kind === "skill" ? (
          <button className="btn btn-secondary" onClick={() => setCapOpen(true)}>
            <Icons.Stethoscope size={13} /> {t("ext.capabilityCheck")}
          </button>
        ) : null}
      </div>

      {loading && filtered.length === 0 ? (
        <div className="tasks-empty">
          <div className="tasks-empty-icon"><Icons.Hourglass size={40} /></div>
          <h2>{t("common.loading")}</h2>
        </div>
      ) : kind === "plugin" ? (
        <div className="tasks-empty">
          <div className="tasks-empty-icon"><Icons.AlertTriangle size={40} /></div>
          <h2>{t("ext.unsupported")}</h2>
        </div>
      ) : filtered.length === 0 ? (
        <div className="tasks-empty">
          <div className="tasks-empty-icon"><Icons.Inbox size={40} /></div>
          <h2>{t("ext.empty")}</h2>
        </div>
      ) : view === "card" ? (
        <div className="ext-grid">
          {filtered.map((it) => (
            <ExtCard key={it.id} item={it} onToggle={toggleStatus} onDelete={remove} onOpen={setDetail} onEdit={(i) => { if (i.agent) setAgentEditor({ mode: "edit", profile: i.agent }); }} t={t} kind={kind} />
          ))}
        </div>
      ) : (
        <div className="ext-rows">
          {filtered.map((it) => (
            <ExtRow key={it.id} item={it} onToggle={toggleStatus} onDelete={remove} onOpen={setDetail} onEdit={(i) => { if (i.agent) setAgentEditor({ mode: "edit", profile: i.agent }); }} t={t} kind={kind} />
          ))}
        </div>
      )}

      {detail && (
        <DetailDrawer
          item={detail}
          kind={kind}
          onClose={() => setDetail(null)}
          onToggle={toggleStatus}
          onDelete={remove}
          onEdit={(p) => setAgentEditor({ mode: "edit", profile: p })}
          onExport={kind === "agent" ? handleExport : undefined}
          onTest={kind === "mcp" ? testConnection : undefined}
          testing={kind === "mcp" && testingId === detail.id}
          testState={detailTest}
          t={t}
        />
      )}

      {importing && (
        <Importer
          kind={kind}
          onCancel={() => setImporting(false)}
          onConfirm={addImported}
          t={t}
        />
      )}

      {agentImporting && (
        <AgentImporter
          onCancel={() => setAgentImporting(false)}
          onImported={async () => {
            setAgentImporting(false);
            await reload();
          }}
          t={t}
        />
      )}

      {agentEditor && (
        <AgentEditorModal
          mode={agentEditor.mode}
          providers={providers}
          profile={agentEditor.mode === "edit" ? agentEditor.profile : undefined}
          onCancel={() => setAgentEditor(null)}
          onSaved={handleAgentSaved}
        />
      )}

      {capOpen && (
        <CapabilityModal onClose={() => setCapOpen(false)} t={t} />
      )}
    </div>
  );
}

function ExtCard({ item, onToggle, onDelete, onOpen, onEdit, t, kind }: { item: ExtItem; onToggle: (id: string) => void; onDelete: (id: string) => void; onOpen: (i: ExtItem) => void; onEdit?: (item: ExtItem) => void; t: (k: DictKey, v?: Record<string, string | number>) => string; kind: ExtKind }) {
  return (
    <div className="ext-card" onClick={() => onOpen(item)}>
      <div className="ext-card-head">
        <span className="ext-icon">{KIND_ICON[kind]}</span>
        <div className="ext-card-title">
          <span className="ext-name">{item.name}</span>
          <span className="ext-ver">v{item.version}</span>
        </div>
        <span className={`ext-status status-${item.status}`}>{t(STATUS_KEY[item.status])}</span>
      </div>
      <p className="ext-desc">{item.description}</p>
      <div className="ext-card-foot" onClick={(e) => e.stopPropagation()}>
        {kind !== "agent" && (
          <label className="mini-toggle">
            <input type="checkbox" checked={item.status !== "disabled"} onChange={() => onToggle(item.id)} />
            <span className="mini-track"><span className="mini-thumb" /></span>
          </label>
        )}
        {kind === "agent" && (
          <button className="btn btn-ghost" onClick={() => onEdit?.(item)}>编辑</button>
        )}
        <button className="btn btn-ghost btn-danger-text" onClick={() => onDelete(item.id)}>{t("ext.delete")}</button>
      </div>
    </div>
  );
}

function ExtRow({ item, onToggle, onDelete, onOpen, onEdit, t, kind }: { item: ExtItem; onToggle: (id: string) => void; onDelete: (id: string) => void; onOpen: (i: ExtItem) => void; onEdit?: (item: ExtItem) => void; t: (k: DictKey, v?: Record<string, string | number>) => string; kind: ExtKind }) {
  return (
    <div className="ext-row" onClick={() => onOpen(item)}>
      <span className="ext-icon">{KIND_ICON[kind]}</span>
      <span className="ext-name">{item.name}</span>
      <span className="ext-desc-row">{item.description}</span>
      <span className={`ext-status status-${item.status}`}>{t(STATUS_KEY[item.status])}</span>
      <span className="ext-src-tag">{SOURCE_LABEL[item.source]}</span>
      <div className="ext-row-actions" onClick={(e) => e.stopPropagation()}>
        {kind !== "agent" && (
          <button className="btn btn-ghost" onClick={() => onToggle(item.id)}>
            {item.status === "disabled" ? t("ext.enable") : t("ext.disable")}
          </button>
        )}
        {kind === "agent" && (
          <button className="btn btn-ghost" onClick={() => onEdit?.(item)}>编辑</button>
        )}
        <button className="btn btn-ghost btn-danger-text" onClick={() => onDelete(item.id)}>{t("ext.delete")}</button>
      </div>
    </div>
  );
}

function DetailDrawer({ item, kind, onClose, onToggle, onDelete, onExport, onTest, onEdit, testing, testState, t }: { item: ExtItem; kind: ExtKind; onClose: () => void; onToggle: (id: string) => void; onDelete: (id: string) => void; onExport?: (id: string, redact: boolean) => void; onTest?: (id: string) => void; onEdit?: (profile: AgentProfile) => void; testing?: boolean; testState?: { ok: boolean; msg: string } | null;   t: (k: DictKey, v?: Record<string, string | number>) => string }) {
  const drawerRef = useDialogA11y<HTMLElement>(true, onClose);
  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside
        className="drawer"
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={item.name}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <div>
            <h2 className="drawer-title">{KIND_ICON[kind]} {item.name}</h2>
            <span className="ext-ver">v{item.version}</span>
          </div>
          <button className="drawer-close" onClick={onClose}>×</button>
        </div>

        <div className="drawer-body">
          <p className="drawer-desc">{item.description}</p>
          <div className="drawer-kv">
            <span>{t("ext.detail")}</span>
            <span>{SOURCE_LABEL[item.source]}</span>
          </div>

          {item.error && (
            <div className="drawer-error">{item.error}</div>
          )}

          {kind === "mcp" && item.capabilities && (
            <section className="drawer-section">
              <h3>{t("ext.capabilities")}</h3>
              <CapRow icon={<Icons.Wrench />} label={t("ext.tools")} items={item.capabilities.tools} />
              <CapRow icon={<Icons.FileText />} label={t("ext.resources")} items={item.capabilities.resources} />
              <CapRow icon={<Icons.MessageSquare />} label={t("ext.prompts")} items={item.capabilities.prompts} />
              {onTest && (
                <button className="btn btn-secondary full" disabled={testing} onClick={() => onTest(item.id)}>
                  {testing ? t("common.loading") : t("ext.testConnection")}
                </button>
              )}
              {testState && (
                <div className={testState.ok ? "drawer-test ok" : "drawer-test err"}>
                  {testState.ok ? <Icons.Check size={14} /> : <Icons.Cross size={14} />} {testState.msg}
                </div>
              )}
            </section>
          )}

          {kind === "plugin" && item.permissions && (
            <section className="drawer-section">
              <h3>{t("ext.permissions")}</h3>
              <PermRow icon={<Icons.Globe />} label="网络访问" granted={item.permissions.network} />
              <PermRow icon={<Icons.Folder />} label="文件系统" granted={item.permissions.fs !== false} note={item.permissions.fs === "ro" ? "只读" : item.permissions.fs === "rw" ? "读写" : ""} />
              <PermRow icon={<Icons.Terminal />} label="Shell 执行" granted={item.permissions.shell} />
              <PermRow icon={<Icons.Database />} label="数据库" granted={item.permissions.db} />
            </section>
          )}

          {item.dependencies && item.dependencies.length > 0 && (
            <section className="drawer-section">
              <h3>依赖</h3>
              <div className="dep-list">
                {item.dependencies.map((d) => (
                  <span key={d} className="dep-chip">{d}</span>
                ))}
              </div>
            </section>
          )}

          {kind === "skill" && (
            <SkillBudgetSection id={item.id} t={t} />
          )}

          {kind === "agent" && item.agent && (
            <AgentProfileSection profile={item.agent} onExport={onExport} t={t} />
          )}
        </div>

        <div className="drawer-foot">
          {kind !== "agent" && (
            <button className="btn btn-secondary" onClick={() => onToggle(item.id)}>
              {item.status === "disabled" ? t("ext.enable") : t("ext.disable")}
            </button>
          )}
          {kind === "agent" && item.agent && (
            <button className="btn btn-secondary" onClick={() => onEdit?.(item.agent!)}>
              <Icons.Edit size={14} /> 编辑
            </button>
          )}
          <button className="btn btn-danger" onClick={() => onDelete(item.id)}>{t("ext.delete")}</button>
        </div>
      </aside>
    </div>
  );
}

function CapRow({ icon, label, items }: { icon: ReactNode; label: string; items?: string[] }) {
  return (
    <div className="cap-row">
      <span className="cap-label"><span className="cap-icon">{icon}</span> {label}</span>
      <span className="cap-count">{(items?.length ?? 0)}</span>
      <div className="cap-items">
        {items?.map((c) => <code key={c} className="cap-chip">{c}</code>)}
      </div>
    </div>
  );
}

function PermRow({ icon, label, granted, note }: { icon: ReactNode; label: string; granted?: boolean; note?: string }) {
  return (
    <div className="perm-row">
      <span className="perm-label"><span className="perm-icon">{icon}</span> {label}</span>
      <span className={granted ? "perm-on" : "perm-off"}>
        {granted ? (note ? `${note} · 已授权` : "已授权") : "未授权"}
      </span>
    </div>
  );
}

function Importer({ kind, onCancel, onConfirm, t }: { kind: ExtKind; onCancel: () => void; onConfirm: (value: string, fromUrl: boolean) => void; t: (k: DictKey, v?: Record<string, string | number>) => string }) {
  const [tab, setTab] = useState<"local" | "url">("local");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const modalRef = useDialogA11y<HTMLDivElement>(true, onCancel);
  const value = tab === "local" ? name : url;
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("ext.import")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">+ {t("ext.import")} · {kind.toUpperCase()}</h2>
        <div className="modal-tabs">
          <button className={tab === "local" ? "active" : ""} onClick={() => setTab("local")}>{t("ext.importLocal")}</button>
          <button className={tab === "url" ? "active" : ""} onClick={() => setTab("url")}>{t("ext.importUrl")}</button>
        </div>
        {tab === "local" ? (
          <div className="modal-field">
            <label>{kind === "mcp" ? "Command" : t("ext.importLocal")}</label>
            <input
              placeholder={kind === "mcp" ? "npx -y @modelcontextprotocol/server-filesystem" : "skill_local_path"}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        ) : (
          <div className="modal-field">
            <label>URL</label>
            <input placeholder="https://..." value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
        )}
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onCancel}>{t("common.cancel")}</button>
          <button className="btn btn-primary" disabled={!value.trim()} onClick={() => onConfirm(value.trim(), tab === "url")}>
            {t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Skill 预算护栏（F8 / ADR-018）──
// 抽屉内嵌的预算编辑器：拉取该 skill 的预算，三个维度可独立留空（= 不限制）。
function SkillBudgetSection({ id, t }: { id: string; t: (k: DictKey, v?: Record<string, string | number>) => string }) {
  const [token, setToken] = useState("");
  const [cost, setCost] = useState("");
  const [time, setTime] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSaved(false);
    setErr(null);
    getSkillBudget(id)
      .then((b) => {
        if (!alive) return;
        setToken(b.token_limit != null ? String(b.token_limit) : "");
        setCost(b.cost_cents_limit != null ? String(b.cost_cents_limit) : "");
        setTime(b.time_secs_limit != null ? String(b.time_secs_limit) : "");
      })
      .catch((e) => console.error("load skill budget failed", e));
    return () => { alive = false; };
  }, [id]);

  // 留空 → null（不限制该维度）；非法数字 → undefined（阻止保存）。
  const toLimit = (v: string): number | null | undefined => {
    const s = v.trim();
    if (s === "") return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return Math.floor(n);
  };

  const save = async () => {
    const tk = toLimit(token);
    const cs = toLimit(cost);
    const tm = toLimit(time);
    if (tk === undefined || cs === undefined || tm === undefined) {
      setErr("请填写非负整数，或留空表示不限制");
      return;
    }
    setErr(null);
    setSaving(true);
    try {
      await setSkillBudget(id, tk, cs, tm);
      setSaved(true);
    } catch (e) {
      console.error("save skill budget failed", e);
      setErr(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="drawer-section">
      <h3><Icons.Coins size={14} /> {t("ext.budget")}</h3>
      <div className="budget-grid">
        <div className="budget-field">
          <label>{t("ext.budgetToken")}</label>
          <input inputMode="numeric" value={token} placeholder="∞" onChange={(e) => { setToken(e.target.value); setSaved(false); }} />
        </div>
        <div className="budget-field">
          <label>{t("ext.budgetCost")}</label>
          <input inputMode="numeric" value={cost} placeholder="∞" onChange={(e) => { setCost(e.target.value); setSaved(false); }} />
        </div>
        <div className="budget-field">
          <label>{t("ext.budgetTime")}</label>
          <input inputMode="numeric" value={time} placeholder="∞" onChange={(e) => { setTime(e.target.value); setSaved(false); }} />
        </div>
      </div>
      <p className="budget-hint">{t("ext.budgetHint")}</p>
      {err && <p className="budget-err">{err}</p>}
      <div className="budget-actions">
        <button className="btn btn-primary" disabled={saving} onClick={save}>
          {saving ? t("common.loading") : t("ext.budgetSave")}
        </button>
        {saved && !err && <span className="budget-saved"><Icons.Check size={13} /> {t("ext.budgetSaved")}</span>}
      </div>
    </section>
  );
}

// ── 能力体检（IX-16 / ADR-019）──
const DIAG_CLASS_LABEL: Record<DiagnosticClass, string> = {
  MissingGrant: "授权缺失",
  RevokedCredential: "凭证失效",
  OrphanedGrant: "孤儿授权",
  UnavailableProvider: "Provider 不可用",
  CliExecutorMissing: "CLI 未安装",
  CliExecutorLaunchFailed: "CLI 启动失败",
  CliExecutorAuthMissing: "CLI 未登录",
};

function CapabilityModal({ onClose, t }: { onClose: () => void; t: (k: DictKey, v?: Record<string, string | number>) => string }) {
  const [items, setItems] = useState<CapabilityDiagnosticDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const modalRef = useDialogA11y<HTMLDivElement>(true, onClose);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await diagnoseCapabilities());
    } catch (e) {
      console.error("diagnose capabilities failed", e);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void run(); }, [run]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal capability-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("ext.capabilityCheck")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title"><Icons.Stethoscope size={16} /> {t("ext.capabilityCheck")}</h2>
        <div className="modal-actions capability-refresh">
          <button className="btn btn-ghost" onClick={run} disabled={loading}>
            <Icons.Refresh size={13} /> {loading ? t("ext.capabilityRunning") : t("ext.capabilityRefresh")}
          </button>
        </div>
        <div className="capability-body">
          {loading ? (
            <div className="tasks-empty">
              <div className="tasks-empty-icon"><Icons.Hourglass size={40} /></div>
              <h2>{t("ext.capabilityRunning")}</h2>
            </div>
          ) : items && items.length === 0 ? (
            <div className="capability-ok"><Icons.Check size={16} /> {t("ext.capabilityOk")}</div>
          ) : (
            items?.map((d, i) => (
              <div className="diag-item" key={i}>
                <div className="diag-head">
                  <span className="diag-class">{DIAG_CLASS_LABEL[d.class]}</span>
                  <span className="diag-scope">{d.scope}</span>
                </div>
                <div className="diag-title">{d.title}</div>
                <div className="diag-detail">{d.detail}</div>
                <div className="diag-fix"><span className="diag-fix-label">{t("ext.capabilityFix")}：</span>{d.fix_hint}</div>
              </div>
            ))
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>{t("common.confirm")}</button>
        </div>
      </div>
    </div>
  );
}

// ── F4 Agent 定义可移植：详情抽屉内的 AgentProfile 扩展字段 + 导出 ──
function AgentProfileSection({ profile, onExport, t }: { profile: AgentProfile; onExport?: (id: string, redact: boolean) => void; t: (k: DictKey, v?: Record<string, string | number>) => string }) {
  const [redact, setRedact] = useState(false);
  return (
    <section className="drawer-section">
      <h3><Icons.Users size={14} /> {t("ext.agentConfig")}</h3>
      <div className="kv-grid">
        <Kv label={t("ext.model")} value={profile.model} />
        <Kv label={t("ext.provider")} value={profile.provider ?? "deepseek"} />
        <Kv label={t("ext.executor")} value={profile.executor ?? t("ext.internal")} />
        <Kv label={t("ext.permissionMode")} value={profile.permission_mode ?? "default"} />
        <Kv label={t("ext.maxTurns")} value={profile.max_turns ? String(profile.max_turns) : "∞"} />
        <Kv label={t("ext.isolation")} value={profile.isolation ?? "none"} />
      </div>
      <CapRow icon={<Icons.Wrench />} label={t("ext.tools")} items={profile.tools} />
      <CapRow icon={<Icons.Ban />} label={t("ext.disallowedTools")} items={profile.disallowed_tools} />
      <div className="drawer-prompt">
        <h4>{t("ext.systemPrompt")}</h4>
        <pre>{profile.system_prompt}</pre>
      </div>
      {onExport && (
        <div className="agent-export">
          <label className="mini-check">
            <input type="checkbox" checked={redact} onChange={(e) => setRedact(e.target.checked)} />
            <span>{t("ext.exportRedact")}</span>
          </label>
          <button className="btn btn-secondary full" onClick={() => onExport(profile.id, redact)}>
            <Icons.Download size={13} /> {t("ext.exportAgent")}
          </button>
        </div>
      )}
    </section>
  );
}

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv-cell">
      <span className="kv-label">{label}</span>
      <span className="kv-value">{value}</span>
    </div>
  );
}

// ── F4 内置席位模板（研究员 / 评审员 / 执行者 / 汇总者）──
const BUILTIN_AGENT_TEMPLATES: Array<{
  name: string;
  model: string;
  system_prompt: string;
  capabilities: string[];
  skills: string[];
  mcp: string[];
  tools: string[];
}> = [
  {
    name: "研究员",
    model: "deepseek-chat",
    system_prompt:
      "你是一名严谨的研究员。围绕用户给定的主题展开多源检索与交叉验证，区分事实与推测，并在结论中标注信息来源与置信度。输出结构清晰、可引用。",
    capabilities: ["search", "summarize"],
    skills: [],
    mcp: [],
    tools: ["WebFetch", "Grep", "Glob", "Read"],
  },
  {
    name: "评审员",
    model: "deepseek-chat",
    system_prompt:
      "你是一名挑剔的评审员。对给定产物（文案 / 代码 / 方案）按明确维度打分，指出具体缺陷与风险，并给出可执行的修改建议。不粉饰问题。",
    capabilities: ["critique"],
    skills: [],
    mcp: [],
    tools: ["Read", "Grep"],
  },
  {
    name: "执行者",
    model: "deepseek-chat",
    system_prompt:
      "你是一名高效的执行者。把明确任务拆成可执行步骤，优先复用既有工具与文件，逐步推进并在每步自检。遇到歧义先按最稳妥方式处理，再标注假设。",
    capabilities: ["execute"],
    skills: [],
    mcp: [],
    tools: ["Read", "Write", "Edit", "Bash"],
  },
  {
    name: "汇总者",
    model: "deepseek-chat",
    system_prompt:
      "你是一名沉稳的汇总者。综合多个来源（研究结论 / 评审意见 / 执行结果）提炼核心结论与一致行动项，消除冲突、标注分歧，输出供决策者直接使用的摘要。",
    capabilities: ["summarize"],
    skills: [],
    mcp: [],
    tools: ["Read", "Grep"],
  },
];

// ── F4 Agent 导入器：扫描本机 ~/.claude/agents → 选择 → 导入为 AgentProfile ──
function AgentImporter({ onCancel, onImported, t }: { onCancel: () => void; onImported: () => void; t: (k: DictKey, v?: Record<string, string | number>) => string }) {
  const [entries, setEntries] = useState<LocalAgentEntry[] | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [creatingTpl, setCreatingTpl] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const modalRef = useDialogA11y<HTMLDivElement>(true, onCancel);

  useEffect(() => {
    scanLocalAgents()
      .then(setEntries)
      .catch((e) => {
        console.error("scan local agents failed", e);
        setEntries([]);
      });
  }, []);

  const doImport = async (path: string) => {
    setImportingId(path);
    setErr(null);
    try {
      await importAgent(path);
      setDone(path);
      setTimeout(onImported, 600);
    } catch (e) {
      console.error("import agent failed", e);
      setErr(friendlyError(e));
    } finally {
      setImportingId(null);
    }
  };

  const createFromTemplate = async (idx: number) => {
    const tpl = BUILTIN_AGENT_TEMPLATES[idx];
    setCreatingTpl(tpl.name);
    setErr(null);
    try {
      await createAgentPreset({
        name: tpl.name,
        model: tpl.model,
        system_prompt: tpl.system_prompt,
        capabilities: tpl.capabilities,
        skills: tpl.skills,
        mcp: tpl.mcp,
        tools: tpl.tools,
      });
      setDone(`tpl:${tpl.name}`);
      setTimeout(onImported, 600);
    } catch (e) {
      console.error("create agent from template failed", e);
      setErr(friendlyError(e));
    } finally {
      setCreatingTpl(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal capability-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("ext.importLocalAgent")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title"><Icons.Users size={16} /> {t("ext.importLocalAgent")}</h2>
        <div className="modal-body agent-import-body">
          <section className="agent-tpl-section">
            <h3>{t("ext.builtinTemplates")}</h3>
            <div className="agent-tpl-grid">
              {BUILTIN_AGENT_TEMPLATES.map((tpl, i) => (
                <button
                  key={tpl.name}
                  className="agent-tpl-card"
                  disabled={creatingTpl !== null || done !== null}
                  onClick={() => createFromTemplate(i)}
                >
                  <span className="agent-tpl-name">{tpl.name}</span>
                  <span className="agent-tpl-desc">{tpl.system_prompt.slice(0, 28)}…</span>
                  {creatingTpl === tpl.name && <span className="agent-tpl-busy">{t("common.loading")}</span>}
                </button>
              ))}
            </div>
          </section>

          <div className="agent-import-divider"><span>{t("ext.importLocalAgentHint")}</span></div>

          {entries === null ? (
            <div className="tasks-empty">
              <div className="tasks-empty-icon"><Icons.Hourglass size={36} /></div>
              <h2>{t("ext.agentImportScanning")}</h2>
            </div>
          ) : entries.length === 0 ? (
            <div className="tasks-empty">
              <div className="tasks-empty-icon"><Icons.Inbox size={36} /></div>
              <h2>{t("ext.agentImportEmpty")}</h2>
              <p className="page-subtitle">~/.claude/agents · ./.claude/agents</p>
            </div>
          ) : (
            <ul className="agent-import-list">
              {entries.map((e) => (
                <li key={e.path} className="agent-import-item">
                  <div className="agent-import-meta">
                    <span className="agent-import-name">{e.name}</span>
                    <span className="agent-import-src">{e.source === "home" ? "~/.claude/agents" : "项目 .claude/agents"}</span>
                  </div>
                  <button
                    className="btn btn-primary"
                    disabled={importingId === e.path || done === e.path}
                    onClick={() => doImport(e.path)}
                  >
                    {done === e.path ? <><Icons.Check size={13} /> {t("ext.agentImported")}</> : importingId === e.path ? t("common.loading") : t("ext.import")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {err && <p className="budget-err">{err}</p>}
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onCancel}>{t("common.cancel")}</button>
        </div>
      </div>
    </div>
  );
}
