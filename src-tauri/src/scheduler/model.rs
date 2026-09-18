






use chrono::{DateTime, Duration as ChronoDuration, NaiveDateTime, TimeZone, Utc};
use cron::Schedule as CronSchedule;
use serde::{Deserialize, Serialize};
use std::str::FromStr;


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskType {
    Cron,
    Once,
    Interval,
}

impl TaskType {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskType::Cron => "cron",
            TaskType::Once => "once",
            TaskType::Interval => "interval",
        }
    }
    pub fn from_str(s: &str) -> Self {
        match s {
            "once" => TaskType::Once,
            "interval" => TaskType::Interval,
            _ => TaskType::Cron,
        }
    }
}










#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskStatus {
    Active,
    Paused,
    Completed,
    Failed,
    Expired,
    
    
    Running,
    
    Interrupted,
}

impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Active => "active",
            TaskStatus::Paused => "paused",
            TaskStatus::Completed => "completed",
            TaskStatus::Failed => "failed",
            TaskStatus::Expired => "expired",
            TaskStatus::Running => "running",
            TaskStatus::Interrupted => "interrupted",
        }
    }
    pub fn from_str(s: &str) -> Self {
        match s {
            "paused" => TaskStatus::Paused,
            "completed" => TaskStatus::Completed,
            "failed" => TaskStatus::Failed,
            "expired" => TaskStatus::Expired,
            "running" => TaskStatus::Running,
            "interrupted" => TaskStatus::Interrupted,
            _ => TaskStatus::Active,
        }
    }
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskSource {
    AgentDialog,
    SkillCallback,
    McpEvent,
    SystemInit,
}

impl TaskSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskSource::AgentDialog => "agent_dialog",
            TaskSource::SkillCallback => "skill_callback",
            TaskSource::McpEvent => "mcp_event",
            TaskSource::SystemInit => "system_init",
        }
    }
    pub fn from_str(s: &str) -> Self {
        match s {
            "skill_callback" => TaskSource::SkillCallback,
            "mcp_event" => TaskSource::McpEvent,
            "system_init" => TaskSource::SystemInit,
            _ => TaskSource::AgentDialog,
        }
    }
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionType {
    Agent,
    Shell,
    Skill,
}

impl ActionType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ActionType::Agent => "agent",
            ActionType::Shell => "shell",
            ActionType::Skill => "skill",
        }
    }
    pub fn from_str(s: &str) -> Self {
        match s {
            "shell" => ActionType::Shell,
            "skill" => ActionType::Skill,
            _ => ActionType::Agent,
        }
    }
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentAction {
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellAction {
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillAction {
    pub skill_id: String,
}


pub enum Schedule {
    Cron(CronSchedule),
    Once(DateTime<Utc>),
    Interval(ChronoDuration),
}

impl Schedule {
    
    pub fn parse(kind: &str, expr: &str) -> Result<Self, String> {
        match kind {
            "cron" => {
                let s = CronSchedule::from_str(expr)
                    .map_err(|e| format!("无效的 cron 表达式: {}", e))?;
                Ok(Schedule::Cron(s))
            }
            "once" => {
                let dt = if let Ok(d) = DateTime::parse_from_rfc3339(expr) {
                    d.with_timezone(&Utc)
                } else if let Ok(n) = NaiveDateTime::parse_from_str(expr, "%Y-%m-%dT%H:%M") {
                    Utc.from_utc_datetime(&n)
                } else {
                    return Err(format!("无效时间: {}", expr));
                };
                Ok(Schedule::Once(dt))
            }
            "interval" => {
                let d = parse_duration(expr)?;
                Ok(Schedule::Interval(d))
            }
            other => Err(format!("未知调度类型: {}", other)),
        }
    }

    
    pub fn next_after(&self, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        match self {
            Schedule::Cron(s) => s.after(&after).next(),
            Schedule::Once(t) => {
                if *t > after {
                    Some(*t)
                } else {
                    None
                }
            }
            Schedule::Interval(d) => Some(after + *d),
        }
    }
}


pub fn parse_duration(s: &str) -> Result<ChronoDuration, String> {
    let s = s.trim();
    let split = s.find(|c: char| c.is_alphabetic()).unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    let num: i64 = num.trim().parse().map_err(|_| format!("无效间隔: {}", s))?;
    let secs = match unit {
        "s" => num,
        "m" => num * 60,
        "h" => num * 3600,
        "d" => num * 86400,
        other => return Err(format!("未知单位: {}", other)),
    };
    Ok(ChronoDuration::seconds(secs))
}


#[derive(Debug, Clone)]
pub struct ScheduledTask {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub type_: TaskType,
    pub schedule_expr: String,
    pub action_type: ActionType,
    pub action_payload: String,
    pub source: TaskSource,
    pub status: TaskStatus,
    pub last_run_at: Option<String>,
    pub next_run_at: Option<String>,
    pub run_count: i64,
    pub created_at: String,
    pub updated_at: String,
}


#[derive(Debug, Clone)]
pub struct CreateTaskPayload {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub type_: TaskType,
    pub schedule_expr: String,
    pub action_type: ActionType,
    pub action_payload: String,
    pub source: TaskSource,
    pub next_run_at: Option<String>,
}

impl ScheduledTask {
    
    pub fn next_occurrence(&self) -> Option<String> {
        Schedule::parse(self.type_.as_str(), &self.schedule_expr)
            .ok()
            .and_then(|s| s.next_after(Utc::now()))
            .map(|d| d.to_rfc3339())
    }

    
    pub fn to_dto(&self) -> crate::types::ScheduledTaskDto {
        let schedule = match self.type_ {
            TaskType::Cron => crate::types::TaskScheduleDto {
                cron: Some(self.schedule_expr.clone()),
                ..Default::default()
            },
            TaskType::Once => crate::types::TaskScheduleDto {
                once: Some(self.schedule_expr.clone()),
                ..Default::default()
            },
            TaskType::Interval => crate::types::TaskScheduleDto {
                interval: Some(self.schedule_expr.clone()),
                ..Default::default()
            },
        };
        crate::types::ScheduledTaskDto {
            id: self.id.clone(),
            title: self.title.clone(),
            description: self.description.clone(),
            type_: self.type_.as_str().to_string(),
            schedule,
            source: self.source.as_str().to_string(),
            status: self.status.as_str().to_string(),
            action_type: self.action_type.as_str().to_string(),
            action_payload: self.action_payload.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            last_run_at: self.last_run_at.clone(),
            next_run_at: self.next_run_at.clone(),
            run_count: self.run_count,
        }
    }
}
