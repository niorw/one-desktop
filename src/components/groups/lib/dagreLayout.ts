//! IX-12 依赖 DAG 自动布局（dagre 封装）。
//!
//! 把 React Flow 的 nodes/edges 喂给 dagre 做有向无环图分层布局（TB 自顶向下），
//! 自动分配坐标并尽量减少边交叉。返回带 position 的 nodes 与原始 edges。

import Dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";

/** 单节点尺寸（与 CSS `.dag-rf-node` 一致）。 */
export const NODE_W = 220;
export const NODE_H = 96;

export function layoutDag(
  nodes: Node[],
  edges: Edge[],
  opts: { rankdir?: "TB" | "LR" } = {},
): { nodes: Node[]; edges: Edge[] } {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: opts.rankdir ?? "LR",
    nodesep: 24,
    ranksep: 72,
    marginx: 16,
    marginy: 16,
  });

  edges.forEach((e) => g.setEdge(e.source, e.target));
  nodes.forEach((n) =>
    g.setNode(n.id, {
      width: (n.width as number) ?? NODE_W,
      height: (n.height as number) ?? NODE_H,
    }),
  );

  Dagre.layout(g);

  return {
    nodes: nodes.map((n) => {
      const p = g.node(n.id);
      return {
        ...n,
        position: {
          x: p.x - ((n.width as number) ?? NODE_W) / 2,
          y: p.y - ((n.height as number) ?? NODE_H) / 2,
        },
      };
    }),
    edges,
  };
}
