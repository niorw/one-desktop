






use crate::agent::tool_registry::{ExecutableTool, ToolDef, ToolExecContext};
use crate::scheduler::model::*;
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;
use crate::storage::task_repo::TaskRepository;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;


#[derive(Clone)]
pub struct AutomationTool {
    db: Arc<DbConnection>,
    op: &'static str,
}

impl AutomationTool {
    pub fn new(db: Arc<DbConnection>, op: &'static str) -> Self {
        Self { db, op }
    }
}


fn resolve_schedule(
    type_: &str,
    schedule_expr: &str,
) -> Result<(TaskType, String, Option<String>), String> {
    let t_type = TaskType::from_str(type_);
    let kind = t_type.as_str();
    let next = Schedule::parse(kind, schedule_expr)
        .map_err(|e| format!("调度表达式无效（{}）：{}", kind, e))?
        .next_after(chrono::Utc::now())
        .map(|d| d.to_rfc3339());
    Ok((t_type, schedule_expr.to_string(), next))
}

#[async_trait]
impl ExecutableTool for AutomationTool {
    async fn execute(&self, args: Value, _ctx: &ToolExecContext) -> Result<String, String> {
        match self.op {
            "list" => self.list(args),
            "create" => self.create(args),
            "update" => self.update(args),
            "delete" => self.delete(args),
            "set_enabled" => self.set_enabled(args),
            other => Err(format!("未知自动化工具操作: {}", other)),
        }
    }
}

impl AutomationTool {
    fn list(&self, args: Value) -> Result<String, String> {
        let repo = TaskRepository::new(self.db.as_ref());
        let mut tasks = repo
            .find_all(())
            .map_err(|e| format!("查询定时任务失败: {}", e))?;
        
        if let Some(status) = args["status"].as_str() {
            tasks.retain(|t| t.status.as_str() == status);
        }
        let dtos: Vec<_> = tasks.iter().map(|t| t.to_dto()).collect();
        let json = serde_json::to_string(&dtos).map_err(|e| format!("序列化失败: {}", e))?;
        Ok(format!("找到 {} 条定时任务：\n{}", dtos.len(), json))
    }

    fn create(&self, args: Value) -> Result<String, String> {
        let title = args["title"].as_str().ok_or("缺少必填参数 title（任务标题）")?;
        let title = title.trim().to_string();
        if title.is_empty() {
            return Err("任务标题不能为空".into());
        }
        let description = args["description"].as_str().map(|s| s.to_string());
        let type_ = args["type"].as_str().unwrap_or("cron").to_string();
        let schedule_expr = args["schedule_expr"]
            .as_str()
            .ok_or("缺少必填参数 schedule_expr（cron/once/interval 表达式）")?;
        let action_type = args["action_type"].as_str().unwrap_or("agent").to_string();
        let action_payload = args["action_payload"]
            .as_str()
            .ok_or("缺少必填参数 action_payload（触发时执行的动作 JSON 字符串）")?;
        let source = args["source"].as_str().unwrap_or("agent_dialog").to_string();

        let (t_type, expr, next) = resolve_schedule(&type_, schedule_expr)?;

        let payload = CreateTaskPayload {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            description,
            type_: t_type,
            schedule_expr: expr,
            action_type: ActionType::from_str(&action_type),
            action_payload: action_payload.to_string(),
            source: TaskSource::from_str(&source),
            next_run_at: next,
        };
        let task = TaskRepository::new(self.db.as_ref())
            .create(payload)
            .map_err(|e| format!("创建定时任务失败: {}", e))?;
        let dto = task.to_dto();
        let json = serde_json::to_string(&dto).map_err(|e| format!("序列化失败: {}", e))?;
        Ok(format!(
            "已创建定时任务 `{}`（下次触发 {}）。返回 JSON：\n{}",
            dto.title,
            dto.next_run_at.as_deref().unwrap_or("无"),
            json
        ))
    }

    fn update(&self, args: Value) -> Result<String, String> {
        let id = args["id"].as_str().ok_or("缺少必填参数 id（任务 id）")?;
        let title = args["title"].as_str().ok_or("缺少必填参数 title")?;
        let description = args["description"].as_str().map(|s| s.to_string());
        let type_ = args["type"].as_str().unwrap_or("cron").to_string();
        let schedule_expr = args["schedule_expr"]
            .as_str()
            .ok_or("缺少必填参数 schedule_expr")?;
        let source = args["source"].as_str().unwrap_or("agent_dialog").to_string();
        let action_type = args["action_type"].as_str().unwrap_or("agent").to_string();
        let action_payload = args["action_payload"]
            .as_str()
            .ok_or("缺少必填参数 action_payload")?;

        let repo = TaskRepository::new(self.db.as_ref());
        let existing = repo
            .find_by_id(id)
            .map_err(|e| format!("查询任务失败: {}", e))?
            .ok_or_else(|| "定时任务不存在（id 无效）".to_string())?;

        let (t_type, expr, next) = resolve_schedule(&type_, schedule_expr)?;
        
        let next_run_at = if existing.schedule_expr == expr && existing.type_ == t_type {
            existing.next_run_at.clone()
        } else {
            next
        };

        repo.update(
            id,
            title,
            description.as_deref(),
            t_type.as_str(),
            &expr,
            &source,
            &action_type,
            action_payload,
            next_run_at.as_deref(),
        )
        .map_err(|e| format!("更新定时任务失败: {}", e))?;

        let updated = repo
            .find_by_id(id)
            .map_err(|e| format!("回查失败: {}", e))?
            .ok_or_else(|| "更新后任务不存在".to_string())?;
        let json = serde_json::to_string(&updated.to_dto()).map_err(|e| format!("序列化失败: {}", e))?;
        Ok(format!("已更新定时任务 `{}`。返回 JSON：\n{}", updated.title, json))
    }

    fn delete(&self, args: Value) -> Result<String, String> {
        let id = args["id"].as_str().ok_or("缺少必填参数 id（任务 id）")?;
        TaskRepository::new(self.db.as_ref())
            .delete(id)
            .map_err(|e| format!("删除定时任务失败: {}", e))?;
        Ok(format!("已删除定时任务 {id}。", id = id))
    }

    fn set_enabled(&self, args: Value) -> Result<String, String> {
        let id = args["id"].as_str().ok_or("缺少必填参数 id（任务 id）")?;
        let enabled = args["enabled"]
            .as_bool()
            .ok_or("缺少必填参数 enabled（true=启用/active，false=暂停/paused）")?;
        let status = if enabled { TaskStatus::Active } else { TaskStatus::Paused };
        TaskRepository::new(self.db.as_ref())
            .set_status(id, status)
            .map_err(|e| format!("切换自动化状态失败: {}", e))?;
        Ok(format!(
            "已{}定时任务 {id}。",
            if enabled { "启用" } else { "暂停" },
            id = id
        ))
    }
}

impl From<AutomationTool> for ToolDef {
    fn from(t: AutomationTool) -> Self {
        let (name, description, parameters) = match t.op {
            "list" => (
                "automation_list",
                concat!(
                    "列出所有自动化（定时任务）。可选 status 过滤（active/paused/...）。",
                    "返回每个任务的 id、标题、调度类型、表达式、动作与下次触发时间，供后续更新/删除引用。"
                ),
                json!({
                    "type": "object",
                    "properties": {
                        "status": { "type": "string", "description": "按状态过滤（可选）：active / paused / completed / failed 等" }
                    },
                    "required": []
                }),
            ),
            "create" => (
                "automation_create",
                concat!(
                    "创建一个自动化（定时任务）。调度类型 type 为 cron/once/interval，",
                    "schedule_expr 为对应表达式（cron 为 6 字段「秒 分 时 日 月 周」，如 \"0 0 9 * * *\" 表示每天 09:00；once 为 RFC3339 或 YYYY-MM-DDTHH:MM；interval 如 \"1h\"）。",
                    "action_type 为 agent/shell/skill，action_payload 为对应动作的 JSON 字符串。",
                    "创建后自动计算下次触发时间，可被后台调度器认领。"
                ),
                json!({
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "任务标题（必填）" },
                        "description": { "type": "string", "description": "任务说明（可选）" },
                        "type": { "type": "string", "enum": ["cron", "once", "interval"], "description": "调度类型（可选，默认 cron）" },
                        "schedule_expr": { "type": "string", "description": "调度表达式（必填，依 type 取值）" },
                        "action_type": { "type": "string", "enum": ["agent", "shell", "skill"], "description": "触发动作类型（可选，默认 agent）" },
                        "action_payload": { "type": "string", "description": "动作参数 JSON 字符串（必填）。agent 例：{\"prompt\":\"...\"}；shell 例：{\"command\":\"...\"}；skill 例：{\"skill_id\":\"...\"}" },
                        "source": { "type": "string", "description": "来源标识（可选，默认 agent_dialog）" }
                    },
                    "required": ["title", "schedule_expr", "action_payload"]
                }),
            ),
            "update" => (
                "automation_update",
                "更新一个已有自动化（定时任务）。id 必填，其余字段与 automation_create 一致。仅调度变化时重算下次触发时间。",
                json!({
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "任务 id（必填）" },
                        "title": { "type": "string", "description": "新标题（必填）" },
                        "description": { "type": "string", "description": "新说明（可选）" },
                        "type": { "type": "string", "enum": ["cron", "once", "interval"], "description": "新调度类型（可选）" },
                        "schedule_expr": { "type": "string", "description": "新调度表达式（必填）" },
                        "action_type": { "type": "string", "enum": ["agent", "shell", "skill"], "description": "新动作类型（可选）" },
                        "action_payload": { "type": "string", "description": "新动作参数 JSON 字符串（必填）" },
                        "source": { "type": "string", "description": "新来源标识（可选）" }
                    },
                    "required": ["id", "title", "schedule_expr", "action_payload"]
                }),
            ),
            "delete" => (
                "automation_delete",
                "删除一个自动化（定时任务，按 id）。删除后不再被调度。",
                json!({
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "任务 id（必填）" }
                    },
                    "required": ["id"]
                }),
            ),
            "set_enabled" => (
                "automation_set_enabled",
                "启用或暂停一个自动化（定时任务）。enabled=true 置为 active（参与调度）；false 置为 paused（停止触发）。",
                json!({
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "任务 id（必填）" },
                        "enabled": { "type": "boolean", "description": "true=启用 / false=暂停（必填）" }
                    },
                    "required": ["id", "enabled"]
                }),
            ),
            other => (
                other,
                "未知自动化工具操作",
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
        let dir = PathBuf::from(std::env::temp_dir()).join(format!("onedesktop_auto_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Arc::new(DbConnection::open(&dir).expect("open test db"))
    }

    #[test]
    fn create_then_list_then_pause() {
        let db = temp_db();
        let out = crate::agent::tool_registry::ToolExecContext::default();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let created = rt
            .block_on(AutomationTool::new(db.clone(), "create").execute(
                json!({
                    "title": "每日摘要",
                    "type": "cron",
                    "schedule_expr": "0 0 9 * * *",
                    "action_type": "agent",
                    "action_payload": "{\"prompt\":\"汇总今日\"}"
                }),
                &out,
            ))
            .unwrap();
        assert!(created.contains("已创建定时任务"), "create: {}", created);
        assert!(created.contains("\"next_run_at\""), "should compute next_run_at: {}", created);

        let listed = rt
            .block_on(AutomationTool::new(db.clone(), "list").execute(json!({}), &out))
            .unwrap();
        assert!(listed.contains("每日摘要"), "list: {}", listed);

        
        let id = serde_json::from_str::<serde_json::Value>(
            &listed[listed.find('[').unwrap()..],
        )
        .unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_string();

        let paused = rt
            .block_on(AutomationTool::new(db.clone(), "set_enabled").execute(
                json!({ "id": id, "enabled": false }),
                &out,
            ))
            .unwrap();
        assert!(paused.contains("暂停"), "pause: {}", paused);

        let active_only = rt
            .block_on(AutomationTool::new(db.clone(), "list").execute(json!({ "status": "active" }), &out))
            .unwrap();
        assert!(!active_only.contains("每日摘要"), "paused task should not appear in active filter: {}", active_only);
    }
}
