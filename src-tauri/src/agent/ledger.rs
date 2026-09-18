











use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};


pub type RunId = String;


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunKind {
    Chat,
    Worker,
    Scheduled,
    Roundtable,
}
impl RunKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RunKind::Chat => "chat",
            RunKind::Worker => "worker",
            RunKind::Scheduled => "scheduled",
            RunKind::Roundtable => "roundtable",
        }
    }
}










#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatus {
    Running,
    Ok,
    Failed,
    Cancelled,
    Timeout,
    
    
    Paused,
    
    Interrupted,
}
impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Running => "running",
            RunStatus::Ok => "ok",
            RunStatus::Failed => "failed",
            RunStatus::Cancelled => "cancelled",
            RunStatus::Timeout => "timeout",
            RunStatus::Paused => "paused",
            RunStatus::Interrupted => "interrupted",
        }
    }
    
    pub fn is_resumable(self) -> bool {
        matches!(self, RunStatus::Paused | RunStatus::Interrupted)
    }
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStepKind {
    Llm,
    Tool,
    Approval,
}
impl RunStepKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStepKind::Llm => "llm",
            RunStepKind::Tool => "tool",
            RunStepKind::Approval => "approval",
        }
    }
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepOutcome {
    Ok,
    Failed,
    Unavailable,
}
impl StepOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            StepOutcome::Ok => "ok",
            StepOutcome::Failed => "failed",
            StepOutcome::Unavailable => "unavailable",
        }
    }
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalSource {
    Human,
    AutoApprove,
    TimeoutDeny,
}
impl ApprovalSource {
    pub fn as_str(self) -> &'static str {
        match self {
            ApprovalSource::Human => "human",
            ApprovalSource::AutoApprove => "auto_approve",
            ApprovalSource::TimeoutDeny => "timeout_deny",
        }
    }
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    Accept,
    Edit,
    Respond,
    Ignore,
}
impl ApprovalDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            ApprovalDecision::Accept => "accept",
            ApprovalDecision::Edit => "edit",
            ApprovalDecision::Respond => "respond",
            ApprovalDecision::Ignore => "ignore",
        }
    }
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnavailableReason {
    Network,
    NotFound,
    Timeout,
    Denied,
    ProviderDown,
}
impl UnavailableReason {
    pub fn as_str(self) -> &'static str {
        match self {
            UnavailableReason::Network => "network",
            UnavailableReason::NotFound => "not_found",
            UnavailableReason::Timeout => "timeout",
            UnavailableReason::Denied => "denied",
            UnavailableReason::ProviderDown => "provider_down",
        }
    }
}


#[derive(Debug, Clone)]
pub struct RunBegin {
    
    
    
    pub run_id: String,
    pub session_id: String,
    pub group_id: Option<String>,
    pub seat_id: Option<String>,
    
    pub kind: RunKind,
    
    pub model: Option<String>,
    
    
    
    
    pub job_id: Option<String>,
    
    pub attempt_no: u32,
}




#[derive(Debug, Clone)]
pub struct RunStep {
    pub seq: u64,
    pub kind: RunStepKind,
    pub name: Option<String>,
    
    pub origin: Option<String>,
    
    pub args_digest: Option<String>,
    pub outcome: StepOutcome,
    pub unavailable_reason: Option<UnavailableReason>,
    pub approval_source: Option<ApprovalSource>,
    pub approval_decision: Option<ApprovalDecision>,
    pub duration_ms: Option<u64>,
    pub started_at: i64,
}


#[derive(Debug, Clone)]
pub struct RunFinish {
    pub status: RunStatus,
    pub ended_at: i64,
    pub model: Option<String>,
    pub prompt_tokens: u64,
    pub output_tokens: u64,
    
    pub reasoning_tokens: u64,
    pub iterations: u32,
    
    pub error_kind: Option<String>,
}









#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Checkpoint {
    
    pub iteration: u32,
    
    pub tokens_used: u64,
    
    pub ts: i64,
}





pub trait RunLedger: Send + Sync {
    
    fn begin(&self, r: RunBegin) -> RunId;
    
    fn step(&self, id: &str, s: RunStep);
    
    fn finish(&self, id: &str, f: RunFinish);
    
    
    
    
    fn checkpoint(&self, id: &str, cp: Checkpoint);
}


pub fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}



pub fn origin_of(tool_name: &str) -> Option<String> {
    if let Some(rest) = tool_name.strip_prefix("mcp__") {
        if let Some((server, _)) = rest.split_once("__") {
            return Some(format!("mcp:{}", server));
        }
        return Some("mcp:unknown".to_string());
    }
    None
}






pub fn args_digest(args: &str) -> String {
    const LIMIT: usize = 256;
    
    let masked = crate::storage::secrets::redact_sensitive_args(args);
    if masked.len() <= LIMIT {
        masked
    } else {
        
        let cut = if masked.is_char_boundary(LIMIT) {
            LIMIT
        } else {
            let mut i = LIMIT;
            while i > 0 && !masked.is_char_boundary(i) {
                i -= 1;
            }
            i
        };
        format!("{}…(len={})", &masked[..cut], args.len())
    }
}

#[cfg(test)]
mod tests {
    use super::args_digest;

    
    
    #[test]
    fn args_digest_no_panic_on_multibyte_boundary() {
        
        let input: String = "上".repeat(130);
        assert!(input.len() > 256);
        
        let out = args_digest(&input);
        
        let prefix = out.split("…(len=").next().unwrap();
        assert!(prefix.chars().count() <= 256);
        assert!(out.contains("len=390"));
    }

    #[test]
    fn args_digest_short_untouched() {
        let out = args_digest(r#"{"path":"/tmp/a.txt"}"#);
        assert_eq!(out, r#"{"path":"/tmp/a.txt"}"#);
    }
}
