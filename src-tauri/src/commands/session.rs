




use crate::session::manager::SessionManager;
use crate::storage::trace_repo::TraceRow;
use crate::types::{MessageDto, SessionDto, TraceDto};
use std::sync::Arc;
use tauri::State;


pub struct SessionState(pub Arc<SessionManager>);

#[tauri::command]
pub async fn create_session(
    state: State<'_, SessionState>,
    title: String,
    model: String,
    preamble: String,
    workspace_id: Option<String>,
) -> Result<SessionDto, String> {
    let mgr = &state.0;
    let session = mgr
        .create_session(title, model, preamble, workspace_id)
        .map_err(|e| e.to_string())?;
    Ok(SessionDto {
        id: session.id,
        title: session.title,
        model: session.model,
        preamble: session.preamble,
        created_at: session.created_at,
        updated_at: session.updated_at,
        mode: session.mode,
        group_id: session.group_id,
        workspace_id: session.workspace_id,
    })
}

#[tauri::command]
pub async fn get_session(
    state: State<'_, SessionState>,
    session_id: String,
) -> Result<Option<SessionDto>, String> {
    let mgr = &state.0;
    let session = mgr.get_session(&session_id).map_err(|e| e.to_string())?;
    Ok(session.map(|s| SessionDto {
        id: s.id,
        title: s.title,
        model: s.model,
        preamble: s.preamble,
        created_at: s.created_at,
        updated_at: s.updated_at,
        mode: s.mode,
        group_id: s.group_id,
        workspace_id: s.workspace_id,
    }))
}

#[tauri::command]
pub async fn list_sessions(state: State<'_, SessionState>) -> Result<Vec<SessionDto>, String> {
    let mgr = &state.0;
    let sessions = mgr.list_sessions().map_err(|e| e.to_string())?;
    Ok(sessions
        .into_iter()
        .map(|s| SessionDto {
            id: s.id,
            title: s.title,
            model: s.model,
            preamble: s.preamble,
            created_at: s.created_at,
            updated_at: s.updated_at,
            mode: s.mode,
            group_id: s.group_id,
            workspace_id: s.workspace_id,
        })
        .collect())
}

#[tauri::command]
pub async fn delete_session(
    state: State<'_, SessionState>,
    session_id: String,
) -> Result<(), String> {
    let mgr = &state.0;
    mgr.delete_session(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_messages(
    state: State<'_, SessionState>,
    session_id: String,
) -> Result<Vec<MessageDto>, String> {
    let mgr = &state.0;
    let messages = mgr.get_messages(&session_id).map_err(|e| e.to_string())?;
    Ok(messages
        .into_iter()
        .map(|m| MessageDto {
            id: m.id,
            session_id: m.session_id,
            role: m.role,
            content: m.content,
            tool_name: m.tool_name,
            tool_args: m.tool_args,
            tool_result: m.tool_result,
            token_usage: m.token_usage,
            reasoning_content: m.reasoning_content,
            created_at: m.created_at,
            seq: m.seq,
            call_id: m.call_id,
            item_kind: m.item_kind,
        })
        .collect())
}

#[tauri::command]
pub async fn get_setting(state: State<'_, SessionState>, key: String) -> Result<String, String> {
    let mgr = &state.0;
    mgr.get_setting(&key).map_err(|e| e.to_string())
}



#[tauri::command]
pub async fn get_trace(
    state: State<'_, SessionState>,
    session_id: String,
) -> Result<Vec<TraceDto>, String> {
    let mgr = &state.0;
    let rows: Vec<TraceRow> = mgr.get_trace(&session_id).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| TraceDto {
            id: r.id,
            session_id: r.session_id,
            scene: r.scene,
            agent_type: r.agent_type,
            kind: r.kind,
            name: r.name,
            seq: r.seq,
            call_id: r.call_id,
            parent_id: r.parent_id,
            content: r.content,
            args: r.args,
            result: r.result,
            reasoning: r.reasoning,
            is_error: r.is_error,
            started_at: r.started_at,
            ended_at: r.ended_at,
            created_at: r.created_at,
        })
        .collect())
}

#[tauri::command]
pub async fn set_setting(
    state: State<'_, SessionState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let mgr = &state.0;
    mgr.set_setting(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn has_active_run(
    state: State<'_, SessionState>,
    session_id: String,
) -> Result<bool, String> {
    let mgr = &state.0;
    mgr.has_active_run(&session_id).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ActiveRunDto {
    pub run_id: String,
    pub session_id: String,
    pub kind: String,
    pub started_at: i64,
}

#[tauri::command]
pub async fn list_active_runs(
    state: State<'_, SessionState>,
) -> Result<Vec<ActiveRunDto>, String> {
    let mgr = &state.0;
    let rows = mgr.list_active_runs().map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| ActiveRunDto {
            run_id: r.run_id,
            session_id: r.session_id,
            kind: r.kind,
            started_at: r.started_at,
        })
        .collect())
}
