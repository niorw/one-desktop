







pub mod cli;



const HEARTBEAT_INTERVAL_SECS: u64 = 5;

use crate::a2a::model::{A2aTask, A2aTaskState};
use crate::agent::engine::{AgentLoopEngine, ResumePoint, RunRequest, StopReason};
use crate::agent::ledger::RunKind;
use crate::agent::ports::RunObserver;
use crate::agent::ports::TaskHeartbeat;
use crate::config::load_config;
use std::time::Duration;
use crate::llm;
use crate::session::manager::SessionManager;
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;


#[derive(Debug, Clone)]
pub struct A2aTaskResult {
    pub task_id: String,
    pub final_text: String,
    pub status: A2aTaskState,
    pub total_tokens: u64,
    
    
    pub failure_kind: Option<String>,
    
    
    
    pub written_files: Vec<String>,
}









#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutorAvailability {
    Available,
    NotFound,
    LaunchFailed,
    AuthMissing,
}


#[async_trait]
pub trait AgentExecutor: Send + Sync {
    
    async fn run(&self, task: A2aTask) -> Result<A2aTaskResult, String>;
    
    async fn cancel(&self, task_id: &str);
    
    
    async fn probe_available(&self) -> ExecutorAvailability;
}





pub struct InternalExecutor {
    engine: Arc<AgentLoopEngine>,
    session_manager: Arc<SessionManager>,
    observer: Arc<dyn RunObserver>,
    
    heartbeat: Arc<dyn TaskHeartbeat>,
    
    running: Arc<TokioMutex<HashMap<String, String>>>,
}

impl InternalExecutor {
    pub fn new(
        engine: Arc<AgentLoopEngine>,
        session_manager: Arc<SessionManager>,
        observer: Arc<dyn RunObserver>,
        heartbeat: Arc<dyn TaskHeartbeat>,
    ) -> Self {
        Self {
            engine,
            session_manager,
            observer,
            heartbeat,
            running: Arc::new(TokioMutex::new(HashMap::new())),
        }
    }
}

#[async_trait]
impl AgentExecutor for InternalExecutor {
    async fn run(&self, task: A2aTask) -> Result<A2aTaskResult, String> {
        let session_id = task.context_id.clone();
        let model = task.meta_str("model", "deepseek-chat");
        let provider_name = task.meta_str("provider", "deepseek");
        let system_prompt = task.meta_str("system_prompt", "");
        let max_iters: u32 = task
            .metadata
            .get("max_iterations")
            .and_then(|v| v.as_u64())
            .unwrap_or(20) as u32;
        let budget: u64 = task
            .metadata
            .get("token_budget")
            .and_then(|v| v.as_u64())
            .unwrap_or(100_000);
        let auto_approve: bool = task
            .metadata
            .get("auto_approve")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let ws_root = task
            .metadata
            .get("workspace_root")
            .and_then(|v| v.as_str())
            .map(std::path::PathBuf::from);
        let prompt = task.task_card_text();
        let trace_id = format!("{}:{}", task.context_id, task.task_id);

        
        
        
        
        let resume_point: Option<ResumePoint> = task
            .metadata
            .get("resume")
            .and_then(|v| serde_json::from_value::<ResumePoint>(v.clone()).ok());

        
        if self
            .session_manager
            .get_session(&session_id)
            .map_err(|e| e.to_string())?
            .is_none()
        {
            self.session_manager
                .create_session_with_id(
                    session_id.clone(),
                    format!("exec-{}", task.task_id),
                    model.clone(),
                    system_prompt.clone(),
                )
                .map_err(|e| e.to_string())?;
        }

        {
            let mut running = self.running.lock().await;
            running.insert(task.task_id.clone(), session_id.clone());
        }

        let config = load_config();
        let provider = llm::create_provider(
            &llm::resolve_internal_provider(&provider_name),
            config.api_key,
            model.clone(),
        );
        let observer = self.observer.clone();

        
        
        
        let hb = self.heartbeat.clone();
        let tid = task.task_id.clone();
        let heartbeat_handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(HEARTBEAT_INTERVAL_SECS));
            loop {
                interval.tick().await;
                if hb.beat(&tid).is_err() {
                    break;
                }
            }
        });

        let outcome = self
            .engine
            .clone()
            .run_guarded(
                observer,
                RunRequest {
                    session_id: session_id.to_string(),
                    
                    
                    user_message: if resume_point.is_some() {
                        String::new()
                    } else {
                        prompt.to_string()
                    },
                    provider,
                    preamble: system_prompt.to_string(),
                    temperature: 0.7,
                    max_tokens_per_call: 4096,
                    max_iterations: Some(max_iters),
                    token_budget: Some(budget),
                    workspace_root: ws_root,
                    auto_approve_override: Some(auto_approve),
                    trace_id: Some(trace_id.clone()),
                    kind: RunKind::Chat,
                    
                    
                    
                    group_id: task
                        .metadata
                        .get("group_id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    seat_id: task
                        .metadata
                        .get("seat_id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    model: Some(model.to_string()),
                    
                    tool_scope: Some(crate::agent::toolplane::ToolScope::only(
                        crate::agent::permission::SAFE_TOOLS,
                    )),
                    
                    session_kind: crate::agent::permission::SessionKind::UnattendedWorker,
                    
                    resume: resume_point,
                    
                    task_id: Some(task.task_id.clone()),
                },
            )
            .await;

        heartbeat_handle.abort();

        {
            let mut running = self.running.lock().await;
            running.remove(&task.task_id);
        }

        let status = match outcome.stop_reason {
            StopReason::Completed => A2aTaskState::Completed,
            StopReason::Cancelled => A2aTaskState::Canceled,
            _ => A2aTaskState::Failed,
        };
        Ok(A2aTaskResult {
            task_id: task.task_id,
            final_text: outcome.final_text,
            status,
            total_tokens: outcome.total_tokens,
            failure_kind: None,
            
            written_files: outcome.written_files,
        })
    }

    async fn cancel(&self, task_id: &str) {
        let session_id = { self.running.lock().await.get(task_id).cloned() };
        if let Some(sid) = session_id {
            let _ = self.engine.cancel(&sid).await;
        }
    }

    async fn probe_available(&self) -> ExecutorAvailability {
        ExecutorAvailability::Available
    }
}
