// Tauri event listener abstraction for agent events.
// Uses synchronous registration API to avoid race conditions on unsubscribe.

import { listen } from "@tauri-apps/api/event";
import type { AgentEvent, GroupEvent, RoundtableEvent, RoundtableSummaryEvent, RoundtableTokenEvent, WorkerNoticeEvent, WorkerStatusEvent } from "../types";

export type EventHandler = (event: AgentEvent) => void;
export type GroupEventHandler = (event: GroupEvent) => void;
export type RoundtableEventHandler = (event: RoundtableEvent) => void;
export type WorkerStatusEventHandler = (event: WorkerStatusEvent) => void;
export type WorkerNoticeEventHandler = (event: WorkerNoticeEvent) => void;

/** 统一事件总线（P2-10）：`onedesktop-event` 通道的 Envelope。 */
export interface EventEnvelope {
  type: string;
  session_id?: string | null;
  group_id?: string | null;
  payload: unknown;
}

export type EnvelopeHandler = (env: EventEnvelope) => void;

/**
 * 订阅统一事件总线（`onedesktop-event`）：新事件类型只需后端走
 * `emit_envelope`，前端此订阅即可按 `env.type` 分发，免改各 hooks。
 * 旧通道（agent-event 等）在兼容期内继续双发，旧订阅不受影响。
 */
export function subscribeToUnifiedEvents(handler: EnvelopeHandler): () => void {
  let active = true;
  let unlistenFn: (() => void) | null = null;

  const promise = listen<EventEnvelope>("onedesktop-event", (event) => {
    if (!active) return;
    try {
      handler(event.payload);
    } catch (e) {
      // 事件处理器异常：记录完整上下文（事件类型 + 错误），避免静默丢事件。
      console.error("[eventBus] unified event handler error", {
        type: event.payload?.type,
        error: String(e),
      });
    }
  });

  promise.then((fn) => {
    if (!active) {
      fn();
    } else {
      unlistenFn = fn;
    }
  });

  return () => {
    active = false;
    if (unlistenFn) {
      unlistenFn();
      unlistenFn = null;
    }
  };
}

/**
 * Subscribe to agent events from the Rust backend.
 * Uses listen() directly — each call is synchronous so unsubscribes are safe.
 */
export function subscribeToAgentEvents(handler: EventHandler): () => void {
  let active = true;
  let unlistenFn: (() => void) | null = null;

  // Fire and consume: listen() returns a Promise, but we store the resolver immediately
  const promise = listen<AgentEvent>("agent-event", (event) => {
    if (active) handler(event.payload);
  });

  promise.then((fn) => {
    // If already unsubscribed before promise resolved, cancel immediately
    if (!active) {
      fn();
    } else {
      unlistenFn = fn;
    }
  });

  return () => {
    active = false;
    if (unlistenFn) {
      unlistenFn();
      unlistenFn = null;
    }
  };
}

/**
 * Subscribe to group-collaboration events (`group-event`) from the Rust backend,
 * e.g. `batch_completed` used to trigger owner acceptance (验收闭环).
 */
export function subscribeToGroupEvents(handler: GroupEventHandler): () => void {
  let active = true;
  let unlistenFn: (() => void) | null = null;

  const promise = listen<GroupEvent>("group-event", (event) => {
    if (active) handler(event.payload);
  });

  promise.then((fn) => {
    if (!active) {
      fn();
    } else {
      unlistenFn = fn;
    }
  });

  return () => {
    active = false;
    if (unlistenFn) {
      unlistenFn();
      unlistenFn = null;
    }
  };
}

/**
 * Subscribe to roundtable message-bus events (`roundtable-message`) from the Rust backend.
 * Fired whenever any participant (owner or worker) posts a roundtable message.
 */
export function subscribeToRoundtable(handler: RoundtableEventHandler): () => void {
  let active = true;
  let unlistenFn: (() => void) | null = null;

  const promise = listen<RoundtableEvent>("roundtable-message", (event) => {
    if (active) handler(event.payload);
  });

  promise.then((fn) => {
    if (!active) {
      fn();
    } else {
      unlistenFn = fn;
    }
  });

  return () => {
    active = false;
    if (unlistenFn) {
      unlistenFn();
      unlistenFn = null;
    }
  };
}

/**
 * Subscribe to roundtable streaming token events (`roundtable-token`) from the Rust backend.
 * Parallel fork of `agent:token` for group (research/field) collaboration views; chat path
 * is untouched. `aborted` payload asks the view to drop the half-finished streaming bubble.
 */
export function subscribeToRoundtableToken(handler: (payload: RoundtableTokenEvent) => void): () => void {
  let active = true;
  let unlistenFn: (() => void) | null = null;

  const promise = listen<RoundtableTokenEvent>("roundtable-token", (event) => {
    if (active) handler(event.payload);
  });

  promise.then((fn) => {
    if (!active) {
      fn();
    } else {
      unlistenFn = fn;
    }
  });

  return () => {
    active = false;
    if (unlistenFn) {
      unlistenFn();
      unlistenFn = null;
    }
  };
}

/**
 * Subscribe to roundtable summary events (`roundtable-summary`) from the Rust backend.
 * Fired when a discussion is aggregated into a group-level summary.
 */
export function subscribeToRoundtableSummary(
  handler: (payload: RoundtableSummaryEvent) => void,
): () => void {
  let active = true;
  let unlistenFn: (() => void) | null = null;

  const promise = listen<RoundtableSummaryEvent>("roundtable-summary", (event) => {
    if (active) handler(event.payload);
  });

  promise.then((fn) => {
    if (!active) {
      fn();
    } else {
      unlistenFn = fn;
    }
  });

  return () => {
    active = false;
    if (unlistenFn) {
      unlistenFn();
      unlistenFn = null;
    }
  };
}

/**
 * Subscribe to Worker status-change events (`worker-status`) from the Rust backend,
 * fired when a Worker transitions Busy <-> Idle during roundtable execution.
 */
export function subscribeToWorkerStatus(handler: WorkerStatusEventHandler): () => void {
  let active = true;
  let unlistenFn: (() => void) | null = null;

  const promise = listen<WorkerStatusEvent>("worker-status", (event) => {
    if (active) handler(event.payload);
  });

  promise.then((fn) => {
    if (!active) {
      fn();
    } else {
      unlistenFn = fn;
    }
  });

  return () => {
    active = false;
    if (unlistenFn) {
      unlistenFn();
      unlistenFn = null;
    }
  };
}

/**
 * F5：订阅 Worker 回合终态通知（`worker-notice`）——席位异常终止或本轮全员空闲，
 * 由后端主动推给群主，避免「派活后石沉大海」。
 */
export function subscribeToWorkerNotice(handler: WorkerNoticeEventHandler): () => void {
  let active = true;
  let unlistenFn: (() => void) | null = null;

  const promise = listen<WorkerNoticeEvent>("worker-notice", (event) => {
    if (active) handler(event.payload);
  });

  promise.then((fn) => {
    if (!active) {
      fn();
    } else {
      unlistenFn = fn;
    }
  });

  return () => {
    active = false;
    if (unlistenFn) {
      unlistenFn();
      unlistenFn = null;
    }
  };
}