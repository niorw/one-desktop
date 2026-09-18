









use crate::agent::tools::memory as memory_files;
use crate::commands::session::SessionState;
use crate::config::load_config;
use crate::llm;
use tauri::{AppHandle, Manager, Runtime};


#[derive(serde::Serialize)]
pub struct MemoryHit {
    pub tier: String,
    pub path: String,
    pub line: usize,
    pub text: String,
}


#[tauri::command]
pub async fn memory_distill<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
) -> Result<String, String> {
    let sm = app.state::<SessionState>();
    let session_mgr = &sm.0;
    let session = session_mgr
        .get_session(&session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "session not found".to_string())?;
    let messages = session_mgr
        .get_messages(&session_id)
        .map_err(|e| e.to_string())?;
    if messages.is_empty() {
        return Err("该会话没有消息，无可蒸馏内容".to_string());
    }

    let config = load_config();
    if config.api_key.is_empty() {
        return Err("API key not configured. Please set it in Settings.".into());
    }
    let provider_name = session_mgr
        .get_setting("provider")
        .unwrap_or_else(|_| "deepseek".to_string());
    
    
    let model = session_mgr
        .get_setting("model")
        .unwrap_or_else(|_| crate::defaults::DEFAULT_MODEL.to_string());
    let provider = llm::create_provider(&provider_name, config.api_key, model);

    
    let mut transcript = String::new();
    for m in &messages {
        let label = match m.role.as_str() {
            "user" => "用户",
            "assistant" => "助手",
            "tool" => "工具结果",
            _ => "系统",
        };
        let snippet: String = m.content.chars().take(240).collect();
        transcript.push_str(&format!("【{}】{}\n", label, snippet));
        if !m.reasoning_content.is_empty() {
            let r: String = m.reasoning_content.chars().take(80).collect();
            transcript.push_str(&format!("（思考：{}）\n", r));
        }
    }
    let system = "你是一个记忆蒸馏助手。你会收到一次 Agent 会话的完整对话记录，\
        请输出一段**项目级记忆要点**，要求：\n\
        1. 只保留值得跨会话记住的事实：项目约定、技术决策、完成的关键动作、用户明确表达的需求与偏好；\n\
        2. 丢弃寒暄、临时状态、已失效的过程信息；\n\
        3. 按话题分组、用 bullet 列表输出，中文，不编造。";
    let user = format!("以下是会话「{}」的记录：\n\n{}", session.title, transcript);
    let digest = llm::client::summarize_text(provider.as_ref(), system, &user, 0.3, 2048)
        .await
        .map_err(|e| format!("蒸馏失败: {}", e))?;

    let entry = format!(
        "\n## 会话「{}」蒸馏（{}）\n{}\n",
        session.title,
        chrono::Local::now().format("%Y-%m-%d %H:%M"),
        digest.trim()
    );
    
    
    let path = match &session.workspace_id {
        Some(id) => memory_files::workspace_project_memory_path(id),
        None => memory_files::project_memory_path(),
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut existing = std::fs::read_to_string(&path).unwrap_or_default();
    existing.push_str(&entry);
    std::fs::write(&path, existing).map_err(|e| format!("写入项目记忆失败: {}", e))?;
    Ok(format!(
        "已蒸馏 {} 条消息并写入项目记忆（{} 字节）。",
        messages.len(),
        digest.len()
    ))
}


#[tauri::command]
pub fn memory_search<R: Runtime>(
    _app: AppHandle<R>,
    query: String,
) -> Result<Vec<MemoryHit>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Err("query is empty".to_string());
    }
    let mut out = Vec::new();
    for (tier, path) in [
        ("user", memory_files::user_memory_path()),
        ("project", memory_files::project_memory_path()),
        ("memory", memory_files::longterm_memory_path()),
    ] {
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for (i, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(&q) {
                out.push(MemoryHit {
                    tier: tier.to_string(),
                    path: path.to_string_lossy().to_string(),
                    line: i + 1,
                    text: line.trim().chars().take(160).collect(),
                });
            }
        }
    }
    Ok(out)
}
