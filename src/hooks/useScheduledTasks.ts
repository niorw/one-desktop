// Scheduled tasks state backed by the Rust scheduler service.
// localStorage persistence removed — the backend (SQLite) is now the source of
// truth and the scheduler engine owns lifecycle (runs, expiry, next-run).
import { useCallback, useEffect, useState } from "react";
import {
  listScheduledTasks,
  createScheduledTask,
  setTaskPaused,
  deleteScheduledTask,
  updateScheduledTask,
} from "../services/tauri";
import type { ScheduledTaskDto } from "../types";
import { friendlyError } from "../services/errors";

export type TaskStatus = "active" | "paused" | "completed" | "failed" | "expired";
export type TaskType = "cron" | "once" | "interval";
export type TaskSource = "agent_dialog" | "skill_callback" | "mcp_event" | "system_init";

export interface ScheduledTask {
  id: string;
  title: string;
  description?: string;
  type: TaskType;
  schedule: { cron?: string; once?: string; interval?: string };
  source: TaskSource;
  status: TaskStatus;
  actionType: "agent" | "shell" | "skill";
  actionPayload: string;
  runCount: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  type: TaskType;
  schedule: { cron?: string; once?: string; interval?: string };
  source?: TaskSource;
  actionType: "agent" | "shell" | "skill";
  /** Pre-serialized JSON payload for the action. */
  actionPayload: string;
}

/** Same shape as CreateTaskInput, plus the id of the task being edited. */
export interface UpdateTaskInput extends CreateTaskInput {
  id: string;
}

function mapDto(d: ScheduledTaskDto): ScheduledTask {
  return {
    id: d.id,
    title: d.title,
    description: d.description ?? undefined,
    type: d.type_ as TaskType,
    schedule: {
      cron: d.schedule.cron ?? undefined,
      once: d.schedule.once ?? undefined,
      interval: d.schedule.interval ?? undefined,
    },
    source: d.source as TaskSource,
    status: d.status as TaskStatus,
    actionType: d.action_type as "agent" | "shell" | "skill",
    actionPayload: d.action_payload,
    runCount: d.run_count,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    lastRunAt: d.last_run_at ?? undefined,
    nextRunAt: d.next_run_at ?? undefined,
  };
}

export function useScheduledTasks() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const dtos = await listScheduledTasks();
      setTasks(dtos.map(mapDto));
      setError(null);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const togglePause = useCallback(
    async (id: string) => {
      const task = tasks.find((t) => t.id === id);
      const paused = task ? task.status !== "paused" : true;
      await setTaskPaused(id, paused);
      await reload();
    },
    [tasks, reload]
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteScheduledTask(id);
      await reload();
    },
    [reload]
  );

  const removeMany = useCallback(
    async (ids: string[]) => {
      for (const id of ids) {
        await deleteScheduledTask(id);
      }
      await reload();
    },
    [reload]
  );

  const create = useCallback(
    async (input: CreateTaskInput) => {
      await createScheduledTask({
        title: input.title,
        description: input.description,
        type: input.type,
        schedule: {
          cron: input.schedule.cron ?? null,
          once: input.schedule.once ?? null,
          interval: input.schedule.interval ?? null,
        },
        source: input.source ?? "agent_dialog",
        actionType: input.actionType,
        actionPayload: input.actionPayload,
      });
      await reload();
    },
    [reload]
  );

  const update = useCallback(
    async (input: UpdateTaskInput) => {
      await updateScheduledTask({
        id: input.id,
        title: input.title,
        description: input.description,
        type: input.type,
        schedule: {
          cron: input.schedule.cron ?? null,
          once: input.schedule.once ?? null,
          interval: input.schedule.interval ?? null,
        },
        source: input.source ?? "agent_dialog",
        actionType: input.actionType,
        actionPayload: input.actionPayload,
      });
      await reload();
    },
    [reload]
  );

  return { tasks, loading, error, reload, togglePause, remove, removeMany, create, update };
}
