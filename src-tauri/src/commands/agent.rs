

use crate::agent::approval::{ApprovalDecision, ProposalDecision, proposal_broker};
use crate::agent::engine::{AgentLoopEngine, RunRequest};
use crate::agent::ledger::RunKind;
use crate::agent::ports::{RunObserver, TauriObserver};
use crate::types::AgentEvent;
use tauri::Emitter;
use crate::agent::toolplane::ToolPlane;
use crate::commands::session::SessionState;
use crate::commands::workspace::WorkspaceState;
use crate::config::load_config;
use crate::llm;
use crate::paths;
use crate::llm::providers::deepseek::ThinkingMode;
use crate::storage::connection::DbConnection;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, State};

pub struct AgentState {
    pub engine: Arc<AgentLoopEngine>,
}



pub struct ToolPlaneState(pub Arc<dyn ToolPlane>);



pub(crate) async fn resolve_workspace_root(db: &DbConnection, session_id: &str) -> Option<PathBuf> {
    
    let ws_id: Option<String> = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT workspace_id FROM sessions WHERE id = ?1",
                [session_id],
                |r| r.get::<usize, Option<String>>(0),
            )
        })
        .ok()
        .flatten();
    let ws_id = ws_id.filter(|id| id != "default")?;
    
    let path = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT path FROM workspaces WHERE id = ?1",
                [ws_id],
                |r| r.get::<usize, Option<String>>(0),
            )
        })
        .ok()
        .flatten()?;
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return None;
    }
    Some(root)
}




pub(crate) fn default_session_root(session_id: &str) -> PathBuf {
    let safe: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let root = paths::data_dir().join("workspaces").join(safe);
    let _ = std::fs::create_dir_all(&root);
    root
}



pub(crate) fn append_workspace_knowledge(preamble: &str, root: &Path) -> String {
    let mut extra = String::new();
    let rules = root.join(".one-desktop").join("rules.md");
    if let Ok(s) = fs::read_to_string(&rules) {
        let s = s.trim();
        if !s.is_empty() {
            extra.push_str("\n\n# 项目规则（来自工作区 .one-desktop/rules.md，作为本会话约束）\n\n");
            extra.push_str(s);
        }
    }
    let mem = root.join(".one-desktop").join("memory").join("PROJECT.md");
    if let Ok(s) = fs::read_to_string(&mem) {
        let s = s.trim();
        if !s.is_empty() {
            extra.push_str("\n\n# 项目记忆（来自工作区 .one-desktop/memory/PROJECT.md）\n\n");
            extra.push_str(s);
        }
    }
    if extra.is_empty() {
        preamble.to_string()
    } else {
        format!("{}\n{}", preamble, extra)
    }
}


fn human_size(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} B", bytes)
    } else {
        format!("{:.1} {}", size, UNITS[unit])
    }
}







fn workspace_contents_snapshot(root: &Path) -> String {
    const LIMIT: usize = 60;
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("pwd: {}", root.display()));
    match fs::read_dir(root) {
        Ok(mut entries) => {
            let mut items: Vec<(String, bool, u64)> = Vec::new();
            let mut total: u64 = 0;
            while let Some(Ok(e)) = entries.next() {
                total += 1;
                let is_dir = e.path().is_dir();
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                let name = e.file_name().to_string_lossy().into_owned();
                items.push((name, is_dir, size));
            }
            items.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            for (name, is_dir, size) in items.iter().take(LIMIT) {
                if *is_dir {
                    lines.push(format!("- {}/        (dir)", name));
                } else {
                    lines.push(format!("- {} (file, {})", name, human_size(*size)));
                }
            }
            if total > LIMIT as u64 {
                lines.push(format!("... ({} more entries hidden)", total - LIMIT as u64));
            } else if total == 0 {
                lines.push("(empty directory)".to_string());
            }
        }
        Err(e) => {
            lines.push(format!("(unable to read directory: {})", e));
        }
    }
    format!(
        "\n\n[Workspace Contents] Live snapshot of your working directory (pwd + ls):\n{}",
        lines.join("\n")
    )
}


#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    agent_state: State<'_, AgentState>,
    session_state: State<'_, SessionState>,
    ws_state: State<'_, WorkspaceState>,
    session_id: String,
    content: String,
) -> Result<(), crate::error::AgentError> {
    let mut _g = crate::commands::CmdLog::begin("send_message", &[
        ("session_id", session_id.clone()),
        ("content_len", content.len().to_string()),
    ]);
    let session_mgr = &session_state.0;

    let config = load_config();
    let api_key = config.api_key;

    let provider_name = session_mgr
        .get_setting("provider")
        .unwrap_or_else(|_| "deepseek".into());
    let model = session_mgr
        .get_setting("model")
        .unwrap_or_else(|_| crate::defaults::DEFAULT_MODEL.into());
    let preamble = session_mgr.get_setting("preamble").unwrap_or_default();
    
    let workspace_root = resolve_workspace_root(&ws_state.db, &session_id).await;
    let preamble = match &workspace_root {
        Some(root) => append_workspace_knowledge(&preamble, root),
        None => preamble,
    };
    
    
    
    
    let effective_root = match workspace_root {
        Some(r) => r,
        None => default_session_root(&session_id),
    };
    
    let tmp_root = paths::session_tmp_root(&session_id);
    let mut ws_note = format!(
        "\n\n[Workspace] Your default working directory is: {}\n\
         Use relative paths for file operations so your outputs land there. \
         If the user asks you to save files to a specific location (an absolute path), write there instead.\n\
         [Temp] Temporary / intermediate / scratch files go under: {} (per-session). \
         Prefer it over the system /tmp so cleanup is contained.",
        effective_root.display(),
        tmp_root.display()
    );
    
    ws_note.push_str(&workspace_contents_snapshot(&effective_root));
    let preamble = format!("{}{}", preamble, ws_note);
    let temperature: f64 = session_mgr
        .get_setting("temperature")
        .unwrap_or_else(|_| "0.7".into())
        .parse()
        .unwrap_or(0.7);
    let max_tokens: u32 = session_mgr
        .get_setting("max_tokens")
        .unwrap_or_else(|_| "0".into())
        .parse()
        .unwrap_or(0);
    let max_iterations: u32 = session_mgr
        .get_setting("max_iterations")
        .unwrap_or_else(|_| "20".into())
        .parse()
        .unwrap_or(20);
    let token_budget: u64 = session_mgr
        .get_setting("token_budget")
        .unwrap_or_else(|_| "100000".into())
        .parse()
        .unwrap_or(100000);
    let thinking_mode_raw = session_mgr
        .get_setting("thinking_mode")
        .unwrap_or_default();
    
    
    let history_len = session_mgr
        .get_messages(&session_id)
        .map(|m| m.len())
        .unwrap_or(0);
    let thinking = ThinkingMode::from_setting(&thinking_mode_raw).resolve_auto(&content, history_len);

    
    
    
    let custom = if provider_name == "custom" {
        let d = llm::custom_defaults_from_settings(
            &session_mgr.get_setting("custom_base_url").unwrap_or_default(),
            &session_mgr.get_setting("token_config").unwrap_or_default(),
            &session_mgr.get_setting("reasoning_dialect").unwrap_or_default(),
        );
        
        llm::set_custom_provider_defaults(d.clone());
        d
    } else {
        llm::CustomProviderDefaults::default()
    };
    
    llm::set_global_provider_name(&session_mgr.get_setting("provider").unwrap_or_default());

    if api_key.is_empty() {
        return Err(crate::error::AgentError::Config {
            message: "API key 未配置，请在设置中填写".into(),
        });
    }

    tracing::info!(
        target: "onedesktop.commands.agent",
        session_id = %session_id,
        content_len = content.len(),
        provider = %provider_name,
        model = %model,
        max_iterations = max_iterations,
        token_budget = token_budget,
        thinking = ?thinking,
        "send_message invoked"
    );

    let provider = llm::create_provider_full(
        &provider_name,
        api_key,
        model.clone(),
        thinking,
        custom.base_url,
        custom.token_config,
        custom.dialect,
    );

    let observer: Arc<dyn RunObserver> = Arc::new(TauriObserver::new(app.clone()));
    let outcome = agent_state
        .engine
        .clone()
        .run_guarded(
            observer,
            RunRequest {
                session_id: session_id.clone(),
                user_message: content.clone(),
                provider,
                preamble: preamble.clone(),
                temperature,
                max_tokens_per_call: max_tokens,
                max_iterations: Some(max_iterations),
                token_budget: Some(token_budget),
                
                
                workspace_root: Some(effective_root.clone()),
                auto_approve_override: None,
                trace_id: None,
                kind: RunKind::Chat,
                group_id: None,
                seat_id: None,
                model: Some(model.clone()),
                tool_scope: None,
                session_kind: crate::agent::permission::SessionKind::User,
                
                resume: None,
                task_id: None,
            },
        )
        .await;

    
    
    let artifacts_json =
        serde_json::to_string(&outcome.written_files).unwrap_or_else(|_| "[]".to_string());
    if let Err(e) = agent_state
        .engine
        .session_manager()
        .backfill_run_artifacts(&session_id, &outcome.run_id, &artifacts_json)
    {
        tracing::warn!(
            target: "onedesktop.agent",
            session_id = %session_id,
            run_id = %outcome.run_id,
            "backfill run artifacts failed: {e}"
        );
    }

    
    
    
    
    let artifact_event = AgentEvent::RunArtifacts {
        seq: None,
        session_id: session_id.clone(),
        run_id: outcome.run_id.clone(),
        artifacts: outcome.written_files.clone(),
    };
    if let Ok(payload) = serde_json::to_value(&artifact_event) {
        let _ = app.emit("agent-event", payload);
    }

    Ok(())
}





#[tauri::command]
pub async fn decide_approval(
    agent_state: State<'_, AgentState>,
    approval_id: String,
    action: String,
    args: Option<serde_json::Value>,
    feedback: Option<String>,
) -> Result<(), String> {
    let mut _g = crate::commands::CmdLog::begin("decide_approval", &[
        ("approval_id", approval_id.clone()),
        ("action", action.clone()),
    ]);
    let decision = match action.as_str() {
        "accept" => ApprovalDecision::Accept,
        "edit" => match args {
            Some(a) => ApprovalDecision::Edit { args: a },
            None => return Err("decide_approval: action=edit requires args".into()),
        },
        "respond" => match feedback {
            Some(f) => ApprovalDecision::Respond { feedback: f },
            None => return Err("decide_approval: action=respond requires feedback".into()),
        },
        "ignore" => ApprovalDecision::Ignore,
        other => return Err(format!("decide_approval: unknown action '{}'", other)),
    };
    agent_state
        .engine
        .decide_approval(&approval_id, decision)
        .await
        .map_err(|e| e.to_string())
}



#[tauri::command]
pub async fn decide_approval_batch(
    agent_state: State<'_, AgentState>,
    ids: Vec<String>,
    action: String,
    args: Option<serde_json::Value>,
    feedback: Option<String>,
) -> Result<Vec<String>, String> {
    let decision = match action.as_str() {
        "accept" => ApprovalDecision::Accept,
        "edit" => match args {
            Some(a) => ApprovalDecision::Edit { args: a },
            None => return Err("decide_approval_batch: action=edit requires args".into()),
        },
        "respond" => match feedback {
            Some(f) => ApprovalDecision::Respond { feedback: f },
            None => return Err("decide_approval_batch: action=respond requires feedback".into()),
        },
        "ignore" => ApprovalDecision::Ignore,
        other => return Err(format!("decide_approval_batch: unknown action '{}'", other)),
    };
    Ok(agent_state
        .engine
        .decide_approval_batch(&ids, decision)
        .await)
}





#[tauri::command]
pub async fn decide_proposal(
    proposal_id: String,
    decision: String,
    option_id: Option<String>,
    custom_text: Option<String>,
) -> Result<(), String> {
    let _g = crate::commands::CmdLog::begin("decide_proposal", &[
        ("proposal_id", proposal_id.clone()),
        ("decision", decision.clone()),
    ]);
    let d = match decision.as_str() {
        "selected" => match option_id {
            Some(id) => ProposalDecision::Selected { option_id: id },
            None => return Err("decide_proposal: selected requires option_id".into()),
        },
        "custom" => match custom_text {
            Some(t) => ProposalDecision::Custom { text: t },
            None => return Err("decide_proposal: custom requires custom_text".into()),
        },
        "rejected" => ProposalDecision::Rejected,
        other => return Err(format!("decide_proposal: unknown decision '{}'", other)),
    };
    proposal_broker()
        .decide(&proposal_id, d)
        .await
        .map_err(|e| e.to_string())
}


#[tauri::command]
pub async fn exempt_tool_for_session(
    agent_state: State<'_, AgentState>,
    session_id: String,
    tool: String,
) -> Result<(), String> {
    agent_state.engine.exempt_tool_for_session(&session_id, &tool);
    Ok(())
}



#[deprecated(note = "use decide_approval with approval_id（四态）")]
#[allow(deprecated)] 
#[tauri::command]
pub async fn approve_tool(
    agent_state: State<'_, AgentState>,
    session_id: String,
    approved: bool,
) -> Result<(), String> {
    let found = agent_state.engine.approve_tool(&session_id, approved).await;
    if !found {
        return Err("No pending approval for this session".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn set_auto_approve(
    agent_state: State<'_, AgentState>,
    enabled: bool,
) -> Result<(), String> {
    *agent_state.engine.auto_approve.lock().unwrap() = enabled;
    Ok(())
}

#[tauri::command]
pub async fn list_tool_permissions(
    session_state: State<'_, SessionState>,
) -> Result<Vec<crate::agent::permission::ToolPermission>, String> {
    session_state
        .0
        .list_tool_permissions()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_tool_permission(
    session_state: State<'_, SessionState>,
    tool_name: String,
    scope: String,
    action: String,
) -> Result<(), String> {
    let action: crate::agent::permission::Permission =
        serde_json::from_str(&format!("\"{}\"", action)).map_err(|e| e.to_string())?;
    session_state
        .0
        .set_tool_permission(&tool_name, &scope, &action)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reset_tool_permissions(session_state: State<'_, SessionState>) -> Result<(), String> {
    session_state
        .0
        .reset_tool_permissions()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_tool_permission(
    session_state: State<'_, SessionState>,
    tool_name: String,
    scope: String,
) -> Result<(), String> {
    session_state
        .0
        .clear_tool_permission(&tool_name, &scope)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_agent(
    agent_state: State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    agent_state.engine.cancel(&session_id).await;
    Ok(())
}




#[tauri::command]
pub async fn steer_agent(
    agent_state: State<'_, AgentState>,
    session_id: String,
    text: String,
) -> Result<bool, String> {
    Ok(agent_state.engine.steer(&session_id, text).await)
}
