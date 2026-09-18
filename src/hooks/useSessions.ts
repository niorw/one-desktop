import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import * as tauri from "../services/tauri";
import { subscribeToAgentEvents } from "../services/eventBus";
import {
  listWorkspaces,
  createWorkspace,
  renameWorkspace,
  deleteWorkspace,
  DEFAULT_WORKSPACE_ID,
  type Workspace,
} from "../services/workspace";
import type { Session } from "../types";

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);

  const loadSessions = useCallback(async () => {
    const startEpoch = createEpochRef.current;
    try {
      setLoading(true);
      const list = await tauri.listSessions();
      // 1) 只采纳未发生并发 createSession 时的结果，避免旧 load 覆盖刚创建的会话。
      // 2) 展开为全新数组：mock/某些后端可能返回同一个可变引用，直接 set 会导致
      //    React 检测不到后续 push 更新，侧栏会话列表不刷新。
      if (createEpochRef.current === startEpoch) {
        setSessions([...list]);
      }
      return list;
    } catch (err) {
      console.error("[useSessions] Failed to load sessions:", err);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const loadWorkspaces = useCallback(async () => {
    try {
      setWorkspaces(await listWorkspaces());
    } catch (err) {
      console.error("[useSessions] Failed to load workspaces:", err);
    }
  }, []);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  // 当前聚焦工作区（资源共享/隔离边界，可显式切换）。初始为默认工作区；
  // 选中会话、在该工作区建会话、点顶部 pill 都会更新它。无全局开关语义。
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(DEFAULT_WORKSPACE_ID);
  // 持最新 sessions 快照，避免 selectSession 闭包读到旧值。
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // 防止「打开页面后立即发送/新建」与 mount 时的 loadSessions 竞态：
  // 若 createSession 在 listSessions 飞行中发生，旧的 load 结果不应覆盖本地状态。
  const createEpochRef = useRef(0);

  const createSession = useCallback(async (workspaceId?: string | null) => {
    createEpochRef.current += 1;
    try {
      const session = await tauri.createSession("", "gpt-4o", "", workspaceId ?? null);
      // 幂等防御：同一 session 被重复调度时不再追加（StrictMode dev 下 setState
      // updater 可能被重复执行，追加式 updater 会产出重复 key 的兄弟节点）。
      setSessions((prev) =>
        prev.some((s) => s.id === session.id) ? prev : [session, ...prev]
      );
      setActiveSessionId(session.id);
      if (session.workspace_id) setActiveWorkspaceId(session.workspace_id);
      return session;
    } catch (err) {
      console.error("[useSessions] Failed to create session:", err);
      return null;
    }
  }, []);

  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      await tauri.deleteSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
      }
    } catch (err) {
      console.error("[useSessions] Failed to delete session:", err);
    }
  }, [activeSessionId]);

  const selectSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    // 跟随会话所属工作区（截图式「进入工作区」语义）。
    const s = sessionsRef.current.find((x) => x.id === sessionId);
    if (s?.workspace_id) setActiveWorkspaceId(s.workspace_id);
  }, []);

  // 顶部 pill：聚焦某工作区。仅更新 activeWorkspaceId，不加载/创建 session，
  // 所有初始化（加载最新 session、初始化 .one-desktop/ 目录）延迟到发送消息时。
  const focusWorkspace = useCallback((workspaceId: string) => {
    setActiveWorkspaceId(workspaceId);
  }, []);

  // ── 工作区 CRUD（删除默认工作区由后端拦截；级联删除后需同步会话列表）──
  const createWs = useCallback(
    async (name: string) => {
      const ws = await createWorkspace(name);
      await loadWorkspaces();
      return ws;
    },
    [loadWorkspaces],
  );

  const renameWs = useCallback(
    async (workspaceId: string, name: string) => {
      await renameWorkspace(workspaceId, name);
      await loadWorkspaces();
    },
    [loadWorkspaces],
  );

  const deleteWs = useCallback(
    async (workspaceId: string, moveToDefault: boolean) => {
      await deleteWorkspace(workspaceId, moveToDefault);
      await loadWorkspaces();
      await loadSessions(); // 级联删除会移除其下会话，同步前端列表
    },
    [loadWorkspaces, loadSessions],
  );

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  return {
    sessions,
    activeSessionId,
    loading,
    loadSessions,
    createSession,
    deleteSession,
    selectSession,
    setActiveSessionId,
    focusWorkspace,
    // 工作区
    workspaces,
    activeWorkspaceId,
    loadWorkspaces,
    createWorkspace: createWs,
    renameWorkspace: renameWs,
    deleteWorkspace: deleteWs,
  };
}
