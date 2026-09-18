








use crate::agent::compaction::{self, COMPACTION_MSG_THRESHOLD, KEEP_RECENT};
use crate::agent::engine::ResumePoint;
use crate::agent::tools::memory::read_memory_block;
use crate::llm::provider::LlmProvider;
use crate::llm::types::ChatMessage;
use crate::session::manager::SessionManager;
use crate::session::model::{CreateMessagePayload, Message, Session};







const CONTINUE_DIRECTIVE: &str = "[系统] 任务续跑";


fn placeholder_tool_result(call_id: &str) -> ChatMessage {
    ChatMessage::tool_result(
        "工具执行在记录结果前被中断，已自动补全以继续会话。",
        call_id,
    )
}







fn continue_directive(rp: &ResumePoint) -> String {
    format!(
        "{}：上文是你本次任务执行到第 {} 轮时的现场（已消耗 {} tokens），执行因中断或暂停停在这里。\n\
         请直接从中断处继续推进，注意：\n\
         - 已经出现在上文里的工具调用及其结果视为**已完成**，不要重复执行；\n\
         - 不要复述或重写上文已经产出的内容；\n\
         - 如果任务其实已经完成，直接给出最终结论即可。",
        CONTINUE_DIRECTIVE, rp.iteration, rp.tokens_used
    )
}



















pub async fn build_messages(
    session: &Session,
    history: &[Message],
    preamble: &str,
    provider: &dyn LlmProvider,
    session_manager: &SessionManager,
    user_message: &str,
    resume: Option<&ResumePoint>,
    cancel_rx: Option<tokio::sync::watch::Receiver<bool>>,
) -> (Vec<ChatMessage>, u64) {
    let effective_preamble = if preamble.is_empty() {
        &session.preamble
    } else {
        preamble
    };

    
    
    
    
    let memory_block = read_memory_block(session.workspace_id.as_deref());
    let system_prompt: String = if effective_preamble.is_empty() {
        memory_block
    } else if memory_block.is_empty() {
        effective_preamble.to_string()
    } else {
        format!(
            "{}\n\n# Persistent Memory\nThe following context is loaded from your long-term memory files and should guide your behavior:\n\n{}",
            effective_preamble, memory_block
        )
    };

    
    
    let system_prompt = if system_prompt.is_empty() {
        crate::agent::engine::REASONING_PROTOCOL.to_string()
    } else {
        format!(
            "{}\n\n{}",
            system_prompt,
            crate::agent::engine::REASONING_PROTOCOL
        )
    };

    
    
    let mut fold: Option<(usize, usize, String)> = None;
    if history.len() > COMPACTION_MSG_THRESHOLD {
        
        
        let prev = session_manager.get_latest_summary(&session.id);
        let cursor = prev.as_ref().map(|(_, c)| *c).unwrap_or(0);
        let prev_summary = prev.as_ref().map(|(s, _)| s.as_str());
        match compaction::fold_history(provider, history, cursor, prev_summary, cancel_rx.clone()).await {
            Ok(summary) => {
                let first_user = history
                    .iter()
                    .position(|m| m.role == "user")
                    .map(|i| i + 1)
                    .unwrap_or(0);
                let end = history
                    .len()
                    .saturating_sub(KEEP_RECENT);
                let start = first_user.max(cursor);
                if end > start {
                    fold = Some((start, end, summary.clone()));
                    let _ = session_manager.save_summary(&session.id, &summary, history.len());
                    tracing::info!(
                        target: "onedesktop.engine",
                        session_id = %session.id,
                        cursor,
                        folded = end - start,
                        total = history.len(),
                        incremental = cursor > 0,
                        "history folded"
                    );
                }
            }
            Err(e) => {
                tracing::warn!(target: "onedesktop.engine", session_id = %session.id, error = %e, "compaction skipped");
            }
        }
    }

    
    let mut messages = Vec::new();
    let mut tool_call_seq: u64 = 0;
    
    
    
    let mut last_tool_call_id: Option<String> = None;
    let is_first_message = history.is_empty();

    if !system_prompt.is_empty() {
        messages.push(ChatMessage::system(&system_prompt));
    }

    for (idx, msg) in history.iter().enumerate() {
        
        if let Some((start, end, summary)) = &fold {
            if idx >= *start && idx < *end {
                continue;
            }
            if idx == *end {
                messages.push(ChatMessage::user(&format!("# 历史摘要\n{}", summary)));
            }
        }
        match msg.role.as_str() {
            "user" => {
                last_tool_call_id = None;
                messages.push(ChatMessage::user(&msg.content));
            }
            "assistant" => {
                if let (Some(tool_name), Some(tool_args)) = (&msg.tool_name, &msg.tool_args) {
                    let call_id = format!("call_{}", tool_call_seq);
                    tool_call_seq += 1;
                    let mut tc = ChatMessage::assistant_tool_call(tool_name, tool_args, &call_id);
                    if !msg.reasoning_content.is_empty() {
                        tc.extra.insert(
                            "reasoning_content".into(),
                            serde_json::Value::String(msg.reasoning_content.clone()),
                        );
                    }
                    messages.push(tc);
                    
                    last_tool_call_id = Some(call_id);
                } else {
                    let mut m = ChatMessage::assistant(&msg.content);
                    if !msg.reasoning_content.is_empty() {
                        m.extra.insert(
                            "reasoning_content".into(),
                            serde_json::Value::String(msg.reasoning_content.clone()),
                        );
                    }
                    messages.push(m);
                    
                    last_tool_call_id = None;
                }
            }
            "tool" => {
                
                
                
                
                let call_id = last_tool_call_id
                    .clone()
                    .unwrap_or_else(|| format!("call_{}", tool_call_seq));
                messages.push(ChatMessage::tool_result(&msg.content, &call_id));
                last_tool_call_id = None;
            }
            _ => {}
        }
    }

    match resume {
        
        
        
        Some(rp) => {
            messages.push(ChatMessage::user(&continue_directive(rp)));
            tracing::info!(
                target: "onedesktop.engine",
                session_id = %session.id,
                iteration = rp.iteration,
                tokens_used = rp.tokens_used,
                replayed = messages.len(),
                "resume: history replayed, continue directive injected"
            );
        }
        
        None => {
            
            if let Err(e) = session_manager.add_message(CreateMessagePayload {
                session_id: session.id.clone(),
                role: "user".into(),
                content: user_message.to_string(),
                tool_name: None,
                tool_args: None,
                tool_result: None,
                token_usage: 0,
                reasoning_content: String::new(),
                call_id: None,
            }) {
            
            tracing::error!(target: "onedesktop.engine", error = %e, "message persist failed (events+messages rolled back)");
        }

            
            if is_first_message {
                let title: String = user_message.chars().take(40).collect();
                let title = if user_message.len() > 40 {
                    format!("{}…", title)
                } else {
                    title
                };
                let _ = session_manager.update_title(&session.id, &title);
            }

            messages.push(ChatMessage::user(user_message));
        }
    }

    
    
    
    messages = sanitize_tool_messages(messages);

    (messages, tool_call_seq)
}












fn sanitize_tool_messages(mut messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let mut sanitized: Vec<ChatMessage> = Vec::with_capacity(messages.len() + 4);
    let mut open_calls: Vec<String> = Vec::new();
    let mut dropped_orphans: u32 = 0;
    for msg in messages.drain(..) {
        match msg.role.as_str() {
            "assistant" => {
                
                for id in open_calls.drain(..) {
                    sanitized.push(placeholder_tool_result(&id));
                }
                if let Some(calls) = &msg.tool_calls {
                    for tc in calls {
                        open_calls.push(tc.id.clone());
                    }
                }
                sanitized.push(msg);
            }
            "tool" => {
                
                
                let is_orphan = match &msg.tool_call_id {
                    Some(cid) => !open_calls.iter().any(|id| id == cid),
                    None => true,
                };
                if is_orphan {
                    dropped_orphans += 1;
                    tracing::warn!(
                        target: "onedesktop.engine",
                        has_call_id = msg.tool_call_id.is_some(),
                        "历史消毒：丢弃孤儿 tool 消息（无对应前置 tool_call），避免 LLM 400"
                    );
                    continue;
                }
                open_calls.retain(|id| id != msg.tool_call_id.as_ref().unwrap());
                sanitized.push(msg);
            }
            _ => {
                
                for id in open_calls.drain(..) {
                    sanitized.push(placeholder_tool_result(&id));
                }
                sanitized.push(msg);
            }
        }
    }
    
    for id in open_calls.drain(..) {
        sanitized.push(placeholder_tool_result(&id));
    }
    if dropped_orphans > 0 {
        tracing::warn!(
            target: "onedesktop.engine",
            dropped = dropped_orphans,
            kept = sanitized.len(),
            "历史消毒：已丢弃孤儿 tool 消息"
        );
    }
    sanitized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_interleaved_pairs_are_kept() {
        let msgs = vec![
            ChatMessage::user("hi"),
            ChatMessage::assistant_tool_call("ls", "{}", "call_0"),
            ChatMessage::tool_result("ok", "call_0"),
            ChatMessage::assistant("done"),
        ];
        let out = sanitize_tool_messages(msgs);
        
        assert_eq!(out.len(), 4);
        assert_eq!(out[2].role, "tool");
    }

    #[test]
    fn orphan_tool_without_preceding_tool_call_is_dropped() {
        
        let msgs = vec![
            ChatMessage::user("上下文被折叠"),
            ChatMessage::tool_result("本应挂在前置 tool_call 上", "call_7"),
            ChatMessage::assistant("继续"),
        ];
        let out = sanitize_tool_messages(msgs);
        
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].role, "user");
        assert_eq!(out[1].role, "assistant");
    }

    #[test]
    fn tool_at_start_with_no_assistant_is_dropped() {
        let msgs = vec![ChatMessage::tool_result("x", "call_0")];
        let out = sanitize_tool_messages(msgs);
        assert!(out.is_empty(), "开头即 tool 必须被丢弃，否则违反协议");
    }

    #[test]
    fn dangling_assistant_tool_call_gets_placeholder() {
        
        let msgs = vec![
            ChatMessage::user("go"),
            ChatMessage::assistant_tool_call("ls", "{}", "call_0"),
        ];
        let out = sanitize_tool_messages(msgs);
        assert_eq!(out.len(), 3, "末尾悬挂 tool_call 应被占位补全");
        assert_eq!(out[2].role, "tool");
        assert_eq!(out[2].tool_call_id.as_deref(), Some("call_0"));
    }

    #[test]
    fn tool_after_user_flushes_placeholder_then_drops_orphan() {
        let msgs = vec![
            ChatMessage::assistant_tool_call("ls", "{}", "call_0"),
            ChatMessage::user("插句话"),
            
            ChatMessage::tool_result("orphan", "call_1"),
        ];
        let out = sanitize_tool_messages(msgs);
        
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].role, "assistant");
        assert_eq!(out[1].role, "tool");
        assert_eq!(out[1].tool_call_id.as_deref(), Some("call_0"));
        assert_eq!(out[2].role, "user");
    }
}
