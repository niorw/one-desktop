




pub mod client;
pub mod json_repair;
pub mod provider;
pub mod providers;
pub mod types;

use crate::llm::provider::LlmProvider;
use crate::llm::providers::{
    deepseek::ThinkingMode,
    openai::{OpenAICompatibleProvider, ReasoningDialect, TokenConfig},
};
use std::sync::{Arc, OnceLock, RwLock};








#[derive(Debug, Clone, Default)]
pub struct CustomProviderDefaults {
    pub base_url: Option<String>,
    pub token_config: Option<TokenConfig>,
    pub dialect: Option<ReasoningDialect>,
}

static CUSTOM_DEFAULTS: OnceLock<RwLock<CustomProviderDefaults>> = OnceLock::new();

fn custom_defaults() -> &'static RwLock<CustomProviderDefaults> {
    CUSTOM_DEFAULTS.get_or_init(|| RwLock::new(CustomProviderDefaults::default()))
}


pub fn set_custom_provider_defaults(d: CustomProviderDefaults) {
    if let Ok(mut g) = custom_defaults().write() {
        *g = d;
    }
}






static GLOBAL_PROVIDER: OnceLock<RwLock<String>> = OnceLock::new();

fn global_provider() -> &'static RwLock<String> {
    GLOBAL_PROVIDER.get_or_init(|| RwLock::new(String::new()))
}


pub fn set_global_provider_name(name: &str) {
    if let Ok(mut g) = global_provider().write() {
        *g = name.to_string();
    }
}


pub fn global_provider_name() -> Option<String> {
    global_provider()
        .read()
        .ok()
        .map(|g| g.clone())
        .filter(|s| !s.is_empty())
}







pub fn resolve_internal_provider(profile_provider: &str) -> String {
    if profile_provider == "deepseek" {
        if let Some(g) = global_provider_name() {
            if g != "deepseek" {
                return g;
            }
        }
    }
    profile_provider.to_string()
}


pub fn custom_defaults_from_settings(
    base_url: &str,
    token_config_json: &str,
    dialect: &str,
) -> CustomProviderDefaults {
    CustomProviderDefaults {
        base_url: if base_url.trim().is_empty() {
            None
        } else {
            Some(base_url.trim().to_string())
        },
        token_config: TokenConfig::from_json(token_config_json),
        dialect: ReasoningDialect::from_name(dialect.trim()),
    }
}






pub fn create_provider(name: &str, api_key: String, model: String) -> Arc<dyn LlmProvider> {
    create_provider_with_thinking(name, api_key, model, ThinkingMode::ServerDefault)
}





pub fn create_provider_with_thinking(
    name: &str,
    api_key: String,
    model: String,
    thinking: ThinkingMode,
) -> Arc<dyn LlmProvider> {
    create_provider_full(name, api_key, model, thinking, None, None, None)
}











pub fn create_provider_full(
    name: &str,
    api_key: String,
    model: String,
    thinking: ThinkingMode,
    base_url: Option<String>,
    token_config: Option<TokenConfig>,
    dialect_override: Option<ReasoningDialect>,
) -> Arc<dyn LlmProvider> {
    
    let (base_url, token_config, dialect_override) = if name == "custom" {
        let g = custom_defaults()
            .read()
            .map(|g| g.clone())
            .unwrap_or_default();
        (
            base_url.or(g.base_url),
            token_config.or(g.token_config),
            dialect_override.or(g.dialect),
        )
    } else {
        (base_url, token_config, dialect_override)
    };

    let dialect = dialect_override.unwrap_or_else(|| match name {
        "openai" => ReasoningDialect::OpenAI,
        "deepseek" => ReasoningDialect::DeepSeek,
        "qwen" => ReasoningDialect::Qwen,
        "glm" => ReasoningDialect::GLM,
        "kimi" => ReasoningDialect::Kimi,
        "minimax" => ReasoningDialect::MiniMax,
        _ => ReasoningDialect::DeepSeek,
    });

    let mut provider =
        OpenAICompatibleProvider::new(api_key, model, dialect).with_thinking(thinking);
    if let Some(url) = base_url {
        provider = provider.with_base_url(url);
    }
    if let Some(tc) = token_config {
        provider = provider.with_token_config(tc);
    }
    Arc::new(provider)
}
