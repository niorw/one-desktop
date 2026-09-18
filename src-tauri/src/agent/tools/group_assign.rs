








use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent::tool_registry::{ExecutableTool, ToolDef, ToolExecContext};
use crate::group::scheduler::TaskScheduler;
use crate::group::task_board::SubTask;


pub struct AssignTasksTool;

#[async_trait]
impl ExecutableTool for AssignTasksTool {
    async fn execute(&self, args: Value, _ctx: &ToolExecContext) -> Result<String, String> {
        let group_id = args["group_id"]
            .as_str()
            .ok_or("缺少必填参数 group_id（目标群 id）")?
            .to_string();
        let tasks_val = args["tasks"]
            .as_array()
            .ok_or("缺少必填参数 tasks（SubTask 数组）")?;
        if tasks_val.is_empty() {
            return Err("tasks 不能为空：coordinator 应至少提交一个子任务".into());
        }

        let mut subtasks: Vec<SubTask> = Vec::with_capacity(tasks_val.len());
        for (i, tv) in tasks_val.iter().enumerate() {
            let id = tv["id"]
                .as_str()
                .map(|s| s.to_string())
                .or_else(|| tv["description"].as_str().map(|_| format!("T{}", i + 1)))
                .ok_or_else(|| format!("tasks[{}] 缺少 id 或 description", i))?;
            let description = tv["description"]
                .as_str()
                .ok_or_else(|| format!("tasks[{}] 缺少 description", i))?
                .trim()
                .to_string();
            if description.is_empty() {
                return Err(format!("tasks[{}] 的 description 不能为空", i));
            }
            let worker_id = tv["worker_id"].as_str().map(|s| s.to_string());
            let depends_on = tv["depends_on"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let capability = tv["capability"].as_str().map(|s| s.to_string());
            let reasoning = tv["reasoning"].as_str().map(|s| s.to_string());

            subtasks.push(SubTask {
                id,
                worker_id,
                description,
                input_refs: vec![],
                output_spec: None,
                depends_on,
                seat_strategy: None,
                capability,
                reasoning,
            });
        }

        let sched = TaskScheduler::get_scheduler_handle()
            .ok_or("调度器尚未就绪，无法提交任务批次（请稍后重试）")?;
        let batch_id = format!("batch_{}", uuid::Uuid::new_v4().simple());
        sched
            .submit_batch(&group_id, &batch_id, subtasks, false)
            .await?;
        Ok(format!(
            "已提交任务批次 {}（含 {} 个子任务，状态 AwaitingApproval）。请群主在任务看板「待审批」列点「批准」后才会执行。",
            batch_id, tasks_val.len()
        ))
    }
}

impl From<AssignTasksTool> for ToolDef {
    fn from(_: AssignTasksTool) -> Self {
        ToolDef {
            name: "assign_tasks".into(),
            description: concat!(
                "将模糊目标拆解为结构化子任务批次并提交给群调度器（coordinator / PM 专用）。",
                "每条子任务含 id（自定义，供 depends_on 引用）、description（必填）、depends_on（依赖的 id 列表，构成 DAG）、",
                "worker_id（可选，指定固定席位；省略则按 capability 匹配空闲 worker）、capability（可选能力标签）、reasoning（拆解依据/验收标准）。",
                "提交后任务进入「待审批」状态，不会自动执行——群主在任务看板批准后才运行。",
                "同一批次内 depends_on 必须引用本批次已定义的 id。"
            ).into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "group_id": { "type": "string", "description": "目标群 id（必填）" },
                    "tasks": {
                        "type": "array",
                        "description": "子任务数组（至少 1 项）",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string", "description": "任务唯一 id（如 T1/T2），供 depends_on 引用" },
                                "description": { "type": "string", "description": "任务内容（必填）" },
                                "depends_on": { "type": "array", "items": { "type": "string" }, "description": "依赖的任务 id 列表，构成 DAG" },
                                "worker_id": { "type": "string", "description": "指定固定席位 worker id（可选）" },
                                "capability": { "type": "string", "description": "所需能力标签（可选，省略按能力匹配）" },
                                "reasoning": { "type": "string", "description": "拆解依据 / 验收标准（可选）" }
                            },
                            "required": ["description"]
                        }
                    }
                },
                "required": ["group_id", "tasks"]
            }),
        }
    }
}
