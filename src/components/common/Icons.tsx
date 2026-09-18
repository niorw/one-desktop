/**
 * Shared SVG icon components.
 * Centralized here so they're used consistently across components.
 */

import React from "react";

type IconProps = { className?: string; size?: number };

export const Icons = {
  Copy: ({ size = 13 }: IconProps = {}) => (
    <svg viewBox="0 0 14 14" fill="none" width={size} height={size}>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.5 9.5V3a.5.5 0 0 1 .5-.5h6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),

  Refresh: ({ size = 13 }: IconProps = {}) => (
    <svg viewBox="0 0 14 14" fill="none" width={size} height={size}>
      <path d="M2 7a5 5 0 0 1 8.5-3.5M12 7a5 5 0 0 1-8.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M11 1.5V3.5H9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 12.5V10.5H5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),

  ThumbUp: ({ size = 13 }: IconProps = {}) => (
    <svg viewBox="0 0 14 14" fill="none" width={size} height={size}>
      <path d="M4 6v5M2 6h2v5H2a.5.5 0 0 1-.5-.5V6.5A.5.5 0 0 1 2 6z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4 6l2-4a1 1 0 0 1 1 1v3h3.5a1 1 0 0 1 .97 1.24l-1 4A1 1 0 0 1 9.5 12H4V6z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  ),

  ThumbDown: ({ size = 13 }: IconProps = {}) => (
    <svg viewBox="0 0 14 14" fill="none" width={size} height={size} style={{ transform: "scaleY(-1)" }}>
      <path d="M4 6v5M2 6h2v5H2a.5.5 0 0 1-.5-.5V6.5A.5.5 0 0 1 2 6z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4 6l2-4a1 1 0 0 1 1 1v3h3.5a1 1 0 0 1 .97 1.24l-1 4A1 1 0 0 1 9.5 12H4V6z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  ),

  Pencil: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.2 2.8a1.8 1.8 0 0 1 2.5 2.5L5.5 13.5l-3.3.8.8-3.3L11.2 2.8Z" />
      <path d="M9.8 4.2l2.5 2.5" />
    </svg>
  ),

  ChevronRight: ({ size = 10 }: IconProps = {}) => (
    <svg viewBox="0 0 10 10" fill="none" width={size} height={size}>
      <path d="M3.5 2L7 5L3.5 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  ChevronLeft: ({ size = 10 }: IconProps = {}) => (
    <svg viewBox="0 0 10 10" fill="none" width={size} height={size}>
      <path d="M6.5 2L3 5L6.5 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),

  // ── Process timeline icons ──
  // A compact, SF Symbols-inspired family used only by the agent process stream.
  // They deliberately share a 16px canvas, 1.5px rounded stroke and no fills so the
  // timeline reads like an Apple utility surface rather than a collection of emoji.
  ProcessReasoning: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m8 1.75.9 3.35L12.25 6 8.9 6.9 8 10.25l-.9-3.35L3.75 6l3.35-.9L8 1.75Z" />
      <path d="m12.2 10.4.45 1.45 1.45.45-1.45.45-.45 1.45-.45-1.45-1.45-.45 1.45-.45.45-1.45Z" />
    </svg>
  ),

  ProcessObservation: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.75 8s2.2-3.5 6.25-3.5S14.25 8 14.25 8 12.05 11.5 8 11.5 1.75 8 1.75 8Z" />
      <circle cx="8" cy="8" r="1.5" />
    </svg>
  ),

  ProcessCommand: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="m4.5 6 2 2-2 2M8.5 10h3" />
    </svg>
  ),

  ProcessEdit: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 13h2.5L13 5.5a1.75 1.75 0 0 0-2.5-2.5L3 10.5V13Z" />
      <path d="m9.5 4 2.5 2.5" />
    </svg>
  ),

  ProcessDocument: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 1.75h5l3 3V13a1.25 1.25 0 0 1-1.25 1.25h-6.5A1.25 1.25 0 0 1 3 13V3A1.25 1.25 0 0 1 4.25 1.75Z" />
      <path d="M9 1.75v3h3M5.5 8h5M5.5 10.5h3.25" />
    </svg>
  ),

  ProcessSearch: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3 3" />
    </svg>
  ),

  ProcessFolder: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.75 5A1.25 1.25 0 0 1 3 3.75h3l1.2 1.5H13A1.25 1.25 0 0 1 14.25 6.5v5.75A1.25 1.25 0 0 1 13 13.5H3a1.25 1.25 0 0 1-1.25-1.25V5Z" />
    </svg>
  ),

  // ── Tool-specific icons ──

  Shell: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size}>
      <path d="M3 4.5l2.5 2.5L3 9.5M7.5 9.5H11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
    </svg>
  ),

  WriteFile: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size}>
      <path d="M3 12.5V3.5a1 1 0 0 1 1-1h5l4 4v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M9 2.5v3.5H12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),

  ReadFile: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size}>
      <path d="M3 13V3a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="8" cy="6.5" r="1.2" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M5 10.5c0-1 1.5-3 3-3s3 2 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),

  ListDir: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size}>
      <path d="M2.5 4.5V3a.5.5 0 0 1 .5-.5h3l1.5 1.5H13a.5.5 0 0 1 .5.5v1.5M2.5 4.5v7.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V4.5" stroke="currentColor" strokeWidth="1.5"/>
    </svg>
  ),

  /**
   * 深度思考图标（ProcessPanel thinking 主推理行）。
   * 设计师方案（2026-08-13）：中心焦点 + 四向射线，表达「聚神推理中」，
   * 深度思考图标：对话气泡 + 三点（经典"正在想"语义，直白不抽象）。
   * 替代 v1"中心射线"（小尺寸下酷似加号+，已被用户否决）。
   * 圆角气泡轮廓 + 内部三点横排，与观察（眼睛）、工具（动作图标）一眼可辨。
   * 16×16 viewBox 与工具行图标统一。
   */
  Think: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4.5h10v6H7.5L5 13v-2.5H3z" />
      <circle cx="6" cy="7.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="8" cy="7.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="10" cy="7.5" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  ),

  /**
   * grep / search 工具行语义图标（放大镜）。
   * 与 read（眼睛+文档）区分：grep 是「在内容里搜」，放大镜更精准（设计师语义图标分发）。
   * 16×16 viewBox 与工具行图标统一。
   */
  Grep: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  ),

  /**
   * 通用工具兜底图标（工具行「已调用」等未识别工具类型时使用）。
   * 扳手形状，16×16 viewBox 与其他工具图标（Shell/ReadFile/WriteFile/ListDir）完全一致，
   * strokeWidth=1.5 统一线重，消除视觉割裂（2026-08-13 图标体系统一）。
   */
  GenericTool: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.5 2a3 3 0 0 1 2 5.2L3 13.5l1.5 1.5 6.3-6.5A3 3 0 1 0 7.5 2z" />
    </svg>
  ),

  Check: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size}>
      <path d="M4 8l2.5 2.5L12 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),

  Cross: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size}>
      <path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),

  // ── Settings & extension icons (unified, single-color, Lucide-style) ──
  Sliders: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="21" y1="4" x2="14" y2="4" /><line x1="10" y1="4" x2="3" y2="4" />
      <line x1="21" y1="12" x2="12" y2="12" /><line x1="8" y1="12" x2="3" y2="12" />
      <line x1="21" y1="20" x2="16" y2="20" /><line x1="12" y1="20" x2="3" y2="20" />
      <line x1="14" y1="2" x2="14" y2="6" /><line x1="8" y1="10" x2="8" y2="14" /><line x1="16" y1="18" x2="16" y2="22" />
    </svg>
  ),

  Globe: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  ),

  Palette: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" stroke="none" /><circle cx="17.5" cy="10.5" r=".5" fill="currentColor" stroke="none" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" stroke="none" /><circle cx="6.5" cy="12.5" r=".5" fill="currentColor" stroke="none" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z" />
    </svg>
  ),

  Info: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  ),

  User: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
    </svg>
  ),

  Bot: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <circle cx="9" cy="14" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="15" cy="14" r="1.5" fill="currentColor" stroke="none" />
      <path d="M8 8V5M16 8V5M12 5V3" strokeLinecap="round" />
    </svg>
  ),

  Plug: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22v-5" /><path d="M9 8V2M15 8V2" /><path d="M18 8H6v4a6 6 0 0 0 12 0z" />
    </svg>
  ),

  Wrench: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />
    </svg>
  ),

  Puzzle: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19.4 13a1.7 1.7 0 0 0 0-3.4h-.5a1.7 1.7 0 0 1-1.7-1.7V7.3a1.7 1.7 0 0 0-3.4 0v.5A1.7 1.7 0 0 1 10 9.5H8.3a1.7 1.7 0 0 0 0 3.4h.5a1.7 1.7 0 0 1 1.7 1.7v1.7a1.7 1.7 0 0 0 3.4 0v-.5a1.7 1.7 0 0 1 1.7-1.7h1.8z" />
    </svg>
  ),

  Sun: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2m-9.66-9.66 1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2m-4.93-4.93-1.41 1.41M6.34 17.66l-1.41 1.41" />
    </svg>
  ),

  Moon: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  ),

  Network: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="6" rx="1" /><rect x="2" y="16" width="6" height="6" rx="1" /><rect x="16" y="16" width="6" height="6" rx="1" />
      <path d="M12 8v4M12 12H5v4M12 12h7v4" />
    </svg>
  ),

  Folder: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),

  FolderOpen: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 14h12.5a2 2 0 0 0 1.9-1.35l1.5-4A2 2 0 0 0 20.1 6H15l-2-2H5a2 2 0 0 0-2 2v10a1 1 0 0 0 1 1h1" />
      <path d="m6 14-1.5 3H19" />
    </svg>
  ),

  ExternalLink: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="m10 14 9-9" />
    </svg>
  ),

  Terminal: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M13 15h4" />
    </svg>
  ),

  Shield: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l8 3.5v5.5c0 5-3.4 8.8-8 10.5-4.6-1.7-8-5.5-8-10.5V5.5L12 2z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),

  ChevronDown: ({ size = 16 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),

  ShieldAlert: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l8 3.5v5.5c0 5-3.4 8.8-8 10.5-4.6-1.7-8-5.5-8-10.5V5.5L12 2z" />
      <path d="M12 8v4" />
      <circle cx="12" cy="15.5" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  ),

  Database: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" /><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    </svg>
  ),

  FileText: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
      <line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="16" y2="17" />
    </svg>
  ),

  /**
   * 观察行图标（ProcessPanel observe 行）。
   * 16×16 viewBox 与工具行图标统一（2026-08-13 图标体系统一）。
   */
  MessageSquare: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5.5L3 14V4z" />
    </svg>
  ),

  // ── Extended settings icons (single-color Lucide-style) ──
  /**
   * 思考/深度思考图标（ProcessPanel thinking 行）。
   * 16×16 viewBox 与工具行图标统一（2026-08-13 图标体系统一）。
   */
  Sparkles: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2v4M8 10v4M2 8h4M10 8h4M4.5 4.5l2.5 2.5M9 9l2.5 2.5M11.5 4.5L9 7M7 9L4.5 11.5" />
    </svg>
  ),

  Brain: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-1.04z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-1.04z" />
      <path d="M12 9h.01" /><path d="M11 14h2" />
    </svg>
  ),

  Users: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),

  Hook: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 9v6a5 5 0 0 1-10 0v-3a3 3 0 0 1 6 0v3" />
      <path d="M16 6V3" />
      <circle cx="16" cy="8" r="2" />
    </svg>
  ),

  /**
   * 意图行图标（ProcessPanel intent 行）。
   * 16×16 viewBox 与工具行图标统一（2026-08-13 图标体系统一）。
   */
  Compass: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M10.5 5.5l-4.5 2 2 4.5 4.5-2z" />
    </svg>
  ),

  BarChart: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
      <line x1="6" y1="20" x2="6" y2="16" />
    </svg>
  ),

  Bookmark: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
    </svg>
  ),

  // ── Status / empty-state icons (single-color Lucide-style) ──
  AlertTriangle: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),

  Inbox: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  ),

  Zap: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),

  Hourglass: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 2h20" /><path d="M2 22h20" />
      <path d="M5 2v4a7 7 0 0 0 14 0V2" /><path d="M5 22v-4a7 7 0 0 0 14 0v4" />
    </svg>
  ),

  Clock: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  ),

  // 能力体检（IX-16 / ADR-019）
  Stethoscope: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 3v5a4 4 0 0 0 8 0V3" />
      <path d="M8 15a5 5 0 0 0 10 0v-2" />
      <circle cx="18" cy="11" r="2" />
    </svg>
  ),

  // Skill 预算护栏（F8 / ADR-018）
  Coins: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="9" r="5" />
      <path d="M9 4.5v9" />
      <path d="M14 14.5a4 4 0 1 0 0 5 4 4 0 0 0 0-5z" />
      <path d="M14 15.5v5" />
    </svg>
  ),

  Ban: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </svg>
  ),

  Download: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  ),

  // ── Roundtable composer icons (single-color Lucide-style) ──
  Paperclip: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  ),

  AtSign: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" />
    </svg>
  ),

  Summarize: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="14" y2="18" />
    </svg>
  ),

  Send: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  ),

  Pause: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  ),

  Play: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="7 4 19 12 7 20 7 4" />
    </svg>
  ),

  Plus: ({ size = 14 }: IconProps = {}) => (
    <svg viewBox="0 0 14 14" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 2.5v9M2.5 7h9" />
    </svg>
  ),

  Trash2: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  ),

  Panel: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="15" y1="4" x2="15" y2="20" />
    </svg>
  ),

  Deliverables: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),

  Kanban: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="currentColor" width={size} height={size}>
      <rect x="3" y="4" width="5" height="14" rx="1.5" />
      <rect x="10" y="8" width="5" height="10" rx="1.5" />
      <rect x="17" y="6" width="5" height="12" rx="1.5" />
    </svg>
  ),

  Image: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  ),

  Mail: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </svg>
  ),

  Eye: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),

  EyeOff: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l18 18" />
      <path d="M10.6 6.2A9.7 9.7 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.3 6.4A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 4-.9" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  ),

  Edit: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  ),

  GitBranch: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9v3a3 3 0 0 1-3 3H9a3 3 0 0 0-3 3" />
    </svg>
  ),

  Close: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  ),

  // ── Queue item action icons (ADR-022 inline queue) ──
  GripVertical: ({ size = 16 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="5" cy="3" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="11" cy="3" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="5" cy="8" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="11" cy="8" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="5" cy="13" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="11" cy="13" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  ),

  ArrowUp: ({ size = 16 }: IconProps = {}) => (
    <svg viewBox="0 0 16 16" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3v10M4 7l4-4 4 4" />
    </svg>
  ),

  Bell: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),

  Mic: ({ size = 20 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <path d="M12 19v4M8 23h8" />
    </svg>
  ),

  // ── Permission mode icons (screenshot-style) ──
  // 完全访问：盾牌 + 斜线 = 不设防（放开全部能力）。
  // 纯线条：本图标集统一 stroke=1.5 / fill=none，禁止 fill 实心元素（会破坏单色线性语汇）。
  ShieldOff: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l8 3.5v5.5c0 5-3.4 8.8-8 10.5-4.6-1.7-8-5.5-8-10.5V5.5L12 2z" />
      <line x1="6.5" y1="6.5" x2="17.5" y2="17.5" />
    </svg>
  ),

  Hand: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0" />
      <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8.5a6 6 0 0 0 6 6h4a4 4 0 0 0 4-4v-7a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0" />
    </svg>
  ),

  Calendar: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),

  Search: ({ size = 18 }: IconProps = {}) => (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),

  /** 空心菱形（◇）。用于实时 footer「已消耗 ◇ X.XX」标识 token 计数。 */
  Diamond: ({ size = 11 }: IconProps = {}) => (
    <svg viewBox="0 0 14 14" fill="none" width={size} height={size}>
      <path d="M7 1.5 L12.5 7 L7 12.5 L1.5 7 Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  ),
};
