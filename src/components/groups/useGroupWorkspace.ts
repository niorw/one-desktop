//! useGroupWorkspace — 群工作区状态 hook（自 GroupsPage 拆出，ADR-007 Step2）。
//!
//! 聚合：服务器状态（groups/workers/batches/metrics/seatLive/board/…）+ 订阅/轮询
//! effect + 全部群操作 handler + 派生值（allTasks/stats/resolveName/…）。
//! GroupsPage 只保留视图路由与 parts 接线（≤400 行）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import * as groupCommands from "../../services/groupCommands";
import { playbookSave } from "../../services/chatCommands";
import { friendlyError } from "../../services/errors";
import { subscribeToAgentEvents, subscribeToGroupEvents, subscribeToRoundtable, subscribeToRoundtableSummary, subscribeToWorkerNotice, subscribeToWorkerStatus } from "../../services/eventBus";
import { usePreview } from "../../components/artifacts/PreviewProvider";
import type { SeatLive } from "../../features/insight/SeatDashboard";
import type { MainView } from "./parts/helpers";
import type {
  AgentEvent, AgentProfile, BlackboardSnapshot, CreateGroupInput, Deliverable, DeliverableKind,
  Group, GroupEvent, ModelProviderConfig, PlaybookStepDto, RoundtableEvent, RoundtableMessage,
  RoundtableSummaryEvent, Settings, SubTask, Task, Worker, WorkerMetric, WorkerNoticeEvent,
  WorkerStatus,
} from "../../types";

export interface UseGroupWorkspaceOptions {
  activeGroupIdProp?: string | null;
  /** R-8（2026-09-02）：设置页 settings —— 透传给 AgentEditorModal 等子智能体编辑器
   *  作为模型/provider 下拉数据源。任何「模型调整」入口都必须从 settings 拉，禁止硬编码。 */
  settings?: Settings;
  onGroupsChange?: () => void;
  onActiveGroupChange?: (id: string | null) => void;
  onCreatingGroupChange?: (v: boolean) => void;
}

export function useGroupWorkspace({
  activeGroupIdProp,
  settings,
  onGroupsChange,
  onActiveGroupChange,
  onCreatingGroupChange,
}: UseGroupWorkspaceOptions) {
  const { t } = useI18n();
  const { openPreview } = usePreview();

  // R-8：从 settings 派生原始 ModelProviderConfig 列表（设置页「模型设置」是它的唯一真源）
  const modelProviders = useMemo<ModelProviderConfig[]>(
    () => settings?.providers ?? [],
    [settings?.providers],
  );

  const [groups, setGroups] = useState<Group[]>([]);
  const [presets, setPresets] = useState<AgentProfile[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [batches, setBatches] = useState<Record<string, Task[]>>({});
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [awaiting, setAwaiting] = useState<Set<string>>(new Set());
  const [view, setView] = useState<MainView>("chat");
  const [panelOpen, setPanelOpen] = useState(true);
  const [addSeatOpen, setAddSeatOpen] = useState(false);
  const [workerDetail, setWorkerDetail] = useState<Worker | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** F5：最近一条席位终态通知（异常常驻直到手动关闭，全员空闲 5s 自动消失）。 */
  const [notice, setNotice] = useState<WorkerNoticeEvent | null>(null);
  const [deliverables, setDeliverables] = useState<Deliverable[]>([]);
  /** 侧边栏刷新信号：新群消息/摘要到达时 +1，驱动 GroupInfoPanel 重拉消息产出物。 */
  const [infoTick, setInfoTick] = useState(0);
  const [delivFilter, setDelivFilter] = useState<"all" | DeliverableKind>("all");
  const [delivSearch, setDelivSearch] = useState("");
  const [delivDetail, setDelivDetail] = useState<Deliverable | null>(null);
  // F9「另存为 Playbook」：保存中的批次 id（防重复提交）。
  const [savingPb, setSavingPb] = useState<string | null>(null);
  // 群产出物点击 → 走全局预览（不再在此内嵌 ArtifactPreview）。
  useEffect(() => {
    if (delivDetail) {
      openPreview({ deliverable: delivDetail, workers, resolveName });
      setDelivDetail(null);
    }
    // workers/resolveName 变化不应重复打开；仅在 delivDetail 置位时触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delivDetail, openPreview]);
  /** F7 共享黑板快照（群主视角，声明/读取键值）。 */
  const [board, setBoard] = useState<BlackboardSnapshot | null>(null);
  const [boardBusy, setBoardBusy] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [metricsByWorker, setMetricsByWorker] = useState<Record<string, WorkerMetric>>({});
  // R4：席位实时运行状态（AgentEvent 按 rt:{group}:{worker} 会话匹配 → 席位）。
  const [seatLive, setSeatLive] = useState<Record<string, SeatLive>>({});

  const batchesRef = useRef(batches);
  batchesRef.current = batches;

  // R4（FR4.2）：订阅 Agent 事件 → 席位实时状态（会话 `rt:{group}:{worker}` 匹配）。
  // Thinking→思考中 / ToolCall→正在运行 `工具名` / ApprovalRequest→等待审批 `工具名`；
  // ToolResult/Done 清除（回到 WorkerStatus 事件管辖的 Busy/Idle）。
  useEffect(() => {
    if (!activeGroupId) {
      setSeatLive({});
      return;
    }
    const prefix = `rt:${activeGroupId}:`;
    const unsub = subscribeToAgentEvents((ev: AgentEvent) => {
      const sid = ev.data.session_id;
      if (!sid.startsWith(prefix)) return;
      const workerId = sid.slice(prefix.length);
      let live: SeatLive | null = null;
      switch (ev.type) {
        case "Thinking":
          live = { label: "思考中" };
          break;
        case "ToolCall":
          live = { label: "正在运行", tool: ev.data.tool_name };
          break;
        case "ApprovalRequest":
          live = { label: "等待审批", tool: ev.data.tool_name };
          break;
        case "ToolResult":
        case "Done":
          live = null;
          break;
        default:
          return;
      }
      setSeatLive((prev) => {
        if (live === null) {
          if (!(workerId in prev)) return prev;
          const next = { ...prev };
          delete next[workerId];
          return next;
        }
        return { ...prev, [workerId]: live };
      });
    });
    return unsub;
  }, [activeGroupId]);

  const loadGroups = useCallback(async () => {
    try {
      const gs = await groupCommands.listGroups();
      setGroups(gs);
      setActiveGroupId((cur) => {
        if (activeGroupIdProp !== undefined) {
          return activeGroupIdProp && gs.some((g) => g.id === activeGroupIdProp) ? activeGroupIdProp : null;
        }
        return cur && gs.some((g) => g.id === cur) ? cur : gs[0]?.id ?? null;
      });
      onGroupsChange?.();
    } catch (e) {
      setError(friendlyError(e));
    }
  }, [activeGroupIdProp, onGroupsChange]);

  const loadPresets = useCallback(async () => {
    try {
      setPresets(await groupCommands.listAgentPresets());
    } catch {
      /* non-fatal */
    }
  }, []);

  const loadDeliverables = useCallback(async (groupId: string) => {
    try {
      setDeliverables(await groupCommands.groupListDeliverables(groupId));
    } catch {
      /* non-fatal */
    }
  }, []);

  /** F7 拉取群共享黑板（命名空间 `bb:{group_id}`）。 */
  const loadBoard = useCallback(async (groupId: string) => {
    try {
      setBoard(await groupCommands.groupBlackboardGet(groupId));
    } catch {
      /* non-fatal */
    }
  }, []);

  /** F7 群主声明/更新黑板键；成功后刷新并清空表单。 */
  const handleBoardSet = useCallback(async () => {
    if (!activeGroupId || !newKey.trim()) return;
    const existing = board?.entries.find((e) => e.key === newKey.trim());
    setBoardBusy(true);
    try {
      await groupCommands.groupBlackboardSet(
        activeGroupId,
        newKey.trim(),
        newValue,
        existing ? existing.version : 0,
      );
      setNewKey("");
      setNewValue("");
      await loadBoard(activeGroupId);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBoardBusy(false);
    }
  }, [activeGroupId, newKey, newValue, board, loadBoard]);

  const loadMetrics = useCallback(async (groupId: string) => {
    try {
      const ms = await groupCommands.groupListWorkerMetrics(groupId);
      const map: Record<string, WorkerMetric> = {};
      for (const m of ms) map[m.worker_id] = m;
      setMetricsByWorker(map);
    } catch {
      /* non-fatal */
    }
  }, []);

  const loadDetail = useCallback(async (groupId: string) => {
    try {
      const [ws, ts, ms] = await Promise.all([
        groupCommands.groupListWorkers(groupId),
        groupCommands.groupListTasks(groupId),
        groupCommands.groupListWorkerMetrics(groupId),
      ]);
      setWorkers(ws);
      const map: Record<string, Task[]> = {};
      const ids: string[] = [];
      for (const task of ts) {
        const bid = task.batch_id ?? "__ungrouped__";
        if (!map[bid]) {
          map[bid] = [];
          ids.push(bid);
        }
        map[bid].push(task);
      }
      setBatches(map);
      setBatchIds(ids);
      const mmap: Record<string, WorkerMetric> = {};
      for (const m of ms) mmap[m.worker_id] = m;
      setMetricsByWorker(mmap);
    } catch (e) {
      setError(friendlyError(e));
    }
  }, []);

  useEffect(() => {
    loadGroups();
    loadPresets();
  }, [loadGroups, loadPresets]);

  useEffect(() => {
    if (activeGroupIdProp !== undefined) {
      setActiveGroupId(activeGroupIdProp);
    }
  }, [activeGroupIdProp]);

  useEffect(() => {
    if (activeGroupId) loadDetail(activeGroupId);
    else {
      setWorkers([]);
      setBatches({});
      setBatchIds([]);
      setMetricsByWorker({});
    }
  }, [activeGroupId, loadDetail]);

  // ── Worker 状态实时刷新：群内 Worker Busy<->Idle 时，侧边栏/成员列表/指标同步更新 ──
  useEffect(() => {
    if (!activeGroupId) return;
    const gid = activeGroupId;
    const unsub = subscribeToWorkerStatus((ev) => {
      if (ev.group_id !== gid) return;
      // 状态 + 当前任务同步更新：Busy 时带 DAG 任务 id，群主可见「谁在跑什么」。
      setWorkers((prev) =>
        prev.map((w) =>
          w.id === ev.worker_id
            ? { ...w, status: ev.status, current_task_id: ev.current_task_id ?? null }
            : w,
        ),
      );
      // 回合结束（回到 Idle/Offline）即刷新指标，体现最新 token/耗时
      if (ev.status !== "Busy") void loadMetrics(gid);
    });
    return unsub;
  }, [activeGroupId, loadMetrics]);

  // ── F5：席位终态通知 —— 异常/全员空闲主动提示群主（idle_all 5s 自动消失） ──
  useEffect(() => {
    if (!activeGroupId) return;
    const gid = activeGroupId;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribeToWorkerNotice((ev) => {
      if (ev.group_id !== gid) return;
      setNotice(ev);
      if (timer) clearTimeout(timer);
      if (ev.kind === "idle_all") {
        timer = setTimeout(() => setNotice(null), 5000);
      }
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [activeGroupId]);

  // 切群时清掉上一群残留的通知，避免串台
  useEffect(() => {
    setNotice(null);
  }, [activeGroupId]);

  // ── 产出物一览：进入该视图时拉取；切换群/视图时重置筛选与详情 ──
  useEffect(() => {
    if (activeGroupId && view === "deliverables") {
      loadDeliverables(activeGroupId);
    } else {
      setDeliverables([]);
      setDelivFilter("all");
      setDelivSearch("");
      setDelivDetail(null);
    }
  }, [activeGroupId, view, loadDeliverables]);

  // ── F7 共享黑板：进入该视图时拉取 ──
  useEffect(() => {
    if (activeGroupId && view === "board") {
      void loadBoard(activeGroupId);
    }
  }, [activeGroupId, view, loadBoard]);

  // ── 产出物实时刷新：任意视图下，新 Worker 回复 / 新摘要到达即重拉产出物 +
  // 任务列表（任务产出可能随回合回填 tasks.outputs），并触发侧边栏重拉消息产出物 ──
  useEffect(() => {
    if (!activeGroupId) return;
    const gid = activeGroupId;
    const refresh = () => {
      setInfoTick((t) => t + 1);
      void loadDetail(gid);
      void loadDeliverables(gid);
    };
    const onMsg = (ev: RoundtableEvent) => {
      if (ev.group_id === gid) refresh();
    };
    const onSum = (ev: RoundtableSummaryEvent) => {
      if (ev.group_id === gid) refresh();
    };
    const u1 = subscribeToRoundtable(onMsg);
    const u2 = subscribeToRoundtableSummary(onSum);
    return () => {
      u1();
      u2();
    };
  }, [activeGroupId, loadDetail, loadDeliverables]);

  // ── 群协作事件：batch_completed 触发验收闭环；batch_cancelled 刷新状态 ──
  useEffect(() => {
    const unsub = subscribeToGroupEvents((ev: GroupEvent) => {
      if (ev.group_id !== activeGroupId) return;
      if (ev.type === "batch_completed") {
        setAwaiting((prev) => new Set(prev).add(ev.batch_id));
        if (activeGroupId) loadDetail(activeGroupId);
      } else if (ev.type === "batch_awaiting_approval") {
        // coordinator 自动拆解提交后即时刷新任务板（任务落 AwaitingApproval，等待群主审批）。
        setAwaiting((prev) => new Set(prev).add(ev.batch_id));
        if (activeGroupId) loadDetail(activeGroupId);
      } else if (ev.type === "batch_cancelled") {
        setAwaiting((prev) => {
          const next = new Set(prev);
          next.delete(ev.batch_id);
          return next;
        });
        if (activeGroupId) loadDetail(activeGroupId);
      } else if (ev.type === "group_paused" || ev.type === "group_resumed") {
        loadGroups();
      } else if (ev.type === "worker_removed") {
        loadDetail(activeGroupId);
        setWorkerDetail((cur) => (cur && cur.id === ev.worker_id ? null : cur));
      } else if (ev.type === "task_reset") {
        // F6 群主恢复动作后即时刷新任务板（任务已回到 Pending，重派进行中）。
        loadDetail(activeGroupId);
      } else if (ev.type === "task_status_changed") {
        // 看板人工改状态后即时刷新（卡片已跨列流动）。
        loadDetail(activeGroupId);
      }
    });
    return unsub;
  }, [activeGroupId]);

  // ── 进度轮询：有在途任务时每 1.5s 刷新 Worker 状态与批次任务 ──
  useEffect(() => {
    if (!activeGroupId || batchIds.length === 0) return;
    let alive = true;
    const tick = async () => {
      try {
        const ws = await groupCommands.groupListWorkers(activeGroupId);
        if (!alive) return;
        setWorkers(ws);
        const cur = batchesRef.current;
        for (const bid of batchIds) {
          const ts = cur[bid];
          if (!ts) continue;
          const open = ts.some((tk) => tk.status === "Pending" || tk.status === "InProgress");
          if (!open) continue;
          const fresh = await groupCommands.groupListTasks(activeGroupId, bid);
          if (!alive) return;
          setBatches((prev) => ({ ...prev, [bid]: fresh }));
        }
      } catch {
        /* ignore transient poll errors */
      }
    };
    tick();
    const iv = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [activeGroupId, batchIds]);

  const allTasks = useMemo(() => Object.values(batches).flat(), [batches]);

  /**
   * 最新方案的批次 id。后端 `find_by_group` 按 rowid ASC 返回，`batchIds`
   * 因此按创建先后排列 —— 末位即最新一批。历史方案仅留数据、不进拓扑渲染。
   */
  const latestBatchId = useMemo(
    () => (batchIds.length > 0 ? batchIds[batchIds.length - 1] : null),
    [batchIds],
  );

  /** 仅最新方案的任务：依赖拓扑图专用（避免历史多套规划路径同屏干扰）。 */
  const latestTasks = useMemo(() => {
    if (!latestBatchId) return [];
    return allTasks.filter((tk) => (tk.batch_id ?? "__ungrouped__") === latestBatchId);
  }, [allTasks, latestBatchId]);
  const tasksByWorker = useMemo(() => {
    const m: Record<string, Task[]> = {};
    for (const tk of allTasks) {
      const wid = tk.assigned_worker ?? tk.worker_id;
      if (!wid) continue;
      (m[wid] ??= []).push(tk);
    }
    return m;
  }, [allTasks]);
  const stats = useMemo(
    () => ({
      seats: workers.length,
      busy: workers.filter((w) => w.status === "Busy").length,
      open: allTasks.filter((tk) => tk.status === "Pending" || tk.status === "InProgress").length,
      completed: allTasks.filter((tk) => tk.status === "Completed").length,
      awaiting: awaiting.size,
    }),
    [workers, allTasks, awaiting],
  );

  const resolveName = useCallback(
    (agentRef: string): string => presets.find((p) => p.id === agentRef)?.name ?? agentRef,
    [presets],
  );

  /** worker_id → 展示名（DAG 节点用）。 */
  const workerName = useCallback(
    (workerId: string): string => {
      const w = workers.find((x) => x.id === workerId);
      return w ? resolveName(w.agent_ref) : workerId;
    },
    [workers, resolveName],
  );

  const handleCreateGroup = async (input: CreateGroupInput) => {
    const g = await groupCommands.createGroup(input);
    // F12：建群后固化拓扑快照（deny-all 默认已在后端兜底，这里显式落选中的预设）。
    //
    // 失败必须显式告知，不能只 console：原实现仅打日志，弹窗照样走完「就绪」并关闭，
    // 用户无感知，之后只会困惑「为何 Worker 之间不能互 @」——实为后端 deny-all 兜底。
    // 群已创建故不抛错（避免用户重试导致重复建群），改为降级提示。
    //
    // 注（2026-09-02 更新）：建群**不再**是唯一入口 —— TopologyPanel（群内「协作拓扑」
    // 视图）已可随时热更，故此处的失败已**可逆**，提示语改为引导用户去面板重设。
    if (input.topology) {
      try {
        await groupCommands.groupTopologySet(g.id, input.topology);
      } catch (e) {
        console.error("[groups] 固化拓扑策略失败（群已创建）", e);
        setError(t("groups.create.topologyFailed", { name: g.name }));
      }
    }
    await loadGroups();
    onActiveGroupChange?.(g.id);
    setView("chat");
    setPanelOpen(true);
    onCreatingGroupChange?.(false);
  };

  // Agent 创建逻辑现由 AgentEditorModal 负责；CreateGroupModal 通过 onPresetCreated 刷新预设。

  const handleDispatch = async (subtasks: SubTask[]) => {
    if (!activeGroupId) return;
    const batchId = await groupCommands.groupAssignTasks(activeGroupId, subtasks);
    const optimistic: Task[] = subtasks.map((s) => ({
      id: s.id,
      group_id: activeGroupId,
      batch_id: batchId,
      worker_id: s.worker_id,
      description: s.description,
      depends_on: s.depends_on,
      input_refs: s.input_refs,
      output_spec: s.output_spec,
      status: "Pending",
      retry_count: 0,
      assigned_worker: null,
      outputs: [],
      reasoning: s.reasoning ?? null,
    }));
    setBatches((prev) => ({ ...prev, [batchId]: optimistic }));
    setBatchIds((prev) => (prev.includes(batchId) ? prev : [...prev, batchId]));
    setView("chat");
  };

  const handleAccept = (batchId: string) => {
    setAwaiting((prev) => {
      const next = new Set(prev);
      next.delete(batchId);
      return next;
    });
    setAccepted((prev) => new Set(prev).add(batchId));
  };

  /** F9：把一批次的任务拆解转成 Playbook 步骤（索引依赖）并保存。 */
  const saveBatchAsPlaybook = async (bid: string) => {
    if (savingPb) return;
    const ts = batches[bid] ?? [];
    if (ts.length === 0) return;
    const idToIdx = new Map(ts.map((x, i) => [x.id, i]));
    const steps: PlaybookStepDto[] = ts.map((x) => ({
      description: x.description,
      depends_on: (x.depends_on ?? [])
        .map((dep) => idToIdx.get(dep))
        .filter((i): i is number => i !== undefined),
      capability: null,
      reasoning: x.reasoning ?? null,
    }));
    setSavingPb(bid);
    try {
      const name = window.prompt(t("groups.playbook.savePrompt"), ts[0].description.slice(0, 24) + "…");
      if (name && name.trim()) {
        await playbookSave({ name: name.trim(), steps });
      }
    } catch {
      // 静默：保存失败不打断验收流程。
    } finally {
      setSavingPb(null);
    }
  };

  const handleCancelBatch = async (batchId: string) => {
    if (!activeGroupId) return;
    try {
      await groupCommands.groupCancelBatch(activeGroupId, batchId);
      await loadDetail(activeGroupId);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  // 侧边栏 worker 卡片上方「批准」：AwaitingApproval → Pending 并触发派发（fail-closed 放行）。
  const handleApproveBatch = async (groupId: string | null, batchId: string) => {
    if (!groupId) return;
    try {
      await groupCommands.groupApproveBatch(groupId, batchId);
      setAwaiting((prev) => {
        const next = new Set(prev);
        next.delete(batchId);
        return next;
      });
      await loadDetail(groupId);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  // ── F6 群主恢复动作：把失败/卡死任务重新放回调度 ──
  const handleTaskRetry = async (taskId: string) => {
    if (!activeGroupId) return;
    try {
      await groupCommands.taskRetry(taskId);
      await loadDetail(activeGroupId);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  const handleTaskReassign = async (taskId: string, workerId: string | null) => {
    if (!activeGroupId) return;
    try {
      await groupCommands.taskReassign(taskId, workerId);
      await loadDetail(activeGroupId);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  const handleTaskSkip = async (taskId: string) => {
    if (!activeGroupId) return;
    try {
      await groupCommands.taskSkipDependency(taskId);
      await loadDetail(activeGroupId);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  // ── 看板人工改状态：拖拽/键盘触发，经 task_set_status（含转移校验） ──
  const handleTaskSetStatus = async (taskId: string, status: import("../../types").TaskStatus) => {
    if (!activeGroupId) return;
    try {
      await groupCommands.taskSetStatus(taskId, status);
      await loadDetail(activeGroupId);
    } catch (e) {
      setError(friendlyError(e));
      throw e; // 让看板层能捕获并 toast
    }
  };

  const handleAddWorker = async (agentRef: string, capabilities: string[]) => {
    if (!activeGroupId) return;
    try {
      await groupCommands.groupAddWorker(activeGroupId, agentRef, capabilities);
      await loadDetail(activeGroupId);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  // ── 能力席位：声明式空槽，仅声明能力，不绑定预设 ──
  const handleAddCapabilitySeat = async (capabilities: string[]) => {
    if (!activeGroupId) return;
    try {
      await groupCommands.groupAddCapabilitySeat(activeGroupId, capabilities);
      await loadDetail(activeGroupId);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  // ── 刷新单个 worker（状态切换后同步抽屉内容）──
  const refreshWorker = async (workerId: string) => {
    if (!activeGroupId) return;
    try {
      const ws = await groupCommands.groupListWorkers(activeGroupId);
      setWorkers(ws);
      setWorkerDetail(ws.find((w) => w.id === workerId) ?? null);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  // ── 手动切换 Worker 在线状态（Idle <-> Offline）──
  const handleSetWorkerStatus = async (workerId: string, status: "idle" | "offline") => {
    if (!activeGroupId) return;
    try {
      await groupCommands.groupSetWorkerStatus(activeGroupId, workerId, status);
      await refreshWorker(workerId);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  // ── 重绑席位来源 Agent（运行时换 agent / 填充能力席位）──
  const handleSetWorkerAgent = async (workerId: string, agentRef: string) => {
    if (!activeGroupId) return;
    try {
      await groupCommands.groupSetWorkerAgent(activeGroupId, workerId, agentRef);
      await refreshWorker(workerId);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  // ── 移除席位（在跑会取消 session + 标任务 Cancelled）──
  const handleRemoveWorker = async (workerId: string) => {
    if (!activeGroupId) return;
    if (!window.confirm(t("groups.agent.confirmRemove"))) return;
    try {
      await groupCommands.groupRemoveWorker(activeGroupId, workerId);
      const ws = await groupCommands.groupListWorkers(activeGroupId);
      setWorkers(ws);
      setWorkerDetail((cur) => (cur && cur.id === workerId ? null : cur));
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  const handlePause = async () => {
    if (!activeGroupId) return;
    try {
      await groupCommands.groupPause(activeGroupId);
      await loadGroups();
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  const handleResume = async () => {
    if (!activeGroupId) return;
    try {
      await groupCommands.groupResume(activeGroupId);
      await loadGroups();
      await loadDetail(activeGroupId);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  const handleDissolve = async () => {
    if (!activeGroupId) return;
    if (!window.confirm(t("groups.confirmDissolve", { name: activeGroup?.name ?? "" }))) return;
    try {
      await groupCommands.groupDissolve(activeGroupId);
      await loadGroups();
      onActiveGroupChange?.(null);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  // 卡片墙排序：按最近活跃时间倒序（无消息回退建群时间），呼应「最新的群聊」入口语义。
  const sortedGroups = useMemo(
    () =>
      [...groups].sort(
        (a, b) => (b.updated_at ?? b.created_at) - (a.updated_at ?? a.created_at),
      ),
    [groups],
  );
  // 卡片墙只展示最近活跃的 5 个（概览入口，太多无意义；完整列表在左侧栏，不受影响）。
  const recentGroups = useMemo(() => sortedGroups.slice(0, 5), [sortedGroups]);
  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? null;

  return {
    // 状态
    groups, presets, activeGroupId, workers, batches, batchIds, accepted, awaiting,
    view, panelOpen, addSeatOpen, workerDetail, error, notice, deliverables, infoTick,
    delivFilter, delivSearch, delivDetail, savingPb, board, boardBusy, newKey, newValue,
    metricsByWorker, seatLive,
    // R-8：从 settings 派生的 ModelProviderConfig 列表（设置页"模型设置"的真值）
    modelProviders,
    // setters
    setView, setPanelOpen, setAddSeatOpen, setWorkerDetail, setError, setNotice,
    setDelivFilter, setDelivSearch, setDelivDetail, setNewKey, setNewValue,
    // 数据加载
    loadGroups, loadPresets, loadDetail, loadBoard, loadDeliverables, loadMetrics,
    // 群操作 handler
    handleBoardSet, handleCreateGroup, handleDispatch, handleAccept, saveBatchAsPlaybook,
    handleCancelBatch, handleApproveBatch, handleTaskRetry, handleTaskReassign,
    handleTaskSkip, handleTaskSetStatus, handleAddWorker, handleAddCapabilitySeat,
    refreshWorker, handleSetWorkerStatus, handleSetWorkerAgent, handleRemoveWorker,
    handlePause, handleResume, handleDissolve,
    // 派生
    allTasks, tasksByWorker, stats, resolveName, workerName, sortedGroups, recentGroups, activeGroup,
    latestBatchId, latestTasks,
    // 文案
    t,
  };
}
