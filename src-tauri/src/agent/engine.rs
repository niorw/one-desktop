








use crate::agent::approval::{ApprovalBroker, ApprovalDecision, ApprovalError, ProposalRequest, ProposalOptionData, ProposalDecision, proposal_broker};
use crate::agent::plan::{self, ProposalDraft};
use crate::agent::ledger::{now_unix_ms, RunBegin, RunFinish, RunKind, RunLedger, RunStatus};
use crate::agent::permission::SessionKind;
use crate::agent::tool_registry::GroupMessageSender;
use crate::skill::budget::SkillBudgetTracker;
use crate::agent::ports::{Blackboard, RunObserver};
use crate::agent::toolplane::{ToolPlane, ToolScope};
use crate::error::AgentError;
use uuid::Uuid;
use crate::llm::client::{self, StreamCallbacks};
use crate::llm::provider::LlmProvider;
use crate::llm::types::{ChatMessage, LlmResponse};
use crate::session::manager::SessionManager;
use crate::session::model::CreateMessagePayload;
use crate::metrics::metrics::Metrics;
use crate::types::AgentEvent;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex as TokioMutex;
mod engine_history;
mod engine_toolrun;
mod engine_loop;





pub const REASONING_PROTOCOL: &str = "\
# 执行行为准则（强制）

你必须按「思考 → 执行 → 观察 → 思考 → 观察 → 再执行」的节奏交替推进任务，不得只连续执行而不解释：

1. 每次调用任何工具（执行）之前，必须先用中文写一段简短说明：你接下来要做什么、为什么要这么做。
2. 工具返回结果（观察）之后，必须先用中文说明你从结果中看到了什么、得出了什么结论，再决定下一步。
3. 思考与观察要持续交替，禁止连续调用多个工具而不解释每一部的意图。
4. 这段中文说明不是可选项——即使步骤显而易见，也必须写出来，让用户理解你的决策过程。
5. 每个工具的 arguments 都带一个 `intent` 字段，你必须用中文填写本次调用该工具的目的（例如「读取 snake-game.html 确认渐变代码是否保留」）。这是结构化的「为什么」，会逐条直接展示给用户，请务必填写，不要留空。
";

const DEFAULT_MAX_ITERATIONS: u32 = 20;
const DEFAULT_TOKEN_BUDGET: u64 = 100_000;
const ITERATION_TIMEOUT_SECS: u64 = 600;

const TOOL_TIMEOUT_SECS: u64 = 120;


#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum StopReason {
    
    Completed,
    
    ToolsExhausted,
    
    TimedOut,
    
    Cancelled,
    
    LlmError,
    
    ToolError,
    
    
    
    Truncated,
    
    
    Paused,
}

impl Default for StopReason {
    fn default() -> Self {
        StopReason::Completed
    }
}


#[derive(Debug, Clone, Default, Serialize)]
pub struct AgentRunOutcome {
    pub final_text: String,
    pub stop_reason: StopReason,
    pub total_tokens: u64,
    pub iterations: u32,
    pub tool_calls: u32,
    
    
    
    pub written_files: Vec<String>,
    
    
    
    
    
    pub run_id: String,
}








#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumePoint {
    
    pub iteration: u32,
    
    pub tokens_used: u64,
    
    pub job_id: Option<String>,
    
    pub attempt_no: u32,
}







pub struct RunRequest {
    pub session_id: String,
    pub user_message: String,
    pub provider: Arc<dyn LlmProvider>,
    pub preamble: String,
    pub temperature: f64,
    pub max_tokens_per_call: u32,
    pub max_iterations: Option<u32>,
    pub token_budget: Option<u64>,
    pub workspace_root: Option<PathBuf>,
    
    
    pub auto_approve_override: Option<bool>,
    
    pub trace_id: Option<String>,
    
    pub kind: RunKind,
    
    pub group_id: Option<String>,
    
    pub seat_id: Option<String>,
    
    pub model: Option<String>,
    
    
    pub tool_scope: Option<ToolScope>,
    
    
    
    pub session_kind: SessionKind,
    
    
    
    pub resume: Option<ResumePoint>,
    
    pub task_id: Option<String>,
}

pub struct AgentLoopEngine {
    session_manager: Arc<SessionManager>,
    
    
    plane: Arc<dyn ToolPlane>,
    metrics: Arc<Metrics>,
    
    ledger: Arc<dyn RunLedger>,
    
    approval: Arc<ApprovalBroker>,
    
    skill_budget: Arc<dyn SkillBudgetTracker>,
    
    
    blackboard: Arc<dyn Blackboard>,
    
    cancel_tokens: Arc<TokioMutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    
    
    
    
    pause_tokens: Arc<TokioMutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    
    
    steer_inboxes: Arc<TokioMutex<HashMap<String, tokio::sync::mpsc::UnboundedSender<String>>>>,
    
    pub auto_approve: Arc<std::sync::Mutex<bool>>,
    
    
    pub group_sender: Arc<std::sync::RwLock<Option<Arc<dyn GroupMessageSender>>>>,
    
    
    pub write_gate: Arc<crate::agent::write_gate::WriteGate>,
}

impl AgentLoopEngine {
    
    
    
    pub(crate) fn session_manager(&self) -> &SessionManager {
        &self.session_manager
    }

    pub fn new(
        session_manager: Arc<SessionManager>,
        plane: Arc<dyn ToolPlane>,
        metrics: Arc<Metrics>,
        ledger: Arc<dyn RunLedger>,
        approval: Arc<ApprovalBroker>,
        skill_budget: Arc<dyn SkillBudgetTracker>,
        blackboard: Arc<dyn Blackboard>,
        group_sender: Arc<std::sync::RwLock<Option<Arc<dyn GroupMessageSender>>>>,
        write_gate: Arc<crate::agent::write_gate::WriteGate>,
    ) -> Self {
        Self {
            session_manager,
            plane,
            metrics,
            ledger,
            approval,
            skill_budget,
            blackboard,
            cancel_tokens: Arc::new(TokioMutex::new(HashMap::new())),
            pause_tokens: Arc::new(TokioMutex::new(HashMap::new())),
            steer_inboxes: Arc::new(TokioMutex::new(HashMap::new())),
            auto_approve: Arc::new(std::sync::Mutex::new(false)),
            group_sender,
            write_gate,
        }
    }

    
    pub fn set_group_sender(&self, sender: Arc<dyn GroupMessageSender>) {
        *self.group_sender.write().unwrap() = Some(sender);
    }

    
    
    pub async fn decide_approval(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), ApprovalError> {
        self.approval.decide(approval_id, decision).await
    }

    
    #[deprecated(note = "use decide_approval with approval_id（四态）")]
    #[allow(deprecated)] 
    pub async fn approve_tool(&self, session_id: &str, approved: bool) -> bool {
        self.approval.approve_tool(session_id, approved).await
    }

    
    
    
    pub async fn decide_approval_batch(
        &self,
        ids: &[String],
        decision: ApprovalDecision,
    ) -> Vec<String> {
        if matches!(decision, ApprovalDecision::Accept) {
            let risky = crate::agent::approval::high_risk_pending_ids(
                &self.approval.pending_snapshot().await,
            );
            let safe: Vec<String> = ids
                .iter()
                .filter(|id| !risky.contains(*id))
                .cloned()
                .collect();
            self.approval.decide_batch(&safe, decision).await
        } else {
            self.approval.decide_batch(ids, decision).await
        }
    }

    
    pub fn exempt_tool_for_session(&self, session_id: &str, tool: &str) {
        self.approval.exempt_tool(session_id, tool);
    }

    
    pub async fn cancel(&self, session_id: &str) {
        let mut tokens = self.cancel_tokens.lock().await;
        if let Some(tx) = tokens.remove(session_id) {
            let _ = tx.send(true);
        }
    }

    
    
    
    
    
    pub async fn pause(&self, session_id: &str) -> bool {
        let tokens = self.pause_tokens.lock().await;
        match tokens.get(session_id) {
            Some(tx) => {
                let _ = tx.send(true);
                true
            }
            None => false,
        }
    }

    
    pub async fn is_running(&self, session_id: &str) -> bool {
        self.pause_tokens.lock().await.contains_key(session_id)
    }

    
    
    
    
    
    pub async fn steer(&self, session_id: &str, text: String) -> bool {
        let inboxes = self.steer_inboxes.lock().await;
        match inboxes.get(session_id) {
            Some(tx) => tx.send(text).is_ok(),
            None => false,
        }
    }

    
    
    
    
    pub fn set_auto_approve(&self, v: bool) {
        *self.auto_approve.lock().unwrap() = v;
    }

    
    
    
    
    fn emit_error(observer: &dyn RunObserver, session_id: &str, error: &AgentError) {
        observer.on(
            AgentEvent::Error {
                seq: None,
                session_id: session_id.to_string(),
                message: error.user_message(),
                error_code: error.error_code().to_string(),
                retriable: error.is_retriable(),
            },
            true,
        );
    }

    
    
    
    
    
    
    
    
    pub async fn run(
        &self,
        observer: Arc<dyn RunObserver>,
        req: RunRequest,
        
        
        run_id: String,
    ) -> AgentRunOutcome {
        let RunRequest { session_id, user_message, provider, preamble, temperature,
            max_tokens_per_call, max_iterations, token_budget, workspace_root,
            auto_approve_override, trace_id, kind, group_id, seat_id, model, tool_scope,
            session_kind, resume, task_id } = req;
        tracing::debug!(target: "onedesktop.engine", session_id = %session_id, trace_id = ?trace_id, "agent run started");
        let start = Instant::now();
        self.metrics.inc_agent_loops();

        
        let run_id = self.ledger.begin(RunBegin {
            run_id: run_id.clone(),
            session_id: session_id.to_string(),
            group_id: group_id.as_ref().map(|s| s.to_string()),
            seat_id: seat_id.as_ref().map(|s| s.to_string()),
            kind,
            model: model.as_ref().map(|s| s.to_string()),
            
            
            job_id: task_id.clone(),
            attempt_no: resume.as_ref().map(|rp| rp.attempt_no + 1).unwrap_or(1),
        });

        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        { self.cancel_tokens.lock().await.insert(session_id.to_string(), cancel_tx); }

        
        let (pause_tx, pause_rx) = tokio::sync::watch::channel(false);
        { self.pause_tokens.lock().await.insert(session_id.to_string(), pause_tx); }

        
        let (steer_tx, steer_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        { self.steer_inboxes.lock().await.insert(session_id.to_string(), steer_tx); }

        
        
        
        let cancelled_flag = Arc::new(AtomicBool::new(false));
        {
            let flag = cancelled_flag.clone();
            let mut crx = cancel_rx.clone();
            tokio::spawn(async move { if crx.changed().await.is_ok() { flag.store(true, Ordering::SeqCst); } });
        }

        
        
        
        
        let max_iters = {
            let configured = max_iterations.unwrap_or(DEFAULT_MAX_ITERATIONS);
            match &resume {
                Some(rp) => configured.max(rp.iteration + 1),
                None => configured,
            }
        };
        let budget = token_budget.unwrap_or(DEFAULT_TOKEN_BUDGET);
        let permission_overrides = self.session_manager.list_tool_permissions().unwrap_or_default();

        
        let (session, history) = match engine_loop::load_session_and_history(self, &session_id).await {
            Ok(v) => v,
            Err(e) => {
                tracing::error!(
                    target: "onedesktop.engine",
                    session_id = %session_id,
                    trace_id = ?trace_id,
                    run_id = %run_id,
                    error = %e,
                    "load session/history failed"
                );
                Self::emit_error(observer.as_ref(), &session_id, &e);
                self.ledger.finish(&run_id, RunFinish {
                    status: RunStatus::Failed,
                    ended_at: now_unix_ms(),
                    model: model.map(|s| s.to_string()),
                    prompt_tokens: 0,
                    output_tokens: 0,
                    reasoning_tokens: 0,
                    iterations: 0,
                    error_kind: Some("internal".into()),
                });
                self.cleanup_cancel(&session_id).await;
                return AgentRunOutcome {
                    stop_reason: StopReason::LlmError,
                    run_id,
                    ..Default::default()
                };
            }
        };

        
        
        
        let (mut messages, mut tool_call_seq) = engine_history::build_messages(
            &session, &history, &preamble, provider.as_ref(), &self.session_manager, &user_message,
            resume.as_ref(), Some(cancel_rx.clone()),
        ).await;

        
        
        
        
        
        
        
        
        
        
        let skip_planning = auto_approve_override == Some(true)
            || session_id.starts_with("rt:")
            || resume.is_some()
            || plan::should_skip_planning(&user_message);
        let plan = if skip_planning {
            plan::PlanResult::default()
        } else {
            plan::plan_turn(provider.as_ref(), &user_message, &preamble).await
        };

        
        if let Some(draft) = plan.proposal {
            async fn propose_and_wait(
                observer: &dyn RunObserver,
                session_id: &str,
                run_id: &str,
                draft: &ProposalDraft,
            ) -> ProposalDecision {
                let options: Vec<ProposalOptionData> = draft
                    .options
                    .iter()
                    .map(|o| ProposalOptionData {
                        id: o.id.clone(),
                        label: o.label.clone(),
                        description: o.description.clone(),
                        risk: o.risk.clone(),
                        recommended: o.recommended,
                    })
                    .collect();
                let req = ProposalRequest::new(session_id, run_id, &draft.title, &draft.summary, options);
                let handle = proposal_broker().register(req.clone()).await;
                observer.on(
                    AgentEvent::Proposal {
                        seq: None,
                        session_id: session_id.to_string(),
                        proposal_id: req.id.clone(),
                        title: draft.title.clone(),
                        summary: draft.summary.clone(),
                        options: draft.options.clone(),
                        risk: "medium".to_string(),
                    },
                    true,
                );
                handle.await_decision(req.expire_after).await
            }

            let decision = propose_and_wait(observer.as_ref(), &session_id, &run_id, &draft).await;

            
            
            match &decision {
                ProposalDecision::Selected { option_id } => {
                    let opt = draft.options.iter().find(|o| &o.id == option_id);
                    let label = opt.map(|o| o.label.as_str()).unwrap_or(option_id.as_str());
                    let desc = opt.map(|o| o.description.as_str()).unwrap_or("");
                    messages.push(ChatMessage::user(&format!(
                        "【方案已确认】我选择：{label}。{desc}\n请直接按该方案执行，不要再重复征求确认。"
                    )));
                }
                ProposalDecision::Custom { text } => {
                    messages.push(ChatMessage::user(&format!(
                        "【方案已调整】上述选项都不合适，按我的要求来：{text}\n请直接执行，不要再重复征求确认。"
                    )));
                }
                ProposalDecision::Rejected => {}
            }

            
            if let ProposalDecision::Rejected = decision {
                self.cleanup_cancel(&session_id).await;
                self.ledger.finish(
                    &run_id,
                    RunFinish {
                        status: RunStatus::Cancelled,
                        ended_at: now_unix_ms(),
                        model: model.map(|s| s.to_string()),
                        prompt_tokens: 0,
                        output_tokens: 0,
                        reasoning_tokens: 0,
                        iterations: 0,
                        error_kind: None,
                    },
                );
                self.write_gate.release_run(&run_id);
                return AgentRunOutcome {
                    stop_reason: StopReason::Cancelled,
                    run_id,
                    ..Default::default()
                };
            }
            
        }

        
        let loop_ctx = engine_loop::LoopCtx {
            observer: &*observer, session_id: &session_id, provider: provider.as_ref(), max_iters, budget,
            temperature, max_tokens_per_call, auto_approve_override,
            permission_overrides: &permission_overrides,
            workspace_root: workspace_root.clone(),
            
            
            tmp_root: Some({
                let p = crate::paths::session_tmp_root(&session_id);
                let _ = std::fs::create_dir_all(&p);
                p
            }),
            cancelled_flag: cancelled_flag.clone(), cancel_rx, pause_rx,
            steer_rx: std::sync::Mutex::new(steer_rx),
            session_manager: self.session_manager.as_ref(),
            ledger: &*self.ledger, run_id: &run_id, model: model.as_deref(),
            seat_id: seat_id.as_deref(),
            
            skill_budget: &*self.skill_budget,
            
            tool_scope: tool_scope.clone().unwrap_or_else(ToolScope::all),
            
            session_kind,
            
            group_sender: self.group_sender.read().unwrap().clone(),
            
            blackboard: Some(self.blackboard.clone()),
            
            write_gate: Some(self.write_gate.clone()),
            
            resume_from: resume.as_ref().map(|rp| rp.iteration).unwrap_or(0),
            prior_tokens: resume.as_ref().map(|rp| rp.tokens_used).unwrap_or(0),
            
            task_id: task_id.as_deref(),
            
            todos: plan.todos.clone(),
        };
        let (mut outcome, total_tokens, total_prompt_tokens, total_output_tokens, total_reasoning_tokens) =
            engine_loop::run_agent_loop(self, loop_ctx, &mut messages, &mut tool_call_seq).await;

        
        self.cleanup_cancel(&session_id).await;

        
        
        self.ledger.finish(&run_id, RunFinish {
            status: match outcome.stop_reason {
                StopReason::Completed | StopReason::ToolsExhausted => RunStatus::Ok,
                StopReason::TimedOut => RunStatus::Timeout,
                StopReason::Cancelled => RunStatus::Cancelled,
                
                StopReason::Paused => RunStatus::Paused,
                StopReason::LlmError | StopReason::ToolError => {
                    RunStatus::Failed
                }
                
                StopReason::Truncated => RunStatus::Failed,
            },
            ended_at: now_unix_ms(),
            model: model.map(|s| s.to_string()),
            prompt_tokens: total_prompt_tokens,
            output_tokens: total_output_tokens,
            reasoning_tokens: total_reasoning_tokens,
            iterations: outcome.iterations,
            error_kind: match outcome.stop_reason {
                StopReason::TimedOut | StopReason::LlmError => Some("provider".into()),
                
                
                StopReason::ToolError => Some("tool".into()),
                StopReason::Truncated => Some("truncated".into()),
                _ => None,
            },
        });
        
        self.write_gate.release_run(&run_id);

        
        outcome.run_id = run_id;

        self.finalize_run(&mut outcome, total_tokens, start, trace_id.as_deref(), &session_id);
        outcome
    }

    
    
    
    
    
    
    
    
    
    
    
    
    pub async fn run_guarded(
        self: Arc<Self>,
        observer: Arc<dyn RunObserver>,
        req: RunRequest,
    ) -> AgentRunOutcome {
        let session_id = req.session_id.clone();
        
        
        let run_id = Uuid::new_v4().to_string();
        let engine = self.clone();
        let obs = observer.clone();
        let run_id_for_task = run_id.clone();
        let handle = tokio::spawn(async move { engine.run(obs, req, run_id_for_task).await });
        match handle.await {
            Ok(outcome) => outcome,
            Err(join_err) => {
                let message = if join_err.is_panic() {
                    
                    let payload = join_err.into_panic();
                    if let Some(s) = payload.downcast_ref::<String>() {
                        format!("引擎运行期异常（panic）：{s}")
                    } else if let Some(s) = payload.downcast_ref::<&str>() {
                        format!("引擎运行期异常（panic）：{s}")
                    } else {
                        "引擎运行期发生未捕获异常（panic），运行已终止。".to_string()
                    }
                } else {
                    "引擎任务被意外取消（JoinHandle 异常）。".to_string()
                };
                tracing::error!(
                    target: "onedesktop.engine",
                    session_id = %session_id,
                    run_id = %run_id,
                    "run aborted: {}",
                    message
                );
                
                
                self.ledger.finish(&run_id, RunFinish {
                    status: RunStatus::Failed,
                    ended_at: now_unix_ms(),
                    model: None,
                    prompt_tokens: 0,
                    output_tokens: 0,
                    reasoning_tokens: 0,
                    iterations: 0,
                    error_kind: Some("internal".into()),
                });
                self.write_gate.release_run(&run_id);
                self.cleanup_cancel(&session_id).await;
                
                observer.on(
                    AgentEvent::Error {
                        seq: None,
                        session_id: session_id.clone(),
                        message: message.clone(),
                        error_code: "ENGINE_PANIC".to_string(),
                        retriable: false,
                    },
                    true,
                );
                AgentRunOutcome {
                    stop_reason: StopReason::LlmError,
                    run_id,
                    ..Default::default()
                }
            }
        }
    }

    
    
    
    
    
    
    async fn call_llm_once(
        &self,
        observer: &dyn RunObserver,
        session_id: &str,
        provider: &dyn LlmProvider,
        messages: &[ChatMessage],
        cancel_rx: tokio::sync::watch::Receiver<bool>,
        temperature: f64,
        max_tokens_per_call: u32,
        tool_scope: &ToolScope,
        thought_id: &str,
    ) -> Result<LlmResponse, ()> {
        let sid = session_id.to_string();
        let callbacks = StreamCallbacks {
            on_token: &|token: &str| {
                observer.on(
                    AgentEvent::Token {
                        seq: None,
                        session_id: sid.clone(),
                        token: token.to_string(),
                    },
                    true,
                );
            },
            on_thinking: &|content: &str| {
                
                
                observer.on(
                    AgentEvent::Thinking {
                        seq: None,
                        session_id: sid.clone(),
                        thought_id: thought_id.to_string(),
                        content: content.to_string(),
                    },
                    true,
                );
            },
        };

        
        
        let tools = self.plane.list(tool_scope).await;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(ITERATION_TIMEOUT_SECS),
            client::stream_chat(
                provider,
                messages,
                &tools,
                temperature,
                max_tokens_per_call,
                callbacks,
                cancel_rx.clone(),
            ),
        );

        let _ = cancel_rx.borrow(); 
        match result.await {
            Ok(resp) => Ok(resp),
            Err(_) => {
                Self::emit_error(
                    observer,
                    session_id,
                    &AgentError::LlmTimeout {
                        elapsed_secs: ITERATION_TIMEOUT_SECS,
                    },
                );
                Err(())
            }
        }
    }

    
    
    
    fn handle_text_response(
        &self,
        observer: &dyn RunObserver,
        session_id: &str,
        messages: &mut Vec<ChatMessage>,
        outcome: &mut AgentRunOutcome,
        content: String,
        reasoning_content: String,
        tokens: u64,
    ) {
        
        
        
        let final_content = if content.trim().is_empty() && !reasoning_content.trim().is_empty() {
            reasoning_content.trim().to_string()
        } else {
            content
        };
        outcome.final_text = final_content.clone();
        outcome.stop_reason = StopReason::Completed;

        if let Err(e) = self.session_manager.add_message(CreateMessagePayload {
            session_id: session_id.to_string(),
            role: "assistant".into(),
            content: final_content.clone(),
            tool_name: None,
            tool_args: None,
            tool_result: None,
            token_usage: tokens as i64,
            reasoning_content: reasoning_content.clone(),
            call_id: None,
        }) {
            
            tracing::error!(target: "onedesktop.engine", error = %e, "message persist failed (events+messages rolled back)");
        }
        messages.push(ChatMessage::assistant(&final_content));

        observer.on(
            AgentEvent::Done {
                seq: None,
                session_id: session_id.to_string(),
                final_response: final_content,
                token_usage: tokens,
            },
            true,
        );
    }

    
    fn finalize_run(
        &self,
        outcome: &mut AgentRunOutcome,
        total_tokens: u64,
        start: Instant,
        trace_id: Option<&str>,
        session_id: &str,
    ) {
        outcome.total_tokens = total_tokens;
        let duration_us = start.elapsed().as_micros() as u64;
        self.metrics.record_loop_duration(duration_us);
        self.metrics.add_tokens(total_tokens);
        tracing::debug!(
            target: "onedesktop.engine",
            session_id = %session_id,
            trace_id = ?trace_id,
            stop_reason = ?outcome.stop_reason,
            iterations = outcome.iterations,
            tool_calls = outcome.tool_calls,
            "agent run finished"
        );
    }

    async fn cleanup_cancel(&self, session_id: &str) {
        let mut tokens = self.cancel_tokens.lock().await;
        tokens.remove(session_id);
        drop(tokens);
        self.pause_tokens.lock().await.remove(session_id);
        self.steer_inboxes.lock().await.remove(session_id);
    }
}
