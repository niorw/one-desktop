







use crate::agent::tool_registry::ToolDef;
use crate::llm::types::{ChatMessage, DeltaEvent};
use serde_json::Value;


pub trait LlmProvider: Send + Sync {
    fn chat_url(&self) -> &str;

    fn model(&self) -> &str;

    
    
    fn api_key(&self) -> &str;

    
    
    
    
    fn build_request_body(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
        temperature: f64,
        max_tokens: u32,
    ) -> Value;

    
    fn parse_delta(&self, json: &Value) -> DeltaEvent;

    
    
    
    fn serialize_message(&self, msg: &ChatMessage) -> Value;
}
