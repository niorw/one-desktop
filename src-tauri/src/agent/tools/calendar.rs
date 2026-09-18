






use chrono::Datelike;
use crate::agent::tool_registry::{ExecutableTool, ToolDef, ToolExecContext};
use crate::storage::connection::DbConnection;
use async_trait::async_trait;
use rusqlite::params;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;



#[derive(Clone)]
pub struct CalendarTool {
    db: Arc<DbConnection>,
    op: &'static str,
}

impl CalendarTool {
    pub fn new(db: Arc<DbConnection>, op: &'static str) -> Self {
        Self { db, op }
    }
}


#[derive(Serialize)]
struct CalEvent {
    id: String,
    date_key: String,
    title: String,
    content: String,
    time_start: Option<String>,
    time_end: Option<String>,
    color: String,
    kind: String,
    created_at: i64,
    updated_at: i64,
}

fn row_to_event(row: &rusqlite::Row) -> rusqlite::Result<CalEvent> {
    Ok(CalEvent {
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
}

fn default_color() -> String {
    "#0a84ff".into()
}
fn default_kind() -> String {
    "schedule".into()
}

#[async_trait]
impl ExecutableTool for CalendarTool {
    async fn execute(&self, args: Value, _ctx: &ToolExecContext) -> Result<String, String> {
        match self.op {
            "create" => self.create(args),
            "list" => self.list(args),
            "update" => self.update(args),
            "delete" => self.delete(args),
            other => Err(format!("未知日历工具操作: {}", other)),
        }
    }
}

impl CalendarTool {
    fn create(&self, args: Value) -> Result<String, String> {
        let date_key = args["date_key"]
            .as_str()
            .ok_or("缺少必填参数 date_key（格式 YYYY-MM-DD）")?;
        let title = args["title"].as_str().ok_or("缺少必填参数 title（事件标题）")?;
        let title = title.trim();
        if title.is_empty() {
            return Err("事件标题不能为空".into());
        }
        let content = args["content"].as_str().unwrap_or("").to_string();
        let time_start = args["time_start"].as_str().map(|s| s.to_string());
        let time_end = args["time_end"].as_str().map(|s| s.to_string());
        let color = args["color"].as_str().map(|s| s.to_string()).unwrap_or_else(default_color);
        let kind = match args["kind"].as_str() {
            Some("reminder") => "reminder".to_string(),
            _ => default_kind(),
        };
        let now = chrono::Utc::now().timestamp();
        let id = uuid::Uuid::new_v4().to_string();

        self.db
            .with_conn_mut(|conn| {
                conn.execute(
                    "INSERT INTO calendar_events (id, date_key, title, content, time_start, time_end, color, kind, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![id, date_key, title, content, time_start, time_end, color, kind, now, now],
                )
            })
            .map_err(|e| format!("写入日历事件失败: {}", e))?;

        Ok(format!(
            "已创建日历事件 {id}（{date_key} · {title}）。返回 JSON 供后续引用：\n{}",
            serde_json::to_string(&json!({
                "id": id, "date_key": date_key, "title": title,
                "time_start": time_start, "time_end": time_end, "color": color, "kind": kind
            }))
            .unwrap_or_default()
        ))
    }

    fn list(&self, args: Value) -> Result<String, String> {
        
        let (year, month) = (
            args["year"].as_i64(),
            args["month"].as_i64(),
        );
        let prefix: String = if let (Some(y), Some(m)) = (year, month) {
            format!("{:04}-{:02}-", y, m)
        } else if let Some(dk) = args["date_key"].as_str() {
            dk.to_string()
        } else {
            let now = chrono::Utc::now();
            format!("{:04}-{:02}-", now.year(), now.month())
        };

        let events = self
            .db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT id, date_key, title, content, time_start, time_end, color, kind, created_at, updated_at
                     FROM calendar_events WHERE date_key LIKE ?1 ORDER BY time_start ASC, created_at ASC",
                )?;
                let items = stmt
                    .query_map(params![format!("{}%", prefix)], row_to_event)?
                    .filter_map(|r| r.ok())
                    .collect::<Vec<CalEvent>>();
                Ok(items)
            })
            .map_err(|e| format!("查询日历事件失败: {}", e))?;

        let json = serde_json::to_string(&events).map_err(|e| format!("序列化失败: {}", e))?;
        Ok(format!("找到 {} 条日历事件（范围 {}）：\n{}", events.len(), prefix.trim_end_matches('-'), json))
    }

    fn update(&self, args: Value) -> Result<String, String> {
        let id = args["id"].as_str().ok_or("缺少必填参数 id（事件 id）")?;
        let title = args["title"].as_str().map(|s| s.trim().to_string());
        let content = args["content"].as_str().map(|s| s.to_string());
        let time_start = args.get("time_start").and_then(|v| v.as_str().map(|s| s.to_string()));
        let time_end = args.get("time_end").and_then(|v| v.as_str().map(|s| s.to_string()));
        let color = args["color"].as_str().map(|s| s.to_string());
        let kind = args["kind"].as_str().map(|s| {
            if s == "reminder" { "reminder".to_string() } else { "schedule".to_string() }
        });

        if title.is_none()
            && content.is_none()
            && time_start.is_none()
            && time_end.is_none()
            && color.is_none()
            && kind.is_none()
        {
            return Err("没有提供任何要更新的字段（title/content/time_start/time_end/color/kind）".into());
        }

        let now = chrono::Utc::now().timestamp();
        let mut sets: Vec<(&str, Box<dyn rusqlite::types::ToSql>)> = Vec::new();
        if let Some(ref t) = title { sets.push(("title", Box::new(t.clone()))); }
        if let Some(ref c) = content { sets.push(("content", Box::new(c.clone()))); }
        if let Some(ref ts) = time_start { sets.push(("time_start", Box::new(ts.clone()))); }
        if let Some(ref te) = time_end { sets.push(("time_end", Box::new(te.clone()))); }
        if let Some(ref cl) = color { sets.push(("color", Box::new(cl.clone()))); }
        if let Some(ref k) = kind { sets.push(("kind", Box::new(k.clone()))); }

        let (sql_parts, values): (Vec<&str>, Vec<Box<dyn rusqlite::types::ToSql>>) =
            sets.into_iter().unzip();
        let n = sql_parts.len();
        let set_clause: String = sql_parts
            .iter()
            .enumerate()
            .map(|(i, c)| format!("{}=?{}", c, i + 1))
            .collect::<Vec<_>>()
            .join(", ");

        let mut all_values: Vec<Box<dyn rusqlite::types::ToSql>> = values;
        all_values.push(Box::new(now));
        all_values.push(Box::new(id.to_string()));

        let sql = format!(
            "UPDATE calendar_events SET {}, updated_at=?{} WHERE id=?{}",
            set_clause,
            n + 1,
            n + 2,
        );
        let refs: Vec<&dyn rusqlite::types::ToSql> = all_values.iter().map(|v| v.as_ref()).collect();

        let affected = self
            .db
            .with_conn_mut(|conn| conn.execute(&sql, refs.as_slice()))
            .map_err(|e| format!("更新日历事件失败: {}", e))?;
        if affected == 0 {
            return Err("日历事件不存在（id 无效）".into());
        }
        Ok(format!("已更新日历事件 {id}。", id = id))
    }

    fn delete(&self, args: Value) -> Result<String, String> {
        let id = args["id"].as_str().ok_or("缺少必填参数 id（事件 id）")?;
        let affected = self
            .db
            .with_conn_mut(|conn| conn.execute("DELETE FROM calendar_events WHERE id = ?1", params![id]))
            .map_err(|e| format!("删除日历事件失败: {}", e))?;
        if affected == 0 {
            return Err("日历事件不存在（id 无效）".into());
        }
        Ok(format!("已删除日历事件 {id}。", id = id))
    }
}

impl From<CalendarTool> for ToolDef {
    fn from(t: CalendarTool) -> Self {
        let (name, description, parameters) = match t.op {
            "create" => (
                "calendar_event_create",
                concat!(
                    "创建一条日历事件（某天的具体安排或提醒）。",
                    "参数 date_key 为 YYYY-MM-DD 格式的日期；title 为标题（必填）；",
                    "可选 content 备注、time_start/time_end（HH:mm 时间段）、color（色条十六进制）、",
                    "kind（schedule=日程 / reminder=提醒事项）。返回新建事件的 id 与摘要。"
                ),
                json!({
                    "type": "object",
                    "properties": {
                        "date_key": { "type": "string", "description": "事件日期，格式 YYYY-MM-DD，例如 2026-08-07" },
                        "title": { "type": "string", "description": "事件标题（必填，不可为空）" },
                        "content": { "type": "string", "description": "备注/详情（可选）" },
                        "time_start": { "type": "string", "description": "开始时间 HH:mm（可选）" },
                        "time_end": { "type": "string", "description": "结束时间 HH:mm（可选）" },
                        "color": { "type": "string", "description": "色条颜色，十六进制如 #0a84ff（可选，默认蓝）" },
                        "kind": { "type": "string", "enum": ["schedule", "reminder"], "description": "类型：schedule=日程 / reminder=提醒事项（可选，默认 schedule）" }
                    },
                    "required": ["date_key", "title"]
                }),
            ),
            "list" => (
                "calendar_event_list",
                concat!(
                    "查询某一范围的日历事件。优先用 year+month（数字）查询整月；",
                    "或传 date_key 前缀（如 2026-08 或 2026-08-07）查询；",
                    "都不传则默认查询本月。返回该范围下所有事件（含 id、时间、色条等）。"
                ),
                json!({
                    "type": "object",
                    "properties": {
                        "year": { "type": "integer", "description": "年份（可选，与 month 搭配查整月）" },
                        "month": { "type": "integer", "description": "月份 1-12（可选，与 year 搭配查整月）" },
                        "date_key": { "type": "string", "description": "日期前缀，如 2026-08 或 2026-08-07（可选）" }
                    },
                    "required": []
                }),
            ),
            "update" => (
                "calendar_event_update",
                concat!(
                    "更新一条已有日历事件。id 必填；其余字段均为可选，只更新传入的字段。",
                    "常用于改标题、改时间、改色条或切换 schedule/reminder 类型。"
                ),
                json!({
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "要更新的事件 id（必填）" },
                        "title": { "type": "string", "description": "新标题（可选）" },
                        "content": { "type": "string", "description": "新备注（可选）" },
                        "time_start": { "type": "string", "description": "新开始时间 HH:mm（可选）" },
                        "time_end": { "type": "string", "description": "新结束时间 HH:mm（可选）" },
                        "color": { "type": "string", "description": "新色条颜色（可选）" },
                        "kind": { "type": "string", "enum": ["schedule", "reminder"], "description": "新类型（可选）" }
                    },
                    "required": ["id"]
                }),
            ),
            "delete" => (
                "calendar_event_delete",
                "删除一条日历事件（按 id）。删除后不可恢复。",
                json!({
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "要删除的事件 id（必填）" }
                    },
                    "required": ["id"]
                }),
            ),
            other => (
                other,
                "未知日历工具操作",
                json!({ "type": "object", "properties": {} }),
            ),
        };
        ToolDef {
            name: name.into(),
            description: description.into(),
            parameters,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_db() -> Arc<DbConnection> {
        let dir = PathBuf::from(std::env::temp_dir()).join(format!("onedesktop_cal_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Arc::new(DbConnection::open(&dir).expect("open test db"))
    }

    #[test]
    fn create_then_list_roundtrip() {
        let db = temp_db();
        let tool = CalendarTool::new(db.clone(), "create");
        let out = crate::agent::tool_registry::ToolExecContext::default();

        let created = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(tool.execute(
                json!({ "date_key": "2026-08-07", "title": "团队周会", "time_start": "10:00", "kind": "schedule" }),
                &out,
            ))
            .unwrap();
        assert!(created.contains("已创建日历事件"), "create should report id: {}", created);

        let listed = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(CalendarTool::new(db.clone(), "list").execute(
                json!({ "date_key": "2026-08" }),
                &out,
            ))
            .unwrap();
        assert!(listed.contains("团队周会"), "list should surface created event: {}", listed);
        assert!(listed.contains("\"id\""), "list output should be JSON");
    }

    #[test]
    fn update_then_delete() {
        let db = temp_db();
        let out = crate::agent::tool_registry::ToolExecContext::default();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let created = rt
            .block_on(CalendarTool::new(db.clone(), "create").execute(
                json!({ "date_key": "2026-08-07", "title": "旧标题" }),
                &out,
            ))
            .unwrap();
        let id = created.split("事件 ").nth(1).unwrap().split('（').next().unwrap().to_string();

        rt.block_on(CalendarTool::new(db.clone(), "update").execute(
            json!({ "id": id, "title": "新标题", "content": "备注" }),
            &out,
        ))
        .unwrap();

        let listed = rt
            .block_on(CalendarTool::new(db.clone(), "list").execute(json!({ "date_key": "2026-08" }), &out))
            .unwrap();
        assert!(listed.contains("新标题"), "update should change title: {}", listed);

        rt.block_on(CalendarTool::new(db.clone(), "delete").execute(json!({ "id": id }), &out))
            .unwrap();
        let after = rt
            .block_on(CalendarTool::new(db.clone(), "list").execute(json!({ "date_key": "2026-08" }), &out))
            .unwrap();
        assert!(!after.contains("新标题"), "after delete, event should be gone: {}", after);
    }
}
