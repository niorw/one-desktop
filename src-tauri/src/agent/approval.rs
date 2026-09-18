


























use crate::agent::ledger::ApprovalSource;
use async_trait::async_trait;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex as TokioMutex, oneshot};



pub const APPROVAL_TIMEOUT_SECS: u64 = 300;


pub type ApprovalId = String;


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

impl RiskLevel {
    
    pub fn of(tool: &str) -> Self {
        match tool {
            "run_shell" | "write_file" | "update_memory" => RiskLevel::High,
            _ => RiskLevel::Medium,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            RiskLevel::Low => "low",
            RiskLevel::Medium => "medium",
            RiskLevel::High => "high",
        }
    }
}


#[derive(Debug, Clone)]
pub struct ApprovalRequest {
    pub id: ApprovalId,
    
    pub session_id: String,
    
    pub run_id: String,
    
    pub seat_id: Option<String>,
    
    pub tool: String,
    
    pub args: String,
    pub risk: RiskLevel,
    
    pub expire_after: Option<Duration>,
}

impl ApprovalRequest {
    
    
    pub fn new(
        session_id: &str,
        run_id: &str,
        seat_id: Option<&str>,
        tool: &str,
        args: &str,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            seat_id: seat_id.map(|s| s.to_string()),
            tool: tool.to_string(),
            args: args.to_string(),
            risk: RiskLevel::of(tool),
            expire_after: Some(Duration::from_secs(APPROVAL_TIMEOUT_SECS)),
        }
    }
}






#[derive(Debug, Clone, PartialEq)]
pub enum ApprovalDecision {
    Accept,
    Edit { args: serde_json::Value },
    Respond { feedback: String },
    Ignore,
}

impl ApprovalDecision {
    pub fn as_str(&self) -> &'static str {
        match self {
            ApprovalDecision::Accept => "accept",
            ApprovalDecision::Edit { .. } => "edit",
            ApprovalDecision::Respond { .. } => "respond",
            ApprovalDecision::Ignore => "ignore",
        }
    }

    
    pub fn to_ledger(&self) -> crate::agent::ledger::ApprovalDecision {
        match self {
            ApprovalDecision::Accept => crate::agent::ledger::ApprovalDecision::Accept,
            ApprovalDecision::Edit { .. } => crate::agent::ledger::ApprovalDecision::Edit,
            ApprovalDecision::Respond { .. } => crate::agent::ledger::ApprovalDecision::Respond,
            ApprovalDecision::Ignore => crate::agent::ledger::ApprovalDecision::Ignore,
        }
    }
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalError {
    
    NotFound,
    
    Closed,
}

impl std::fmt::Display for ApprovalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApprovalError::NotFound => write!(f, "approval not found or already decided"),
            ApprovalError::Closed => write!(f, "approval channel closed"),
        }
    }
}

struct PendingEntry {
    tx: oneshot::Sender<ApprovalDecision>,
    
    req: ApprovalRequest,
}



pub struct PendingHandle {
    id: ApprovalId,
    rx: oneshot::Receiver<ApprovalDecision>,
    pending: Arc<TokioMutex<HashMap<ApprovalId, PendingEntry>>>,
}

impl PendingHandle {
    
    
    
    
    
    
    pub async fn await_decision(self, expire: Option<Duration>) -> (ApprovalDecision, ApprovalSource) {
        match expire {
            Some(d) => match tokio::time::timeout(d, self.rx).await {
                Ok(Ok(decision)) => (decision, ApprovalSource::Human),
                Ok(Err(_)) => (ApprovalDecision::Ignore, ApprovalSource::Human),
                Err(_) => {
                    self.pending.lock().await.remove(&self.id);
                    (ApprovalDecision::Ignore, ApprovalSource::TimeoutDeny)
                }
            },
            None => match self.rx.await {
                Ok(decision) => (decision, ApprovalSource::Human),
                Err(_) => (ApprovalDecision::Ignore, ApprovalSource::Human),
            },
        }
    }
}





pub struct ApprovalBroker {
    pending: Arc<TokioMutex<HashMap<ApprovalId, PendingEntry>>>,
    
    exemptions: Arc<std::sync::RwLock<HashMap<String, HashSet<String>>>>,
}

impl Default for ApprovalBroker {
    fn default() -> Self {
        Self::new()
    }
}

impl ApprovalBroker {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(TokioMutex::new(HashMap::new())),
            exemptions: Arc::new(std::sync::RwLock::new(HashMap::new())),
        }
    }

    
    
    pub async fn register(&self, req: ApprovalRequest) -> PendingHandle {
        let (tx, rx) = oneshot::channel();
        let id = req.id.clone();
        let pending = self.pending.clone();
        self.pending
            .lock()
            .await
            .insert(id.clone(), PendingEntry { tx, req });
        PendingHandle { id, rx, pending }
    }

    
    pub async fn decide(
        &self,
        id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), ApprovalError> {
        let mut map = self.pending.lock().await;
        match map.remove(id) {
            Some(entry) => {
                tracing::info!(
                    target: "onedesktop.approval",
                    approval_id = %id,
                    session_id = %entry.req.session_id,
                    tool = %entry.req.tool,
                    decision = ?decision,
                    "approval decided"
                );
                entry.tx.send(decision).map_err(|_| ApprovalError::Closed)
            }
            None => {
                tracing::warn!(
                    target: "onedesktop.approval",
                    approval_id = %id,
                    decision = ?decision,
                    "approval decision for unknown id (expired or double-decide)"
                );
                Err(ApprovalError::NotFound)
            }
        }
    }

    
    
    
    #[deprecated(note = "use decide_approval with approval_id（四态）")]
    pub async fn approve_tool(&self, session_id: &str, approved: bool) -> bool {
        let mut map = self.pending.lock().await;
        let target: Option<ApprovalId> = map
            .iter()
            .find(|(_, e)| e.req.session_id == session_id)
            .map(|(id, _)| id.clone());
        if let Some(id) = target {
            if let Some(entry) = map.remove(&id) {
                let _ = entry.tx.send(if approved {
                    ApprovalDecision::Accept
                } else {
                    ApprovalDecision::Ignore
                });
                return true;
            }
        }
        false
    }

    
    pub fn exempt_tool(&self, session_id: &str, tool: &str) {
        self.exemptions
            .write()
            .unwrap()
            .entry(session_id.to_string())
            .or_default()
            .insert(tool.to_string());
    }

    
    pub fn is_exempt(&self, session_id: &str, tool: &str) -> bool {
        self.exemptions
            .read()
            .unwrap()
            .get(session_id)
            .map(|s| s.contains(tool))
            .unwrap_or(false)
    }

    
    pub async fn pending_by_run(&self, run_id: &str) -> Vec<ApprovalRequest> {
        self.pending
            .lock()
            .await
            .values()
            .filter(|e| e.req.run_id == run_id)
            .map(|e| e.req.clone())
            .collect()
    }

    
    pub async fn pending_snapshot(&self) -> Vec<ApprovalRequest> {
        self.pending.lock().await.values().map(|e| e.req.clone()).collect()
    }

    
    
    pub async fn decide_batch(&self, ids: &[String], decision: ApprovalDecision) -> Vec<String> {
        let mut map = self.pending.lock().await;
        let mut decided = Vec::new();
        for id in ids {
            if let Some(entry) = map.remove(id) {
                if entry.tx.send(decision.clone()).is_ok() {
                    decided.push(id.clone());
                }
            }
        }
        decided
    }

    
    pub async fn pending_count(&self) -> usize {
        self.pending.lock().await.len()
    }
}





pub fn high_risk_pending_ids(pending: &[ApprovalRequest]) -> HashSet<String> {
    pending
        .iter()
        .filter(|r| matches!(r.risk, RiskLevel::High))
        .map(|r| r.id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn req(session: &str) -> ApprovalRequest {
        ApprovalRequest::new(session, "run-1", Some("seat-1"), "write_file", r#"{"path":"/x"}"#)
    }

    #[tokio::test]
    async fn register_then_decide_accept() {
        let broker = ApprovalBroker::new();
        let handle = broker.register(req("s1")).await;
        let id = handle.id.clone();
        let task = tokio::spawn(async move {
            handle
                .await_decision(Some(Duration::from_secs(5)))
                .await
        });
        
        broker.decide(&id, ApprovalDecision::Accept).await.unwrap();
        let (decision, source) = task.await.unwrap();
        assert_eq!(decision, ApprovalDecision::Accept);
        assert_eq!(source, ApprovalSource::Human);
        assert_eq!(broker.pending_count().await, 0);
    }

    #[tokio::test]
    async fn edit_and_respond_payload_roundtrip() {
        let broker = ApprovalBroker::new();
        
        let handle = broker.register(req("s1")).await;
        let id = handle.id.clone();
        let task = tokio::spawn(async move {
            handle
                .await_decision(Some(Duration::from_secs(5)))
                .await
        });
        broker
            .decide(&id, ApprovalDecision::Edit { args: json!({"path": "/y"}) })
            .await
            .unwrap();
        let (decision, source) = task.await.unwrap();
        assert_eq!(
            decision,
            ApprovalDecision::Edit { args: json!({"path": "/y"}) }
        );
        assert_eq!(source, ApprovalSource::Human);

        
        let handle = broker.register(req("s1")).await;
        let id = handle.id.clone();
        let task = tokio::spawn(async move {
            handle
                .await_decision(Some(Duration::from_secs(5)))
                .await
        });
        broker
            .decide(
                &id,
                ApprovalDecision::Respond { feedback: "别删，先列目录".into() },
            )
            .await
            .unwrap();
        let (decision, _) = task.await.unwrap();
        assert_eq!(
            decision,
            ApprovalDecision::Respond { feedback: "别删，先列目录".into() }
        );
    }

    #[tokio::test]
    async fn timeout_fail_closed_to_ignore_with_timeout_deny() {
        let broker = ApprovalBroker::new();
        let handle = broker.register(req("s1")).await;
        let task = tokio::spawn(async move {
            handle
                .await_decision(Some(Duration::from_millis(50)))
                .await
        });
        let (decision, source) = task.await.unwrap();
        assert_eq!(decision, ApprovalDecision::Ignore);
        assert_eq!(source, ApprovalSource::TimeoutDeny);
        
        assert_eq!(broker.pending_count().await, 0);
    }

    #[tokio::test]
    async fn decide_unknown_id_is_not_found_and_decide_is_idempotent() {
        let broker = ApprovalBroker::new();
        assert_eq!(
            broker.decide("nope", ApprovalDecision::Ignore).await,
            Err(ApprovalError::NotFound)
        );

        let handle = broker.register(req("s1")).await;
        let id = handle.id.clone();
        
        broker.decide(&id, ApprovalDecision::Ignore).await.unwrap();
        
        assert_eq!(
            broker.decide(&id, ApprovalDecision::Accept).await,
            Err(ApprovalError::NotFound)
        );
    }

    #[tokio::test]
    async fn concurrent_asks_are_independent_per_id() {
        
        let broker = ApprovalBroker::new();
        let h1 = broker.register(req("s1")).await;
        let h2 = broker.register(req("s1")).await;
        let id1 = h1.id.clone();
        let id2 = h2.id.clone();

        let t1 = tokio::spawn(async move {
            h1.await_decision(Some(Duration::from_secs(5))).await
        });
        let t2 = tokio::spawn(async move {
            h2.await_decision(Some(Duration::from_secs(5))).await
        });

        
        broker.decide(&id2, ApprovalDecision::Respond { feedback: "f2".into() }).await.unwrap();
        broker.decide(&id1, ApprovalDecision::Accept).await.unwrap();

        let (d1, _) = t1.await.unwrap();
        let (d2, _) = t2.await.unwrap();
        assert_eq!(d1, ApprovalDecision::Accept);
        assert_eq!(d2, ApprovalDecision::Respond { feedback: "f2".into() });
        assert_eq!(broker.pending_count().await, 0);
    }

    #[tokio::test]
    #[allow(deprecated)] 
    async fn legacy_approve_tool_maps_by_session() {
        let broker = ApprovalBroker::new();
        
        assert!(!broker.approve_tool("s1", true).await);

        let handle = broker.register(req("s1")).await;
        let task = tokio::spawn(async move {
            handle
                .await_decision(Some(Duration::from_secs(5)))
                .await
        });
        assert!(broker.approve_tool("s1", true).await);
        let (decision, source) = task.await.unwrap();
        assert_eq!(decision, ApprovalDecision::Accept);
        assert_eq!(source, ApprovalSource::Human);

        
        assert!(!broker.approve_tool("s1", false).await);

        
        let h1 = broker.register(req("w1")).await;
        let h2 = broker.register(req("w2")).await;
        let t1 = tokio::spawn(async move {
            h1.await_decision(Some(Duration::from_secs(5))).await
        });
        let t2 = tokio::spawn(async move {
            h2.await_decision(Some(Duration::from_secs(5))).await
        });
        assert!(broker.approve_tool("w2", false).await); 
        assert!(broker.approve_tool("w1", false).await); 
        let (d1, _) = t1.await.unwrap();
        let (d2, _) = t2.await.unwrap();
        assert_eq!(d1, ApprovalDecision::Ignore);
        assert_eq!(d2, ApprovalDecision::Ignore);
    }

    #[test]
    fn risk_level_mapping() {
        assert_eq!(RiskLevel::of("run_shell"), RiskLevel::High);
        assert_eq!(RiskLevel::of("write_file"), RiskLevel::High);
        assert_eq!(RiskLevel::of("update_memory"), RiskLevel::High);
        assert_eq!(RiskLevel::of("read_file"), RiskLevel::Medium);
        assert_eq!(RiskLevel::of("mcp__x__y"), RiskLevel::Medium);
        assert_eq!(RiskLevel::High.as_str(), "high");
        assert_eq!(RiskLevel::Medium.as_str(), "medium");
        assert_eq!(RiskLevel::Low.as_str(), "low");
    }

    #[test]
    fn decision_as_str_and_to_ledger() {
        assert_eq!(ApprovalDecision::Accept.as_str(), "accept");
        assert_eq!(ApprovalDecision::Edit { args: json!({}) }.as_str(), "edit");
        assert_eq!(
            ApprovalDecision::Respond { feedback: "x".into() }.as_str(),
            "respond"
        );
        assert_eq!(ApprovalDecision::Ignore.as_str(), "ignore");
        assert_eq!(
            ApprovalDecision::Accept.to_ledger(),
            crate::agent::ledger::ApprovalDecision::Accept
        );
        assert_eq!(
            ApprovalDecision::Edit { args: json!({}) }.to_ledger(),
            crate::agent::ledger::ApprovalDecision::Edit
        );
    }

    #[tokio::test]
    async fn session_exemption_skips_ask() {
        let broker = ApprovalBroker::new();
        broker.exempt_tool("s1", "mcp__gh__create");
        assert!(broker.is_exempt("s1", "mcp__gh__create"));
        assert!(!broker.is_exempt("s1", "other_tool"));
        assert!(!broker.is_exempt("s2", "mcp__gh__create"));
    }

    #[tokio::test]
    async fn batch_decide_counts_only_pending() {
        let broker = ApprovalBroker::new();
        let h1 = broker.register(req("s1")).await;
        let h2 = broker.register(req("s2")).await;
        
        let n = broker
            .decide_batch(
                &[h1.id.clone(), h2.id.clone(), "ghost-id".to_string()],
                ApprovalDecision::Accept,
            )
            .await;
        assert_eq!(n.len(), 2);
        assert_eq!(broker.pending_count().await, 0);
    }

    #[tokio::test]
    async fn pending_by_run_filters_correctly() {
        let broker = ApprovalBroker::new();
        let r1 = ApprovalRequest::new("s1", "run-A", Some("w1"), "mcp__x__y", "{}");
        let r2 = ApprovalRequest::new("s2", "run-A", Some("w2"), "mcp__x__z", "{}");
        let r3 = ApprovalRequest::new("s3", "run-B", None, "read_file", "{}");
        broker.register(r1).await;
        broker.register(r2).await;
        broker.register(r3).await;
        let run_a = broker.pending_by_run("run-A").await;
        assert_eq!(run_a.len(), 2);
        assert_eq!(broker.pending_by_run("run-B").await.len(), 1);
    }

    #[tokio::test]
    async fn high_risk_pending_ids_excludes_dangerous_from_batch() {
        let broker = ApprovalBroker::new();
        
        let h1 = broker.register(ApprovalRequest::new("s1", "run-A", None, "run_shell", "{}")).await;
        let h2 = broker.register(ApprovalRequest::new("s2", "run-A", None, "mcp__x__y", "{}")).await;
        let h3 = broker.register(ApprovalRequest::new("s3", "run-B", None, "read_file", "{}")).await;

        let pending = broker.pending_snapshot().await;
        let risky = high_risk_pending_ids(&pending);

        assert_eq!(risky.len(), 1);
        assert!(risky.contains(&h1.id));
        assert!(!risky.contains(&h2.id));
        assert!(!risky.contains(&h3.id));
    }
}



#[async_trait]
impl crate::agent::ports::ApprovalGate for ApprovalBroker {
    async fn request_cli_approval(
        &self,
        tool: &str,
        args: &str,
        session_id: &str,
    ) -> Result<ApprovalDecision, String> {
        let req = ApprovalRequest::new(session_id, &format!("cli:{}", tool), None, tool, args);
        let handle = self.register(req).await;
        let (decision, _src) = handle
            .await_decision(Some(Duration::from_secs(APPROVAL_TIMEOUT_SECS)))
            .await;
        Ok(decision)
    }
}








pub const PROPOSAL_TIMEOUT_SECS: u64 = 300;


#[derive(Debug, Clone, PartialEq)]
pub enum ProposalDecision {
    
    Selected { option_id: String },
    
    Custom { text: String },
    
    Rejected,
}

impl ProposalDecision {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProposalDecision::Selected { .. } => "selected",
            ProposalDecision::Custom { .. } => "custom",
            ProposalDecision::Rejected => "rejected",
        }
    }
}


#[derive(Debug, Clone)]
pub struct ProposalOptionData {
    pub id: String,
    pub label: String,
    pub description: String,
    pub risk: String,
    pub recommended: bool,
}


#[derive(Debug, Clone)]
pub struct ProposalRequest {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub title: String,
    pub summary: String,
    pub options: Vec<ProposalOptionData>,
    pub risk: RiskLevel,
    pub expire_after: Option<Duration>,
}

impl ProposalRequest {
    pub fn new(
        session_id: &str,
        run_id: &str,
        title: &str,
        summary: &str,
        options: Vec<ProposalOptionData>,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            title: title.to_string(),
            summary: summary.to_string(),
            options,
            risk: RiskLevel::Medium,
            expire_after: Some(Duration::from_secs(PROPOSAL_TIMEOUT_SECS)),
        }
    }
}

struct ProposalPendingEntry {
    tx: oneshot::Sender<ProposalDecision>,
    #[allow(dead_code)]
    req: ProposalRequest,
}


pub struct ProposalHandle {
    id: String,
    rx: oneshot::Receiver<ProposalDecision>,
    pending: Arc<TokioMutex<HashMap<String, ProposalPendingEntry>>>,
}

impl ProposalHandle {
    
    pub async fn await_decision(self, expire: Option<Duration>) -> ProposalDecision {
        match expire {
            Some(d) => match tokio::time::timeout(d, self.rx).await {
                Ok(Ok(decision)) => decision,
                Ok(Err(_)) => ProposalDecision::Rejected,
                Err(_) => {
                    self.pending.lock().await.remove(&self.id);
                    ProposalDecision::Rejected
                }
            },
            None => match self.rx.await {
                Ok(decision) => decision,
                Err(_) => ProposalDecision::Rejected,
            },
        }
    }
}


pub struct ProposalBroker {
    pending: Arc<TokioMutex<HashMap<String, ProposalPendingEntry>>>,
}

impl Default for ProposalBroker {
    fn default() -> Self {
        Self::new()
    }
}

impl ProposalBroker {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(TokioMutex::new(HashMap::new())),
        }
    }

    
    pub async fn register(&self, req: ProposalRequest) -> ProposalHandle {
        let (tx, rx) = oneshot::channel();
        let id = req.id.clone();
        let pending = self.pending.clone();
        self.pending
            .lock()
            .await
            .insert(id.clone(), ProposalPendingEntry { tx, req });
        ProposalHandle { id, rx, pending }
    }

    
    pub async fn decide(
        &self,
        id: &str,
        decision: ProposalDecision,
    ) -> Result<(), ApprovalError> {
        let mut map = self.pending.lock().await;
        match map.remove(id) {
            Some(entry) => {
                tracing::info!(
                    target: "onedesktop.approval",
                    proposal_id = %id,
                    session_id = %entry.req.session_id,
                    decision = ?decision,
                    "proposal decided"
                );
                entry.tx.send(decision).map_err(|_| ApprovalError::Closed)
            }
            None => {
                tracing::warn!(
                    target: "onedesktop.approval",
                    proposal_id = %id,
                    decision = ?decision,
                    "proposal decision for unknown id (expired or double-decide)"
                );
                Err(ApprovalError::NotFound)
            }
        }
    }
}


static PROPOSAL_BROKER: std::sync::OnceLock<Arc<ProposalBroker>> = std::sync::OnceLock::new();


pub fn proposal_broker() -> Arc<ProposalBroker> {
    PROPOSAL_BROKER
        .get_or_init(|| Arc::new(ProposalBroker::new()))
        .clone()
}
