// Calendar mode command layer — macOS-style schedule (title + time + color + note).
//
// Kept separate from chat/group so each nav mode owns its own command surface.
// `tauri.ts` re-exports this for legacy callers.
import { invoke } from "@tauri-apps/api/core";
import type { CalendarEvent } from "../types";

export type { CalendarEvent };

/** 新建日历事件。 */
export async function createCalendarEvent(p: {
  date_key: string;
  title: string;
  content?: string;
  time_start?: string;
  time_end?: string;
  color?: string;
  kind?: string;
}): Promise<CalendarEvent> {
  return invoke("calendar_event_create", { payload: p });
}

export async function listCalendarEventsByMonth(p: {
  year: number;
  month: number;
}): Promise<CalendarEvent[]> {
  return invoke("calendar_event_list_by_month", { payload: p });
}

export async function updateCalendarEvent(p: {
  id: string;
  title?: string;
  content?: string;
  time_start?: string | null;
  time_end?: string | null;
  color?: string;
  kind?: string;
}): Promise<CalendarEvent> {
  return invoke("calendar_event_update", { payload: p });
}

export async function deleteCalendarEvent(id: string): Promise<void> {
  return invoke("calendar_event_delete", { payload: { id } });
}

/** 手动发送一条测试系统通知，验证 macOS 通知通道是否接通。 */
export async function testReminderNotification(): Promise<void> {
  return invoke("reminder_notify_test");
}
