










use crate::agent::approval::{ApprovalBroker, ApprovalDecision, ApprovalRequest};
use crate::agent::ledger::{
    args_digest, now_unix_ms, ApprovalSource, origin_of, RunLedger, RunStep,
    RunStepKind, StepOutcome, UnavailableReason as LedgerUnavailable,
};
use crate::agent::ledger::ApprovalDecision as LedgerDecision;
use crate::agent::permission::{self, Permission, SessionKind, ToolPermission};
use crate::agent::ports::{Blackboard, RunObserver};
use crate::skill::budget::{skill_id_of, BudgetVerdict, SkillBudgetTracker, SkillUsage};
use crate::agent::tool_registry::{GroupMessageSender, ToolExecContext};
use crate::agent::toolplane::{ToolOutcome, ToolPlane, ToolScope, UnavailableReason as PlaneUnavailable};
use crate::llm::json_repair::{coerce_tool_args, extract_tool_args_tolerant, repair_json};
use crate::llm::types::{ChatMessage, ToolCallResult};
use crate::session::manager::SessionManager;
use crate::session::model::CreateMessagePayload;
use crate::metrics::metrics::Metrics;
use crate::types::AgentEvent;
use futures_util::future::join_all;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Instant;






pub struct ToolRunDeps<'a> {
    pub observer: &'a dyn RunObserver,
    pub sid: &'a str,
    pub session_id: &'a str,
    pub session_manager: &'a SessionManager,
    
    pub plane: &'a dyn ToolPlane,
    pub metrics: &'a Metrics,
    
    pub approval: &'a ApprovalBroker,
    
    pub tool_scope: &'a ToolScope,
    
    
    pub global_auto_approve: bool,
    
    pub auto_approve_override: Option<bool>,
    pub permission_overrides: &'a [ToolPermission],
    pub workspace_root: Option<PathBuf>,
    
    
    pub tmp_root: Option<PathBuf>,
    pub cancelled_flag: Arc<AtomicBool>,
    
    pub ledger: &'a dyn RunLedger,
    
    pub run_id: &'a str,
    
    pub seat_id: Option<&'a str>,
    
    pub session_kind: SessionKind,
    
    pub skill_budget: &'a dyn SkillBudgetTracker,
    
    pub group_sender: Option<Arc<dyn GroupMessageSender>>,
    
    pub blackboard: Option<Arc<dyn Blackboard>>,
    
    pub write_gate: Option<Arc<crate::agent::write_gate::WriteGate>>,
}





enum ExecDecision {
    ExecuteOriginal,
    ExecuteEdited(serde_json::Value),
    Skip(String),
}




pub async fn run_tool_calls(
    deps: &ToolRunDeps<'_>,
    calls: &[ToolCallResult],
    reasoning_content: &str,
    plan_content: &str,
    tokens: u64,
    messages: &mut Vec<ChatMessage>,
    tool_call_seq: &mut u64,
    
    
    written_files: Arc<Mutex<Vec<String>>>,
) -> (u32, u32) {
    let tool_count = calls.len();
    let mut failed_count: u32 = 0;

    
    let call_ids: Vec<String> = calls
        .iter()
        .map(|_| {
            let id = format!("call_{}", *tool_call_seq);
            *tool_call_seq += 1;
            id
        })
        .collect();

    
    
    
    
    
    

        
        
        
        
        
        
        if !plan_content.trim().is_empty() {
            let _ = deps.session_manager.add_observation(
                deps.session_id,
                plan_content.trim().to_string(),
            );
        }

        
        
        
        
        
        
        
        
        
        
        const MAX_PARALLEL_TOOLS: usize = 4;
        let read_only_tool = |n: &str| {
            matches!(
                n,
                "read_file" | "read_text_file" | "list_dir" | "get_weather" | "read_state"
            )
        };
        let want_parallel = tool_count > 1 && calls.iter().all(|c| read_only_tool(&c.name));
        let mut use_parallel = want_parallel;
        if use_parallel {
            
            
            
            let auto = deps
                .auto_approve_override
                .unwrap_or(deps.global_auto_approve);
            for call in calls {
                let mut perm =
                    permission::decide(&call.name, deps.session_kind, auto, deps.permission_overrides);
                if let Some(sid) = skill_id_of(&call.name) {
                    if let BudgetVerdict::Exceeded(_) = deps.skill_budget.check(deps.run_id, &sid) {
                        perm = Permission::Ask;
                    }
                }
                if matches!(perm, Permission::Ask) && deps.approval.is_exempt(deps.session_id, &call.name)
                {
                    perm = Permission::Allow;
                }
                if !matches!(perm, Permission::Allow) || !deps.tool_scope.allows(&call.name) {
                    use_parallel = false;
                    break;
                }
            }
        }
        if use_parallel {
            
            
            
            struct ParallelCall {
                name: String,
                call_id: String,
                args_raw: String,
                per_reason: String,
                digest: String,
                step_start: Instant,
                started_at: i64,
                args_json: serde_json::Value,
                tool_ctx: ToolExecContext,
            }
            let mut prepped: Vec<ParallelCall> = Vec::with_capacity(tool_count);
            for (i, call) in calls.iter().enumerate() {
                let intent = extract_intent(&call.arguments);
                let per_reason = match &intent {
                    Some(it) => it.clone(),
                    None => {
                        if !reasoning_content.is_empty() {
                            String::new()
                        } else if i == 0 && !plan_content.trim().is_empty() {
                            plan_content.trim().to_string()
                        } else if reasoning_content.is_empty() && plan_content.trim().is_empty() {
                            summarize_tool_intent(std::slice::from_ref(call))
                        } else {
                            String::new()
                        }
                    }
                };
                if !per_reason.is_empty() {
                    let th_id = format!("th_{}", call_ids[i]);
                    deps.observer.on(
                        AgentEvent::Thinking {
                            seq: None,
                            session_id: deps.sid.to_string(),
                            thought_id: th_id.clone(),
                            content: per_reason.clone(),
                        },
                        true,
                    );
                    deps.observer.on(
                        AgentEvent::ThinkingEnd {
                            seq: None,
                            session_id: deps.sid.to_string(),
                            thought_id: th_id,
                        },
                        true,
                    );
                }
                deps.observer.on(
                    AgentEvent::ToolCall {
                        seq: None,
                        session_id: deps.sid.to_string(),
                        call_id: call_ids[i].clone(),
                        tool_name: call.name.clone(),
                        tool_args: call.arguments.clone(),
                    },
                    true,
                );

                let mut args_json = match serde_json::from_str(&call.arguments) {
                    Ok(parsed) => coerce_tool_args(&call.name, &call.arguments, parsed),
                    Err(_) => match serde_json::from_str(&repair_json(&call.arguments)) {
                        Ok(parsed) => coerce_tool_args(&call.name, &call.arguments, parsed),
                        Err(_) => extract_tool_args_tolerant(&call.name, &call.arguments),
                    },
                };
                if let Some(obj) = args_json.as_object_mut() {
                    obj.remove("intent");
                }
                let workspace_id = deps
                    .session_manager
                    .get_session(deps.session_id)
                    .ok()
                    .flatten()
                    .and_then(|s| s.workspace_id.clone());
                let tool_ctx = ToolExecContext {
                    workspace_root: deps.workspace_root.clone(),
                    tmp_root: deps.tmp_root.clone(),
                    cancel: Some(deps.cancelled_flag.clone()),
                    enforce_root: deps.workspace_root.is_some()
                        && deps.session_kind != SessionKind::User,
                    group_sender: deps.group_sender.clone(),
                    blackboard: deps.blackboard.clone(),
                    sender_session: Some(deps.session_id.to_string()),
                    workspace_id,
                    write_gate: deps.write_gate.clone(),
                    run_id: Some(deps.run_id.to_string()),
                    written_files: Some(written_files.clone()),
                };
                prepped.push(ParallelCall {
                    name: call.name.clone(),
                    call_id: call_ids[i].clone(),
                    args_raw: call.arguments.clone(),
                    per_reason,
                    digest: args_digest(&call.arguments),
                    step_start: Instant::now(),
                    started_at: now_unix_ms(),
                    args_json,
                    tool_ctx,
                });
            }

            
            let mut parts_at: Vec<Option<(Result<String, String>, StepOutcome, Option<LedgerUnavailable>)>> =
                (0..prepped.len()).map(|_| None).collect();
            for chunk_start in (0..prepped.len()).step_by(MAX_PARALLEL_TOOLS) {
                let chunk_end = (chunk_start + MAX_PARALLEL_TOOLS).min(prepped.len());
                let futs: Vec<_> = (chunk_start..chunk_end)
                    .map(|idx| {
                        let p = &prepped[idx];
                        async move {
                            let parts = match tokio::time::timeout(
                                std::time::Duration::from_secs(super::TOOL_TIMEOUT_SECS),
                                deps.plane.invoke(&p.name, p.args_json.clone(), &p.tool_ctx),
                            )
                            .await
                            {
                                Ok(outcome) => outcome.into_tool_parts(),
                                Err(_) => (
                                    Err(format!(
                                        "Tool '{}' timed out after {}s",
                                        p.name,
                                        super::TOOL_TIMEOUT_SECS
                                    )),
                                    StepOutcome::Failed,
                                    None,
                                ),
                            };
                            (idx, parts)
                        }
                    })
                    .collect();
                for (idx, parts) in join_all(futs).await {
                    parts_at[idx] = Some(parts);
                }
            }

            
            
            for (i, p) in prepped.iter().enumerate() {
                let (exec_result, step_outcome, unavailable_reason) =
                    parts_at[i].take().expect("parallel tool result missing");
                let digest = p.digest.clone();
                let step_start = p.step_start;
                let started_at = p.started_at;

                if let Err(e) = deps.session_manager.add_message(CreateMessagePayload {
                    session_id: deps.session_id.to_string(),
                    role: "assistant".into(),
                    content: String::new(),
                    tool_name: Some(p.name.clone()),
                    tool_args: Some(p.args_raw.clone()),
                    tool_result: None,
                    token_usage: tokens as i64,
                    reasoning_content: p.per_reason.clone(),
                    call_id: Some(p.call_id.clone()),
                }) {
            
            tracing::error!(target: "onedesktop.engine", error = %e, "message persist failed (events+messages rolled back)");
        }
                let mut tc_msg =
                    ChatMessage::assistant_tool_call(&p.name, &p.args_raw, &p.call_id);
                if !p.per_reason.is_empty() {
                    tc_msg.extra.insert(
                        "reasoning_content".into(),
                        serde_json::Value::String(p.per_reason.clone()),
                    );
                }
                messages.push(tc_msg);

                deps.metrics.inc_tool_calls();
                let result_str = match &exec_result {
                    Ok(r) => {
                        let clean = sanitize_tool_result(r);
                        deps.observer.on(
                            AgentEvent::ToolResult {
                                seq: None,
                                session_id: deps.sid.to_string(),
                                call_id: p.call_id.clone(),
                                tool_name: p.name.clone(),
                                result: clean.clone(),
                                is_error: false,
                            },
                            true,
                        );
                        clean
                    }
                    Err(e) => {
                        deps.metrics.inc_tool_errors();
                        failed_count += 1;
                        let clean = sanitize_tool_result(e);
                        deps.observer.on(
                            AgentEvent::ToolResult {
                                seq: None,
                                session_id: deps.sid.to_string(),
                                call_id: p.call_id.clone(),
                                tool_name: p.name.clone(),
                                result: clean.clone(),
                                is_error: true,
                            },
                            false,
                        );
                        format!("Error: {}", clean)
                    }
                };

                record_tool_step(
                    deps.ledger,
                    deps.run_id,
                    &p.name,
                    &digest,
                    step_outcome,
                    unavailable_reason,
                    Some(ApprovalSource::AutoApprove),
                    None,
                    step_start.elapsed().as_millis() as u64,
                    started_at,
                );
                if let Some(sid) = skill_id_of(&p.name) {
                    let _ = deps.skill_budget.record_usage(
                        deps.run_id,
                        &sid,
                        &SkillUsage {
                            tokens: 0,
                            cost_cents: 0,
                            elapsed_ms: step_start.elapsed().as_millis() as u64,
                        },
                    );
                }
                messages.push(ChatMessage::tool_result(&result_str, &p.call_id));
                if let Err(e) = deps.session_manager.add_message(CreateMessagePayload {
                    session_id: deps.session_id.to_string(),
                    role: "tool".into(),
                    content: result_str,
                    tool_name: Some(p.name.clone()),
                    tool_args: None,
                    tool_result: exec_result.as_ref().ok().cloned(),
                    token_usage: 0,
                    reasoning_content: String::new(),
                    call_id: Some(p.call_id.clone()),
                }) {
            
            tracing::error!(target: "onedesktop.engine", error = %e, "message persist failed (events+messages rolled back)");
        }
            }
            return (failed_count, tool_count as u32);
        }

        for (i, call) in calls.iter().enumerate() {
            tracing::debug!(
                target: "onedesktop.engine",
                tool = %call.name,
                tool_index = i,
                tool_count,
                "Executing tool call"
            );

            
            
            
            
            
            let intent = extract_intent(&call.arguments);
            let per_reason = match &intent {
                Some(it) => it.clone(),
                None => {
                    if !reasoning_content.is_empty() {
                        String::new()
                    } else if i == 0 && !plan_content.trim().is_empty() {
                        plan_content.trim().to_string()
                    } else if reasoning_content.is_empty() && plan_content.trim().is_empty() {
                        summarize_tool_intent(std::slice::from_ref(call))
                    } else {
                        String::new()
                    }
                }
            };

        
        let step_start = Instant::now();
        let started_at = now_unix_ms();
        let mut digest = args_digest(&call.arguments);
        let mut approval_source: Option<ApprovalSource> = None;
        let mut approval_decision: Option<LedgerDecision> = None;

        
        if let Err(e) = deps.session_manager.add_message(CreateMessagePayload {
            session_id: deps.session_id.to_string(),
            role: "assistant".into(),
            content: String::new(),
            tool_name: Some(call.name.clone()),
            tool_args: Some(call.arguments.clone()),
            tool_result: None,
            token_usage: tokens as i64,
            reasoning_content: per_reason.clone(),
            
            call_id: Some(call_ids[i].clone()),
        }) {
            
            tracing::error!(target: "onedesktop.engine", error = %e, "message persist failed (events+messages rolled back)");
        }

        
        let mut tc_msg = ChatMessage::assistant_tool_call(&call.name, &call.arguments, &call_ids[i]);
            if !per_reason.is_empty() {
                tc_msg.extra.insert(
                    "reasoning_content".into(),
                    serde_json::Value::String(per_reason.clone()),
                );
            }
        messages.push(tc_msg);

        
        if !per_reason.is_empty() {
            
            
            let th_id = format!("th_{}", call_ids[i]);
            deps.observer.on(
                AgentEvent::Thinking {
                    seq: None,
                    session_id: deps.sid.to_string(),
                    thought_id: th_id.clone(),
                    content: per_reason.clone(),
                },
                true,
            );
            deps.observer.on(
                AgentEvent::ThinkingEnd {
                    seq: None,
                    session_id: deps.sid.to_string(),
                    thought_id: th_id,
                },
                true,
            );
        }

        
        deps.observer.on(
            AgentEvent::ToolCall {
                seq: None,
                session_id: deps.sid.to_string(),
                call_id: call_ids[i].clone(),
                tool_name: call.name.clone(),
                tool_args: call.arguments.clone(),
            },
            true,
        );

        
        
        
        
        
        let auto = deps
            .auto_approve_override
            .unwrap_or(deps.global_auto_approve);
        
        
        
        let session_kind = deps.session_kind;
        let mut perm = permission::decide(&call.name, session_kind, auto, deps.permission_overrides);
        
        
        if let Some(sid) = skill_id_of(&call.name) {
            if let BudgetVerdict::Exceeded(reason) = deps.skill_budget.check(deps.run_id, &sid) {
                perm = Permission::Ask;
                tracing::warn!(
                    target: "onedesktop.budget",
                    skill_id = %sid,
                    %reason,
                    "skill 超出预算，升级为人工审批"
                );
            }
        }
        
        
        if matches!(perm, Permission::Ask) && deps.approval.is_exempt(deps.session_id, &call.name) {
            perm = Permission::Allow;
        }

        
        
        if !deps.tool_scope.allows(&call.name) {
            let msg = format!("Tool '{}' not allowed in this scope", call.name);
            deps.observer.on(
                AgentEvent::ToolResult {
                    seq: None,
                    session_id: deps.sid.to_string(),
                    call_id: call_ids[i].clone(),
                    tool_name: call.name.clone(),
                    result: msg.clone(),
                    is_error: true,
                },
                true,
            );
            messages.push(ChatMessage::tool_result(&msg, &call_ids[i]));
            if let Err(e) = deps.session_manager.add_message(CreateMessagePayload {
                session_id: deps.session_id.to_string(),
                role: "tool".into(),
                content: msg.clone(),
                tool_name: Some(call.name.clone()),
                tool_args: None,
                tool_result: Some("Out of scope".into()),
                token_usage: 0,
                reasoning_content: String::new(),
                call_id: Some(call_ids[i].clone()),
            }) {
            
            tracing::error!(target: "onedesktop.engine", error = %e, "message persist failed (events+messages rolled back)");
        }
            record_tool_step(
                deps.ledger,
                deps.run_id,
                &call.name,
                &digest,
                StepOutcome::Failed,
                None,
                None,
                None,
                step_start.elapsed().as_millis() as u64,
                started_at,
            );
            continue;
        }

        let exec_decision = match perm {
            Permission::Allow => {
                approval_source = Some(ApprovalSource::AutoApprove);
                ExecDecision::ExecuteOriginal
            }
            Permission::Deny => {
                ExecDecision::Skip(format!(
                    "Tool '{}' denied by permission policy",
                    call.name
                ))
            }
            Permission::Ask => {
                
                
                let req = ApprovalRequest::new(
                    deps.session_id,
                    deps.run_id,
                    deps.seat_id,
                    &call.name,
                    &call.arguments,
                );
                let handle = deps.approval.register(req.clone()).await;
                deps.observer.on(
                    AgentEvent::ApprovalRequest {
                        seq: None,
                        session_id: deps.sid.to_string(),
                        approval_id: req.id.clone(),
                        tool_name: call.name.clone(),
                        tool_args: call.arguments.clone(),
                        seat: req.seat_id.clone(),
                        risk: req.risk.as_str().to_string(),
                    },
                    true,
                );
                let (decision, source) = handle.await_decision(req.expire_after).await;
                approval_source = Some(source);
                approval_decision = Some(decision.to_ledger());
                match decision {
                    ApprovalDecision::Accept => ExecDecision::ExecuteOriginal,
                    ApprovalDecision::Edit { args } => ExecDecision::ExecuteEdited(args),
                    ApprovalDecision::Respond { feedback } => ExecDecision::Skip(format!(
                        "用户未执行该操作，反馈：{}",
                        feedback
                    )),
                    ApprovalDecision::Ignore => {
                        ExecDecision::Skip("用户拒绝执行该操作".into())
                    }
                }
            }
        };

        if let ExecDecision::Skip(reject_msg) = &exec_decision {
            deps.observer.on(
                AgentEvent::ToolResult {
                    seq: None,
                    session_id: deps.sid.to_string(),
                    call_id: call_ids[i].clone(),
                    tool_name: call.name.clone(),
                    result: reject_msg.clone(),
                    is_error: true,
                },
                true,
            );
            messages.push(ChatMessage::tool_result(reject_msg, &call_ids[i]));
            if let Err(e) = deps.session_manager.add_message(CreateMessagePayload {
                session_id: deps.session_id.to_string(),
                role: "tool".into(),
                content: reject_msg.clone(),
                tool_name: Some(call.name.clone()),
                tool_args: None,
                tool_result: Some("User rejected".into()),
                token_usage: 0,
                reasoning_content: String::new(),
                call_id: Some(call_ids[i].clone()),
            }) {
            
            tracing::error!(target: "onedesktop.engine", error = %e, "message persist failed (events+messages rolled back)");
        }
            
            record_tool_step(
                deps.ledger,
                deps.run_id,
                &call.name,
                &digest,
                StepOutcome::Failed,
                None,
                approval_source,
                approval_decision,
                step_start.elapsed().as_millis() as u64,
                started_at,
            );
            continue;
        }

        
        let mut tool_args_json: serde_json::Value = match serde_json::from_str(&call.arguments) {
            Ok(parsed) => coerce_tool_args(&call.name, &call.arguments, parsed),
            Err(_) => {
                
                let repaired = repair_json(&call.arguments);
                match serde_json::from_str(&repaired) {
                    Ok(parsed) => {
                        tracing::warn!(
                            target: "onedesktop.engine",
                            tool = %call.name,
                            "Tool args JSON repaired after parse failure"
                        );
                        coerce_tool_args(&call.name, &call.arguments, parsed)
                    }
                    Err(_) => {
                        
                        
                        
                        tracing::warn!(
                            target: "onedesktop.engine",
                            tool = %call.name,
                            raw = %call.arguments,
                            "Tool args JSON unparseable; extracting fields tolerantly"
                        );
                        extract_tool_args_tolerant(&call.name, &call.arguments)
                    }
                }
            }
        };
        
        if let Some(obj) = tool_args_json.as_object_mut() {
            obj.remove("intent");
        }
        
        let mut edited = false;
        if let ExecDecision::ExecuteEdited(v) = &exec_decision {
            tool_args_json = v.clone();
            digest = args_digest(&v.to_string());
            edited = true;
        }

        
        
        let workspace_id = deps
            .session_manager
            .get_session(deps.session_id)
            .ok()
            .flatten()
            .and_then(|s| s.workspace_id.clone());

        let tool_ctx = ToolExecContext {
            workspace_root: deps.workspace_root.clone(),
            tmp_root: deps.tmp_root.clone(),
            cancel: Some(deps.cancelled_flag.clone()),
            
            
            
            enforce_root: deps.workspace_root.is_some()
                && deps.session_kind != SessionKind::User,
            
            group_sender: deps.group_sender.clone(),
            
            blackboard: deps.blackboard.clone(),
            sender_session: Some(deps.session_id.to_string()),
            
            workspace_id,
            
            write_gate: deps.write_gate.clone(),
            run_id: Some(deps.run_id.to_string()),
            
            written_files: Some(written_files.clone()),
        };
        
        
        
        let (exec_result, step_outcome, unavailable_reason) = match tokio::time::timeout(
            std::time::Duration::from_secs(super::TOOL_TIMEOUT_SECS),
            deps.plane.invoke(&call.name, tool_args_json, &tool_ctx),
        )
        .await
        {
            Ok(outcome) => outcome.into_tool_parts(),
            Err(_) => (
                Err(format!(
                    "Tool '{}' timed out after {}s",
                    call.name, super::TOOL_TIMEOUT_SECS
                )),
                StepOutcome::Failed,
                None,
            ),
        };
        deps.metrics.inc_tool_calls();

        let result_str = match &exec_result {
            Ok(r) => {
                
                
                let clean = sanitize_tool_result(r);
                deps.observer.on(
                    AgentEvent::ToolResult {
                        seq: None,
                        session_id: deps.sid.to_string(),
                        call_id: call_ids[i].clone(),
                        tool_name: call.name.clone(),
                        result: clean.clone(),
                        is_error: false,
                    },
                    true,
                );
                
                
                if edited {
                    format!("{}（参数已被用户调整）", clean)
                } else {
                    clean
                }
            }
            Err(e) => {
                deps.metrics.inc_tool_errors();
                failed_count += 1;
                let clean = sanitize_tool_result(e);
                deps.observer.on(
                    AgentEvent::ToolResult {
                        seq: None,
                        session_id: deps.sid.to_string(),
                        call_id: call_ids[i].clone(),
                        tool_name: call.name.clone(),
                        result: clean.clone(),
                        is_error: true,
                    },
                    false,
                );
                format!("Error: {}", clean)
            }
        };

        
        record_tool_step(
            deps.ledger,
            deps.run_id,
            &call.name,
            &digest,
            step_outcome,
            unavailable_reason,
            approval_source,
            approval_decision,
            step_start.elapsed().as_millis() as u64,
            started_at,
        );

        
        
        if let Some(sid) = skill_id_of(&call.name) {
            let _ = deps.skill_budget.record_usage(
                deps.run_id,
                &sid,
                &SkillUsage {
                    tokens: 0,
                    cost_cents: 0,
                    elapsed_ms: step_start.elapsed().as_millis() as u64,
                },
            );
        }

        
        messages.push(ChatMessage::tool_result(&result_str, &call_ids[i]));

        if let Err(e) = deps.session_manager.add_message(CreateMessagePayload {
            session_id: deps.session_id.to_string(),
            role: "tool".into(),
            content: result_str,
            tool_name: Some(call.name.clone()),
            tool_args: None,
            tool_result: exec_result.as_ref().ok().cloned(),
            token_usage: 0,
            reasoning_content: String::new(),
            call_id: Some(call_ids[i].clone()),
        }) {
            
            tracing::error!(target: "onedesktop.engine", error = %e, "message persist failed (events+messages rolled back)");
        }
    }

    (failed_count, tool_count as u32)
}


fn extract_intent(args: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(args).ok()?;
    let s = v.get("intent")?.as_str()?.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}


fn human_action(tool: &str) -> &'static str {
    match tool {
        "read_file" | "read_text_file" => "读取文件",
        "write_file" | "create_file" => "写入文件",
        "edit_file" | "patch_file" => "修改文件",
        "run_command" | "shell" | "exec" => "执行命令",
        "grep" | "search" | "search_files" => "搜索内容",
        "list_files" | "list_dir" => "列出文件",
        "web_fetch" | "fetch_url" => "抓取网页",
        "send_to_worker" => "派发给协作 Agent",
        _ => "调用工具",
    }
}




fn summarize_tool_intent(calls: &[ToolCallResult]) -> String {
    let parts: Vec<String> = calls
        .iter()
        .map(|call| {
            let digest = args_digest(&call.arguments);
            
            let readable =
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&call.arguments) {
                    ["command", "script", "cmd", "path", "file", "pattern", "query"]
                        .iter()
                        .find_map(|k| {
                            v.get(*k)
                                .and_then(|x| x.as_str())
                                .filter(|s| !s.is_empty())
                        })
                        .map(|s| s.to_string())
                        .unwrap_or(digest)
                } else {
                    digest
                };
            let verb = human_action(call.name.as_str());
            format!("{}：{}", verb, readable)
        })
        .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!("即将 {}", parts.join("；"))
    }
}







const MAX_TOOL_RESULT_CHARS: usize = 32_000;



fn looks_like_html(s: &str) -> bool {
    let head = s.trim_start();
    if head.len() < 64 {
        return false;
    }
    let low = head.to_ascii_lowercase();
    low.contains("<!doctype html")
        || low.contains("<html")
        || (low.contains('<')
            && (low.contains("<head") || low.contains("<body") || low.contains("<div")))
}


fn strip_blocks(src: &str, open_tag: &str, close_tag: &str) -> String {
    let low = src.to_ascii_lowercase();
    let open = format!("<{}", open_tag);
    let close = format!("</{}>", close_tag);
    let mut result = String::with_capacity(src.len());
    let mut pos = 0usize;
    loop {
        match low[pos..].find(&open) {
            None => {
                result.push_str(&src[pos..]);
                break;
            }
            Some(rel) => {
                let o = pos + rel;
                result.push_str(&src[pos..o]);
                let after = o + open.len();
                match low[after..].find(&close) {
                    None => break, 
                    Some(c_rel) => {
                        let c = after + c_rel + close.len();
                        pos = c;
                    }
                }
            }
        }
    }
    result
}


fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        if c == '<' {
            in_tag = true;
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag {
            out.push(c);
        }
    }
    out
}


fn decode_entities(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let n = chars.len();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < n {
        if chars[i] == '&' {
            let mut j = i + 1;
            let mut end = None;
            while j < n && j - i <= 12 {
                if chars[j] == ';' {
                    end = Some(j);
                    break;
                }
                j += 1;
            }
            if let Some(j) = end {
                let ent: String = chars[i + 1..j].iter().collect();
                let decoded = match ent.as_str() {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some('\u{a0}'),
                    _ if ent.starts_with('#') => {
                        let num = &ent[1..];
                        let cp = if num.starts_with('x') || num.starts_with('X') {
                            u32::from_str_radix(&num[1..], 16).ok()
                        } else {
                            num.parse::<u32>().ok()
                        };
                        cp.and_then(std::char::from_u32)
                    }
                    _ => None,
                };
                if let Some(ch) = decoded {
                    out.push(ch);
                    i = j + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}


fn html_to_text(html: &str) -> String {
    let mut s = html.to_string();
    s = strip_blocks(&s, "script", "script");
    s = strip_blocks(&s, "style", "style");
    s = strip_blocks(&s, "head", "head");
    s = strip_blocks(&s, "svg", "svg");
    s = strip_tags(&s);
    s = decode_entities(&s);
    let mut out = String::with_capacity(s.len());
    let mut prev_ws = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !prev_ws {
                out.push(' ');
            }
            prev_ws = true;
        } else {
            out.push(c);
            prev_ws = false;
        }
    }
    out.trim().to_string()
}



pub fn sanitize_tool_result(raw: &str) -> String {
    let total_chars = raw.chars().count();
    let capped: String = if total_chars > MAX_TOOL_RESULT_CHARS {
        let kept: String = raw.chars().take(MAX_TOOL_RESULT_CHARS).collect();
        format!(
            "{}\n…[结果已截断：原始 {} 字符，仅保留前 {} 字符]",
            kept, total_chars, MAX_TOOL_RESULT_CHARS
        )
    } else {
        raw.to_string()
    };
    if looks_like_html(&capped) {
        html_to_text(&capped)
    } else {
        capped
    }
}


#[allow(clippy::too_many_arguments)]
fn record_tool_step(
    ledger: &dyn RunLedger,
    run_id: &str,
    name: &str,
    args_digest_str: &str,
    outcome: StepOutcome,
    unavailable_reason: Option<LedgerUnavailable>,
    approval_source: Option<ApprovalSource>,
    approval_decision: Option<LedgerDecision>,
    duration_ms: u64,
    started_at: i64,
) {
    ledger.step(
        run_id,
        RunStep {
            seq: 0,
            kind: RunStepKind::Tool,
            name: Some(name.to_string()),
            origin: origin_of(name),
            args_digest: Some(args_digest_str.to_string()),
            outcome,
            unavailable_reason,
            approval_source,
            approval_decision,
            duration_ms: Some(duration_ms),
            started_at,
        },
    );
}







fn tool_outcome_to_parts(outcome: ToolOutcome) -> (Result<String, String>, StepOutcome, Option<LedgerUnavailable>) {
    match outcome {
        ToolOutcome::Ok { content, .. } => (Ok(content), StepOutcome::Ok, None),
        ToolOutcome::Failed { message, .. } => (Err(message), StepOutcome::Failed, None),
        ToolOutcome::Unavailable { reason } => (
            Err(format!("Unavailable ({}): {}", reason.as_str(), describe_unavailable(&reason))),
            StepOutcome::Unavailable,
            Some(to_ledger_unavailable(&reason)),
        ),
    }
}

impl ToolOutcome {
    
    fn into_tool_parts(self) -> (Result<String, String>, StepOutcome, Option<LedgerUnavailable>) {
        tool_outcome_to_parts(self)
    }
}


fn describe_unavailable(reason: &PlaneUnavailable) -> String {
    match reason {
        PlaneUnavailable::Network(msg) => format!("网络不可达: {}", msg),
        PlaneUnavailable::NotFound => "工具不存在".to_string(),
        PlaneUnavailable::Timeout => "调用超时".to_string(),
        PlaneUnavailable::Denied => "被拒绝".to_string(),
        PlaneUnavailable::ProviderDown(msg) => format!("Provider 不可用: {}", msg),
    }
}



fn to_ledger_unavailable(reason: &PlaneUnavailable) -> LedgerUnavailable {
    match reason {
        PlaneUnavailable::Network(_) => LedgerUnavailable::Network,
        PlaneUnavailable::NotFound => LedgerUnavailable::NotFound,
        PlaneUnavailable::Timeout => LedgerUnavailable::Timeout,
        PlaneUnavailable::Denied => LedgerUnavailable::Denied,
        PlaneUnavailable::ProviderDown(_) => LedgerUnavailable::ProviderDown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::toolplane::UnavailableReason as PlaneUnavailable;

    #[test]
    fn outcome_ok_maps_to_success() {
        let (exec, outcome, unavail) = tool_outcome_to_parts(ToolOutcome::Ok {
            content: "hi".to_string(),
            ms: 3,
        });
        assert_eq!(exec, Ok("hi".to_string()));
        assert_eq!(outcome, StepOutcome::Ok);
        assert!(unavail.is_none());
    }

    #[test]
    fn outcome_failed_maps_to_error() {
        let (exec, outcome, unavail) = tool_outcome_to_parts(ToolOutcome::Failed {
            message: "boom".to_string(),
            retryable: true,
        });
        assert_eq!(exec, Err("boom".to_string()));
        assert_eq!(outcome, StepOutcome::Failed);
        assert!(unavail.is_none());
    }

    #[test]
    fn outcome_unavailable_maps_reason() {
        let (exec, outcome, unavail) = tool_outcome_to_parts(ToolOutcome::Unavailable {
            reason: PlaneUnavailable::Network("dns fail".to_string()),
        });
        assert!(exec.is_err());
        assert!(exec.unwrap_err().starts_with("Unavailable (network)"));
        assert_eq!(outcome, StepOutcome::Unavailable);
        assert_eq!(unavail, Some(LedgerUnavailable::Network));
    }

    #[test]
    fn timeout_fallback_is_failed() {
        
        let (exec, outcome, unavail): (Result<String, String>, StepOutcome, Option<LedgerUnavailable>) =
            (
                Err(format!(
                    "Tool '{}' timed out after {}s",
                    "x", super::super::TOOL_TIMEOUT_SECS
                )),
                StepOutcome::Failed,
                None,
            );
        assert!(exec.is_err());
        assert_eq!(outcome, StepOutcome::Failed);
        assert!(unavail.is_none());
    }

    #[test]
    fn html_to_text_strips_markup_and_decodes() {
        let html = "<!DOCTYPE html><html><head><style>.a{color:red}</style></head>\
<body><script>var x=1;</script><p>正文第一段 &amp; 第二段</p><!-- comment --></body></html>";
        let text = html_to_text(html);
        assert!(!text.contains("<script"));
        assert!(!text.contains("<style"));
        assert!(!text.contains("var x=1"));
        assert!(text.contains("正文第一段"));
        assert!(text.contains("第二段"));
        assert!(text.contains('&')); 
        assert!(!text.contains("<!--"));
    }

    #[test]
    fn sanitize_tool_result_converts_html_and_caps() {
        let big = format!(
            "<html><body>{}</body></html>",
            "正".repeat(MAX_TOOL_RESULT_CHARS + 5000)
        );
        let out = sanitize_tool_result(&big);
        assert!(out.contains('正'));
        assert!(out.contains("结果已截断"));
        assert!(out.len() < big.len());
    }

    #[test]
    fn sanitize_tool_result_keeps_json() {
        let json = r#"{"items":[{"title":"央视报道","url":"http://cctv.com/x"}]}"#;
        let out = sanitize_tool_result(json);
        assert_eq!(out, json); 
    }

    #[test]
    fn sanitize_tool_result_caps_huge_plain() {
        let huge = "x".repeat(MAX_TOOL_RESULT_CHARS + 100);
        let out = sanitize_tool_result(&huge);
        assert!(out.contains("结果已截断"));
    }
}
