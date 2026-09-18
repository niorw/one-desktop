











use crate::agent::tool_registry::ToolDef;
use crate::llm::provider::LlmProvider;
use crate::llm::providers::deepseek::{ThinkingMode, REASONING_EFFORTS};
use crate::llm::types::{ChatMessage, DeltaEvent};
use serde_json::{json, Value};


#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReasoningDialect {
    
    #[default]
    OpenAI,
    
    DeepSeek,
    
    Qwen,
    
    GLM,
    
    Kimi,
    
    MiniMax,
}

impl ReasoningDialect {
    
    pub fn default_endpoint(&self) -> &'static str {
        match self {
            ReasoningDialect::OpenAI => "https://api.openai.com/v1/chat/completions",
            ReasoningDialect::DeepSeek => "https://api.deepseek.com/v1/chat/completions",
            ReasoningDialect::Qwen => {
                "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
            }
            ReasoningDialect::GLM => "https://open.bigmodel.cn/api/paas/v4/chat/completions",
            ReasoningDialect::Kimi => "https://api.moonshot.cn/v1/chat/completions",
            ReasoningDialect::MiniMax => "https://api.minimax.io/v1/chat/completions",
        }
    }

    
    pub fn reasoning_field(&self) -> Option<&'static str> {
        match self {
            ReasoningDialect::OpenAI => None,
            ReasoningDialect::DeepSeek
            | ReasoningDialect::Qwen
            | ReasoningDialect::GLM
            | ReasoningDialect::Kimi => Some("reasoning_content"),
            ReasoningDialect::MiniMax => Some("reasoning_details"),
        }
    }

    
    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "openai" => Some(Self::OpenAI),
            "deepseek" => Some(Self::DeepSeek),
            "qwen" => Some(Self::Qwen),
            "glm" => Some(Self::GLM),
            "kimi" => Some(Self::Kimi),
            "minimax" => Some(Self::MiniMax),
            _ => None,
        }
    }
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenConfig {
    pub prompt_key: String,
    pub output_key: String,
    pub reasoning_key: String,
    pub total_key: String,
}

impl Default for TokenConfig {
    fn default() -> Self {
        Self {
            prompt_key: "prompt_tokens".into(),
            output_key: "completion_tokens".into(),
            reasoning_key: "reasoning_tokens".into(),
            total_key: "total_tokens".into(),
        }
    }
}

impl TokenConfig {
    
    
    
    
    
    
    pub fn from_json(raw: &str) -> Option<Self> {
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        let v: Value = serde_json::from_str(raw).ok()?;
        let def = Self::default();
        let pick = |k: &str, fallback: &str| -> String {
            v.get(k)
                .and_then(|x| x.as_str())
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|| fallback.to_string())
        };
        Some(Self {
            prompt_key: pick("prompt_key", &def.prompt_key),
            output_key: pick("output_key", &def.output_key),
            reasoning_key: pick("reasoning_key", &def.reasoning_key),
            total_key: pick("total_key", &def.total_key),
        })
    }
}


pub struct OpenAICompatibleProvider {
    api_key: String,
    model: String,
    base_url: String,
    dialect: ReasoningDialect,
    thinking: ThinkingMode,
    token_config: TokenConfig,
}

impl OpenAICompatibleProvider {
    pub fn new(api_key: String, model: String, dialect: ReasoningDialect) -> Self {
        let base_url = dialect.default_endpoint().to_string();
        Self {
            api_key,
            model,
            base_url,
            dialect,
            thinking: ThinkingMode::default(),
            token_config: TokenConfig::default(),
        }
    }

    pub fn with_thinking(mut self, thinking: ThinkingMode) -> Self {
        self.thinking = thinking;
        self
    }

    
    
    
    
    pub fn with_base_url(mut self, url: String) -> Self {
        let u = url.trim();
        if !u.is_empty() {
            self.base_url = normalize_chat_url(u);
        }
        self
    }

    
    pub fn with_token_config(mut self, cfg: TokenConfig) -> Self {
        self.token_config = cfg;
        self
    }

    
    fn emit_thinking(&self, body: &mut Value) {
        emit_thinking(self.dialect, &self.thinking, body);
    }
}





pub fn normalize_chat_url(url: &str) -> String {
    let u = url.trim().trim_end_matches('/');
    if u.ends_with("/chat/completions") {
        u.to_string()
    } else {
        format!("{u}/chat/completions")
    }
}









pub fn emit_thinking(dialect: ReasoningDialect, thinking: &ThinkingMode, body: &mut Value) {
    match (dialect, thinking) {
        (_, ThinkingMode::ServerDefault) => {}
        
        
        (_, ThinkingMode::Auto) => {}
        (ReasoningDialect::OpenAI, _) => {} 

        (ReasoningDialect::DeepSeek, ThinkingMode::Disabled) => {
            body["thinking"] = json!({ "type": "disabled" });
        }
        (ReasoningDialect::DeepSeek, ThinkingMode::Enabled { effort }) => {
            body["thinking"] = json!({ "type": "enabled" });
            if let Some(e) = effort {
                if REASONING_EFFORTS.contains(&e.as_str()) {
                    body["reasoning_effort"] = json!(e);
                }
            }
        }

        (ReasoningDialect::Qwen, ThinkingMode::Disabled) => {
            body["enable_thinking"] = json!(false);
        }
        (ReasoningDialect::Qwen, ThinkingMode::Enabled { effort }) => {
            body["enable_thinking"] = json!(true);
            if let Some(e) = effort {
                body["thinking_budget"] = json!(effort_to_budget(e));
            }
        }

        (ReasoningDialect::GLM, ThinkingMode::Disabled) => {
            body["thinking"] = json!({ "type": "disabled" });
        }
        (ReasoningDialect::GLM, ThinkingMode::Enabled { .. }) => {
            body["thinking"] = json!({ "type": "enabled" });
        }

        (ReasoningDialect::Kimi, ThinkingMode::Disabled) => {
            body["reasoning_effort"] = json!("none");
        }
        (ReasoningDialect::Kimi, ThinkingMode::Enabled { effort }) => {
            let e = effort.clone().unwrap_or_else(|| "medium".to_string());
            body["reasoning_effort"] = json!(e);
        }

        (ReasoningDialect::MiniMax, ThinkingMode::Disabled) => {
            body["reasoning_split"] = json!(false);
        }
        (ReasoningDialect::MiniMax, ThinkingMode::Enabled { .. }) => {
            body["reasoning_split"] = json!(true);
        }
    }
}


fn effort_to_budget(effort: &str) -> u32 {
    match effort {
        "none" | "minimal" => 1024,
        "low" => 2048,
        "medium" => 4096,
        "high" => 8192,
        "xhigh" => 12288,
        "max" => 16384,
        _ => 4096,
    }
}

impl LlmProvider for OpenAICompatibleProvider {
    fn chat_url(&self) -> &str {
        &self.base_url
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn api_key(&self) -> &str {
        &self.api_key
    }

    fn build_request_body(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
        temperature: f64,
        max_tokens: u32,
    ) -> Value {
        let msg_json: Vec<Value> = messages.iter().map(|m| self.serialize_message(m)).collect();

        let mut body = json!({
            "model": self.model,
            "messages": msg_json,
            "stream": true,
            "temperature": temperature,
        });
        if max_tokens > 0 {
            body["max_tokens"] = json!(max_tokens);
        }

        
        self.emit_thinking(&mut body);

        if !tools.is_empty() {
            let tool_json: Vec<Value> = tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.parameters,
                        }
                    })
                })
                .collect();
            body["tools"] = json!(tool_json);
        }

        body
    }

    fn parse_delta(&self, json: &Value) -> DeltaEvent {
        let mut event = DeltaEvent::default();

        
        let usage = json.get("usage");
        if let Some(total) = usage
            .and_then(|u| u.get(self.token_config.total_key.as_str()))
            .and_then(|t| t.as_u64())
        {
            event.usage_tokens = Some(total);
        }
        if let Some(p) = usage
            .and_then(|u| u.get(self.token_config.prompt_key.as_str()))
            .and_then(|t| t.as_u64())
        {
            event.usage_prompt_tokens = Some(p);
        }
        if let Some(c) = usage
            .and_then(|u| u.get(self.token_config.output_key.as_str()))
            .and_then(|t| t.as_u64())
        {
            event.usage_output_tokens = Some(c);
        }
        
        
        
        if !self.token_config.reasoning_key.is_empty() {
            let key = self.token_config.reasoning_key.as_str();
            let r = usage
                .and_then(|u| u.get(key))
                .and_then(|t| t.as_u64())
                .or_else(|| {
                    usage
                        .and_then(|u| u.get("completion_tokens_details"))
                        .and_then(|d| d.get(key))
                        .and_then(|t| t.as_u64())
                });
            if let Some(r) = r {
                event.reasoning_tokens = Some(r);
            }
        }

        let choices = match json.get("choices").and_then(|c| c.as_array()) {
            Some(c) => c,
            None => return event,
        };

        for choice in choices {
            let delta = match choice.get("delta") {
                Some(d) => d,
                None => continue,
            };

            
            if let Some(c) = delta.get("content").and_then(|c| c.as_str()) {
                if !c.is_empty() {
                    event.content = Some(c.to_string());
                }
            }

            
            if let Some(field) = self.dialect.reasoning_field() {
                if field == "reasoning_details" {
                    if let Some(arr) = delta.get("reasoning_details").and_then(|a| a.as_array()) {
                        let joined: String = arr
                            .iter()
                            .map(|d| {
                                if let Some(s) = d.as_str() {
                                    s.to_string()
                                } else {
                                    d.get("content")
                                        .and_then(|c| c.as_str())
                                        .unwrap_or("")
                                        .to_string()
                                }
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        if !joined.is_empty() {
                            event.reasoning_content = Some(joined);
                        }
                    }
                } else if let Some(rc) = delta.get(field).and_then(|c| c.as_str()) {
                    if !rc.is_empty() {
                        event.reasoning_content = Some(rc.to_string());
                    }
                }
            }

            
            if let Some(tc_array) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                for tc in tc_array {
                    let index = tc.get("index").and_then(|i| i.as_u64());
                    let func = &tc["function"];
                    if let Some(name) = func.get("name").and_then(|n| n.as_str()) {
                        if !name.is_empty() {
                            event.tool_call_name = Some(name.to_string());
                        }
                    }
                    if let Some(args) = func.get("arguments").and_then(|a| a.as_str()) {
                        if !args.is_empty() {
                            event.tool_call_args = Some(args.to_string());
                        }
                    }
                    event.tool_call_index = index;
                }
            }

            
            if let Some(fr) = choice.get("finish_reason").and_then(|f| f.as_str()) {
                event.finish_reason = Some(fr.to_string());
            }
        }

        event
    }

    fn serialize_message(&self, msg: &ChatMessage) -> Value {
        let mut obj = json!({
            "role": msg.role,
            "content": msg.content,
        });

        if let Some(tool_calls) = &msg.tool_calls {
            let calls: Vec<Value> = tool_calls
                .iter()
                .map(|tc| {
                    json!({
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        }
                    })
                })
                .collect();
            obj["tool_calls"] = json!(calls);
        }

        if let Some(tcid) = &msg.tool_call_id {
            obj["tool_call_id"] = json!(tcid);
        }

        
        
        if self.dialect.reasoning_field() == Some("reasoning_content") && msg.role == "assistant" {
            let rc = msg
                .extra
                .get("reasoning_content")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            obj["reasoning_content"] = json!(rc);
        }

        obj
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(dialect: ReasoningDialect, thinking: ThinkingMode) -> OpenAICompatibleProvider {
        OpenAICompatibleProvider::new("k".into(), "m".into(), dialect).with_thinking(thinking)
    }

    fn body(dialect: ReasoningDialect, thinking: ThinkingMode) -> Value {
        p(dialect, thinking).build_request_body(&[], &[], 0.7, 0)
    }

    

    #[test]
    fn server_default_emits_nothing_for_every_dialect() {
        
        
        for d in [
            ReasoningDialect::OpenAI,
            ReasoningDialect::DeepSeek,
            ReasoningDialect::Qwen,
            ReasoningDialect::GLM,
            ReasoningDialect::Kimi,
            ReasoningDialect::MiniMax,
        ] {
            let b = body(d, ThinkingMode::ServerDefault);
            for k in [
                "thinking",
                "reasoning_effort",
                "enable_thinking",
                "thinking_budget",
                "reasoning_split",
            ] {
                assert!(b.get(k).is_none(), "{d:?} should not emit {k}");
            }
        }
    }

    #[test]
    fn openai_dialect_ignores_thinking_entirely() {
        
        let b = body(
            ReasoningDialect::OpenAI,
            ThinkingMode::Enabled {
                effort: Some("high".into()),
            },
        );
        assert!(b.get("thinking").is_none());
        assert!(b.get("reasoning_effort").is_none());
    }

    #[test]
    fn qwen_emits_enable_thinking_and_budget() {
        let b = body(
            ReasoningDialect::Qwen,
            ThinkingMode::Enabled {
                effort: Some("high".into()),
            },
        );
        assert_eq!(b["enable_thinking"], json!(true));
        assert_eq!(b["thinking_budget"], json!(8192));

        let off = body(ReasoningDialect::Qwen, ThinkingMode::Disabled);
        assert_eq!(off["enable_thinking"], json!(false));
        assert!(off.get("thinking_budget").is_none());
    }

    #[test]
    fn glm_emits_thinking_type_only() {
        let b = body(ReasoningDialect::GLM, ThinkingMode::Enabled { effort: None });
        assert_eq!(b["thinking"]["type"], json!("enabled"));
        
        assert!(b.get("reasoning_effort").is_none());
    }

    #[test]
    fn kimi_emits_top_level_effort_and_none_when_disabled() {
        let b = body(
            ReasoningDialect::Kimi,
            ThinkingMode::Enabled {
                effort: Some("low".into()),
            },
        );
        assert_eq!(b["reasoning_effort"], json!("low"));
        assert!(b.get("thinking").is_none());

        
        let off = body(ReasoningDialect::Kimi, ThinkingMode::Disabled);
        assert_eq!(off["reasoning_effort"], json!("none"));
    }

    #[test]
    fn minimax_emits_reasoning_split() {
        let on = body(ReasoningDialect::MiniMax, ThinkingMode::Enabled { effort: None });
        assert_eq!(on["reasoning_split"], json!(true));
        let off = body(ReasoningDialect::MiniMax, ThinkingMode::Disabled);
        assert_eq!(off["reasoning_split"], json!(false));
    }

    

    #[test]
    fn minimax_reasoning_details_array_is_aggregated() {
        
        let chunk = json!({
            "choices": [{
                "delta": {
                    "reasoning_details": [
                        { "type": "text", "content": "第一步" },
                        "第二步"
                    ]
                }
            }]
        });
        let ev = p(ReasoningDialect::MiniMax, ThinkingMode::ServerDefault).parse_delta(&chunk);
        assert_eq!(ev.reasoning_content.as_deref(), Some("第一步\n第二步"));
    }

    #[test]
    fn openai_dialect_ignores_reasoning_content_field() {
        let chunk = json!({
            "choices": [{ "delta": { "reasoning_content": "不该被读到" } }]
        });
        let ev = p(ReasoningDialect::OpenAI, ThinkingMode::ServerDefault).parse_delta(&chunk);
        assert_eq!(ev.reasoning_content, None);
    }

    #[test]
    fn reasoning_content_parsed_for_string_dialects() {
        let chunk = json!({
            "choices": [{ "delta": { "reasoning_content": "思考中" } }]
        });
        for d in [
            ReasoningDialect::DeepSeek,
            ReasoningDialect::Qwen,
            ReasoningDialect::GLM,
            ReasoningDialect::Kimi,
        ] {
            let ev = p(d, ThinkingMode::ServerDefault).parse_delta(&chunk);
            assert_eq!(ev.reasoning_content.as_deref(), Some("思考中"), "{d:?}");
        }
    }

    

    #[test]
    fn reasoning_tokens_are_counted_separately() {
        let chunk = json!({
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 20,
                "reasoning_tokens": 7,
                "total_tokens": 30
            },
            "choices": []
        });
        let ev = p(ReasoningDialect::DeepSeek, ThinkingMode::ServerDefault).parse_delta(&chunk);
        assert_eq!(ev.usage_prompt_tokens, Some(10));
        assert_eq!(ev.usage_output_tokens, Some(20));
        assert_eq!(ev.reasoning_tokens, Some(7));
        assert_eq!(ev.usage_tokens, Some(30));
    }

    #[test]
    fn reasoning_tokens_read_from_completion_tokens_details() {
        
        
        let chunk = json!({
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 20,
                "completion_tokens_details": { "reasoning_tokens": 13 },
                "total_tokens": 30
            },
            "choices": []
        });
        let ev = p(ReasoningDialect::DeepSeek, ThinkingMode::ServerDefault).parse_delta(&chunk);
        assert_eq!(ev.reasoning_tokens, Some(13));
        
        assert_eq!(ev.usage_output_tokens, Some(20));
    }

    #[test]
    fn custom_token_config_remaps_usage_keys() {
        
        let chunk = json!({
            "usage": { "input_tokens": 11, "output_tokens": 22 },
            "choices": []
        });
        let prov = OpenAICompatibleProvider::new("k".into(), "m".into(), ReasoningDialect::OpenAI)
            .with_token_config(TokenConfig {
                prompt_key: "input_tokens".into(),
                output_key: "output_tokens".into(),
                reasoning_key: String::new(), 
                total_key: "total_tokens".into(),
            });
        let ev = prov.parse_delta(&chunk);
        assert_eq!(ev.usage_prompt_tokens, Some(11));
        assert_eq!(ev.usage_output_tokens, Some(22));
        assert_eq!(ev.reasoning_tokens, None);
        assert_eq!(ev.usage_tokens, None);
    }

    

    #[test]
    fn base_url_normalization() {
        assert_eq!(
            normalize_chat_url("https://h/v1"),
            "https://h/v1/chat/completions"
        );
        assert_eq!(
            normalize_chat_url("https://h/v1/"),
            "https://h/v1/chat/completions"
        );
        
        assert_eq!(
            normalize_chat_url("https://h/proxy/chat/completions"),
            "https://h/proxy/chat/completions"
        );
    }

    #[test]
    fn empty_base_url_does_not_override_default() {
        let prov = OpenAICompatibleProvider::new("k".into(), "m".into(), ReasoningDialect::Kimi)
            .with_base_url("   ".into());
        assert_eq!(prov.chat_url(), ReasoningDialect::Kimi.default_endpoint());
    }

    #[test]
    fn assistant_reasoning_echo_only_for_reasoning_content_dialects() {
        let msg = ChatMessage {
            role: "assistant".into(),
            content: "答案".into(),
            tool_calls: None,
            tool_call_id: None,
            extra: Default::default(),
        };
        
        let v = p(ReasoningDialect::DeepSeek, ThinkingMode::ServerDefault).serialize_message(&msg);
        assert_eq!(v["reasoning_content"], json!(""));
        
        for d in [ReasoningDialect::OpenAI, ReasoningDialect::MiniMax] {
            let v = p(d, ThinkingMode::ServerDefault).serialize_message(&msg);
            assert!(v.get("reasoning_content").is_none(), "{d:?}");
        }
    }
}
