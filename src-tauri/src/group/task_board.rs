




use crate::group::SeatType;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Cancelled,
    
    
    
    AwaitingApproval,
}

impl TaskStatus {
    
    
    
    
    
    
    
    pub fn as_db_str(&self) -> String {
        serde_json::to_string(self).expect("TaskStatus 序列化不会失败（纯单元变体 enum）")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubTask {
    pub id: String,
    
    pub worker_id: Option<String>,
    pub description: String,
    pub input_refs: Vec<String>,
    pub output_spec: Option<String>,
    pub depends_on: Vec<String>,
    pub seat_strategy: Option<SeatType>,
    
    #[serde(default)]
    pub capability: Option<String>,
    
    #[serde(default)]
    pub reasoning: Option<String>,
}

impl SubTask {
    pub fn new(
        id: &str,
        worker_id: Option<&str>,
        description: &str,
        depends_on: Vec<String>,
    ) -> Self {
        Self {
            id: id.to_string(),
            worker_id: worker_id.map(|s| s.to_string()),
            description: description.to_string(),
            input_refs: vec![],
            output_spec: None,
            depends_on,
            seat_strategy: None,
            capability: None,
            reasoning: None,
        }
    }

    
    pub fn with_batch(&self, group_id: &str, batch: &str) -> CreateTaskPayload {
        CreateTaskPayload {
            id: self.id.clone(),
            group_id: group_id.to_string(),
            batch_id: Some(batch.to_string()),
            worker_id: self.worker_id.clone(),
            description: self.description.clone(),
            depends_on: self.depends_on.clone(),
            input_refs: self.input_refs.clone(),
            output_spec: self.output_spec.clone(),
            status: None,
            capability: self.capability.clone(),
            reasoning: self.reasoning.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub group_id: String,
    pub batch_id: Option<String>,
    pub worker_id: Option<String>,
    pub description: String,
    pub depends_on: Vec<String>,
    pub input_refs: Vec<String>,
    pub output_spec: Option<String>,
    pub status: TaskStatus,
    pub retry_count: i32,
    pub assigned_worker: Option<String>,
    pub outputs: Vec<String>,
    
    #[serde(default)]
    pub capability: Option<String>,
    
    #[serde(default)]
    pub reasoning: Option<String>,
    
    #[serde(default)]
    pub last_heartbeat: Option<i64>,
    
    #[serde(default)]
    pub last_error: Option<String>,
    
    #[serde(default)]
    pub order_idx: i64,
}



impl Task {
    
    
    
    pub fn task_card(&self) -> String {
        let mut card = format!("# Task {}\n{}", self.id, self.description);
        if let Some(r) = &self.reasoning {
            let r = r.trim();
            if !r.is_empty() {
                card.push_str(&format!(
                    "\n\n# Owner Reasoning (referenceTaskIds: [{}])\n{}",
                    self.id, r
                ));
            }
        }
        card
    }
}

#[derive(Debug, Clone)]
pub struct CreateTaskPayload {
    pub id: String,
    pub group_id: String,
    pub batch_id: Option<String>,
    pub worker_id: Option<String>,
    pub description: String,
    pub depends_on: Vec<String>,
    pub input_refs: Vec<String>,
    pub output_spec: Option<String>,
    
    pub status: Option<TaskStatus>,
    pub capability: Option<String>,
    pub reasoning: Option<String>,
}


