









use crate::commands::group::GroupState;
use crate::commands::session::SessionState;
use crate::config::load_config;
use crate::group::manager::GroupManager;
use crate::group::roundtable_repo::{RoundtableMessage, RoundtableRepository};
use crate::group::scheduler::TaskScheduler;
use crate::group::task_board::SubTask;
use crate::group::{CreateGroupPayload, Group, GroupKind};
use std::sync::Arc;
use crate::llm;
use crate::llm::json_repair::repair_json;
use crate::session::manager::SessionManager;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuggestedSeat {
    pub name: String,
    
    pub capability: String,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuggestedTask {
    pub description: String,
    
    #[serde(default)]
    pub depends_on: Vec<String>,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpgradeProposal {
    pub title: String,
    pub goal: String,
    #[serde(default)]
    pub seats: Vec<SuggestedSeat>,
    #[serde(default)]
    pub tasks: Vec<SuggestedTask>,
    
    #[serde(default)]
    pub est_calls: u32,
    
    #[serde(default)]
    pub est_tokens: u32,
}

const PROPOSE_SYSTEM: &str = "你是 OneDesktop 的群协作规划器。根据用户提供的单聊对话，输出一个 JSON 对象（纯 JSON，不要 Markdown 代码块，不要任何解释）：
{
  \"title\": \"群名（≤20字）\",
  \"goal\": \"协作目标（一句话）\",
  \"seats\": [{\"name\": \"席位名\", \"capability\": \"该席位擅长什么（一句话）\"}],
  \"tasks\": [{\"description\": \"子任务\", \"depends_on\": [\"前序子任务的 description 原文\"]}],
  \"est_calls\": 预估完成该协作需要的 LLM 调用次数（整数）,
  \"est_tokens\": 预估总 token 数（整数）
}
要求：seats 建议 2-4 个、能力互补；tasks 拆解 2-5 个并给出依赖；title/goal 贴合对话主题。";


fn build_transcript(session_mgr: &SessionManager, session_id: &str) -> String {
    let msgs = session_mgr.get_messages(session_id).unwrap_or_default();
    let mut out = String::new();
    let mut total = 0usize;
    for m in msgs.iter().rev().take(40) {
        let role = match m.role.as_str() {
            "user" => "用户",
            "assistant" => "助手",
            _ => "系统",
        };
        let text: String = m.content.chars().take(400).collect();
        let line = format!("{}: {}\n", role, text);
        total += line.len();
        if total > 8_000 {
            break;
        }
        out.insert_str(0, &line);
    }
    if out.is_empty() {
        "(对话为空)".to_string()
    } else {
        out
    }
}


#[tauri::command]
pub async fn session_upgrade_propose<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
) -> Result<UpgradeProposal, String> {
    let mut _g = crate::commands::CmdLog::begin("session_upgrade_propose", &[
        ("session_id", session_id.clone()),
    ]);
    let sm = app.state::<SessionState>();
    let session_mgr = &sm.0;
    let session = session_mgr
        .get_session(&session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "session not found".to_string())?;

    let config = load_config();
    if config.api_key.is_empty() {
        return Err("API key not configured. Please set it in Settings.".into());
    }
    let provider_name = session_mgr
        .get_setting("provider")
        .unwrap_or_else(|_| "deepseek".into());
    
    
    let model = session_mgr
        .get_setting("model")
        .unwrap_or_else(|_| crate::defaults::DEFAULT_MODEL.into());
    let provider = llm::create_provider(&provider_name, config.api_key, model);

    let transcript = build_transcript(session_mgr, &session_id);
    let user = format!(
        "单聊标题：{}\n\n对话内容：\n{}\n\n请输出 JSON。",
        session.title, transcript
    );

    let raw = llm::client::summarize_text(provider.as_ref(), PROPOSE_SYSTEM, &user, 0.3, 2048)
        .await
        .map_err(|e| format!("升级建议生成失败: {}", e))?;

    
    let parsed = serde_json::from_str::<UpgradeProposal>(&raw).unwrap_or_else(|_| {
        serde_json::from_str::<UpgradeProposal>(&repair_json(&raw)).unwrap_or_else(|_| {
            UpgradeProposal {
                title: session.title.clone(),
                goal: String::new(),
                seats: vec![],
                tasks: vec![],
                est_calls: 0,
                est_tokens: 0,
            }
        })
    });
    Ok(parsed)
}






#[tauri::command]
pub async fn session_confirm_upgrade<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    title: String,
    goal: String,
    owner_agent_ref: String,
    seat_refs: Vec<String>,
    tasks: Vec<SubTask>,
) -> Result<Group, String> {
    let mut _g = crate::commands::CmdLog::begin("session_confirm_upgrade", &[
        ("session_id", session_id.clone()),
        ("title", title.clone()),
        ("seat_count", seat_refs.len().to_string()),
        ("task_count", tasks.len().to_string()),
    ]);
    let gs = app.state::<GroupState>();
    let db = gs.db.clone();
    let sm = app.state::<SessionState>();
    let session_mgr = &sm.0;

    let session = session_mgr
        .get_session(&session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "session not found".to_string())?;

    
    let group = GroupManager::new(db.clone()).create_group(CreateGroupPayload {
        name: if title.trim().is_empty() {
            session.title.clone()
        } else {
            title
        },
        goal,
        owner_agent_ref,
        seat_config: serde_json::json!({ "static": seat_refs }),
        kind: GroupKind::Chat,
    })?;

    
    
    let transcript = build_transcript(session_mgr, &session_id);
    let seed_msg = RoundtableMessage {
        seq: 0,
        group_id: group.id.clone(),
        author: String::new(),
        worker_id: String::new(),
        author_kind: "system".into(),
        content: format!("[会话上下文]（由单聊升级带入，作为协作起点）：\n{}", transcript),
        mentions: vec![],
        attachments: vec![],
        created_at: crate::agent::ledger::now_unix_ms(),
        session_id: String::new(),
    };
    if let Ok(seq) = RoundtableRepository::new(db.as_ref()).create(&seed_msg) {
        let _ = app.emit("roundtable-message", &RoundtableMessage { seq, ..seed_msg });
    }

    
    if !tasks.is_empty() {
        let batch_id = format!("batch_{}", uuid::Uuid::new_v4().simple());
        let scheduler = app.state::<Arc<TaskScheduler>>();
        let _ = scheduler.inner().clone().submit_batch(&group.id, &batch_id, tasks, true).await;
    }

    
    session_mgr
        .set_session_mode(&session_id, Some("group"), Some(group.id.as_str()))
        .map_err(|e| e.to_string())?;

    Ok(group)
}


#[tauri::command]
pub async fn session_fold_to_chat<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
) -> Result<(), String> {
    let mut _g = crate::commands::CmdLog::begin("session_fold_to_chat", &[
        ("session_id", session_id.clone()),
    ]);
    let sm = app.state::<SessionState>();
    sm.0.set_session_mode(&session_id, None, None)
        .map_err(|e| e.to_string())
}
