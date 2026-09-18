





use serde::{Deserialize, Serialize};
use std::collections::HashMap;


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpTransport {
    Stdio,
    Sse,
    Http,
}

impl McpTransport {
    pub fn as_str(&self) -> &'static str {
        match self {
            McpTransport::Stdio => "stdio",
            McpTransport::Sse => "sse",
            McpTransport::Http => "http",
        }
    }
    pub fn from_str(s: &str) -> Self {
        match s {
            "sse" => McpTransport::Sse,
            "http" => McpTransport::Http,
            _ => McpTransport::Stdio,
        }
    }
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpStatus {
    Enabled,
    Disabled,
    Error,
    Connecting,
}

impl McpStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            McpStatus::Enabled => "enabled",
            McpStatus::Disabled => "disabled",
            McpStatus::Error => "error",
            McpStatus::Connecting => "connecting",
        }
    }
    pub fn from_str(s: &str) -> Self {
        match s {
            "enabled" => McpStatus::Enabled,
            "error" => McpStatus::Error,
            "connecting" => McpStatus::Connecting,
            _ => McpStatus::Disabled,
        }
    }
}


#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpCapabilities {
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub resources: Vec<String>,
    #[serde(default)]
    pub prompts: Vec<String>,
}


#[derive(Debug, Clone)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub url: Option<String>,
    pub enabled: bool,
    pub status: McpStatus,
    pub capabilities: McpCapabilities,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}


#[derive(Debug, Clone)]
pub struct CreateMcpServerPayload {
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub url: Option<String>,
    pub enabled: bool,
}

impl McpServer {
    
    
    
    
    pub fn to_dto(&self) -> crate::types::McpServerDto {
        use crate::storage::secrets::{is_sensitive_key, redact};
        let env = self
            .env
            .iter()
            .map(|(k, v)| {
                if is_sensitive_key(k) {
                    (k.clone(), redact(v))
                } else {
                    (k.clone(), v.clone())
                }
            })
            .collect();
        crate::types::McpServerDto {
            id: self.id.clone(),
            name: self.name.clone(),
            transport: self.transport.as_str().to_string(),
            command: self.command.clone(),
            args: self.args.clone(),
            env,
            url: self.url.clone(),
            enabled: self.enabled,
            status: self.status.as_str().to_string(),
            capabilities: crate::types::McpCapabilitiesDto {
                tools: self.capabilities.tools.clone(),
                resources: self.capabilities.resources.clone(),
                prompts: self.capabilities.prompts.clone(),
            },
            error: self.error.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}
