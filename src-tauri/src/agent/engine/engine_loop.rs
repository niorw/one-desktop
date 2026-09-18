










use crate::agent::engine::engine_toolrun;
use crate::agent::engine::{AgentError, AgentLoopEngine, AgentRunOutcome, ChatMessage, LlmResponse, StopReason};
use crate::agent::ledger::{now_unix_ms, Checkpoint, RunLedger, RunStep, RunStepKind, StepOutcome};
use crate::agent::permission::{SessionKind, ToolPermission};
use crate::agent::ports::{Blackboard, RunObserver};
use crate::agent::tool_registry::GroupMessageSender;
use crate::agent::toolplane::ToolScope;
use crate::skill::budget::SkillBudgetTracker;
use crate::llm::provider::LlmProvider;
use crate::session::model::{Message, Session};
use crate::types::{AgentEvent, TodoEntry};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::AtomicBool;
use tokio::sync::watch;





pub struct LoopCtx<'a> {
    pub observer: &'a dyn RunObserver,
    pub session_id: &'a str,
    pub provider: &'a dyn LlmProvider,
    pub max_iters: u32,
    pub budget: u64,
    pub temperature: f64,
    pub max_tokens_per_call: u32,
    pub auto_approve_override: Option<bool>,
    pub permission_overrides: &'a [ToolPermission],
    pub workspace_root: Option<PathBuf>,
    
    
    pub tmp_root: Option<PathBuf>,
    pub cancelled_flag: Arc<AtomicBool>,
    pub cancel_rx: watch::Receiver<bool>,
    
    
    pub pause_rx: watch::Receiver<bool>,
    
    pub ledger: &'a dyn RunLedger,
    
    pub skill_budget: &'a dyn SkillBudgetTracker,
    
    pub run_id: &'a str,
    
    pub model: Option<&'a str>,
    
    pub seat_id: Option<&'a str>,
    
    pub tool_scope: ToolScope,
    
    pub session_kind: SessionKind,
    
    pub group_sender: Option<Arc<dyn GroupMessageSender>>,
    
    pub blackboard: Option<Arc<dyn Blackboard>>,
    
    pub write_gate: Option<Arc<crate::agent::write_gate::WriteGate>>,
    
    
    
    pub resume_from: u32,
    
    
    
    
    pub prior_tokens: u64,
    
    
    pub task_id: Option<&'a str>,
    
    
    
    pub todos: Vec<TodoEntry>,
    
    
    pub steer_rx: std::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<String>>,
    
    
    pub session_manager: &'a crate::session::manager::SessionManager,
}


pub async fn load_session_and_history(
    engine: &AgentLoopEngine,
    session_id: &str,
) -> Result<(Session, Vec<Message>), AgentError> {
    let session = match engine.session_manager.get_session(session_id) {
        Ok(Some(s)) => s,
        Ok(None) => {
            return Err(AgentError::SessionNotFound {
                session_id: session_id.to_string(),
            })
        }
        Err(e) => {
            return Err(AgentError::Storage {
                message: e.to_string(),
            })
        }
    };
    let history = match engine.session_manager.get_messages(session_id) {
        Ok(h) => h,
        Err(e) => {
            return Err(AgentError::Storage {
                message: e.to_string(),
            })
        }
    };
    Ok((session, history))
}








fn emit_checkpoint(ctx: &LoopCtx<'_>, done_iterations: u32, run_tokens: u64) {
    let cp = Checkpoint {
        iteration: done_iterations,
        tokens_used: ctx.prior_tokens + run_tokens,
        ts: now_unix_ms(),
    };
    ctx.ledger.checkpoint(ctx.run_id, cp);
    ctx.observer.on(
        AgentEvent::Progress {
            seq: None,
            session_id: ctx.session_id.to_string(),
            task_id: ctx.task_id.map(|s| s.to_string()),
            iteration: cp.iteration,
            max_iterations: ctx.max_iters,
            
            
            percent: (cp.iteration as f64 / ctx.max_iters.max(1) as f64).min(1.0),
            tokens_used: cp.tokens_used,
            token_budget: ctx.budget,
        },
        true,
    );
}





const MAX_PROMPT_CHARS: usize = 120_000;

const TRUNCATED_TOOL_RESULT_CHARS: usize = 2_000;





const IN_RUN_COMPACT_CHARS: usize = 48_000;

const IN_RUN_COMPACT_MIN_MSGS: usize = 24;

const IN_RUN_KEEP_TAIL: usize = 12;

fn estimate_messages(msgs: &[ChatMessage]) -> usize {
    msgs.iter()
        .map(|m| {
            m.content.len()
                + m.extra
                    .values()
                    .map(|v| v.to_string().len())
                    .sum::<usize>()
        })
        .sum()
}

fn enforce_prompt_budget(messages: &mut Vec<ChatMessage>, max_chars: usize) {
    let mut total = estimate_messages(messages);
    if total <= max_chars {
        return;
    }
    tracing::warn!(
        target: "onedesktop.engine",
        est_chars = total,
        max_chars,
        "Prompt 超出预算，截断最旧工具结果"
    );
    for m in messages.iter_mut() {
        if total <= max_chars {
            break;
        }
        if m.role == "tool" {
            let cur = m.content.chars().count();
            if cur > TRUNCATED_TOOL_RESULT_CHARS {
                let kept: String = m.content.chars().take(TRUNCATED_TOOL_RESULT_CHARS).collect();
                m.content = format!(
                    "{}\n…[较早的工具结果已截断为前 {} 字符，原始 {} 字符]",
                    kept, TRUNCATED_TOOL_RESULT_CHARS, cur
                );
                
                total = total.saturating_sub(cur.saturating_sub(m.content.chars().count()));
            }
        }
    }
}







fn find_compact_boundary(messages: &[ChatMessage], keep_tail: usize) -> Option<usize> {
    if messages.len() < 2 || messages.first().map(|m| m.role.as_str()) != Some("system") {
        return None;
    }
    let desired = messages.len().saturating_sub(keep_tail);
    let mut keep_from = desired;
    while keep_from > 1 && messages[keep_from].role.as_str() != "user" {
        keep_from -= 1;
    }
    if keep_from > 1 && messages[keep_from].role.as_str() == "user" {
        Some(keep_from)
    } else {
        None
    }
}












async fn maybe_in_run_compact(
    provider: &dyn LlmProvider,
    messages: &mut Vec<ChatMessage>,
    cancel_rx: tokio::sync::watch::Receiver<bool>,
) {
    if messages.len() < IN_RUN_COMPACT_MIN_MSGS {
        return;
    }
    if estimate_messages(messages) < IN_RUN_COMPACT_CHARS {
        return;
    }
    let Some(keep_from) = find_compact_boundary(messages, IN_RUN_KEEP_TAIL) else {
        return;
    };
    
    if keep_from <= 1 {
        return;
    }

    let mut transcript = String::new();
    for m in &messages[1..keep_from] {
        let label = match m.role.as_str() {
            "user" => "用户",
            "assistant" => "助手",
            "tool" => "工具结果",
            _ => "系统",
        };
        let snippet: String = m.content.chars().take(600).collect();
        transcript.push_str(&format!("【{}】{}\n", label, snippet));
        
        if let Some(serde_json::Value::String(r)) = m.extra.get("reasoning_content") {
            if !r.is_empty() {
                let r: String = r.chars().take(120).collect();
                transcript.push_str(&format!("（思考：{}）\n", r));
            }
        }
    }

    let system = "你是一个对话历史压缩助手。请把下面的 Agent 与用户历史对话压缩成一段**信息无损的中文要点摘要**：\
        保留关键事实、用户要求、已完成的动作与结论，按时间顺序组织，不编造内容，不调用工具。";
    let user = format!(
        "以下是需要压缩的早期对话段：\n\n{}\n\n请输出摘要。",
        transcript
    );

    match crate::llm::client::summarize_text_with_cancel(provider, system, &user, 0.2, 1536, Some(cancel_rx)).await {
        Ok(summary) => {
            let summary_msg = ChatMessage::user(&format!("# 对话历史摘要\n{}", summary));
            let new_messages: Vec<ChatMessage> = std::iter::once(messages[0].clone())
                .chain(std::iter::once(summary_msg))
                .chain(messages[keep_from..].iter().cloned())
                .collect();
            let before = messages.len();
            *messages = new_messages;
            tracing::info!(
                target: "onedesktop.engine",
                folded = before - messages.len(),
                kept = messages.len(),
                "in-run history compacted"
            );
        }
        Err(e) => {
            tracing::warn!(
                target: "onedesktop.engine",
                error = %e,
                "in-run compaction skipped, fallback to truncation budget"
            );
        }
    }
}









pub async fn run_agent_loop(
    engine: &AgentLoopEngine,
    ctx: LoopCtx<'_>,
    messages: &mut Vec<ChatMessage>,
    tool_call_seq: &mut u64,
) -> (AgentRunOutcome, u64, u64, u64, u64) {
    let mut outcome = AgentRunOutcome {
        stop_reason: StopReason::ToolsExhausted,
        ..Default::default()
    };
    
    
    let mut consecutive_failed_rounds: u32 = 0;
    const MAX_CONSECUTIVE_FAILED_ROUNDS: u32 = 2;
    
    
    let written_files: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let mut total_tokens: u64 = 0;
    
    let mut total_prompt_tokens: u64 = 0;
    let mut total_output_tokens: u64 = 0;
    
    let mut total_reasoning_tokens: u64 = 0;

    
    let mut todos = ctx.todos.clone();

    
    
    for iteration in ctx.resume_from..ctx.max_iters {
        outcome.iterations = iteration + 1;

        
        
        {
            let mut rx = ctx.steer_rx.lock().expect("steer_rx poisoned");
            while let Ok(text) = rx.try_recv() {
                let t = text.trim().to_string();
                if t.is_empty() {
                    continue;
                }
                
                
                let persisted = ctx.session_manager.add_message(
                    crate::session::model::CreateMessagePayload {
                        session_id: ctx.session_id.to_string(),
                        role: "user".into(),
                        content: t.clone(),
                        tool_name: None,
                        tool_args: None,
                        tool_result: None,
                        token_usage: 0,
                        reasoning_content: String::new(),
                        call_id: None,
                    },
                );
                match persisted {
                    Ok(_) => {
                        messages.push(ChatMessage::user(&t));
                        tracing::info!(
                            target: "onedesktop.engine",
                            session_id = ctx.session_id,
                            "steer message merged into next step"
                        );
                    }
                    Err(e) => {
                        tracing::error!(
                            target: "onedesktop.engine",
                            error = %e,
                            "steer message persist failed; dropped (not shown to model)"
                        );
                    }
                }
            }
        }

        
        if *ctx.cancel_rx.borrow() {
            tracing::info!(target: "onedesktop.engine", session_id = ctx.session_id, iteration, "Cancelled by user");
            AgentLoopEngine::emit_error(ctx.observer, ctx.session_id, &AgentError::Cancelled);
            outcome.stop_reason = StopReason::Cancelled;
            break;
        }

        
        
        
        
        
        if *ctx.pause_rx.borrow() {
            emit_checkpoint(&ctx, iteration, total_tokens);
            tracing::info!(
                target: "onedesktop.engine",
                session_id = ctx.session_id,
                iteration,
                "paused by user, checkpoint persisted"
            );
            ctx.observer.on(
                AgentEvent::Paused {
                    seq: None,
                    session_id: ctx.session_id.to_string(),
                    task_id: ctx.task_id.map(|s| s.to_string()),
                    iteration,
                    tokens_used: ctx.prior_tokens + total_tokens,
                },
                true,
            );
            
            
            outcome.iterations = iteration;
            outcome.stop_reason = StopReason::Paused;
            break;
        }

        
        
        tracing::debug!(
            target: "onedesktop.engine",
            iteration,
            msg_count = messages.len(),
            total_tokens,
            "Agent loop iteration"
        );

        
        {
            let todo_idx = (iteration - ctx.resume_from) as usize;
            if todo_idx < todos.len() {
                todos[todo_idx].status = "active".to_string();
                emit_todo_update(&ctx, &todos);
            }
        }

        
        
        
        
        
        maybe_in_run_compact(ctx.provider, messages, ctx.cancel_rx.clone()).await;
        
        enforce_prompt_budget(messages, MAX_PROMPT_CHARS);
        let th_id = format!("th_main_{}", iteration);
        let result = match engine
            .call_llm_once(
                ctx.observer,
                ctx.session_id,
                ctx.provider,
                messages,
                ctx.cancel_rx.clone(),
                ctx.temperature,
                ctx.max_tokens_per_call,
                &ctx.tool_scope,
                &th_id,
            )
            .await
        {
            Ok(resp) => {
                
                ctx.ledger.step(ctx.run_id, RunStep {
                    seq: 0,
                    kind: RunStepKind::Llm,
                    name: ctx.model.map(|s| s.to_string()),
                    origin: None,
                    args_digest: None,
                    outcome: StepOutcome::Ok,
                    unavailable_reason: None,
                    approval_source: None,
                    approval_decision: None,
                    duration_ms: None,
                    started_at: now_unix_ms(),
                });
                resp
            }
            Err(()) => {
                outcome.stop_reason = StopReason::TimedOut;
                break;
            }
        };

        match result {
            
            LlmResponse::Text {
                content,
                reasoning_content,
                tokens,
                prompt_tokens,
                output_tokens,
                reasoning_tokens,
                finish_reason,
            } => {
                total_tokens += tokens;
                total_prompt_tokens += prompt_tokens;
                total_output_tokens += output_tokens;
                total_reasoning_tokens += reasoning_tokens;
                
                let emitted_chars = content.chars().count();
                engine.handle_text_response(
                    ctx.observer,
                    ctx.session_id,
                    messages,
                    &mut outcome,
                    content,
                    reasoning_content,
                    tokens,
                );
                
                
                
                
                finalize_todos_on_text(&mut todos);
                emit_todo_update(&ctx, &todos);
                
                ctx.observer.on(
                    AgentEvent::ThinkingEnd { seq: None, session_id: ctx.session_id.to_string(), thought_id: th_id.clone() },
                    true,
                );
                
                
                
                if finish_reason.as_deref() == Some("length") {
                    tracing::warn!(
                        target: "onedesktop.engine",
                        session_id = ctx.session_id,
                        iteration,
                        emitted_chars,
                        "LLM output truncated by token cap; run marked Truncated"
                    );
                    outcome.stop_reason = StopReason::Truncated;
                }
                break;
            }
            
            LlmResponse::ToolCalls {
                calls,
                reasoning_content,
                plan_content,
                tokens,
                prompt_tokens,
                output_tokens,
                reasoning_tokens,
            } => {
                total_tokens += tokens;
                total_prompt_tokens += prompt_tokens;
                total_output_tokens += output_tokens;
                total_reasoning_tokens += reasoning_tokens;
                outcome.tool_calls += calls.len() as u32;

                
                let deps = engine_toolrun::ToolRunDeps {
                    observer: ctx.observer,
                    sid: ctx.session_id,
                    session_id: ctx.session_id,
                    session_manager: &*engine.session_manager,
                    plane: &*engine.plane,
                    metrics: &*engine.metrics,
                    approval: &*engine.approval,
                    tool_scope: &ctx.tool_scope,
                    global_auto_approve: *engine.auto_approve.lock().unwrap(),
                    auto_approve_override: ctx.auto_approve_override,
                    permission_overrides: ctx.permission_overrides,
                    workspace_root: ctx.workspace_root.clone(),
                    tmp_root: ctx.tmp_root.clone(),
                    cancelled_flag: ctx.cancelled_flag.clone(),
                    ledger: ctx.ledger,
                    run_id: ctx.run_id,
                    seat_id: ctx.seat_id,
                    session_kind: ctx.session_kind,
                    
                    skill_budget: ctx.skill_budget,
                    
                    group_sender: ctx.group_sender.clone(),
                    
                    blackboard: ctx.blackboard.clone(),
                    
                    write_gate: ctx.write_gate.clone(),
                };
                let (round_failed, round_total) = engine_toolrun::run_tool_calls(
                    &deps,
                    &calls,
                    &reasoning_content,
                    &plan_content,
                    tokens,
                    messages,
                    tool_call_seq,
                    written_files.clone(),
                )
                .await;

                
                
                
                
                
                
                
                
                
                
                
                ctx.observer.on(
                    AgentEvent::ThinkingEnd { seq: None, session_id: ctx.session_id.to_string(), thought_id: th_id.clone() },
                    true,
                );
                emit_checkpoint(&ctx, iteration + 1, total_tokens);

                
                
                
                {
                    let done_idx = (iteration - ctx.resume_from) as usize;
                    if done_idx < todos.len() {
                        todos[done_idx].status =
                            if round_failed > 0 { "failed" } else { "done" }.to_string();
                        emit_todo_update(&ctx, &todos);
                    }
                }

                
                
                
                if round_total > 0 && round_failed == round_total {
                    consecutive_failed_rounds += 1;
                    if consecutive_failed_rounds >= MAX_CONSECUTIVE_FAILED_ROUNDS {
                        let msg = format!(
                            "连续 {} 轮工具调用全部失败，已停止重试。请检查命令/脚本或环境后重试。",
                            consecutive_failed_rounds
                        );
                        AgentLoopEngine::emit_error(
                            ctx.observer,
                            ctx.session_id,
                            &AgentError::ToolError { message: msg.clone() },
                        );
                        
                        for (ti, t) in todos.iter_mut().enumerate() {
                            if ti >= (iteration - ctx.resume_from) as usize && t.status != "done" {
                                t.status = "failed".to_string();
                            }
                        }
                        emit_todo_update(&ctx, &todos);
                        outcome.stop_reason = StopReason::ToolError;
                        outcome.final_text = msg;
                        break;
                    }
                } else {
                    consecutive_failed_rounds = 0;
                }
            }

            LlmResponse::Error(err) => {
                AgentLoopEngine::emit_error(
                    ctx.observer,
                    ctx.session_id,
                    &AgentError::LlmError { message: err },
                );
                outcome.stop_reason = StopReason::LlmError;
                
                {
                    let fail_idx = (iteration - ctx.resume_from) as usize;
                    if fail_idx < todos.len() {
                        todos[fail_idx].status = "failed".to_string();
                        emit_todo_update(&ctx, &todos);
                    }
                }
                break;
            }

            LlmResponse::Cancelled => {
                AgentLoopEngine::emit_error(ctx.observer, ctx.session_id, &AgentError::Cancelled);
                outcome.stop_reason = StopReason::Cancelled;
                
                {
                    let fail_idx = (iteration - ctx.resume_from) as usize;
                    if fail_idx < todos.len() {
                        todos[fail_idx].status = "failed".to_string();
                        emit_todo_update(&ctx, &todos);
                    }
                }
                break;
            }
        }
    }

    
    outcome.written_files = written_files
        .lock()
        .expect("written_files mutex poisoned")
        .clone();
    (outcome, total_tokens, total_prompt_tokens, total_output_tokens, total_reasoning_tokens)
}









fn finalize_todos_on_text(todos: &mut [TodoEntry]) {
    for t in todos.iter_mut() {
        if t.status != "done" {
            t.status = "failed".to_string();
        }
    }
}

fn emit_todo_update(ctx: &LoopCtx, todos: &[TodoEntry]) {
    ctx.observer.on(
        AgentEvent::TodoUpdate {
            seq: None,
            session_id: ctx.session_id.to_string(),
            run_id: ctx.run_id.to_string(),
            todos: todos.to_vec(),
        },
        true,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_boundary_lands_on_user() {
        
        let msgs = vec![
            ChatMessage::system("sys"),
            ChatMessage::user("task"),
            ChatMessage::assistant_tool_call("ls", "{}", "c0"),
            ChatMessage::tool_result("ok", "c0"),
            ChatMessage::assistant("mid"),
            ChatMessage::user("followup"),
            ChatMessage::assistant("done"),
        ];
        
        assert_eq!(find_compact_boundary(&msgs, 2), Some(5));
        
        assert_eq!(msgs[5].role.as_str(), "user");
    }

    #[test]
    fn compact_boundary_scans_back_to_user_past_tool() {
        
        let msgs = vec![
            ChatMessage::system("sys"),
            ChatMessage::user("task"),
            ChatMessage::assistant_tool_call("ls", "{}", "c0"),
            ChatMessage::tool_result("ok", "c0"),
            ChatMessage::user("followup"),
            ChatMessage::assistant_tool_call("cat", "{}", "c1"),
            ChatMessage::tool_result("x", "c1"),
        ];
        
        assert_eq!(find_compact_boundary(&msgs, 2), Some(4));
    }

    #[test]
    fn compact_boundary_none_when_no_user_after_system() {
        
        let msgs = vec![
            ChatMessage::system("sys"),
            ChatMessage::assistant_tool_call("ls", "{}", "c0"),
            ChatMessage::tool_result("ok", "c0"),
        ];
        assert_eq!(find_compact_boundary(&msgs, 1), None);
    }

    #[test]
    fn compact_boundary_requires_system_first() {
        
        let msgs = vec![
            ChatMessage::user("x"),
            ChatMessage::assistant("y"),
        ];
        assert_eq!(find_compact_boundary(&msgs, 1), None);
    }
}

#[cfg(test)]
mod todos_tests {
    use super::*;

    fn entry(status: &str) -> TodoEntry {
        TodoEntry {
            id: format!("t-{status}"),
            title: status.to_string(),
            status: status.to_string(),
            active_form: None,
        }
    }

    
    #[test]
    fn text_finalize_keeps_done_marks_rest_failed() {
        let mut todos = vec![
            entry("done"),
            entry("done"),
            entry("pending"),
            entry("active"),
        ];
        finalize_todos_on_text(&mut todos);
        let statuses: Vec<&str> = todos.iter().map(|t| t.status.as_str()).collect();
        assert_eq!(statuses, vec!["done", "done", "failed", "failed"]);
    }

    
    #[test]
    fn text_finalize_preserves_failed() {
        let mut todos = vec![entry("done"), entry("failed")];
        finalize_todos_on_text(&mut todos);
        assert_eq!(todos[1].status, "failed");
    }

    
    #[test]
    fn text_finalize_noop_when_all_done() {
        let mut todos = vec![entry("done"), entry("done"), entry("done")];
        finalize_todos_on_text(&mut todos);
        assert!(todos.iter().all(|t| t.status == "done"));
    }
}
