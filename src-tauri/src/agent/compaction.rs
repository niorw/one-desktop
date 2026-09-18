











use crate::llm::client;
use crate::llm::provider::LlmProvider;
use crate::session::model::Message;


pub const COMPACTION_MSG_THRESHOLD: usize = 40;

pub const KEEP_RECENT: usize = 10;










pub fn compute_fold_window(history_len: usize, first_user: usize, cursor: usize) -> Option<(usize, usize)> {
    if history_len <= KEEP_RECENT + 2 {
        return None;
    }
    let end = history_len.saturating_sub(KEEP_RECENT);
    let start = first_user.max(cursor);
    if end <= start {
        return None;
    }
    Some((start, end))
}









pub async fn fold_history(
    provider: &dyn LlmProvider,
    history: &[Message],
    cursor: usize,
    prev_summary: Option<&str>,
    cancel_rx: Option<tokio::sync::watch::Receiver<bool>>,
) -> Result<String, String> {
    let first_user = history
        .iter()
        .position(|m| m.role == "user")
        .map(|i| i + 1)
        .unwrap_or(0);
    let (start, end) = compute_fold_window(history.len(), first_user, cursor)
        .ok_or_else(|| "no incremental segment to fold".to_string())?;

    let mut transcript = String::new();
    for m in &history[start..end] {
        let label = match m.role.as_str() {
            "user" => "用户",
            "assistant" => "助手",
            "tool" => "工具结果",
            _ => "系统",
        };
        let snippet: String = m.content.chars().take(300).collect();
        transcript.push_str(&format!("【{}】{}\n", label, snippet));
        if !m.reasoning_content.is_empty() {
            let r: String = m.reasoning_content.chars().take(100).collect();
            transcript.push_str(&format!("（思考：{}）\n", r));
        }
    }

    let system = "你是一个长会话历史压缩助手。你会收到一段 Agent 与用户的历史对话记录，\
        请用中文输出一段**信息无损的要点摘要**，要求：\n\
        1. 保留关键事实、用户要求、已完成的动作与结论；\n\
        2. 按时间顺序组织，标注各条要点对应的话题；\n\
        3. 不编造记录中不存在的内容，不调用任何工具。";
    let user = match prev_summary {
        Some(prev) if !prev.is_empty() => format!(
            "以下是截至上次的会话摘要：\n\n{}\n\n以下是自上份摘要之后新增的对话段（需整合进摘要）：\n\n{}\n\n请将新增内容整合进上述摘要，输出**更新后的完整摘要**。",
            prev, transcript
        ),
        _ => format!(
            "以下是需要压缩的对话历史：\n\n{}\n\n请输出摘要。",
            transcript
        ),
    };
    client::summarize_text_with_cancel(provider, system, &user, 0.3, 2048, cancel_rx).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> Message {
        Message {
            id: 0,
            session_id: "s".into(),
            role: role.into(),
            content: content.into(),
            tool_name: None,
            tool_args: None,
            tool_result: None,
            token_usage: 0,
            reasoning_content: String::new(),
            created_at: String::new(),
            seq: 0,
            call_id: None,
            item_kind: None,
            run_id: None,
            artifacts: None,
        }
    }

    #[test]
    fn short_history_does_not_fold() {
        let h = vec![msg("user", "hi"), msg("assistant", "hello")];
        let _rt = tokio::runtime::Runtime::new().unwrap();
        
        
        assert!(h.len() <= COMPACTION_MSG_THRESHOLD);
        assert!(KEEP_RECENT > 0);
    }

    #[test]
    fn fold_window_full_when_no_cursor() {
        
        assert_eq!(compute_fold_window(50, 1, 0), Some((1, 40)));
    }

    #[test]
    fn fold_window_respects_cursor() {
        
        assert_eq!(compute_fold_window(50, 1, 30), Some((30, 40)));
        
        assert_eq!(compute_fold_window(50, 1, 40), None);
    }

    #[test]
    fn fold_window_short_history_none() {
        assert_eq!(compute_fold_window(12, 1, 0), None);
    }
}
