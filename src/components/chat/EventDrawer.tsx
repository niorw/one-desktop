import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { subscribeToUnifiedEvents, type EventEnvelope } from "../../services/eventBus";
import { Icons } from "../common/Icons";
import "./EventDrawer.css";

interface EventDrawerProps {
  open: boolean;
  onClose: () => void;
}

/**
 * EventDrawer —— 实时「归一化事件流」抽屉（移植自 WorkBuddy 设计，Apple 中性重做）。
 *
 * 复用既有的全局事件总线 `subscribeToUnifiedEvents`（`onedesktop-event` 通道，
 * 与内核 `emit_envelope` 同构），不做任何内核改动。每条事件渲染为：
 *   #seq  ·  type  ·  payload 摘要  ·  时:分:秒
 *
 * 过滤高频 token delta，避免刷屏；保留结构化事件（tool/thinking/run 边界）。
 * 滚动缓冲上限 200 条，超出丢最旧。
 */
const MAX_ROWS = 200;

const MIN_DRAWER_W = 280;
const MAX_DRAWER_W = 760;
const DRAWER_W_KEY = "onedesktop:event-drawer-width";
const clampDrawerW = (n: number) => Math.max(MIN_DRAWER_W, Math.min(MAX_DRAWER_W, n));

function detailOf(env: EventEnvelope): string {
  try {
    const s = JSON.stringify(env.payload ?? {});
    return s.length > 400 ? s.slice(0, 400) + "…" : s;
  } catch {
    return String(env.payload);
  }
}

function timeOf(env: EventEnvelope): string {
  const t = (env.payload as { time?: number })?.time ?? Date.now();
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function EventDrawer({ open, onClose }: EventDrawerProps) {
  const [rows, setRows] = useState<EventEnvelope[]>([]);
  const [paused, setPaused] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const [width, setWidth] = useState<number>(() => {
    const raw =
      (typeof localStorage !== "undefined" && localStorage.getItem(DRAWER_W_KEY)) || "";
    const n = raw ? parseInt(raw, 10) : 400;
    return Number.isFinite(n) && n > 0 ? clampDrawerW(n) : 400;
  });
  const [resizing, setResizing] = useState(false);

  // 左边缘拖动拉宽：drawer 固定在右侧，cursor 左移即增大宽度。
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let last = startW;
    setResizing(true);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMove = (ev: MouseEvent) => {
      last = clampDrawerW(startW + (startX - ev.clientX));
      setWidth(last);
    };
    const onUp = () => {
      setResizing(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem(DRAWER_W_KEY, String(last));
      } catch {
        /* 忽略持久化失败（隐私模式等） */
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    const unsub = subscribeToUnifiedEvents((env) => {
      if (pausedRef.current) return;
      // 过滤纯流式 token delta，保留结构化事件边界。
      if (/token/i.test(env.type ?? "")) return;
      setRows((prev) => {
        const next = [...prev, env];
        return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
      });
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [rows, open]);

  return (
    <div
      className={`event-drawer${open ? " open" : ""}${resizing ? " resizing" : ""}`}
      style={{ width: open ? width : undefined }}
      role="log"
      aria-label="Agent 事件流"
      aria-hidden={!open}
    >
      <div
        className="event-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整事件流宽度"
        onMouseDown={startResize}
      />
      <div className="event-drawer-header">
        <div className="title">
          <Icons.Terminal size={14} />
          <span>事件流 · 实时</span>
          <span className="event-count">{rows.length}</span>
        </div>
        <div className="event-drawer-actions">
          <button
            className="event-btn"
            onClick={() => setPaused((p) => !p)}
            title={paused ? "继续" : "暂停"}
            aria-pressed={paused}
            disabled={!open}
          >
            {paused ? <Icons.Play size={13} /> : <Icons.Pause size={13} />}
          </button>
          <button
            className="event-btn"
            onClick={() => setRows([])}
            title="清空"
            disabled={!open}
          >
            <Icons.Trash2 size={13} />
          </button>
          <button className="event-btn" onClick={onClose} title="关闭" aria-label="关闭事件流" disabled={!open}>
            <Icons.Close size={13} />
          </button>
        </div>
      </div>
      <div className="event-list" ref={listRef}>
        {rows.length === 0 ? (
          <div className="event-empty">等待事件…（发送一条消息即可看到归一化事件流）</div>
        ) : (
          rows.map((env, i) => (
            <div className="event-item" key={`${env.type}-${i}`}>
              <span className="e-seq">#{i + 1}</span>
              <span className="e-type">{env.type}</span>
              <span className="e-detail">{detailOf(env)}</span>
              <span className="e-time">{timeOf(env)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default EventDrawer;
