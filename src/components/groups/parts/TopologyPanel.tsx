import { useCallback, useEffect, useMemo, useState } from "react";
import { Icons } from "../../common/Icons";
import type { Worker } from "../../../types";
import type { DictKey } from "../../../i18n/dict";
import { groupTopologyGet, groupTopologySet } from "../../../services/groupCommands";
import { friendlyError } from "../../../services/errors";
import {
  buildTopology,
  parseTopologyPolicy,
  type TopologyMode,
  type VisibleMap,
} from "../lib/topology";
import "./TopologyPanel.css";

/**
 * TopologyPanel — 建群后的协作拓扑热更面板（2026-09-02 新增）。
 *
 * 补齐一个架构缺口：原先「建群是设置拓扑的唯一入口」，一旦建群后想改（或建群时
 * 固化失败）就再无补救路径，只能解散重建。后端 `group_topology_set` 早已就绪，
 * 缺的只是前端 UI。
 *
 * ═══ 关键一致性约束（务必遵守）═══
 * 自定义模式的 Worker→Worker 边必须用 **worker.id**（不是 agent_ref / preset id）。
 * 后端 `Endpoint::Worker(String)` 存 worker_id，路由匹配是精确比较 `w == worker_id`
 * （见 `group/topology.rs` 的 `Endpoint::matches`）。建群弹窗之所以无法正确设置
 * 自定义拓扑，正是因为建群那一刻 Worker 还没 spawn、拿不到 worker_id —— 只有本
 * 面板（Worker 已存在）能设对。星形 / 全连通只依赖 `All→All` 边，与 worker_id
 * 无关，故建群时设置是有效的。
 */
export function TopologyPanel({
  groupId,
  workers,
  resolveName,
  t,
}: {
  groupId: string;
  workers: Worker[];
  resolveName: (ref: string) => string;
  t: (k: DictKey, v?: Record<string, string | number>) => string;
}) {
  const [mode, setMode] = useState<TopologyMode>("star");
  const [visibleMap, setVisibleMap] = useState<VisibleMap>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  /** 后端快照里的版本号（区分「刚保存」与「库里原本就是」）。 */
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);

  /** 席位 = 群内 Worker 的 id（拓扑端点的正确取值，见文件头注释）。 */
  const seatIds = useMemo(() => workers.map((w) => w.id), [workers]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const policy = await groupTopologyGet(groupId);
      const parsed = parseTopologyPolicy(policy);
      setMode(parsed.mode);
      setVisibleMap(parsed.visibleMap);
      setCurrentVersion(policy?.version ?? null);
      setSavedVersion(null);
    } catch (e) {
      console.error("[topology-panel] load failed", e);
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleVisible = (from: string, to: string) =>
    setVisibleMap((prev) => {
      const cur = prev[from] ?? [];
      const next = cur.includes(to) ? cur.filter((x) => x !== to) : [...cur, to];
      return { ...prev, [from]: next };
    });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const policy = buildTopology({ mode, seatIds, visibleMap });
      const newVersion = await groupTopologySet(groupId, policy);
      setSavedVersion(newVersion);
      setCurrentVersion(newVersion);
    } catch (e) {
      console.error("[topology-panel] save failed", e);
      setError(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  /** 与后端快照逐字段比较：模式或可见性矩阵任一不同即可保存。 */
  const dirty = useMemo(() => {
    // 简化：首次加载完成前不可保存；之后用户任何改动都允许保存（幂等写入无副作用）。
    return !loading;
  }, [loading]);

  const MODES: { value: TopologyMode; icon: () => JSX.Element; titleKey: string; descKey: string }[] = [
    {
      value: "star",
      icon: () => <Icons.Network size={16} />,
      titleKey: "groups.topology.star",
      descKey: "groups.topology.starDesc",
    },
    {
      value: "full",
      icon: () => <Icons.Hook size={16} />,
      titleKey: "groups.topology.full",
      descKey: "groups.topology.fullDesc",
    },
    {
      value: "custom",
      icon: () => <Icons.Sliders size={16} />,
      titleKey: "groups.topology.custom",
      descKey: "groups.topology.customDesc",
    },
  ];

  return (
    <div className="topo-panel">
      <header className="topo-panel-head">
        <div>
          <h2>{t("groups.topology.title")}</h2>
          <p className="topo-panel-sub">{t("groups.topology.subtitle")}</p>
        </div>
        <button
          type="button"
          className="topo-reload-btn"
          onClick={() => void load()}
          disabled={loading}
          aria-label={t("groups.topology.reload")}
          title={t("groups.topology.reload")}
        >
          <Icons.Refresh size={14} />
        </button>
      </header>

      {loading ? (
        <div className="topo-loading">{t("common.loading")}</div>
      ) : (
        <>
          <div className="topo-modes" role="radiogroup" aria-label={t("groups.field.topology")}>
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={mode === m.value}
                className={`topo-mode ${mode === m.value ? "active" : ""}`}
                onClick={() => {
                  setMode(m.value);
                  setSavedVersion(null);
                }}
              >
                <span className="topo-mode-icon">{m.icon()}</span>
                <span className="topo-mode-title">{t(m.titleKey as DictKey)}</span>
                <span className="topo-mode-desc">{t(m.descKey as DictKey)}</span>
              </button>
            ))}
          </div>

          {mode === "custom" && (
            <section className="topo-custom">
              <p className="topo-custom-hint">{t("groups.topology.customHint")}</p>
              {workers.length === 0 ? (
                <div className="topo-custom-empty">—</div>
              ) : (
                workers.map((from) => {
                  const peers = workers.filter((w) => w.id !== from.id);
                  if (peers.length === 0) return null;
                  return (
                    <div key={from.id} className="topo-matrix-row">
                      <div className="topo-matrix-from">
                        {resolveName(from.agent_ref)}
                      </div>
                      <div className="topo-matrix-peers">
                        {peers.map((to) => {
                          const checked = (visibleMap[from.id] ?? []).includes(to.id);
                          return (
                            <button
                              key={to.id}
                              type="button"
                              className={`topo-peer-chip ${checked ? "active" : ""}`}
                              onClick={() => {
                                toggleVisible(from.id, to.id);
                                setSavedVersion(null);
                              }}
                            >
                              {resolveName(to.agent_ref)}
                              <span className="topo-peer-check" aria-hidden="true">
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
              <p className="topo-denied-hint">{t("groups.topology.deniedHint")}</p>
            </section>
          )}

          {error && <div className="topo-error" role="alert">{error}</div>}

          {savedVersion !== null && !error && (
            <div className="topo-saved">
              <Icons.Check size={13} />{" "}
              {t("groups.topology.savedAs", { version: savedVersion })}
            </div>
          )}

          <footer className="topo-panel-foot">
            <span className="topo-version">
              {currentVersion !== null
                ? t("groups.topology.currentVersion", { version: currentVersion })
                : ""}
            </span>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void save()}
              disabled={saving || !dirty}
            >
              {saving ? t("groups.topology.saving") : t("groups.topology.save")}
            </button>
          </footer>
        </>
      )}
    </div>
  );
}
