



use crate::scheduler::engine::Scheduler;
use crate::scheduler::model::*;
use crate::storage::repository::Repository;
use crate::storage::task_repo::TaskRepository;
use crate::types::{ScheduledTaskDto, TaskScheduleDto};
use std::sync::Arc;
use tauri::State;


pub struct SchedulerState(pub Arc<Scheduler>);

#[tauri::command]
pub async fn list_scheduled_tasks(
    state: State<'_, SchedulerState>,
) -> Result<Vec<ScheduledTaskDto>, String> {
    TaskRepository::new(&state.0.db)
        .find_all(())
        .map_err(|e| e.to_string())
        .map(|v| v.into_iter().map(|t| t.to_dto()).collect())
}

#[tauri::command]
pub async fn create_scheduled_task(
    state: State<'_, SchedulerState>,
    title: String,
    description: Option<String>,
    type_: String,
    schedule: TaskScheduleDto,
    source: String,
    action_type: String,
    action_payload: String,
) -> Result<ScheduledTaskDto, String> {
    let (t_type, expr) = match type_.as_str() {
        "once" => (TaskType::Once, schedule.once.ok_or("缺少 once 时间")?),
        "interval" => (
            TaskType::Interval,
            schedule.interval.ok_or("缺少 interval 表达式")?,
        ),
        _ => (TaskType::Cron, schedule.cron.ok_or("缺少 cron 表达式")?),
    };
    let next = Schedule::parse(t_type.as_str(), &expr)
        .map_err(|e| e.to_string())?
        .next_after(chrono::Utc::now())
        .map(|d| d.to_rfc3339());

    let payload = CreateTaskPayload {
        id: uuid::Uuid::new_v4().to_string(),
        title,
        description,
        type_: t_type,
        schedule_expr: expr,
        action_type: ActionType::from_str(&action_type),
        action_payload,
        source: TaskSource::from_str(&source),
        next_run_at: next,
    };
    TaskRepository::new(&state.0.db)
        .create(payload)
        .map_err(|e| e.to_string())
        .map(|t| t.to_dto())
}

#[tauri::command]
pub async fn set_task_paused(
    state: State<'_, SchedulerState>,
    id: String,
    paused: bool,
) -> Result<(), String> {
    let status = if paused {
        TaskStatus::Paused
    } else {
        TaskStatus::Active
    };
    TaskRepository::new(&state.0.db)
        .set_status(&id, status)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_scheduled_task(
    state: State<'_, SchedulerState>,
    id: String,
) -> Result<(), String> {
    TaskRepository::new(&state.0.db)
        .delete(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_scheduled_task(
    state: State<'_, SchedulerState>,
    id: String,
    title: String,
    description: Option<String>,
    type_: String,
    schedule: TaskScheduleDto,
    source: String,
    action_type: String,
    action_payload: String,
) -> Result<ScheduledTaskDto, String> {
    
    
    let (t_type, expr) = match type_.as_str() {
        "once" => (TaskType::Once, schedule.once.ok_or("缺少 once 时间")?),
        "interval" => (
            TaskType::Interval,
            schedule.interval.ok_or("缺少 interval 表达式")?,
        ),
        _ => (TaskType::Cron, schedule.cron.ok_or("缺少 cron 表达式")?),
    };
    let next = Schedule::parse(t_type.as_str(), &expr)
        .map_err(|e| e.to_string())?
        .next_after(chrono::Utc::now())
        .map(|d| d.to_rfc3339());

    
    let existing = TaskRepository::new(&state.0.db)
        .find_by_id(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "任务不存在".to_string())?;
    let next_run_at = if existing.schedule_expr == expr && existing.type_ == t_type {
        existing.next_run_at.clone()
    } else {
        next
    };

    TaskRepository::new(&state.0.db)
        .update(
            &id,
            &title,
            description.as_deref(),
            t_type.as_str(),
            &expr,
            &source,
            &action_type,
            &action_payload,
            next_run_at.as_deref(),
        )
        .map_err(|e| e.to_string())?;

    TaskRepository::new(&state.0.db)
        .find_by_id(&id)
        .map_err(|e| e.to_string())?
        .map(|t| t.to_dto())
        .ok_or_else(|| "更新后任务不存在".to_string())
}

#[tauri::command]
pub async fn run_task_now(state: State<'_, SchedulerState>, id: String) -> Result<(), String> {
    let task = TaskRepository::new(&state.0.db)
        .find_by_id(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "任务不存在".to_string())?;
    state.0.clone().execute_now(task);
    Ok(())
}
