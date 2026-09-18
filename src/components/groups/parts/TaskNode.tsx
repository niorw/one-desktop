//! IX-12 DAG 自定义节点（只读）。
//!
//! 节点显示任务描述（两行截断，hover 显示完整标题）、完成进度条、状态徽标、负责人，
//! 以及产出物徽标与「ready 待启动」描边。状态底色走系统语义令牌，dark 主题自动适配。

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { TaskStatus } from "../../../types";

export interface TaskNodeData {
  title: string;
  status: TaskStatus;
  worker: string;
  /** 产出物文件名列表（outputs 非空时显示徽标）。 */
  outputs: string[];
  /** 依赖已全部完成、自身待启动 → 蓝色描边提示「可启动」。 */
  ready: boolean;
  /** 完成度 0~1（按状态推导，非真实进度）。 */
  progress: number;
  [key: string]: unknown;
}

/** 状态 → 节点底色（color-mix 叠加，自动适配 light/dark）。 */
const STATUS_FILL: Record<TaskStatus, string> = {
  Pending: "var(--bg-secondary)",
  InProgress: "color-mix(in srgb, var(--accent) 12%, transparent)",
  Completed: "color-mix(in srgb, var(--success) 14%, transparent)",
  Failed: "color-mix(in srgb, var(--status-error-strong) 14%, transparent)",
  Cancelled: "var(--bg-secondary)",
  AwaitingApproval: "color-mix(in srgb, var(--status-awaiting) 14%, transparent)",
};

function TaskNodeInner({ data }: { data: TaskNodeData }) {
  return (
    <div
      className={`dag-rf-node status-${data.status}${data.ready ? " is-ready" : ""}`}
      style={{ background: STATUS_FILL[data.status] }}
      title={data.title}
    >
      <Handle type="target" position={Position.Left} className="dag-rf-handle" />
      {data.outputs.length > 0 && (
        <span className="dag-rf-output" title="含产出物" aria-label="含产出物">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M4 2h5l3 3v9H4z" />
            <path d="M9 2v3h3" />
          </svg>
        </span>
      )}
      <div className="dag-rf-title">{data.title}</div>
      <div className="dag-rf-progress">
        <span className="dag-rf-progress-fill" style={{ width: `${Math.round(data.progress * 100)}%` }} />
      </div>
      <div className="dag-rf-meta">
        <span className={`dag-rf-badge status-${data.status}`}>{data.status}</span>
        <span className="dag-rf-worker">{data.worker}</span>
      </div>
      <Handle type="source" position={Position.Right} className="dag-rf-handle" />
    </div>
  );
}

export const TaskNode = memo(TaskNodeInner);
