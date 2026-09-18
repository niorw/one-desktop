









use crate::agent::tool_registry::{ExecutableTool, ToolDef, ToolExecContext};
use crate::group::task_board::{CreateTaskPayload, TaskStatus};
use crate::group::task_board_repo::TaskBoardRepository;
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;
use async_trait::async_trait;
use rusqlite::params;
use serde_json::{json, Value};
use std::sync::Arc;

const PERSONAL_GROUP: &str = "personal";


#[derive(Clone)]
pub struct KanbanTool {
    db: Arc<DbConnection>,
    op: &'static str,
}

impl KanbanTool {
    pub fn new(db: Arc<DbConnection>, op: &'static str) -> Self {
        Self { db, op }
    }
}


fn parse_status(s: &str) -> Result<TaskStatus, String> {
    match s {
        "Pending" | "pending" => Ok(TaskStatus::Pending),
        "InProgress" | "in_progress" | "inprogress" => Ok(TaskStatus::InProgress),
        "Completed" | "completed" => Ok(TaskStatus::Completed),
        "Failed" | "failed" => Ok(TaskStatus::Failed),
        "Cancelled" | "cancelled" | "canceled" => Ok(TaskStatus::Cancelled),
        other => Err(format!(
            "未知看板状态: {}（应为 Pending / InProgress / Completed / Failed / Cancelled）",
            other
        )),
    }
}


fn next_order_idx(db: &DbConnection, status: &TaskStatus) -> i64 {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT COALESCE(MAX(order_idx), -1) + 1 FROM tasks WHERE status = ?1",
            params![serde_json::to_string(status).unwrap()],
            |row| row.get::<_, i64>(0),
        )
    })
    .unwrap_or(0)
}

#[async_trait]
impl ExecutableTool for KanbanTool {
    async fn execute(&self, args: Value, _ctx: &ToolExecContext) -> Result<String, String> {
        match self.op {
            "create" => self.create(args),
            "list" => self.list(args),
            "update" => self.update(args),
            "delete" => self.delete(args),
            other => Err(format!("未知看板工具操作: {}", other)),
        }
    }
}

impl KanbanTool {
    fn create(&self, args: Value) -> Result<String, String> {
        let description = args["description"]
            .as_str()
            .ok_or("缺少必填参数 description（任务描述）")?;
        let description = description.trim().to_string();
        if description.is_empty() {
            return Err("任务描述不能为空".into());
        }
        let group_id = args["group_id"]
            .as_str()
            .map(|s| s.to_string())
            .unwrap_or_else(|| PERSONAL_GROUP.to_string());
        let status = match args["status"].as_str() {
            Some(s) => parse_status(s)?,
            None => TaskStatus::Pending,
        };
        let capability = args["capability"].as_str().map(|s| s.to_string());
        let reasoning = args["reasoning"].as_str().map(|s| s.to_string());

        let payload = CreateTaskPayload {
            id: uuid::Uuid::new_v4().to_string(),
            group_id,
            batch_id: None, 
            worker_id: None,
            description,
            depends_on: vec![],
            input_refs: vec![],
            output_spec: None,
            status: Some(status),
            capability,
            reasoning,
        };
        let task = TaskBoardRepository::new(self.db.as_ref())
            .create(payload)
            .map_err(|e| format!("创建看板任务失败: {}", e))?;
        let json = serde_json::to_string(&task).map_err(|e| format!("序列化失败: {}", e))?;
        Ok(format!(
            "已创建看板任务（{}/{}，状态 {}）。返回 JSON：\n{}",
            task.group_id, task.id, serde_json::to_string(&task.status).unwrap().trim_matches('"'), json
        ))
    }

    fn list(&self, args: Value) -> Result<String, String> {
        let group_id = args["group_id"]
            .as_str()
            .map(|s| s.to_string())
            .unwrap_or_else(|| PERSONAL_GROUP.to_string());
        let mut tasks = TaskBoardRepository::new(self.db.as_ref())
            .find_by_group(&group_id)
            .map_err(|e| format!("查询看板任务失败: {}", e))?;
        if let Some(status) = args["status"].as_str() {
            let want = parse_status(status)?;
            tasks.retain(|t| t.status == want);
        }
        let json = serde_json::to_string(&tasks).map_err(|e| format!("序列化失败: {}", e))?;
        Ok(format!(
            "找到 {} 条看板任务（group {}）：\n{}",
            tasks.len(),
            group_id,
            json
        ))
    }

    fn update(&self, args: Value) -> Result<String, String> {
        let id = args["id"].as_str().ok_or("缺少必填参数 id（任务 id）")?;
        let repo = TaskBoardRepository::new(self.db.as_ref());
        let existing = repo
            .find_by_id(id)
            .map_err(|e| format!("查询任务失败: {}", e))?
            .ok_or_else(|| "看板任务不存在（id 无效）".to_string())?;

        let mut description = existing.description.clone();
        let mut status = existing.status.clone();
        let mut capability = existing.capability.clone();
        let mut reasoning = existing.reasoning.clone();

        if let Some(d) = args["description"].as_str() {
            description = d.trim().to_string();
        }
        if let Some(s) = args["status"].as_str() {
            status = parse_status(s)?;
        }
        if let Some(c) = args["capability"].as_str() {
            capability = Some(c.to_string());
        }
        if let Some(r) = args["reasoning"].as_str() {
            reasoning = Some(r.to_string());
        }

        
        let order_idx = if status != existing.status {
            next_order_idx(self.db.as_ref(), &status)
        } else {
            existing.order_idx
        };

        self.db
            .with_conn_mut(|conn| {
                conn.execute(
                    "UPDATE tasks SET description=?1, status=?2, capability=?3, reasoning=?4, order_idx=?5 WHERE id=?6",
                    params![
                        description,
                        serde_json::to_string(&status).unwrap(),
                        capability,
                        reasoning,
                        order_idx,
                        id
                    ],
                )
            })
            .map_err(|e| format!("更新看板任务失败: {}", e))?;

        Ok(format!(
            "已更新看板任务 {}（状态 {}）。",
            id,
            serde_json::to_string(&status).unwrap().trim_matches('"')
        ))
    }

    fn delete(&self, args: Value) -> Result<String, String> {
        let id = args["id"].as_str().ok_or("缺少必填参数 id（任务 id）")?;
        TaskBoardRepository::new(self.db.as_ref())
            .delete(id)
            .map_err(|e| format!("删除看板任务失败: {}", e))?;
        Ok(format!("已删除看板任务 {id}。", id = id))
    }
}

impl From<KanbanTool> for ToolDef {
    fn from(t: KanbanTool) -> Self {
        let (name, description, parameters) = match t.op {
            "create" => (
                "kanban_task_create",
                concat!(
                    "在看板上新建一张任务卡（默认落在 personal 个人看板，可传 group_id 定向到某群看板）。",
                    "description 为任务内容（必填）；status 指定初始列（Pending/InProgress/Completed/Failed/Cancelled，默认 Pending）；",
                    "capability 与 reasoning 可选。新建卡片追加到对应列末尾，不参与群 DAG 调度。"
                ),
                json!({
                    "type": "object",
                    "properties": {
                        "group_id": { "type": "string", "description": "看板所属 group（可选，默认 personal 个人看板）" },
                        "description": { "type": "string", "description": "任务描述（必填）" },
                        "status": { "type": "string", "enum": ["Pending", "InProgress", "Completed", "Failed", "Cancelled"], "description": "初始看板列（可选，默认 Pending）" },
                        "capability": { "type": "string", "description": "所需能力标签（可选）" },
                        "reasoning": { "type": "string", "description": "拆解依据/验收标准（可选）" }
                    },
                    "required": ["description"]
                }),
            ),
            "list" => (
                "kanban_task_list",
                concat!(
                    "列出某看板的任务卡（默认 personal 个人看板）。可选 status 只返回某一列的任务。",
                    "返回每张卡的 id、描述、状态、能力标签等，供后续更新/移动/删除引用。"
                ),
                json!({
                    "type": "object",
                    "properties": {
                        "group_id": { "type": "string", "description": "看板所属 group（可选，默认 personal）" },
                        "status": { "type": "string", "enum": ["Pending", "InProgress", "Completed", "Failed", "Cancelled"], "description": "只看某一列（可选）" }
                    },
                    "required": []
                }),
            ),
            "update" => (
                "kanban_task_update",
                concat!(
                    "更新一张看板任务卡。id 必填；description/status/capability/reasoning 均为可选，只更新传入字段。",
                    "改 status 即「跨列移动」卡片（如 Pending → Completed），会自动追加到目标列末尾。"
                ),
                json!({
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "任务卡 id（必填）" },
                        "description": { "type": "string", "description": "新描述（可选）" },
                        "status": { "type": "string", "enum": ["Pending", "InProgress", "Completed", "Failed", "Cancelled"], "description": "新状态/目标列（可选，变更即跨列移动）" },
                        "capability": { "type": "string", "description": "新能力标签（可选）" },
                        "reasoning": { "type": "string", "description": "新拆解依据（可选）" }
                    },
                    "required": ["id"]
                }),
            ),
            "delete" => (
                "kanban_task_delete",
                "删除一张看板任务卡（按 id）。删除后不可恢复。",
                json!({
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "任务卡 id（必填）" }
                    },
                    "required": ["id"]
                }),
            ),
            other => (
                other,
                "未知看板工具操作",
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
        let dir = PathBuf::from(std::env::temp_dir()).join(format!("onedesktop_kb_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Arc::new(DbConnection::open(&dir).expect("open test db"))
    }

    #[test]
    fn personal_board_crud() {
        let db = temp_db();
        let out = crate::agent::tool_registry::ToolExecContext::default();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let created = rt
            .block_on(KanbanTool::new(db.clone(), "create").execute(
                json!({ "description": "写周报", "status": "InProgress" }),
                &out,
            ))
            .unwrap();
        assert!(created.contains("已创建看板任务"), "create: {}", created);

        let listed = rt
            .block_on(KanbanTool::new(db.clone(), "list").execute(json!({}), &out))
            .unwrap();
        assert!(listed.contains("写周报"), "list: {}", listed);

        
        let parsed: serde_json::Value =
            serde_json::from_str(listed.split("\n").last().unwrap()).unwrap();
        let id = parsed[0]["id"].as_str().unwrap().to_string();

        let updated = rt
            .block_on(KanbanTool::new(db.clone(), "update").execute(
                json!({ "id": id, "status": "Completed" }),
                &out,
            ))
            .unwrap();
        assert!(updated.contains("Completed"), "update should move to Completed: {}", updated);

        
        let done = rt
            .block_on(KanbanTool::new(db.clone(), "list").execute(json!({ "status": "Completed" }), &out))
            .unwrap();
        assert!(done.contains("写周报"), "completed list should contain it: {}", done);
        let pending = rt
            .block_on(KanbanTool::new(db.clone(), "list").execute(json!({ "status": "Pending" }), &out))
            .unwrap();
        assert!(!pending.contains("写周报"), "pending list should NOT contain it: {}", pending);

        rt.block_on(KanbanTool::new(db.clone(), "delete").execute(json!({ "id": id }), &out))
            .unwrap();
        let after = rt
            .block_on(KanbanTool::new(db.clone(), "list").execute(json!({}), &out))
            .unwrap();
        assert!(!after.contains("写周报"), "after delete, gone: {}", after);
    }
}
