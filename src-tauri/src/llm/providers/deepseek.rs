






use crate::agent::tool_registry::ToolDef;
use crate::llm::provider::LlmProvider;
use crate::llm::providers::openai::{OpenAICompatibleProvider, ReasoningDialect};
use crate::llm::types::{ChatMessage, DeltaEvent};
use serde_json::Value;






pub const REASONING_EFFORTS: [&str; 7] = [
    "none", "minimal", "low", "medium", "high", "xhigh", "max",
];








#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ThinkingMode {
    
    
    Auto,
    
    
    #[default]
    ServerDefault,
    
    Enabled { effort: Option<String> },
    
    Disabled,
}

impl ThinkingMode {
    
    
    
    
    
    
    
    pub fn from_setting(raw: &str) -> Self {
        let v = raw.trim().to_ascii_lowercase();
        match v.as_str() {
            "" | "auto" | "default" => Self::Auto,
            "off" | "disabled" | "false" => Self::Disabled,
            "on" | "enabled" | "true" => Self::Enabled { effort: None },
            other if REASONING_EFFORTS.contains(&other) => Self::Enabled {
                effort: Some(other.to_string()),
            },
            _ => Self::ServerDefault,
        }
    }

    
    
    
    pub fn resolve_auto(self, user_message: &str, history_len: usize) -> Self {
        match self {
            ThinkingMode::Auto => {
                if is_complex_task(user_message, history_len) {
                    ThinkingMode::Enabled { effort: None }
                } else {
                    ThinkingMode::Disabled
                }
            }
            other => other,
        }
    }
}






pub fn is_complex_task(user_message: &str, history_len: usize) -> bool {
    let msg = user_message.trim();
    if msg.is_empty() {
        
        return true;
    }
    let lower = msg.to_lowercase();

    
    const DEEP: &[&str] = &[
        "仔细", "深入", "思考", "规划", "步骤", "分步", "逐步", "推理", "分析一下", "权衡",
        "对比", "方案", "架构", "设计", "为什么", "怎么做到", "如何", "思路",
    ];
    if DEEP.iter().any(|k| msg.contains(k)) {
        return true;
    }

    
    const TASK: &[&str] = &[
        "实现", "编写", "写", "创建", "生成", "构建", "开发", "重构", "修复", "调试", "优化",
        "改进", "脚本", "代码", "函数", "程序", "组件", "前端", "后端", "接口", "api", "数据库",
        "sql", "爬虫", "抓取", "解析", "批量", "自动化", "部署", "迁移", "转换", "提取", "整理",
        "总结", "报告", "文件", "目录", "搜索", "检索", "排查", "排错", "计算", "建模", "改写",
        "重命名", "合并", "拆分", "处理", "html", "json", "数据",
    ];
    if TASK.iter().any(|k| lower.contains(&k.to_lowercase())) {
        return true;
    }

    
    let sentences = msg.matches(['。', '；', ';', '?', '？', '!', '！', '\n']).count();
    if msg.chars().count() >= 200 || sentences >= 3 {
        return true;
    }

    
    if history_len >= 12 {
        return true;
    }

    false
}





pub struct DeepSeekProvider {
    inner: OpenAICompatibleProvider,
}

impl DeepSeekProvider {
    
    pub fn new(api_key: String, model: String) -> Self {
        Self {
            inner: OpenAICompatibleProvider::new(api_key, model, ReasoningDialect::DeepSeek),
        }
    }

    
    pub fn with_thinking(mut self, thinking: ThinkingMode) -> Self {
        self.inner = self.inner.with_thinking(thinking);
        self
    }
}

impl LlmProvider for DeepSeekProvider {
    fn chat_url(&self) -> &str {
        self.inner.chat_url()
    }

    fn model(&self) -> &str {
        self.inner.model()
    }

    fn api_key(&self) -> &str {
        self.inner.api_key()
    }

    fn build_request_body(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
        temperature: f64,
        max_tokens: u32,
    ) -> Value {
        self.inner
            .build_request_body(messages, tools, temperature, max_tokens)
    }

    fn parse_delta(&self, json: &Value) -> DeltaEvent {
        self.inner.parse_delta(json)
    }

    fn serialize_message(&self, msg: &ChatMessage) -> Value {
        self.inner.serialize_message(msg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::types::DeltaEvent;
    use serde_json::json;

    #[test]
    fn parse_delta_extracts_separated_usage_tokens() {
        
        let chunk = json!({
            "usage": {
                "prompt_tokens": 123,
                "completion_tokens": 45,
                "total_tokens": 168
            },
            "choices": []
        });
        let ev: DeltaEvent = DeepSeekProvider::new("k".into(), "m".into()).parse_delta(&chunk);
        assert_eq!(ev.usage_tokens, Some(168));
        assert_eq!(ev.usage_prompt_tokens, Some(123));
        assert_eq!(ev.usage_output_tokens, Some(45));
    }

    #[test]
    fn parse_delta_missing_usage_yields_none() {
        let chunk = json!({ "choices": [] });
        let ev: DeltaEvent = DeepSeekProvider::new("k".into(), "m".into()).parse_delta(&chunk);
        assert_eq!(ev.usage_tokens, None);
        assert_eq!(ev.usage_prompt_tokens, None);
        assert_eq!(ev.usage_output_tokens, None);
    }

    
    fn body_with(thinking: ThinkingMode) -> Value {
        DeepSeekProvider::new("k".into(), "deepseek-v4-pro".into())
            .with_thinking(thinking)
            .build_request_body(&[], &[], 0.7, 0)
    }

    #[test]
    fn server_default_omits_thinking_fields() {
        
        
        let body = body_with(ThinkingMode::ServerDefault);
        assert!(body.get("thinking").is_none());
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn disabled_emits_thinking_disabled() {
        let body = body_with(ThinkingMode::Disabled);
        assert_eq!(body["thinking"]["type"], json!("disabled"));
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn enabled_emits_effort_at_top_level() {
        
        let body = body_with(ThinkingMode::Enabled {
            effort: Some("high".into()),
        });
        assert_eq!(body["thinking"]["type"], json!("enabled"));
        assert_eq!(body["reasoning_effort"], json!("high"));
        assert!(body["thinking"].get("reasoning_effort").is_none());
    }

    #[test]
    fn illegal_effort_is_dropped_not_sent() {
        
        let body = body_with(ThinkingMode::Enabled {
            effort: Some("bogus".into()),
        });
        assert_eq!(body["thinking"]["type"], json!("enabled"));
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn from_setting_parses_aliases_and_degrades_dirty_input() {
        assert_eq!(ThinkingMode::from_setting(""), ThinkingMode::Auto);
        assert_eq!(ThinkingMode::from_setting("auto"), ThinkingMode::Auto);
        assert_eq!(ThinkingMode::from_setting("default"), ThinkingMode::Auto);
        assert_eq!(ThinkingMode::from_setting("off"), ThinkingMode::Disabled);
        assert_eq!(
            ThinkingMode::from_setting("disabled"),
            ThinkingMode::Disabled
        );
        assert_eq!(
            ThinkingMode::from_setting("on"),
            ThinkingMode::Enabled { effort: None }
        );
        assert_eq!(
            ThinkingMode::from_setting("  HIGH  "),
            ThinkingMode::Enabled {
                effort: Some("high".into())
            }
        );
        
        assert_eq!(
            ThinkingMode::from_setting("turbo-ultra"),
            ThinkingMode::ServerDefault
        );
    }

    #[test]
    fn every_whitelisted_effort_survives_roundtrip() {
        for eff in REASONING_EFFORTS {
            let mode = ThinkingMode::from_setting(eff);
            assert_eq!(
                mode,
                ThinkingMode::Enabled {
                    effort: Some(eff.to_string())
                },
                "effort {eff} should parse"
            );
            let body = body_with(mode);
            assert_eq!(body["reasoning_effort"], json!(eff));
        }
    }

    #[test]
    fn auto_off_for_simple_greeting() {
        
        assert_eq!(
            ThinkingMode::Auto.resolve_auto("你好", 0),
            ThinkingMode::Disabled
        );
        assert_eq!(
            ThinkingMode::Auto.resolve_auto("今天天气怎么样", 0),
            ThinkingMode::Disabled
        );
    }

    #[test]
    fn auto_on_for_complex_task() {
        
        assert_eq!(
            ThinkingMode::Auto.resolve_auto("帮我在央视网 HTML 中检索正文关键词段落", 0),
            ThinkingMode::Enabled { effort: None }
        );
        assert_eq!(
            ThinkingMode::Auto.resolve_auto("写一个 Python 脚本批量重命名文件", 0),
            ThinkingMode::Enabled { effort: None }
        );
        
        assert_eq!(
            ThinkingMode::Auto.resolve_auto("请深入分析一下这个方案的利弊", 0),
            ThinkingMode::Enabled { effort: None }
        );
    }

    #[test]
    fn explicit_modes_passthrough_under_resolve_auto() {
        
        assert_eq!(
            ThinkingMode::Disabled.resolve_auto("实现一个登录组件", 0),
            ThinkingMode::Disabled
        );
        assert_eq!(
            ThinkingMode::Enabled { effort: None }.resolve_auto("你好", 0),
            ThinkingMode::Enabled { effort: None }
        );
        assert_eq!(
            ThinkingMode::ServerDefault.resolve_auto("复杂任务描述", 0),
            ThinkingMode::ServerDefault
        );
    }

    #[test]
    fn long_history_is_treated_complex() {
        
        assert_eq!(
            ThinkingMode::Auto.resolve_auto("继续", 15),
            ThinkingMode::Enabled { effort: None }
        );
    }

    #[test]
    fn is_complex_task_heuristics() {
        assert!(!is_complex_task("谢谢", 0));
        assert!(is_complex_task("", 0), "空指令保守开");
        assert!(is_complex_task("帮我重构这段 Rust 代码", 0));
        assert!(is_complex_task(
            "请阅读以下长文档并给出结构化结论：\n段落一\n段落二\n段落三",
            0
        ));
    }
}
