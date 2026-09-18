




use crate::error::AgentError;
use crate::storage::connection::DbConnection;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub struct CalendarState {
    pub db: Arc<DbConnection>,
}

#[derive(Deserialize)]
pub struct CalendarEventCreate {
    pub date_key: String,
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub time_start: Option<String>,
    #[serde(default)]
    pub time_end: Option<String>,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default = "default_kind")]
    pub kind: String,
}

fn default_color() -> String {
    "#0a84ff".into()
}


fn default_kind() -> String {
    "schedule".into()
}

#[derive(Deserialize)]
pub struct CalendarEventListByMonth {
    pub year: i32,
    pub month: i32,
}

#[derive(Deserialize)]
pub struct CalendarEventUpdate {
    pub id: String,
    pub title: Option<String>,
    pub content: Option<String>,
    pub time_start: Option<Option<String>>,
    pub time_end: Option<Option<String>>,
    pub color: Option<String>,
    pub kind: Option<String>,
}

#[derive(Deserialize)]
pub struct CalendarEventDelete {
    pub id: String,
}

#[derive(Serialize, Clone)]
pub struct CalendarEvent {
    pub id: String,
    pub date_key: String,
    pub title: String,
    pub content: String,
    pub time_start: Option<String>,
    pub time_end: Option<String>,
    pub color: String,
    pub kind: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[tauri::command]
pub async fn calendar_event_create(
    app: AppHandle,
    payload: CalendarEventCreate,
) -> Result<CalendarEvent, AgentError> {
    let db = app.state::<CalendarState>();
    let title = payload.title.trim().to_string();
    if title.is_empty() {
        return Err(AgentError::Config {
            message: "事件标题不能为空".into(),
        });
    }
    let now = chrono::Utc::now().timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let kind = if payload.kind == "reminder" { "reminder" } else { "schedule" };
    db.db
        .with_conn_mut(|conn| {
            conn.execute(
                "INSERT INTO calendar_events (id, date_key, title, content, time_start, time_end, color, kind, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![id, payload.date_key, title, payload.content, payload.time_start, payload.time_end, payload.color, kind, now, now],
            )
        })
        .map_err(|e| AgentError::Storage { message: e.to_string() })?;
    Ok(CalendarEvent {
        id,
        date_key: payload.date_key,
        title,
        content: payload.content,
        time_start: payload.time_start,
        time_end: payload.time_end,
        color: payload.color,
        kind: kind.to_string(),
        created_at: now,
        updated_at: now,
    })
}

#[tauri::command]
pub async fn calendar_event_list_by_month(
    app: AppHandle,
    payload: CalendarEventListByMonth,
) -> Result<Vec<CalendarEvent>, AgentError> {
    let db = app.state::<CalendarState>();
    let prefix = format!("{:04}-{:02}-", payload.year, payload.month);
    db.db
        .with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, date_key, title, content, time_start, time_end, color, kind, created_at, updated_at
                 FROM calendar_events WHERE date_key LIKE ?1 ORDER BY time_start ASC, created_at ASC",
            )?;
            let items = stmt
                .query_map(params![format!("{}%", prefix)], |row| {
                    Ok(CalendarEvent {
                        id: row.get(0)?,
                        date_key: row.get(1)?,
                        title: row.get(2)?,
                        content: row.get(3)?,
                        time_start: row.get(4)?,
                        time_end: row.get(5)?,
                        color: row.get(6)?,
                        kind: row.get(7)?,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(items)
        })
        .map_err(|e| AgentError::Storage { message: e.to_string() })
}

#[tauri::command]
pub async fn calendar_event_update(
    app: AppHandle,
    payload: CalendarEventUpdate,
) -> Result<CalendarEvent, AgentError> {
    let db = app.state::<CalendarState>();
    let now = chrono::Utc::now().timestamp();

    
    let mut sets = Vec::<(&str, Box<dyn rusqlite::types::ToSql>)>::new();
    if let Some(ref t) = payload.title { sets.push(("title", Box::new(t.clone()))); }
    if let Some(ref c) = payload.content { sets.push(("content", Box::new(c.clone()))); }
    if let Some(ref ts) = payload.time_start {
        sets.push(("time_start", Box::new(ts.as_ref().map(|s| s.clone()))));
        
        sets.push(("notified_at", Box::new(Option::<i64>::None)));
    }
    if let Some(ref te) = payload.time_end {
        sets.push(("time_end", Box::new(te.as_ref().map(|s| s.clone()))));
    }
    if let Some(ref cl) = payload.color { sets.push(("color", Box::new(cl.clone()))); }
    if let Some(ref k) = payload.kind { sets.push(("kind", Box::new(k.clone()))); }

    if sets.is_empty() {
        return Err(AgentError::Config { message: "没有要更新的字段".into() });
    }

    let (sql_parts, values): (Vec<&str>, Vec<Box<dyn rusqlite::types::ToSql>>) =
        sets.into_iter().unzip();
    let set_clause: String = sql_parts.iter().map(|c| format!("{}=?", c)).collect::<Vec<_>>().join(", ");

    let mut all_values: Vec<Box<dyn rusqlite::types::ToSql>> = values;
    all_values.push(Box::new(payload.id.clone()));
    all_values.push(Box::new(now));

    let sql = format!(
        "UPDATE calendar_events SET {}, updated_at=?{} WHERE id=?{}",
        set_clause,
        all_values.len() - 2,
        all_values.len() - 1,
    );

    let refs: Vec<&dyn rusqlite::types::ToSql> = all_values.iter().map(|v| v.as_ref()).collect();
    let affected = db.db.with_conn_mut(|conn| conn.execute(&sql, refs.as_slice()))
        .map_err(|e| AgentError::Storage { message: e.to_string() })?;

    if affected == 0 {
        return Err(AgentError::Config { message: "事件不存在".into() });
    }

    db.db.with_conn(|conn| {
        conn.query_row(
            "SELECT id, date_key, title, content, time_start, time_end, color, kind, created_at, updated_at FROM calendar_events WHERE id = ?1",
            params![payload.id], |row| {
                Ok(CalendarEvent {
                    id: row.get(0)?, date_key: row.get(1)?, title: row.get(2)?,
                    content: row.get(3)?, time_start: row.get(4)?, time_end: row.get(5)?,
                    color: row.get(6)?, kind: row.get(7)?,
                    created_at: row.get(8)?, updated_at: row.get(9)?,
                })
            })
        }).map_err(|e| AgentError::Storage { message: e.to_string() })
}

#[tauri::command]
pub async fn calendar_event_delete(
    app: AppHandle,
    payload: CalendarEventDelete,
) -> Result<(), AgentError> {
    let db = app.state::<CalendarState>();
    db.db
        .with_conn_mut(|conn| {
            conn.execute("DELETE FROM calendar_events WHERE id = ?1", params![payload.id])
        })
        .map_err(|e| AgentError::Storage { message: e.to_string() })?;
    Ok(())
}
