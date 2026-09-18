




use serde::{Deserialize, Serialize};


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallDef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    
    #[serde(skip)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl ChatMessage {
    pub fn user(content: &str) -> Self {
        Self {
            role: "user".into(),
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: None,
            extra: Default::default(),
        }
    }

    pub fn assistant(content: &str) -> Self {
        Self {
            role: "assistant".into(),
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: None,
            extra: Default::default(),
        }
    }

    pub fn assistant_tool_call(tool_name: &str, tool_args: &str, call_id: &str) -> Self {
        Self {
            role: "assistant".into(),
            content: String::new(),
            tool_calls: Some(vec![ToolCallDef {
                id: call_id.to_string(),
                call_type: "function".into(),
                function: ToolCallFunction {
                    name: tool_name.to_string(),
                    arguments: tool_args.to_string(),
                },
            }]),
            tool_call_id: None,
            extra: Default::default(),
        }
    }

    pub fn tool_result(content: &str, call_id: &str) -> Self {
        Self {
            role: "tool".into(),
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: Some(call_id.to_string()),
            extra: Default::default(),
        }
    }

    pub fn system(content: &str) -> Self {
        Self {
            role: "system".into(),
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: None,
            extra: Default::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallDef {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: ToolCallFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallFunction {
    pub name: String,
    pub arguments: String,
}


#[derive(Debug, Clone)]
pub enum LlmResponse {
    
    Text {
        content: String,
        reasoning_content: String,
        
        tokens: u64,
        
        prompt_tokens: u64,
        
        output_tokens: u64,
        
        reasoning_tokens: u64,
        
        
        
        finish_reason: Option<String>,
    },
    
    ToolCalls {
        calls: Vec<ToolCallResult>,
        reasoning_content: String,
        
        
        
        
        plan_content: String,
        tokens: u64,
        prompt_tokens: u64,
        output_tokens: u64,
        
        reasoning_tokens: u64,
    },
    Error(String),
    
    Cancelled,
}


#[derive(Debug, Clone)]
pub struct ToolCallResult {
    pub name: String,
    pub arguments: String,
}


#[derive(Debug, Default)]
pub struct DeltaEvent {
    pub content: Option<String>,
    pub reasoning_content: Option<String>,
    pub tool_call_name: Option<String>,
    pub tool_call_args: Option<String>,
    pub tool_call_index: Option<u64>,
    pub finish_reason: Option<String>,
    pub usage_tokens: Option<u64>,
    
    pub usage_prompt_tokens: Option<u64>,
    
    pub usage_output_tokens: Option<u64>,
    
    pub reasoning_tokens: Option<u64>,
}
