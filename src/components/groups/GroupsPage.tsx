//! GroupsPage 编排壳（ADR-007 Step2 完成：状态逻辑已抽入 useGroupWorkspace）。
//!
//! 本文件仅保留：Props 契约 + 视图路由 JSX + parts 接线 + 卡片墙渲染。
//! 全部状态/订阅/轮询/handler 在 ./useGroupWorkspace.ts。

import { Icons } from "../common/Icons";
import { RunsView } from "../../features/insight/RunGantt";
import type { DictKey } from "../../i18n/dict";
import type { DeliverableKind, Settings } from "../../types";
import { usePreview } from "../../components/artifacts/PreviewProvider";
import {
  AddSeatModal, CreateGroupModal, GroupDeliverables, GroupDispatch,
  GroupInfoPanel, GroupRoundtable, TaskDagView, TopologyPanel,
  WorkerDetailDrawer,
} from "./parts";
import { useGroupWorkspace } from "./useGroupWorkspace";
import "./groups.css";

interface GroupsPageProps {
  activeGroupId?: string | null;
  /** R-8：设置页 settings（hook 用它派生 modelProviders 传给 AgentEditorModal） */
  settings?: Settings;
  onGroupsChange?: () => void;
  onActiveGroupChange?: (id: string | null) => void;
  creatingGroup?: boolean;
  onCreatingGroupChange?: (v: boolean) => void;
  /** R7（FR7.3）：群折叠回单聊（宿主负责找会话 + 切视图）。 */
  onFoldBack?: () => void;
}

/** 轻量相对时间（群卡片用，中文优先）。入参为 Unix 秒。 */
function relTime(ts: number): string {
  const diff = Date.now() - ts * 1000;
  const m = 60_000, h = 3_600_000, d = 86_400_000;
  if (diff < m) return "刚刚";
  if (diff < h) return `${Math.floor(diff / m)} 分钟前`;
  if (diff < d) return `${Math.floor(diff / h)} 小时前`;
  if (diff < 30 * d) return `${Math.floor(diff / d)} 天前`;
  return new Date(ts * 1000).toLocaleDateString("zh-CN");
}

export function GroupsPage({
  activeGroupId: activeGroupIdProp,
  settings,
  onGroupsChange,
  onActiveGroupChange,
  creatingGroup = false,
  onCreatingGroupChange,
  onFoldBack,
}: GroupsPageProps = {}) {
  const { openPreview } = usePreview();
  const ws = useGroupWorkspace({
    activeGroupIdProp,
    // R-8：把 settings 透传下去，让 hook 派生出 modelProviders（用于 AgentEditorModal）
    settings,
    onGroupsChange,
    onActiveGroupChange,
    onCreatingGroupChange,
  });
  const {
    groups, presets, activeGroupId, workers, batches, accepted, awaiting, modelProviders,
    view, panelOpen, addSeatOpen, workerDetail, error, notice, deliverables,
    delivFilter, delivSearch, delivDetail, savingPb, board, boardBusy, newKey, newValue,
    metricsByWorker, seatLive, infoTick,
    setView, setPanelOpen, setAddSeatOpen, setWorkerDetail, setError, setNotice,
    setDelivFilter, setDelivSearch, setDelivDetail, setNewKey, setNewValue,
    loadPresets, loadDetail, handleBoardSet, handleCreateGroup, handleDispatch,
    handleAccept, saveBatchAsPlaybook, handleCancelBatch, handleApproveBatch,
    handleTaskRetry, handleTaskReassign, handleTaskSkip, handleAddWorker,
    handleAddCapabilitySeat, handleSetWorkerStatus, handleSetWorkerAgent,
    handleRemoveWorker, handlePause, handleResume, handleDissolve,
    allTasks, tasksByWorker, stats, resolveName, workerName,
    latestTasks,
    sortedGroups, recentGroups, activeGroup, t,
  } = ws;

  return (
    <div className="groups-page">
      <div className="group-detail">
        {!activeGroup ? (
          sortedGroups.length === 0 ? (
            <div className="gh-empty">
              <p>{t("groups.hub.empty")}</p>
              <button className="btn btn-primary btn-sm" onClick={() => onCreatingGroupChange?.(true)}>
                + {t("groups.newGroup")}
              </button>
            </div>
          ) : (
            <div className="group-hub">
              <div className="gh-head">
                <div className="gh-title-row">
                  <h2>{t("groups.hub.title")}</h2>
                  <span className="gh-count">{recentGroups.length}</span>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm gh-new-btn"
                  onClick={() => onCreatingGroupChange?.(true)}
                >
                  <Icons.Plus size={14} />
                  {t("groups.newGroup")}
                </button>
              </div>
              <div className="gh-list">
                {recentGroups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    className="gh-row"
                    onClick={() => onActiveGroupChange?.(g.id)}
                  >
                    <span className="gh-avatar">
                      <Icons.Users size={20} />
                    </span>
                    <div className="gh-main">
                      <div className="gh-row-top">
                        <span className="gh-name" title={g.name}>{g.name}</span>
                        <span className="gh-time">{relTime(g.updated_at ?? g.created_at)}</span>
                      </div>
                      <p className="gh-preview">
                        {g.last_message_preview ? (
                          g.last_message_preview
                        ) : (
                          <span className="gh-preview--fallback">{g.goal}</span>
                        )}
                      </p>
                      <div className="gh-row-meta">
                        <span className={`grp-kind grp-kind-${(g.kind ?? "Chat").toLowerCase()}`}>
                          {t(`groups.kind.${(g.kind ?? "Chat").toLowerCase()}` as DictKey)}
                        </span>
                        <span className={`grp-status grp-status-${(g.status ?? "Active").toLowerCase()}`}>
                          {t(`groups.status.${g.status ?? "Active"}` as DictKey)}
                        </span>
                        <span className="gh-members" title={t("groups.members")}>
                          <Icons.Users size={12} />
                          {g.member_count ?? 0}
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (
          <>
            <header className="page-header group-header">
              <div className="group-header-main">
                <h1>{activeGroup.name}</h1>
                <span className={`grp-status grp-status-${(activeGroup.status ?? "Active").toLowerCase()}`}>
                  {t(`groups.status.${activeGroup.status ?? "Active"}` as DictKey)}
                </span>
                <span className={`grp-kind grp-kind-${(activeGroup.kind ?? "Chat").toLowerCase()}`} title={t("groups.field.kind")}>
                  {t(`groups.kind.${(activeGroup.kind ?? "Chat").toLowerCase()}` as DictKey)}
                </span>
              </div>
              <div className="group-header-actions">
                {activeGroup.status === "Active" && (
                  <>
                    <button
                      className="btn btn-ghost btn-icon"
                      onClick={handlePause}
                      title={t("groups.pause")}
                      aria-label={t("groups.pause")}
                    >
                      <Icons.Pause />
                    </button>
                    <button
                      className="btn btn-ghost btn-icon"
                      onClick={handleDissolve}
                      title={t("groups.dissolve")}
                      aria-label={t("groups.dissolve")}
                    >
                      <Icons.Trash2 />
                    </button>
                  </>
                )}
                {activeGroup.status === "Paused" && (
                  <button
                    className="btn btn-secondary btn-icon"
                    onClick={handleResume}
                    title={t("groups.resume")}
                    aria-label={t("groups.resume")}
                  >
                    <Icons.Play />
                  </button>
                )}
                <button
                  className={`btn btn-ghost btn-icon ${view === "deliverables" ? "active" : ""}`}
                  onClick={() => setView((v) => (v === "deliverables" ? "chat" : "deliverables"))}
                  aria-pressed={view === "deliverables"}
                  title={view === "deliverables" ? t("groups.chat") : t("groups.deliverables.title")}
                  aria-label={t("groups.deliverables.title")}
                >
                  <Icons.Deliverables />
                </button>
                <button
                  className={`btn btn-ghost btn-icon ${view === "runs" ? "active" : ""}`}
                  onClick={() => setView((v) => (v === "runs" ? "chat" : "runs"))}
                  aria-pressed={view === "runs"}
                  title={view === "runs" ? t("groups.chat") : "运行"}
                  aria-label="运行"
                >
                  <Icons.BarChart />
                </button>
                <button
                  className={`btn btn-ghost btn-icon ${view === "board" ? "active" : ""}`}
                  onClick={() => setView((v) => (v === "board" ? "chat" : "board"))}
                  aria-pressed={view === "board"}
                  title={view === "board" ? t("groups.chat") : t("groups.board.title")}
                  aria-label={t("groups.board.title")}
                >
                  <Icons.Database />
                </button>
                {/* R-5：建群后拓扑热更入口（后端 group_topology_set 早已就绪，缺的只是前端） */}
                <button
                  className={`btn btn-ghost btn-icon ${view === "topology" ? "active" : ""}`}
                  onClick={() => setView((v) => (v === "topology" ? "chat" : "topology"))}
                  aria-pressed={view === "topology"}
                  title={view === "topology" ? t("groups.chat") : t("groups.topology.navTitle")}
                  aria-label={t("groups.topology.navTitle")}
                >
                  <Icons.Network />
                </button>
                <button
                  className={`btn btn-ghost btn-icon ${panelOpen ? "active" : ""}`}
                  onClick={() => setPanelOpen((v) => !v)}
                  aria-pressed={panelOpen}
                  title={t("groups.panel.toggle")}
                  aria-label={t("groups.panel.toggle")}
                >
                  <Icons.Panel />
                </button>
              </div>
            </header>

            <div className="group-body">
              <div className="group-chat-col">
                {view === "deliverables" ? (
                  <GroupDeliverables
                    groupId={activeGroupId ?? ""}
                    deliverables={deliverables}
                    workers={workers}
                    filter={delivFilter}
                    setFilter={setDelivFilter}
                    search={delivSearch}
                    setSearch={setDelivSearch}
                    resolveName={resolveName}
                    onOpen={setDelivDetail}
                    t={t}
                  />
                ) : view === "chat" ? (
                  <>
                    {notice && (
                      <div
                        className={`rt-notice rt-notice-${notice.kind === "failed" ? "error" : "info"}`}
                        role="status"
                      >
                        <span className="rt-notice-icon">
                          {notice.kind === "failed" ? (
                            <Icons.AlertTriangle size={14} />
                          ) : (
                            <Icons.Check size={14} />
                          )}
                        </span>
                        <span className="rt-notice-text">{notice.detail}</span>
                        <button
                          type="button"
                          className="rt-notice-close"
                          onClick={() => setNotice(null)}
                          aria-label={t("settings.close")}
                        >
                          <Icons.Cross size={12} />
                        </button>
                      </div>
                    )}
                    {/* F9 待验收批次横幅：从旧 RoundtableProgressStrip 收敛至此。 */}
                    {awaiting.size > 0 && (
                      <div className="rt-strip">
                        <div className="rt-strip-section">
                          <span className="rt-strip-label">{t("groups.info.awaiting")}</span>
                          <div className="rt-await-list">
                            {[...awaiting].map((bid) => {
                              const ts = batches[bid] ?? [];
                              const total = ts.length;
                              const done = ts.filter((x) => x.status === "Completed").length;
                              const canCancel = ts.some((x) => x.status === "Pending" || x.status === "InProgress");
                              return (
                                <div key={bid} className="rt-await-banner">
                                  <span className="rt-await-text">
                                    {t("groups.batch.awaiting")} · <span className="rt-await-count">{done}/{total}</span> {t("groups.batch.tasks")}
                                  </span>
                                  <div className="rt-await-actions">
                                    {ts.length > 0 && (
                                      <button
                                        className="btn btn-ghost btn-sm"
                                        onClick={() => void saveBatchAsPlaybook(bid)}
                                        disabled={savingPb === bid}
                                        title={t("groups.playbook.saveTitle")}
                                      >
                                        {t("groups.playbook.save")}
                                      </button>
                                    )}
                                    {canCancel && (
                                      <button className="btn btn-ghost btn-sm" onClick={() => handleCancelBatch(bid)}>
                                        {t("groups.batches.cancel")}
                                      </button>
                                    )}
                                    <button className="btn btn-primary btn-sm" onClick={() => handleAccept(bid)}>
                                      {t("groups.batch.accept")}
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* IX-12：任务依赖 DAG 只读视图（>4 任务时拓扑一目了然）。
                        管理员在环交接棒：抽屉关联产出 / 启动就绪任务后回调刷新。
                        只渲染**最新方案**的批次：同一群多次重新规划会留下多批历史任务，
                        若全量渲染则多套路径同屏、互相干扰。历史批次仅留数据不展示。 */}
                    <TaskDagView
                      tasks={latestTasks}
                      workerName={workerName}
                      workers={workers}
                      resolveName={resolveName}
                      onRetry={handleTaskRetry}
                      onReassign={handleTaskReassign}
                      onSkip={handleTaskSkip}
                    />
                    <GroupRoundtable
                      groupId={activeGroupId ?? ""}
                      group={activeGroup}
                      workers={workers}
                      metricsByWorker={metricsByWorker}
                      resolveName={resolveName}
                      t={t}
                      onError={setError}
                    />

                  </>
                ) : view === "runs" ? (
                  <RunsView
                    groupId={activeGroupId ?? ""}
                    resolveWorkerName={(seat) =>
                      seat ? (workers.find((w) => w.id === seat) ? resolveName(workers.find((w) => w.id === seat)!.agent_ref) : seat) : "—"
                    }
                  />
                ) : view === "topology" ? (
                  <TopologyPanel
                    groupId={activeGroupId ?? ""}
                    workers={workers}
                    resolveName={resolveName}
                    t={t}
                  />
                ) : view === "board" ? (
                  <section className="group-board" aria-label={t("groups.board.title")}>
                    <p className="board-hint">{t("groups.board.hint")}</p>
                    <div className="board-add">
                      <input
                        className="input"
                        placeholder={t("groups.board.keyPlaceholder")}
                        value={newKey}
                        onChange={(e) => setNewKey(e.target.value)}
                        aria-label={t("groups.board.keyPlaceholder")}
                      />
                      <input
                        className="input"
                        placeholder={t("groups.board.valuePlaceholder")}
                        value={newValue}
                        onChange={(e) => setNewValue(e.target.value)}
                        aria-label={t("groups.board.valuePlaceholder")}
                      />
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={!newKey.trim() || boardBusy}
                        onClick={handleBoardSet}
                      >
                        {t("groups.board.declare")}
                      </button>
                    </div>
                    {board && board.entries.length > 0 ? (
                      <table className="board-table">
                        <thead>
                          <tr>
                            <th>{t("groups.board.colKey")}</th>
                            <th>{t("groups.board.colValue")}</th>
                            <th>{t("groups.board.colVersion")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {board.entries.map((e) => (
                            <tr key={e.key}>
                              <td className="board-key">{e.key}</td>
                              <td className="board-value">{e.value}</td>
                              <td className="board-version">{e.version}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="board-empty">{t("groups.board.empty")}</p>
                    )}
                  </section>
                ) : (
                  <GroupDispatch
                    workers={workers}
                    resolveName={resolveName}
                    onDispatch={handleDispatch}
                    onDone={() => setView("chat")}
                    t={t}
                  />
                )}
              </div>

              {panelOpen && view === "chat" && (
                <GroupInfoPanel
                  group={activeGroup}
                  workers={workers}
                  stats={stats}
                  tasksByWorker={tasksByWorker}
                  metricsByWorker={metricsByWorker}
                  seatLive={seatLive}
                  resolveName={resolveName}
                  tasks={allTasks}
                  refreshTick={infoTick}
                  onApproveBatch={(bid) => void handleApproveBatch(activeGroupId, bid)}
                  onCancelBatch={(bid) => void handleCancelBatch(bid)}
                  onAddSeat={() => setAddSeatOpen(true)}
                  onOpenWorker={setWorkerDetail}
                  onAdjust={() => setView("dispatch")}
                  onReplan={() => setView("dispatch")}
                  onViewAllDeliverables={() => setView("deliverables")}
                  onOpenFile={(path) => openPreview({ filePath: path })}
                  t={t}
                />
              )}
            </div>
          </>
        )}
      </div>

      {creatingGroup && (
        <CreateGroupModal
          presets={presets}
          providers={modelProviders}
          onPresetCreated={() => loadPresets()}
          onCancel={() => onCreatingGroupChange?.(false)}
          onCreate={handleCreateGroup}
          t={t}
        />
      )}

      {addSeatOpen && (
        <AddSeatModal
          presets={presets}
          existing={new Set(workers.map((w) => w.agent_ref))}
          resolveName={resolveName}
          onCancel={() => setAddSeatOpen(false)}
          onAdd={handleAddWorker}
          onAddCapability={handleAddCapabilitySeat}
          t={t}
        />
      )}

      {workerDetail && (
        <WorkerDetailDrawer
          worker={workerDetail}
          group={activeGroup}
          presets={presets}
          tasksByWorker={tasksByWorker}
          metric={metricsByWorker[workerDetail.id]}
          resolveName={resolveName}
          onClose={() => setWorkerDetail(null)}
          onSetStatus={handleSetWorkerStatus}
          onSetAgent={handleSetWorkerAgent}
          onRemove={handleRemoveWorker}
          t={t}
        />
      )}


      {error && <div className="groups-error" onClick={() => setError(null)}>{error}</div>}
    </div>
  );
}
