import { useMemo, useState } from "react";
import { useDialogA11y } from "../../common/useDialogA11y";
import { Icons } from "../../common/Icons";
import { AgentEditorModal } from "../../agents/AgentEditorModal";
import { friendlyError } from "../../../services/errors";
import type {
  AgentProfile,
  CreateGroupInput,
  GroupKind,
  ModelProviderConfig,
  TopologyPolicy,
  TopologyPreset,
} from "../../../types";
import { roleCategory, GROUP_TEMPLATES } from "../../../constants/roles";
import type { RoleCategory, GroupTemplate } from "../../../constants/roles";
import type { DictKey } from "../../../i18n/dict";
import { buildTopology } from "../lib/topology";
import "./CreateGroupModal.css";

/** 「新建协作群」弹窗（UX R-3 重写）。
 *
 *  设计要点（2026-09-02）：
 *  · Apple HIG 单色克制 + 唯一蓝做激活态；语义变量驱动 dark 自适应
 *  · 横排 4 等宽模板卡 / chip-pill 选择器 / segmented 单选卡（性质+拓扑）/ sticky live preview footer
 *  · 移除所有原生 checkbox/native select，全部换成自定义 chip
 *  · 错误内联保留；建群阶段化进度条保留；栅格不加新控制参数
 */
export function CreateGroupModal({
  presets,
  providers,
  onPresetCreated,
  onCancel,
  onCreate,
  t,
}: {
  presets: AgentProfile[];
  /** 设置页 settings.providers（必填；用于子 Agent 编辑弹窗内的模型/provider 下拉数据源）。 */
  providers: ModelProviderConfig[];
  /** 新建 Agent 保存后通知父层刷新预设列表（建群弹窗内调起 AgentEditorModal 自行 create）。 */
  onPresetCreated?: (p: AgentProfile) => void;
  onCancel: () => void;
  onCreate: (input: CreateGroupInput) => void | Promise<void>;
  t: (k: DictKey, v?: Record<string, string | number>) => string;
}) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [ownerId, setOwnerId] = useState(presets[0]?.id ?? "");
  const [seatIds, setSeatIds] = useState<string[]>(presets.slice(0, 2).map((p) => p.id));
  const [agentEditorOpen, setAgentEditorOpen] = useState(false);

  // F12 协作拓扑预设
  const [topoKind, setTopoKind] = useState<TopologyPreset>("star");
  // 群性质：研发型 / 调研型 / 聊天型（决定 Worker 回答展示强度）
  const [kind, setKind] = useState<GroupKind>("Chat");
  // 自定义模式下，每个席位可直接发消息/ @ 的同伴 id 列表
  const [visibleMap, setVisibleMap] = useState<Record<string, string[]>>({});

  /// 拓扑策略文档改由 `lib/topology.ts` 的 `buildTopology` 生成 —— 该模块是建群与
  /// 建群后热更面板共用的唯一真源，此处不再内联实现（避免两处逻辑漂移）。
  const buildTopologyDoc = () =>
    buildTopology({ mode: topoKind, seatIds, visibleMap });

  const modalRef = useDialogA11y<HTMLDivElement>(true, onCancel);

  const toggleSeat = (id: string) =>
    setSeatIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const canSubmit = name.trim().length > 0 && ownerId.length > 0;

  // 「按功能建群」模板：点击预填群名 / 目标 / 性质 / 所选角色（按 name 反查 agent_ref）。
  const applyTemplate = (tpl: GroupTemplate) => {
    setName(tpl.label);
    setGoal(tpl.goal);
    setKind(tpl.kind);
    const ids = presets.filter((p) => tpl.roles.includes(p.name)).map((p) => p.id);
    setSeatIds(ids);
    if (tpl.ownerRole) {
      const owner = presets.find((p) => p.name === tpl.ownerRole);
      if (owner) setOwnerId(owner.id);
    }
  };

  // 按职能 / 聊天人格 / 其他 分组展示 Agent Catalog。
  const CAT_LABEL: Record<RoleCategory, string> = {
    functional: "职能角色",
    chat: "聊天人格",
    other: "其他",
  };
  const grouped = useMemo(() => {
    const g: Record<RoleCategory, AgentProfile[]> = { functional: [], chat: [], other: [] };
    for (const p of presets) g[roleCategory(p.name)].push(p);
    return g;
  }, [presets]);

  // 当前生效模板（用于模板卡 active 高亮）。
  // 比对范围：群名 / 群性质 / 席位组合 / 群主 —— **刻意不比对 `goal`**：
  // 模板的业务内核是「角色组合 + 群性质」（决定 Worker 构成与协作方式），
  // `goal` 只是可自由编辑的说明文本，改了它并不代表脱离该模板。
  const matchedTplKey = useMemo(() => {
    for (const tpl of GROUP_TEMPLATES) {
      const wantedIds = presets.filter((p) => tpl.roles.includes(p.name)).map((p) => p.id);
      const owner = tpl.ownerRole ? presets.find((p) => p.name === tpl.ownerRole) : undefined;
      if (
        name.trim() === tpl.label &&
        kind === tpl.kind &&
        wantedIds.length === seatIds.length &&
        wantedIds.every((id) => seatIds.includes(id)) &&
        (tpl.ownerRole ? owner?.id === ownerId : true)
      ) {
        return tpl.key;
      }
    }
    return null;
  }, [name, kind, ownerId, seatIds, presets]);

  // IX-13：建群阶段化进度（感知性能：无信息量 loading → 阶段可见）。
  // 0=idle 1=装配席位 2=固化拓扑 3=建立会话 4=就绪（短暂停留后自动关闭）。
  const [phase, setPhase] = useState<0 | 1 | 2 | 3 | 4>(0);
  const [error, setError] = useState<string | null>(null);
  const submitting = phase > 0;

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setError(null);
    setPhase(1);
    await new Promise((r) => setTimeout(r, 180));
    setPhase(2);
    await new Promise((r) => setTimeout(r, 120));
    setPhase(3);
    try {
      await onCreate({
        name: name.trim(),
        goal: goal.trim(),
        owner_agent_ref: ownerId,
        seat_config: { static: seatIds },
        kind,
        topology: buildTopologyDoc(),
      });
    } catch (e) {
      console.error("[create-group] failed:", e);
      setError(friendlyError(e));
      setPhase(0);
      return;
    }
    setPhase(4);
    await new Promise((r) => setTimeout(r, 350));
    onCancel();
  };

  const toggleVisible = (from: string, to: string) =>
    setVisibleMap((prev) => {
      const cur = prev[from] ?? [];
      const next = cur.includes(to)
        ? cur.filter((x) => x !== to)
        : [...cur, to];
      return { ...prev, [from]: next };
    });

  // Agent 新建逻辑已下沉至 AgentEditorModal。
  const handleAgentSaved = (p: AgentProfile) => {
    setSeatIds((prev) => (prev.includes(p.id) ? prev : [...prev, p.id]));
    setAgentEditorOpen(false);
    onPresetCreated?.(p);
  };

  // ── 计算 live preview 所需数据 ──
  const ownerName = useMemo(
    () => presets.find((p) => p.id === ownerId)?.name ?? "—",
    [presets, ownerId],
  );
  const kindPreviewText =
    kind === "Dev"
      ? t("groups.create.preview.kind.dev")
      : kind === "Research"
        ? t("groups.create.preview.kind.research")
        : kind === "Chat"
          ? t("groups.create.preview.kind.chat")
          : t("groups.create.preview.kind.unknown");
  const topoPreviewText =
    topoKind === "star"
      ? t("groups.create.preview.topo.star")
      : topoKind === "full"
        ? t("groups.create.preview.topo.full")
        : t("groups.create.preview.topo.custom");

  return (
    <>
      <div className="modal-overlay" onClick={onCancel}>
        <div
          className="modal modal-wide cg-modal"
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-label={t("groups.createTitle")}
          onClick={(e) => e.stopPropagation()}
        >
          {/* ── Header：标题 + 描述 + 关闭 ── */}
          <header className="cg-modal-header">
            <div className="cg-modal-head-text">
              <h2>{t("groups.createTitle")}</h2>
              <p>{t("groups.empty.desc")}</p>
            </div>
            <button
              type="button"
              className="cg-close-btn"
              onClick={onCancel}
              aria-label={t("common.cancel")}
            >
              <Icons.Close size={16} />
            </button>
          </header>

          {/* ── Body：滚动区 ── */}
          <div className="cg-modal-body">
            {/* § 1. 快速开始 */}
            <section className="cg-section" aria-labelledby="cg-section-start">
              <h3 className="cg-section-label" id="cg-section-start">
                {t("groups.create.section.start")}
              </h3>
              <div className="cg-templates" role="radiogroup" aria-label={t("groups.create.section.start")}>
                {GROUP_TEMPLATES.map((tpl) => {
                  const active = matchedTplKey === tpl.key;
                  return (
                    <button
                      key={tpl.key}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`cg-tpl ${active ? "active" : ""}`}
                      onClick={() => applyTemplate(tpl)}
                      title={tpl.description}
                    >
                      <span className="cg-tpl-icon" aria-hidden="true">
                        <Icons.Sparkles size={14} />
                      </span>
                      <span className="cg-tpl-title">{tpl.label}</span>
                      <span className="cg-tpl-desc">{tpl.description}</span>
                      <span className="cg-tpl-check" aria-hidden="true">
                        <Icons.Check size={9} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* § 2. 基础信息 */}
            <section className="cg-section" aria-labelledby="cg-section-basic">
              <h3 className="cg-section-label" id="cg-section-basic">
                {t("groups.create.section.basic")}
              </h3>
              <div className="cg-field">
                <label htmlFor="cg-name" className="cg-field-label">
                  {t("groups.field.name")}
                </label>
                <input
                  id="cg-name"
                  className="cg-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("groups.create.placeholder.name")}
                  autoComplete="off"
                  maxLength={48}
                />
              </div>
              <div className="cg-field">
                <label htmlFor="cg-goal" className="cg-field-label">
                  {t("groups.field.goal")}
                </label>
                <textarea
                  id="cg-goal"
                  className="cg-textarea"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder={t("groups.create.placeholder.goal")}
                  rows={2}
                  maxLength={500}
                />
              </div>
            </section>

            {/* § 3. 协作配置 */}
            <section className="cg-section" aria-labelledby="cg-section-collab">
              <h3 className="cg-section-label" id="cg-section-collab">
                {t("groups.create.section.collaboration")}
              </h3>

              <div className="cg-field">
                <label className="cg-field-label">{t("groups.field.kind")}</label>
                <div className="cg-segment-grid" role="radiogroup" aria-label={t("groups.field.kind")}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={kind === "Dev"}
                    className={`cg-segment ${kind === "Dev" ? "active" : ""}`}
                    onClick={() => setKind("Dev")}
                  >
                    <span className="cg-segment-icon" aria-hidden="true">
                      <Icons.Terminal size={16} />
                    </span>
                    <span className="cg-segment-title">{t("groups.kind.dev")}</span>
                    <span className="cg-segment-desc">{t("groups.kind.devDesc")}</span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={kind === "Research"}
                    className={`cg-segment ${kind === "Research" ? "active" : ""}`}
                    onClick={() => setKind("Research")}
                  >
                    <span className="cg-segment-icon" aria-hidden="true">
                      <Icons.Compass size={16} />
                    </span>
                    <span className="cg-segment-title">{t("groups.kind.research")}</span>
                    <span className="cg-segment-desc">{t("groups.kind.researchDesc")}</span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={kind === "Chat"}
                    className={`cg-segment ${kind === "Chat" ? "active" : ""}`}
                    onClick={() => setKind("Chat")}
                  >
                    <span className="cg-segment-icon" aria-hidden="true">
                      <Icons.MessageSquare size={16} />
                    </span>
                    <span className="cg-segment-title">{t("groups.kind.chat")}</span>
                    <span className="cg-segment-desc">{t("groups.kind.chatDesc")}</span>
                  </button>
                </div>
              </div>

              <div className="cg-field">
                <label className="cg-field-label">{t("groups.field.topology")}</label>
                <div className="cg-segment-grid" role="radiogroup" aria-label={t("groups.field.topology")}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={topoKind === "star"}
                    className={`cg-segment ${topoKind === "star" ? "active" : ""}`}
                    onClick={() => setTopoKind("star")}
                  >
                    <span className="cg-segment-icon" aria-hidden="true">
                      <Icons.Network size={16} />
                    </span>
                    <span className="cg-segment-title">{t("groups.topology.star")}</span>
                    <span className="cg-segment-desc">{t("groups.topology.starDesc")}</span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={topoKind === "full"}
                    className={`cg-segment ${topoKind === "full" ? "active" : ""}`}
                    onClick={() => setTopoKind("full")}
                  >
                    <span className="cg-segment-icon" aria-hidden="true">
                      <Icons.Hook size={16} />
                    </span>
                    <span className="cg-segment-title">{t("groups.topology.full")}</span>
                    <span className="cg-segment-desc">{t("groups.topology.fullDesc")}</span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={topoKind === "custom"}
                    className={`cg-segment ${topoKind === "custom" ? "active" : ""}`}
                    onClick={() => setTopoKind("custom")}
                  >
                    <span className="cg-segment-icon" aria-hidden="true">
                      <Icons.Sliders size={16} />
                    </span>
                    <span className="cg-segment-title">{t("groups.topology.custom")}</span>
                    <span className="cg-segment-desc">{t("groups.topology.customDesc")}</span>
                  </button>
                </div>

                {topoKind === "custom" && (
                  <div className="cg-custom-matrix">
                    {/* 诚实提示：建群时 Worker 尚未 spawn，拿不到 worker_id，
                        自定义模式下的同伴矩阵到此为止只能算"预设"，真正的
                        worker_id 授权必须等建群后到 TopologyPanel 完成。 */}
                    <p className="cg-custom-hint cg-custom-hint--warn">
                      {t("groups.create.customDeferredHint")}
                    </p>
                    <p className="cg-custom-hint">{t("groups.create.customHint")}</p>
                    {seatIds.length === 0 ? (
                      <div className="cg-custom-empty">—</div>
                    ) : (
                      seatIds.map((from) => {
                        const peerIds = seatIds.filter((x) => x !== from);
                        if (peerIds.length === 0) return null;
                        return (
                          <div key={from} className="cg-custom-row">
                            <div className="cg-custom-from">
                              {presets.find((p) => p.id === from)?.name ?? from}
                            </div>
                            <div className="cg-custom-peers">
                              {peerIds.map((to) => {
                                const checked = (visibleMap[from] ?? []).includes(to);
                                const name = presets.find((p) => p.id === to)?.name ?? to;
                                return (
                                  <button
                                    key={to}
                                    type="button"
                                    className={`cg-pill ${checked ? "active" : ""}`}
                                    onClick={() => toggleVisible(from, to)}
                                  >
                                    {name}
                                    <span className="cg-pill-check" aria-hidden="true">
                                      <Icons.Check size={8} />
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* § 4. 智能体 */}
            <section className="cg-section" aria-labelledby="cg-section-agents">
              <h3 className="cg-section-label" id="cg-section-agents">
                {t("groups.create.section.agents")}
              </h3>

              {/* 群主 Agent sub-card：左侧 accent 边突出"唯一最高权限"语义，与
                  Worker 平等成员视觉区分。两个 className 共存：.cg-field 提供 label-in-top 布局，
                  .cg-subsection 提供 box 视觉；CSS 源码序保证 gap:8px（sub）覆盖 .cg-field 的 6px。 */}
              <div className="cg-field cg-subsection cg-subsection--primary">
                <label className="cg-field-label">{t("groups.field.owner")}</label>
                <p className="cg-field-helper">{t("groups.create.ownerHelper")}</p>
                {presets.length === 0 ? (
                  <span className="cg-segment-desc">—</span>
                ) : (
                  <div className="cg-pill-list" role="radiogroup" aria-label={t("groups.field.owner")}>
                    {presets.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        role="radio"
                        aria-checked={ownerId === p.id}
                        className={`cg-pill ${ownerId === p.id ? "active" : ""}`}
                        onClick={() => setOwnerId(p.id)}
                      >
                        <Icons.Users size={11} />
                        {p.name}
                        <span className="cg-pill-check" aria-hidden="true">
                          <Icons.Check size={8} />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 静态智能体 Worker sub-card：平实（成员平等），内部 worker-group 之间
                  用 dashed 分隔线区分两个角色分类。 */}
              <div className="cg-field cg-subsection">
                <label className="cg-field-label">{t("groups.field.agents")}</label>
                {presets.length === 0 ? (
                  <span className="cg-segment-desc">—</span>
                ) : (
                  (["functional", "chat", "other"] as RoleCategory[]).map((cat) =>
                    grouped[cat].length === 0 ? null : (
                      <div key={cat} className="cg-worker-group">
                        <div className="cg-worker-group-title">
                          {CAT_LABEL[cat]}
                          <span className="cg-count">
                            {t("groups.create.agentCount", { n: grouped[cat].length })}
                          </span>
                        </div>
                        <div className="cg-pill-list">
                          {grouped[cat].map((p) => {
                            const checked = seatIds.includes(p.id);
                            return (
                              <button
                                key={p.id}
                                type="button"
                                className={`cg-pill ${checked ? "active" : ""}`}
                                onClick={() => toggleSeat(p.id)}
                              >
                                {p.name}
                                <span className="cg-pill-check" aria-hidden="true">
                                  <Icons.Check size={8} />
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ),
                  )
                )}

                <button
                  type="button"
                  className="cg-add-agent"
                  onClick={() => setAgentEditorOpen(true)}
                >
                  <Icons.Plus size={13} />
                  {t("groups.create.addAgent")}
                </button>
              </div>
            </section>

            {/* 阶段化进度（IX-13） */}
            {submitting && (
              <div className="cg-phases" aria-live="polite">
                {[
                  t("groups.create.phase.agents"),
                  t("groups.create.phase.topology"),
                  t("groups.create.phase.session"),
                  t("groups.create.phase.ready"),
                ].map((label, i) => {
                  const idx = (i + 1) as 1 | 2 | 3 | 4;
                  const state = phase > idx ? "done" : phase === idx ? "active" : "todo";
                  return (
                    <>
                      <span key={`p-${idx}`} className={`cg-phase cg-phase-${state}`}>
                        <span className="cg-phase-dot" aria-hidden="true">
                          {state === "done" ? (
                            <Icons.Check size={8} />
                          ) : state === "active" ? (
                            <span className="cg-phase-spin" />
                          ) : (
                            <span className="cg-phase-idle" />
                          )}
                        </span>
                        <span>{label}</span>
                      </span>
                      {i < 3 && <span key={`s-${idx}`} className="cg-phase-sep" />}
                    </>
                  );
                })}
              </div>
            )}

            {/* 错误提示 */}
            {error && (
              <div className="cg-error" role="alert">
                <Icons.AlertTriangle size={16} className="cg-error-icon" />
                <span>{error}</span>
              </div>
            )}
          </div>

          {/* ── Footer：sticky live preview + actions ── */}
          <footer className="cg-modal-footer">
            <div className="cg-preview" aria-live="polite">
              <span className="cg-preview-label">{t("groups.create.preview.title")}</span>
              <span className="cg-preview-pill accent">
                {kindPreviewText} · {topoPreviewText}
              </span>
              <span className="cg-preview-pill">
                {t("groups.create.preview.owner", { name: ownerName })}
              </span>
              <span className="cg-preview-pill">
                {seatIds.length === 0
                  ? t("groups.create.preview.workersNone")
                  : t("groups.create.preview.workers", { n: seatIds.length })}
              </span>
            </div>
            <div className="cg-actions">
              <button className="btn btn-secondary" onClick={onCancel} disabled={submitting}>
                {t("common.cancel")}
              </button>
              <button
                className="btn btn-primary"
                disabled={!canSubmit || submitting}
                onClick={() => void submit()}
              >
                {submitting ? t("groups.create.submitting") : t("groups.create.submit")}
              </button>
            </div>
          </footer>
        </div>
      </div>

      {agentEditorOpen && (
        <AgentEditorModal
          mode="create"
          providers={providers}
          onCancel={() => setAgentEditorOpen(false)}
          onSaved={handleAgentSaved}
        />
      )}
    </>
  );
}
