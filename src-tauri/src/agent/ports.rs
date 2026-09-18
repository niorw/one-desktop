














use crate::agent::approval::ApprovalDecision;
use crate::events::EventEnvelope;
use crate::types::AgentEvent;
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Runtime};
use uuid::Uuid;






pub trait RunObserver: Send + Sync {
    fn on(&self, ev: AgentEvent, via_new_bus: bool);
}










static SEQ_COUNTERS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();


fn next_seq(session_id: &str) -> u64 {
    let mut map = SEQ_COUNTERS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner()); 
    let n = map.entry(session_id.to_string()).or_insert(0);
    *n += 1;
    *n
}


pub struct TauriObserver<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriObserver<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> RunObserver for TauriObserver<R> {
    fn on(&self, ev: AgentEvent, via_new_bus: bool) {
        
        let sid = ev_session(&ev).unwrap_or_default();
        let ev = ev.with_seq(next_seq(&sid));

        let topic = topic_of(&ev);
        let payload = serde_json::to_value(&ev).unwrap_or_default();
        if via_new_bus {
            let env = EventEnvelope {
                r#type: topic.to_string(),
                session_id: ev_session(&ev),
                group_id: None,
                payload: payload.clone(),
            };
            let _ = self.app.emit("onedesktop-event", &env);
        }
        let _ = self.app.emit("agent-event", &payload);
    }
}


fn topic_of(ev: &AgentEvent) -> &'static str {
    match ev {
        AgentEvent::Token { .. } => "agent:token",
        AgentEvent::Thinking { .. } => "agent:thinking",
        AgentEvent::ThinkingEnd { .. } => "agent:thinking_end",
        AgentEvent::Progress { .. } => "agent:progress",
        AgentEvent::Paused { .. } => "agent:paused",
        AgentEvent::Done { .. } => "agent:done",
        AgentEvent::Error { .. } => "agent:error",
        AgentEvent::ToolCall { .. } => "agent:tool_call",
        AgentEvent::ApprovalRequest { .. } => "agent:approval_request",
        AgentEvent::ToolResult { .. } => "agent:tool_result",
        AgentEvent::TodoUpdate { .. } => "agent:todo_update",
        AgentEvent::Proposal { .. } => "agent:proposal",
        AgentEvent::RunArtifacts { .. } => "agent:run_artifacts",
    }
}



fn ev_session(ev: &AgentEvent) -> Option<String> {
    let s = match ev {
        AgentEvent::Token { session_id, .. } => session_id,
        AgentEvent::Thinking { session_id, .. } => session_id,
        AgentEvent::ThinkingEnd { session_id, .. } => session_id,
        AgentEvent::Progress { session_id, .. } => session_id,
        AgentEvent::Paused { session_id, .. } => session_id,
        AgentEvent::Done { session_id, .. } => session_id,
        AgentEvent::Error { session_id, .. } => session_id,
        AgentEvent::ToolCall { session_id, .. } => session_id,
        AgentEvent::ApprovalRequest { session_id, .. } => session_id,
        AgentEvent::ToolResult { session_id, .. } => session_id,
        AgentEvent::TodoUpdate { session_id, .. } => session_id,
        AgentEvent::Proposal { session_id, .. } => session_id,
        AgentEvent::RunArtifacts { session_id, .. } => session_id,
    };
    Some(s.clone())
}











pub trait EventBus: Send + Sync {
    
    
    fn emit(&self, legacy_channel: &str, r#type: &str, group_id: Option<&str>, payload: serde_json::Value);
}


pub struct TauriEventBus<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriEventBus<R> {
    pub fn new(app: AppHandle<R>) -> Arc<dyn EventBus> {
        Arc::new(Self { app })
    }
}

impl<R: Runtime> EventBus for TauriEventBus<R> {
    fn emit(&self, legacy_channel: &str, r#type: &str, group_id: Option<&str>, payload: serde_json::Value) {
        crate::events::emit_envelope(&self.app, legacy_channel, r#type, None, group_id, payload);
    }
}





#[async_trait]
pub trait ApprovalGate: Send + Sync {
    
    
    async fn request_cli_approval(
        &self,
        tool: &str,
        args: &str,
        session_id: &str,
    ) -> Result<ApprovalDecision, String>;
}










pub trait Blackboard: Send + Sync {
    
    fn read(&self, session_id: &str, key: &str) -> Option<(String, u64)>;

    
    
    fn list(&self, session_id: &str) -> Vec<(String, String, u64)>;

    
    
    
    
    
    
    fn cas_write(
        &self,
        session_id: &str,
        key: &str,
        value: &str,
        expected_version: u64,
    ) -> Result<u64, BlackboardError>;
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlackboardError {
    
    Conflict(u64),
    
    Store(String),
    
    
    RoutingDenied(String),
}












pub trait MessageBus: Send + Sync {
    
    fn post(&self, msg: AgentMessage) -> Result<(), MessageBusError>;

    
    
    fn pending_for(&self, recipient: &str) -> Result<Vec<AgentMessage>, MessageBusError>;

    
    fn mark_delivered(&self, id: &str) -> Result<(), MessageBusError>;
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMessage {
    
    pub id: String,
    
    pub from_session: String,
    
    pub to_session: String,
    
    pub kind: String,
    
    pub body_path: String,
    
    pub created_at: i64,
}

impl AgentMessage {
    
    pub fn new(from_session: &str, to_session: &str, kind: &str, body_path: &str) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            from_session: from_session.to_string(),
            to_session: to_session.to_string(),
            kind: kind.to_string(),
            body_path: body_path.to_string(),
            created_at: now_secs(),
        }
    }
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MessageBusError {
    
    Store(String),
    
    NotFound,
    
    
    RoutingDenied(String),
}


fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}










pub trait TaskHeartbeat: Send + Sync {
    
    fn beat(&self, task_id: &str) -> Result<(), HeartbeatError>;
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeartbeatError {
    
    Store(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    
    #[test]
    fn seq_is_monotonic_per_session_and_isolated_across_sessions() {
        let a = format!("sess-a-{}", Uuid::new_v4());
        let b = format!("sess-b-{}", Uuid::new_v4());

        let a1 = next_seq(&a);
        let a2 = next_seq(&a);
        let b1 = next_seq(&b);
        let a3 = next_seq(&a);

        assert_eq!((a1, a2, a3), (1, 2, 3), "同会话必须连续递增");
        assert_eq!(b1, 1, "另一会话独立起号，不被 a 的计数带偏");
    }

    
    
    #[test]
    fn seq_survives_across_observer_instances() {
        let sid = format!("sess-{}", Uuid::new_v4());
        assert_eq!(next_seq(&sid), 1);
        
        assert_eq!(next_seq(&sid), 2);
        assert_eq!(next_seq(&sid), 3);
    }

    #[test]
    fn with_seq_preserves_payload_and_stamps_seq() {
        let ev = AgentEvent::ToolCall {
            seq: None,
            session_id: "s1".into(),
            call_id: "call_abc".into(),
            tool_name: "read_file".into(),
            tool_args: "{}".into(),
        };
        match ev.with_seq(42) {
            AgentEvent::ToolCall {
                seq,
                session_id,
                call_id,
                tool_name,
                ..
            } => {
                assert_eq!(seq, Some(42));
                assert_eq!(session_id, "s1");
                assert_eq!(call_id, "call_abc", "身份字段不能在赋号过程中丢失");
                assert_eq!(tool_name, "read_file");
            }
            other => panic!("变体被改写了: {other:?}"),
        }
    }

    
    
    #[test]
    fn thinking_end_has_topic_and_session() {
        let ev = AgentEvent::ThinkingEnd {
            seq: None,
            session_id: "s9".into(),
            thought_id: "th_main_0".into(),
        };
        assert_eq!(topic_of(&ev), "agent:thinking_end");
        assert_eq!(ev_session(&ev).as_deref(), Some("s9"));
    }

    
    #[test]
    fn seq_serializes_as_flat_field() {
        let ev = AgentEvent::Thinking {
            seq: None,
            thought_id: "th_main_1".into(),
            session_id: "s1".into(),
            content: "hi".into(),
        }
        .with_seq(7);
        let v = serde_json::to_value(&ev).expect("serialize");
        assert_eq!(v["data"]["seq"], 7);
        assert_eq!(v["data"]["thought_id"], "th_main_1");
    }
}
