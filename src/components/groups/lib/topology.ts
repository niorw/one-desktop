//! 群协作拓扑策略的**唯一真源**（Single Source of Truth）。
//!
//! 建群弹窗（CreateGroupModal）与建群后热更面板（TopologyPanel）共用同一套
//! 「模式 → 策略文档」的构造与反解逻辑，避免两处实现漂移导致：
//!   · 建群时选「星形」，热更面板读回来却显示「全连通」
//!   · 自定义可见性矩阵在保存/回读后丢失
//!
//! 与后端 `group::topology`（`TopologyPolicy` / `Endpoint` / `Channel`）serde 同构。

import type { TopologyPolicy } from "../../../types";

/** 建群 / 热更面板共用的三选一预设。 */
export type TopologyMode = "star" | "full" | "custom";

/** 自定义模式下，每个席位可直接发消息/ @ 的同伴 id 列表。 */
export type VisibleMap = Record<string, string[]>;

/** 群（@All）恒可 @ 任意 Worker —— 星形与自定义都以这条边打底。 */
const ALL_MENTION_EDGE: TopologyPolicy["edges"][number] = {
  from: "All",
  to: "All",
  channels: ["Mention"],
};

/**
 * 由「模式 + 席位 + 自定义可见性」生成拓扑策略文档。
 *
 * - full：默认放行（Allow），无需边 —— 全通道全端点互通。
 * - star：默认 Deny（最小权限），仅保留「群 @ 全员」一条边。
 * - custom：默认 Deny + 「群 @ 全员」+ 逐 Worker 显式授权（Message + Mention）。
 */
export function buildTopology(opts: {
  mode: TopologyMode;
  seatIds: string[];
  visibleMap?: VisibleMap;
}): TopologyPolicy {
  const { mode, seatIds, visibleMap = {} } = opts;

  if (mode === "full") {
    return { version: 1, default: "Allow", edges: [] };
  }

  const edges: TopologyPolicy["edges"] = [{ ...ALL_MENTION_EDGE }];

  if (mode === "custom") {
    for (const from of seatIds) {
      for (const to of visibleMap[from] ?? []) {
        if (to === from) continue;
        edges.push({
          from: { Worker: from },
          to: { Worker: to },
          channels: ["Message", "Mention"],
        });
      }
    }
  }

  return { version: 1, default: "Deny", edges };
}

/**
 * 反解策略文档 → UI 状态（模式 + 自定义可见性）。
 *
 * 判定顺序（与 `buildTopology` 严格互逆）：
 *   1. `default === "Allow"` → full（全连通放行一切，边上无信息）
 *   2. `default === "Deny"` 且存在 Worker→Worker 边 → custom
 *   3. 否则 → star（只剩「群 @ 全员」一条边）
 *
 * 不可识别的形状（如手工编辑过的策略）**保守回退 star**，绝不猜 custom ——
 * 猜错会把用户的精细授权矩阵摊平，属不可逆的数据损坏。
 */
export function parseTopologyPolicy(policy: TopologyPolicy | null | undefined): {
  mode: TopologyMode;
  visibleMap: VisibleMap;
} {
  if (!policy) return { mode: "star", visibleMap: {} };

  if (policy.default === "Allow") {
    return { mode: "full", visibleMap: {} };
  }

  const visibleMap: VisibleMap = {};
  let hasWorkerEdge = false;

  for (const e of policy.edges ?? []) {
    // 只认 Worker→Worker 的显式授权边；「All」端点是群广播，不属同伴矩阵。
    if (typeof e.from === "string" || typeof e.to === "string") continue;
    const from = e.from.Worker;
    const to = e.to.Worker;
    if (!from || !to || from === to) continue;
    hasWorkerEdge = true;
    (visibleMap[from] ??= []).push(to);
  }

  if (!hasWorkerEdge) return { mode: "star", visibleMap: {} };
  return { mode: "custom", visibleMap };
}
