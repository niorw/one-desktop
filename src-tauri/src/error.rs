


use thiserror::Error;



#[derive(Error, Debug, Clone)]
pub enum AgentError {
    #[error("[SESSION_NOT_FOUND] Session {session_id} not found")]
    SessionNotFound { session_id: String },

    #[error("[LLM_ERROR] LLM provider error: {message}")]
    LlmError { message: String },

    #[error("[LLM_TIMEOUT] LLM request timed out after {elapsed_secs}s")]
    LlmTimeout { elapsed_secs: u64 },

    #[error("[LLM_NETWORK] Network error calling LLM: {message}")]
    LlmNetwork { message: String },

    #[error("[LLM_RATE_LIMIT] LLM rate limited: {message}")]
    LlmRateLimit { message: String },

    #[error("[TOOL_NOT_FOUND] Tool '{tool_name}' not found in registry")]
    ToolNotFound { tool_name: String },

    #[error("[TOOL_EXECUTION] Tool '{tool_name}' execution failed: {message}")]
    ToolExecution { tool_name: String, message: String },

    #[error("[TOOL_TIMEOUT] Tool '{tool_name}' timed out after {elapsed_secs}s")]
    ToolTimeout {
        tool_name: String,
        elapsed_secs: u64,
    },

    #[error("[TOOL_UNAUTHORIZED] Tool '{tool_name}' was rejected by user")]
    ToolUnauthorized { tool_name: String },

    #[error("[MAX_ITERATIONS] Agent reached maximum iterations ({max})")]
    MaxIterations { max: u32 },

    #[error("[STORAGE_ERROR] Database error: {message}")]
    Storage { message: String },

    #[error("[CONFIG_ERROR] Configuration error: {message}")]
    Config { message: String },

    #[error("[CANCELLED] Agent was cancelled by user")]
    Cancelled,

    
    #[error("[TOOL_ERROR] {message}")]
    ToolError { message: String },

    #[error("[INTERNAL] Internal error: {message}")]
    Internal { message: String },

    
    #[error("[UNKNOWN] {message}")]
    Legacy { message: String },
}

impl AgentError {
    
    pub fn error_code(&self) -> &'static str {
        match self {
            AgentError::SessionNotFound { .. } => "SESSION_NOT_FOUND",
            AgentError::LlmError { .. } => "LLM_ERROR",
            AgentError::LlmTimeout { .. } => "LLM_TIMEOUT",
            AgentError::LlmNetwork { .. } => "LLM_NETWORK",
            AgentError::LlmRateLimit { .. } => "LLM_RATE_LIMIT",
            AgentError::ToolNotFound { .. } => "TOOL_NOT_FOUND",
            AgentError::ToolExecution { .. } => "TOOL_EXECUTION",
            AgentError::ToolTimeout { .. } => "TOOL_TIMEOUT",
            AgentError::ToolUnauthorized { .. } => "TOOL_UNAUTHORIZED",
            AgentError::MaxIterations { .. } => "MAX_ITERATIONS",
            AgentError::Storage { .. } => "STORAGE_ERROR",
            AgentError::Config { .. } => "CONFIG_ERROR",
            AgentError::Cancelled => "CANCELLED",
            AgentError::ToolError { .. } => "TOOL_ERROR",
            AgentError::Internal { .. } => "INTERNAL",
            AgentError::Legacy { .. } => "UNKNOWN",
        }
    }

    
    pub fn is_retriable(&self) -> bool {
        matches!(
            self,
            AgentError::LlmTimeout { .. }
                | AgentError::LlmNetwork { .. }
                | AgentError::LlmRateLimit { .. }
        )
    }

    
    pub fn user_message(&self) -> String {
        match self {
            AgentError::SessionNotFound { .. } => "会话未找到".into(),
            AgentError::LlmError { message } => format!("AI 服务错误: {message}"),
            AgentError::LlmTimeout { elapsed_secs } => format!("AI 服务超时 ({elapsed_secs}秒)"),
            AgentError::LlmNetwork { message } => format!("网络错误: {message}"),
            AgentError::LlmRateLimit { .. } => "请求过于频繁，请稍后重试".into(),
            AgentError::ToolNotFound { tool_name } => format!("工具 '{tool_name}' 未安装"),
            AgentError::ToolExecution { tool_name, message } => {
                format!("工具 '{tool_name}' 执行失败: {message}")
            }
            AgentError::ToolTimeout { tool_name, .. } => format!("工具 '{tool_name}' 执行超时"),
            AgentError::ToolUnauthorized { tool_name } => format!("工具 '{tool_name}' 被拒绝"),
            AgentError::MaxIterations { max } => format!("已达到最大推理次数 ({max})"),
            AgentError::Storage { message } => format!("数据存储错误: {message}"),
            AgentError::Config { message } => format!("配置错误: {message}"),
            AgentError::Cancelled => "已取消".into(),
            AgentError::ToolError { message } => message.clone(),
            AgentError::Internal { message } => format!("内部错误: {message}"),
            AgentError::Legacy { message } => message.clone(),
        }
    }
}



impl From<String> for AgentError {
    fn from(s: String) -> Self {
        AgentError::Legacy { message: s }
    }
}

impl From<&str> for AgentError {
    fn from(s: &str) -> Self {
        AgentError::Legacy {
            message: s.to_string(),
        }
    }
}

impl From<rusqlite::Error> for AgentError {
    fn from(e: rusqlite::Error) -> Self {
        AgentError::Storage {
            message: e.to_string(),
        }
    }
}

impl From<reqwest::Error> for AgentError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            AgentError::LlmTimeout { elapsed_secs: 0 }
        } else if e.is_connect() {
            AgentError::LlmNetwork {
                message: e.to_string(),
            }
        } else {
            AgentError::LlmError {
                message: e.to_string(),
            }
        }
    }
}

impl From<std::io::Error> for AgentError {
    fn from(e: std::io::Error) -> Self {
        AgentError::ToolExecution {
            tool_name: "unknown".into(),
            message: e.to_string(),
        }
    }
}


pub type AgentResult<T> = Result<T, AgentError>;













use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

impl Serialize for AgentError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut st = serializer.serialize_struct("AgentError", 2)?;
        st.serialize_field("code", self.error_code())?;
        st.serialize_field("message", &self.user_message())?;
        st.end()
    }
}

#[cfg(test)]
mod error_contract_tests {
    use super::*;

    #[test]
    fn agent_error_serializes_to_code_message_object() {
        
        let err = AgentError::SessionNotFound {
            session_id: "s1".into(),
        };
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["code"], "SESSION_NOT_FOUND");
        assert_eq!(v["message"], "会话未找到");
    }

    #[test]
    fn llm_errors_are_marked_retriable() {
        assert!(AgentError::LlmTimeout { elapsed_secs: 5 }.is_retriable());
        assert!(AgentError::LlmNetwork {
            message: "conn reset".into()
        }
        .is_retriable());
        assert!(AgentError::LlmRateLimit {
            message: "too many".into()
        }
        .is_retriable());
        assert!(!AgentError::ToolNotFound {
            tool_name: "x".into()
        }
        .is_retriable());
    }

    #[test]
    fn error_codes_are_stable_and_prefixed() {
        let cases = vec![
            (
                AgentError::SessionNotFound {
                    session_id: "s".into(),
                },
                "SESSION_NOT_FOUND",
            ),
            (AgentError::LlmTimeout { elapsed_secs: 1 }, "LLM_TIMEOUT"),
            (
                AgentError::ToolExecution {
                    tool_name: "t".into(),
                    message: "m".into(),
                },
                "TOOL_EXECUTION",
            ),
            (
                AgentError::Storage {
                    message: "m".into(),
                },
                "STORAGE_ERROR",
            ),
            (
                AgentError::Internal {
                    message: "m".into(),
                },
                "INTERNAL",
            ),
        ];
        for (err, code) in cases {
            assert_eq!(err.error_code(), code);
        }
    }

    #[test]
    fn string_error_converts_with_unknown_code() {
        
        let e: AgentError = "some legacy string error".to_string().into();
        assert_eq!(e.error_code(), "UNKNOWN");
        assert!(e.user_message().contains("some legacy"));
    }
}
