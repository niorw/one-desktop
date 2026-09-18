




use crate::paths;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::str::FromStr;


#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SearchProvider {
    
    #[default]
    Tavily,
    
    Brave,
}

impl SearchProvider {
    
    pub fn mcp_id(&self) -> &'static str {
        match self {
            SearchProvider::Tavily => "tavily",
            SearchProvider::Brave => "brave",
        }
    }

    
    pub fn env_var(&self) -> &'static str {
        match self {
            SearchProvider::Tavily => "TAVILY_API_KEY",
            SearchProvider::Brave => "BRAVE_API_KEY",
        }
    }
}

impl FromStr for SearchProvider {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "tavily" => Ok(SearchProvider::Tavily),
            "brave" => Ok(SearchProvider::Brave),
            other => Err(format!("未知搜索 provider: {other}")),
        }
    }
}

impl std::fmt::Display for SearchProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            SearchProvider::Tavily => "tavily",
            SearchProvider::Brave => "brave",
        };
        f.write_str(s)
    }
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub api_key: String,
    
    #[serde(default)]
    pub search_provider: SearchProvider,
    
    
    #[serde(default, alias = "web_search_api_key")]
    pub tavily_api_key: String,
    
    #[serde(default)]
    pub brave_api_key: String,
}

impl Config {
    
    pub fn active_search_key(&self) -> &str {
        match self.search_provider {
            SearchProvider::Tavily => self.tavily_api_key.as_str(),
            SearchProvider::Brave => self.brave_api_key.as_str(),
        }
    }

    
    pub fn active_search_key_mut(&mut self) -> &mut String {
        match self.search_provider {
            SearchProvider::Tavily => &mut self.tavily_api_key,
            SearchProvider::Brave => &mut self.brave_api_key,
        }
    }
}


fn config_path() -> PathBuf {
    paths::data_dir().join("config.json")
}


pub fn load_config() -> Config {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Config::default(),
    }
}


pub fn save_config(config: &Config) -> Result<(), String> {
    let path = config_path();
    
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write config: {}", e))?;
    tracing::info!(target: "onedesktop.config", "Config saved");
    Ok(())
}
