use serde::{Deserialize, Serialize};


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum AgentEvent {
    
    Token {
        #[serde(default)]
        seq: Option<u64>,
        session_id: String,
        token: String,
    },
    
    ToolCall {
        #[serde(default)]
        seq: Option<u64>,
        
        call_id: String,
        session_id: String,
        tool_name: String,
        tool_args: String,
    },
    
    ToolResult {
        #[serde(default)]
        seq: Option<u64>,
        
        call_id: String,
        session_id: String,
        tool_name: String,
        result: String,
        is_error: bool,
    },
    
    Thinking {
        #[serde(default)]
        seq: Option<u64>,
        
        thought_id: String,
        session_id: String,
        content: String,
    },
    
    ThinkingEnd {
        #[serde(default)]
        seq: Option<u64>,
        session_id: String,
        thought_id: String,
    },
    
    
    ApprovalRequest {
        #[serde(default)]
        seq: Option<u64>,
        session_id: String,
        approval_id: String,
        tool_name: String,
        tool_args: String,
        #[serde(default)]
        seat: Option<String>,
        #[serde(default)]
        risk: String,
    },
    
    
    
    
    
    
    
    Progress {
        #[serde(default)]
        seq: Option<u64>,
        session_id: String,
        #[serde(default)]
        task_id: Option<String>,
        iteration: u32,
        max_iterations: u32,
        percent: f64,
        tokens_used: u64,
        token_budget: u64,
    },
    
    
    
    Paused {
        #[serde(default)]
        seq: Option<u64>,
        session_id: String,
        #[serde(default)]
        task_id: Option<String>,
        
        iteration: u32,
        tokens_used: u64,
    },
    
    Done {
        #[serde(default)]
        seq: Option<u64>,
        session_id: String,
        final_response: String,
        token_usage: u64,
    },
    
    Error {
        #[serde(default)]
        seq: Option<u64>,
        session_id: String,
        message: String,
        #[serde(default)]
        error_code: String,
        #[serde(default)]
        retriable: bool,
    },
    
    
    TodoUpdate {
        #[serde(default)]
        seq: Option<u64>,
        session_id: String,
        run_id: String,
        todos: Vec<TodoEntry>,
    },
    
    
    Proposal {
        #[serde(default)]
        seq: Option<u64>,
        session_id: String,
        proposal_id: String,
        title: String,
        summary: String,
        options: Vec<ProposalOption>,
        #[serde(default)]
        risk: String,
    },
    
    
    
    
    RunArtifacts {
        #[serde(default)]
        seq: Option<u64>,
        session_id: String,
        run_id: String,
        artifacts: Vec<String>,
    },
}

impl AgentEvent {
    
    
    
    pub fn with_seq(self, seq: u64) -> Self {
        match self {
            AgentEvent::Token { seq: _, session_id, token } => {
                AgentEvent::Token { seq: Some(seq), session_id, token }
            }
            AgentEvent::ToolCall { seq: _, session_id, call_id, tool_name, tool_args } => {
                AgentEvent::ToolCall { seq: Some(seq), session_id, call_id, tool_name, tool_args }
            }
            AgentEvent::ToolResult { seq: _, session_id, call_id, tool_name, result, is_error } => {
                AgentEvent::ToolResult { seq: Some(seq), session_id, call_id, tool_name, result, is_error }
            }
            AgentEvent::Thinking { seq: _, session_id, thought_id, content } => {
                AgentEvent::Thinking { seq: Some(seq), session_id, thought_id, content }
            }
            AgentEvent::ThinkingEnd { seq: _, session_id, thought_id } => {
                AgentEvent::ThinkingEnd { seq: Some(seq), session_id, thought_id }
            }
            AgentEvent::ApprovalRequest { seq: _, session_id, approval_id, tool_name, tool_args, seat, risk } => {
                AgentEvent::ApprovalRequest { seq: Some(seq), session_id, approval_id, tool_name, tool_args, seat, risk }
            }
            AgentEvent::Progress { seq: _, session_id, task_id, iteration, max_iterations, percent, tokens_used, token_budget } => {
                AgentEvent::Progress { seq: Some(seq), session_id, task_id, iteration, max_iterations, percent, tokens_used, token_budget }
            }
            AgentEvent::Paused { seq: _, session_id, task_id, iteration, tokens_used } => {
                AgentEvent::Paused { seq: Some(seq), session_id, task_id, iteration, tokens_used }
            }
            AgentEvent::Done { seq: _, session_id, final_response, token_usage } => {
                AgentEvent::Done { seq: Some(seq), session_id, final_response, token_usage }
            }
            AgentEvent::Error { seq: _, session_id, message, error_code, retriable } => {
                AgentEvent::Error { seq: Some(seq), session_id, message, error_code, retriable }
            }
            AgentEvent::TodoUpdate { seq: _, session_id, run_id, todos } => {
                AgentEvent::TodoUpdate { seq: Some(seq), session_id, run_id, todos }
            }
            AgentEvent::Proposal { seq: _, session_id, proposal_id, title, summary, options, risk } => {
                AgentEvent::Proposal { seq: Some(seq), session_id, proposal_id, title, summary, options, risk }
            }
            AgentEvent::RunArtifacts { seq: _, session_id, run_id, artifacts } => {
                AgentEvent::RunArtifacts { seq: Some(seq), session_id, run_id, artifacts }
            }
        }
    }
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoEntry {
    pub id: String,
    pub title: String,
    pub status: String,
    #[serde(default)]
    pub active_form: Option<String>,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposalOption {
    pub id: String,
    pub label: String,
    pub description: String,
    
    #[serde(default)]
    pub risk: String,
    #[serde(default)]
    pub recommended: bool,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionDto {
    pub id: String,
    pub title: String,
    pub model: String,
    pub preamble: String,
    pub created_at: String,
    pub updated_at: String,
    
    #[serde(default)]
    pub mode: Option<String>,
    
    #[serde(default)]
    pub group_id: Option<String>,
    
    #[serde(default)]
    pub workspace_id: Option<String>,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageDto {
    pub id: i64,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_args: Option<String>,
    pub tool_result: Option<String>,
    pub token_usage: i64,
    pub reasoning_content: String,
    pub created_at: String,
    
    #[serde(default)]
    pub seq: i64,
    
    #[serde(default)]
    pub call_id: Option<String>,
    
    #[serde(default)]
    pub item_kind: Option<String>,
}





#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceDto {
    pub id: i64,
    pub session_id: String,
    pub scene: String,
    #[serde(default)]
    pub agent_type: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub seq: i64,
    #[serde(default)]
    pub call_id: Option<String>,
    #[serde(default)]
    pub parent_id: Option<i64>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub args: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub is_error: Option<bool>,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub ended_at: Option<i64>,
    pub created_at: String,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingsDto {
    pub api_key: String,
    pub model: String,
    pub preamble: String,
    pub max_iterations: u32,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpCapabilitiesDto {
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub resources: Vec<String>,
    #[serde(default)]
    pub prompts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerDto {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: std::collections::HashMap<String, String>,
    pub url: Option<String>,
    pub enabled: bool,
    pub status: String,
    pub capabilities: McpCapabilitiesDto,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub source: String,
    pub path: Option<String>,
    pub url: Option<String>,
    pub status: String,
    pub dependencies: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}


#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TaskScheduleDto {
    #[serde(default)]
    pub cron: Option<String>,
    #[serde(default)]
    pub once: Option<String>,
    #[serde(default)]
    pub interval: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledTaskDto {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub type_: String,
    pub schedule: TaskScheduleDto,
    pub source: String,
    pub status: String,
    pub action_type: String,
    pub action_payload: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_run_at: Option<String>,
    pub next_run_at: Option<String>,
    pub run_count: i64,
}
