//! IX-12 · 任务依赖 DAG 只读视图。
//!
//! 用 React Flow（`@xyflow/react`）+ dagre 自动布局渲染当前批次任务的依赖图：
//! 自动分层、尽量减少边交叉，节点按状态着色，支持缩放 / 平移。
//! 增强信息层：节点进度条 + 产出徽标 + ready 描边；拓扑层完成率环 + 关键路径高亮；
//! 点击节点弹出详情抽屉。纯展示：编辑交互全部锁死（NG1：不做可视化画布编辑器）。

import { useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Edge, Node } from "@xyflow/react";
import type { DictKey } from "../../../i18n/dict";
import { useI18n } from "../../../i18n/I18nProvider";
import type { Task, TaskStatus, Worker } from "../../../types";
import { layoutDag, NODE_H, NODE_W } from "../lib/dagreLayout";
import { TaskNode } from "./TaskNode";
import type { TaskNodeData } from "./TaskNode";
import { agentDisplayName, WORKER_STATUS_KEY } from "./helpers";
import { Icons } from "../../common/Icons";

const nodeTypes = { task: TaskNode };

/** 图例顺序（与状态语义一致）。 */
const LEGEND: TaskStatus[] = [
  "Pending",
  "InProgress",
  "Completed",
  "Failed",
  "Cancelled",
];

/** 图例色点（与节点底色同口径，color-mix 适配 light/dark）。 */
const STATUS_FILL: Record<TaskStatus, string> = {
  Pending: "var(--bg-secondary)",
  InProgress: "color-mix(in srgb, var(--accent) 12%, transparent)",
  Completed: "color-mix(in srgb, var(--success) 14%, transparent)",
  Failed: "color-mix(in srgb, var(--status-error-strong) 14%, transparent)",
  Cancelled: "var(--bg-secondary)",
  // 协调者拆解仍会落 AwaitingApproval（fail-closed 闸门），节点渲染需颜色兜底；
  // 图例（LEGEND）不再展示该状态。
  AwaitingApproval: "color-mix(in srgb, var(--status-awaiting) 14%, transparent)",
};

/** 关键路径信号色（去饱和暖陶土，与设计系统一致）。 */
const SIGNAL = "var(--signal)";

interface Props {
  tasks: Task[];
  /** worker_id → 展示名解析（来自 GroupsPage 的 workerName）。 */
  workerName?: (workerId: string) => string;
  /** 群席位列表：失败节点决策「改派」下拉用。 */
  workers?: Worker[];
  /** agent_ref → 展示名解析（改派下拉显示席位名）。 */
  resolveName?: (ref: string) => string;
  onRetry?: (taskId: string) => void | Promise<void>;
  onReassign?: (taskId: string, workerId: string | null) => void | Promise<void>;
  onSkip?: (taskId: string) => void | Promise<void>;
}

/** depends_on 兜底：运行时可能是 JSON 字符串（DB 存储态），逐字符迭代会导致边全部失效。 */
function normalizeDeps(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? (p as string[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** 状态 → 完成度指示（非真实进度，仅状态可视化）。 */
function statusProgress(s: TaskStatus): number {
  if (s === "Completed") return 1;
  if (s === "InProgress") return 0.55;
  return 0;
}

/** 计算 DAG 最长路径（按节点数加权）上的节点集合，用于关键路径高亮。 */
function criticalPathNodes(tasks: Task[]): Set<string> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const deps = new Map<string, string[]>();
  for (const tk of tasks) deps.set(tk.id, normalizeDeps(tk.depends_on).filter((d) => byId.has(d)));

  const order: string[] = [];
  const vis = new Set<string>();
  const temp = new Set<string>();
  const dfs = (id: string) => {
    if (vis.has(id) || temp.has(id)) return;
    temp.add(id);
    for (const d of deps.get(id) ?? []) dfs(d);
    temp.delete(id);
    vis.add(id);
    order.push(id);
  };
  for (const tk of tasks) dfs(tk.id);

  const dist = new Map<string, number>();
  const pred = new Map<string, string | null>();
  for (const id of order) {
    dist.set(id, 1);
    pred.set(id, null);
  }
  for (const id of order) {
    for (const d of deps.get(id) ?? []) {
      if ((dist.get(id) ?? 0) < (dist.get(d) ?? 0) + 1) {
        dist.set(id, (dist.get(d) ?? 0) + 1);
        pred.set(id, d);
      }
    }
  }

  let end = "";
  let max = 0;
  for (const [id, v] of dist) {
    if (v > max) {
      max = v;
      end = id;
    }
  }
  const path = new Set<string>();
  let cur: string | null = end;
  while (cur) {
    path.add(cur);
    cur = pred.get(cur) ?? null;
  }
  return path;
}

/** 由 tasks 构建 React Flow 的 nodes/edges 并跑 dagre 布局。 */
function buildGraph(tasks: Task[], workerName?: (workerId: string) => string) {
  const byId = new Map(tasks.map((x) => [x.id, x]));
  const critical = criticalPathNodes(tasks);

  const nodes: Node<TaskNodeData>[] = tasks.map((tk, i) => {
    const deps = normalizeDeps(tk.depends_on);
    const ready =
      tk.status === "Pending" && deps.every((d) => byId.get(d)?.status === "Completed");
    return {
      id: tk.id,
      type: "task",
      data: {
        title: tk.description,
        status: tk.status,
        worker: tk.worker_id ? (workerName ? workerName(tk.worker_id) : tk.worker_id) : "—",
        outputs: (tk.outputs as string[] | undefined) ?? [],
        ready,
        progress: statusProgress(tk.status),
      },
      position: { x: 0, y: i * (NODE_H + 24) },
      width: NODE_W,
      height: NODE_H,
    };
  });

  const edges: Edge[] = [];
  for (const tk of tasks) {
    for (const dep of normalizeDeps(tk.depends_on)) {
      if (!byId.has(dep)) continue;
      const isCritical = critical.has(dep) && critical.has(tk.id);
      edges.push({
        id: `${dep}->${tk.id}`,
        source: dep,
        target: tk.id,
        type: "smoothstep",
        className: isCritical ? "dag-rf-edge-critical" : undefined,
        style: isCritical
          ? { stroke: SIGNAL, strokeWidth: 2, strokeDasharray: "5 4" }
          : { stroke: "var(--text-tertiary)", strokeWidth: 1.6 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: isCritical ? SIGNAL : "var(--text-tertiary)",
        },
      });
    }
  }

  return layoutDag(nodes, edges);
}

function CompletionRing({ done, total }: { done: number; total: number }) {
  const r = 18;
  const circ = 2 * Math.PI * r;
  const pct = total > 0 ? done / total : 0;
  const off = circ * (1 - pct);
  return (
    <div className="dag-ring" title={`${done}/${total} 已完成`}>
      <svg width="44" height="44" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r={r} fill="none" stroke="var(--border-light)" strokeWidth="4" />
        <circle
          cx="22"
          cy="22"
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={off}
          transform="rotate(-90 22 22)"
        />
        <text x="22" y="26" text-anchor="middle" font-size="12" font-weight="500" fill="var(--text-primary)">
          {done}/{total}
        </text>
      </svg>
    </div>
  );
}

/** 只读详情；失败节点额外挂「决策区」（重试 / 改派 / 跳过依赖），
 *  使群待决策任务完全在 DAG 节点内闭环，不再依赖任何看板。 */
function TaskDetailDrawer({
  task,
  tasks,
  workers,
  resolveName,
  workerName,
  onRetry,
  onReassign,
  onSkip,
  onClose,
}: {
  task: Task;
  tasks: Task[];
  workers?: Worker[];
  resolveName?: (ref: string) => string;
  workerName?: (workerId: string) => string;
  onRetry?: (taskId: string) => void | Promise<void>;
  onReassign?: (taskId: string, workerId: string | null) => void | Promise<void>;
  onSkip?: (taskId: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const deps = normalizeDeps(task.depends_on)
    .map((d) => byId.get(d))
    .filter((x): x is Task => Boolean(x));
  // last_heartbeat 落库为**秒**（与 runs.started_at 的毫秒不同源），
  // Date 构造要毫秒 —— 漏乘 1000 会显示成 1970-01-22（与 KanbanCard 同口径）。
  const heart = task.last_heartbeat
    ? new Date(task.last_heartbeat * 1000).toLocaleString()
    : "—";
  const outputs = (task.outputs as string[] | undefined) ?? [];
  const failed = task.status === "Failed";

  const wid = task.assigned_worker ?? task.worker_id;
  const owner = wid ? workers?.find((w) => w.id === wid) : undefined;

  return (
    <div className="dag-detail-drawer">
      <div className="dag-detail-head">
        <span className={`dag-rf-badge status-${task.status}`}>{task.status}</span>
        <span className="dag-detail-worker">
          {task.worker_id ? (workerName ? workerName(task.worker_id) : task.worker_id) : "—"}
        </span>
        <button type="button" className="dag-detail-close" onClick={onClose} aria-label={t("common.close")}>
          <Icons.Close size={14} />
        </button>
      </div>
      <p className="dag-detail-title">{task.description}</p>
      <dl className="dag-detail-grid">
        <div>
          <dt>{t("groups.dag.depends")}</dt>
          <dd>{deps.length > 0 ? deps.map((d) => d.description).join("；") : t("groups.dag.none")}</dd>
        </div>
        <div>
          <dt>{t("groups.dag.outputs")}</dt>
          <dd>{outputs.length > 0 ? outputs.map((o) => o.split(/[\\/]/).pop()).join("、") : t("groups.dag.none")}</dd>
        </div>
        <div>
          <dt>{t("groups.dag.retry")}</dt>
          <dd>{task.retry_count ?? 0}</dd>
        </div>
        <div>
          <dt>{t("groups.dag.capability")}</dt>
          <dd>{task.capability ?? "—"}</dd>
        </div>
        <div>
          <dt>{t("groups.dag.lastHeartbeat")}</dt>
          <dd>{heart}</dd>
        </div>
      </dl>

      {failed && (
        <div className="dag-detail-decide">
          <div className="dag-detail-decide-head">
            <Icons.AlertTriangle size={14} />
            <span>{t("groups.recover.title")}</span>
          </div>
          {task.last_error && <p className="dag-detail-err" title={task.last_error}>{task.last_error}</p>}
          <div className="dag-detail-meta">
            {t("groups.task.worker")}:{" "}
            {owner
              ? agentDisplayName(owner, resolveName ?? ((r) => r), t)
              : wid
                ? wid
                : t("groups.task.noWorker")}
            {" · "}
            {t("groups.recover.retry")} #{task.retry_count ?? 0}
          </div>
          <div className="dag-detail-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRetry?.(task.id)}>
              {t("groups.recover.retry")}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSkip?.(task.id)}>
              {t("groups.recover.skip")}
            </button>
            <select
              className="dag-detail-reassign"
              aria-label={t("groups.recover.to")}
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") return;
                onReassign?.(task.id, v === "auto" ? null : v);
              }}
            >
              <option value="" disabled>
                {t("groups.recover.reassign")}
              </option>
              <option value="auto">{t("groups.recover.auto")}</option>
              {(workers ?? [])
                .filter((w) => w.seat_type !== "Capability")
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {agentDisplayName(w, resolveName ?? ((r) => r), t)} · {t(WORKER_STATUS_KEY[w.status])}
                  </option>
                ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

interface InnerProps {
  tasks: Task[];
  workerName?: (workerId: string) => string;
  workers?: Worker[];
  resolveName?: (ref: string) => string;
  onRetry?: (taskId: string) => void | Promise<void>;
  onReassign?: (taskId: string, workerId: string | null) => void | Promise<void>;
  onSkip?: (taskId: string) => void | Promise<void>;
  onSelect: (id: string) => void;
}

function Inner({ tasks, workerName, workers, resolveName, onRetry, onReassign, onSkip, onSelect }: InnerProps) {
  const { t } = useI18n();
  const layout = useMemo(() => buildGraph(tasks, workerName), [tasks, workerName]);

  const [nodes, setNodes, onNodesChange] = useNodesState(layout.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layout.edges);

  // 任务或状态变化时重建图（位置/状态同步）。
  useEffect(() => {
    setNodes(layout.nodes);
    setEdges(layout.edges);
  }, [layout, setNodes, setEdges]);

  const doneCount = tasks.filter((tk) => tk.status === "Completed").length;

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_, node) => onSelect(node.id)}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      elementsSelectable
      minZoom={0.3}
      maxZoom={1.6}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      <Panel position="top-right" className="dag-rf-panel">
        <CompletionRing done={doneCount} total={tasks.length} />
      </Panel>
      <Controls className="dag-rf-controls" showInteractive={false} />
    </ReactFlow>
  );
}

export function TaskDagView({ tasks, workerName, workers, resolveName, onRetry, onReassign, onSkip }: Props) {
  const { t } = useI18n();
  // 默认合并（收起）：DAG 仅显示头部 + 「N 节点 · M 依赖」计数，展开才渲染画布。
  const [collapsed, setCollapsed] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (tasks.length === 0) return null;

  // 无依赖拓扑：全部为独立节点，不渲染 DAG 卡片（独立任务走侧边栏批准自动派发）。
  const hasDeps = tasks.some((tk) => normalizeDeps(tk.depends_on).length > 0);
  if (!hasDeps) return null;

  const depCount = tasks.reduce((n, tk) => n + normalizeDeps(tk.depends_on).length, 0);
  const selected = selectedId ? tasks.find((tk) => tk.id === selectedId) ?? null : null;

  return (
    <div className={`dag-card${collapsed ? " dag-card-collapsed" : ""}`}>
      <div className="dag-head">
        <span className="dag-title">{t("groups.dag.title")}</span>
        <div className="dag-head-actions">
          <button
            type="button"
            className="dag-collapse-btn"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
          >
            {collapsed ? t("groups.dag.expand") : t("groups.dag.collapse")}
            <span className="dag-collapse-count">
              {t("groups.dag.count", { n: tasks.length, m: depCount })}
            </span>
          </button>
        </div>
      </div>
      {!collapsed && (
        <>
          <div className="dag-legend">
            {LEGEND.map((s) => (
              <span key={s} className="dag-legend-item">
                <i className="dag-dot" style={{ background: STATUS_FILL[s] }} />
                {t(`groups.dag.status.${s}` as DictKey)}
              </span>
            ))}
            <span className="dag-legend-item">
              <i className="dag-dot dag-dot-ready" />
              可启动
            </span>
            <span className="dag-legend-item">
              <i className="dag-dot dag-dot-critical" />
              关键路径
            </span>
          </div>
          <div className="dag-rf-canvas">
            <ReactFlowProvider>
              <Inner
                tasks={tasks}
                workerName={workerName}
                workers={workers}
                resolveName={resolveName}
                onRetry={onRetry}
                onReassign={onReassign}
                onSkip={onSkip}
                onSelect={setSelectedId}
              />
            </ReactFlowProvider>
          </div>
          {selected && (
            <TaskDetailDrawer
              task={selected}
              tasks={tasks}
              workers={workers}
              resolveName={resolveName}
              workerName={workerName}
              onRetry={onRetry}
              onReassign={onReassign}
              onSkip={onSkip}
              onClose={() => setSelectedId(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
