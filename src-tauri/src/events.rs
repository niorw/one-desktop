






use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Debug, Clone, Serialize)]
pub struct EventEnvelope {
    
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    
    pub payload: serde_json::Value,
}


pub fn emit_envelope<R: Runtime>(
    app: &AppHandle<R>,
    legacy_channel: &str,
    r#type: &str,
    session_id: Option<&str>,
    group_id: Option<&str>,
    payload: serde_json::Value,
) {
    let env = EventEnvelope {
        r#type: r#type.to_string(),
        session_id: session_id.map(|s| s.to_string()),
        group_id: group_id.map(|g| g.to_string()),
        payload: payload.clone(),
    };
    let _ = app.emit("onedesktop-event", &env);
    let _ = app.emit(legacy_channel, &payload);
}
