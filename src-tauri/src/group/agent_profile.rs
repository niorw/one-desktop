





use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub model: String,
    pub system_prompt: String,
    pub capabilities: Vec<String>,
    pub skills: Vec<String>,
    pub mcp: Vec<String>,
    pub tools: Vec<String>,
    
    #[serde(default)]
    pub plugins: Vec<String>,
    pub created_at: i64,
    
    #[serde(default = "default_token_budget")]
    pub token_budget: u64,
    
    #[serde(default = "default_provider")]
    pub provider: String,
    
    
    #[serde(default)]
    pub executor: Option<String>,
    
    #[serde(default)]
    pub disallowed_tools: Vec<String>,
    
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    
    #[serde(default)]
    pub max_turns: u32,
    
    #[serde(default = "default_isolation")]
    pub isolation: String,
}

pub fn default_token_budget() -> u64 {
    100_000
}

pub fn default_provider() -> String {
    
    
    crate::llm::global_provider_name().unwrap_or_else(|| "deepseek".to_string())
}

pub fn default_permission_mode() -> String {
    "default".to_string()
}

pub fn default_isolation() -> String {
    "none".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAgentProfilePayload {
    pub name: String,
    pub model: String,
    pub system_prompt: String,
    pub capabilities: Vec<String>,
    pub skills: Vec<String>,
    pub mcp: Vec<String>,
    pub tools: Vec<String>,
}



#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentProfileExt {
    #[serde(default)]
    pub disallowed_tools: Vec<String>,
    #[serde(default)]
    pub plugins: Vec<String>,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    #[serde(default)]
    pub max_turns: u32,
    #[serde(default = "default_isolation")]
    pub isolation: String,
}


#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateAgentProfilePayload {
    pub name: Option<String>,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    pub capabilities: Option<Vec<String>>,
    pub skills: Option<Vec<String>>,
    pub mcp: Option<Vec<String>>,
    pub tools: Option<Vec<String>>,
    
    #[serde(default)]
    pub plugins: Option<Vec<String>>,
    
    #[serde(default)]
    pub disallowed_tools: Option<Vec<String>>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub max_turns: Option<u32>,
    #[serde(default)]
    pub isolation: Option<String>,
}

impl CreateAgentProfilePayload {
    
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("name is required".into());
        }
        if self.model.trim().is_empty() {
            return Err("model is required".into());
        }
        if self.system_prompt.trim().is_empty() {
            return Err("system_prompt is required".into());
        }
        Ok(())
    }
}

impl AgentProfile {
    
    
    
    
    
    
    
    pub fn capabilities_block(&self, skill_l1: &str) -> String {
        let mut lines: Vec<String> = Vec::new();
        if !skill_l1.is_empty() {
            lines.push(skill_l1.to_string());
        }
        if !self.mcp.is_empty() {
            lines.push(format!("MCP servers: {}", self.mcp.join(", ")));
        }
        if !self.tools.is_empty() {
            lines.push(format!("Tools: {}", self.tools.join(", ")));
        }
        if !self.plugins.is_empty() {
            lines.push(format!("Plugins: {}", self.plugins.join(", ")));
        }
        if lines.is_empty() {
            return String::new();
        }
        let mut block = String::from("[Capabilities]\n");
        block.push_str(&lines.join("\n"));
        block
    }
}
