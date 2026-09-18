/**
 * PixelAvatar — 确定性像素头像生成工具（群维度，不绑定角色）。
 *
 * 给定任意 seed 字符串（约定：群内 `worker_id`，owner 用 `agent_ref`），
 * 稳定生成同一图案 + 同一配色；不同 seed 高区分度。同一 worker 在不同群
 * 是不同 worker_id → 各自群内固定头像（"群维度"）。
 *
 * 配色返回 light/dark 双值，由调用方以 CSS 变量注入（--w-acc / --w-acc-dark），
 * SVG 用 currentColor 取色，主题切换自动跟随。
 */

import React, { type CSSProperties } from "react";

/** 10 组高区分度、双主题可读的配色（light 深色系 / dark 亮色系）。 */
const PALETTE: ReadonlyArray<readonly [string, string]> = [
  ["#0055b8", "#4aa3ff"], // 蓝
  ["#1a7f37", "#30d158"], // 绿
  ["#b45309", "#ff9f0a"], // 橙
  ["#c41e3a", "#ff6b81"], // 红
  ["#6d28d9", "#c084fc"], // 紫
  ["#0e7490", "#22d3ee"], // 青
  ["#a16207", "#fbbf24"], // 琥珀
  ["#be123c", "#fb7185"], // 玫红
  ["#4338ca", "#818cf8"], // 靛
  ["#15803d", "#34d399"], // 翠绿
];

/** FNV-1a 32 位哈希：任意 seed → uint32（确定性强）。 */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** seed → 主题色对（light/dark）。 */
export function workerColors(seed: string): { light: string; dark: string } {
  const [light, dark] = PALETTE[hashSeed(seed) % PALETTE.length];
  return { light, dark };
}

/** mulberry32 伪随机（确定性，与平台无关）。 */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const GRID = 8;

/**
 * 8×8 对称像素头像（左右镜像，人脸感）。填充色用 currentColor，
 * 由父级注入 --w-acc / --w-acc-dark 实现双主题。
 */
export function PixelAvatar({
  seed,
  size = 20,
  className,
  style,
}: {
  seed: string;
  size?: number;
  className?: string;
  /**
   * 样式注入（V6：群内每个 worker 取专属色 → inline color 覆盖 SVG currentColor）。
   * 例如 `style={{ color: workerColors(seed).light }}`，dark theme 下由外部以
   * `[data-theme="dark"]` 选择器或 className 覆盖。
   */
  style?: CSSProperties;
}) {
  const rnd = mulberry32(hashSeed(seed));
  const cells: React.ReactNode[] = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID / 2; x++) {
      if (rnd() > 0.55) {
        cells.push(<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} />);
        cells.push(<rect key={`${GRID - 1 - x}-${y}`} x={GRID - 1 - x} y={y} width={1} height={1} />);
      }
    }
  }
  return (
    <svg
      viewBox={`0 0 ${GRID} ${GRID}`}
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
      shapeRendering="crispEdges"
      fill="currentColor"
    >
      {cells}
    </svg>
  );
}
