


#[derive(Debug, Clone)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub model: String,
    pub preamble: String,
    pub created_at: String,
    pub updated_at: String,
    
    pub mode: Option<String>,
    
    pub group_id: Option<String>,
    
    pub workspace_id: Option<String>,
}


#[derive(Debug, Clone)]
pub struct CreateSessionPayload {
    pub id: String,
    pub title: String,
    pub model: String,
    pub preamble: String,
    pub mode: Option<String>,
    pub group_id: Option<String>,
    pub workspace_id: Option<String>,
}


#[derive(Debug, Clone, Default)]
pub struct SessionQuery {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}


#[derive(Debug, Clone)]
pub struct Message {
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
    
    pub seq: i64,
    
    pub call_id: Option<String>,
    
    pub item_kind: Option<String>,
    
    
    pub run_id: Option<String>,
    
    
    pub artifacts: Option<String>,
}


#[derive(Debug, Clone)]
pub struct CreateMessagePayload {
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_args: Option<String>,
    pub tool_result: Option<String>,
    pub token_usage: i64,
    pub reasoning_content: String,
    
    pub call_id: Option<String>,
}


#[derive(Debug, Clone)]
pub struct MessageQuery {
    pub session_id: Option<String>,
    pub role: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

impl Default for MessageQuery {
    fn default() -> Self {
        Self {
            session_id: None,
            role: None,
            limit: None,
            offset: None,
        }
    }
}
