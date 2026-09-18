


use crate::commands::session::SessionState;
use crate::commands::workspace::WorkspaceState;
use crate::config::load_config;
use crate::llm;
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Clone, Serialize)]
pub struct InspirationDto {
    pub id: String,
    pub workspace_id: Option<String>,
    pub content: String,
    pub tags: Vec<String>,
    pub created_at: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn parse_tags_json(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}


#[tauri::command]
pub async fn list_inspirations(
    state: tauri::State<'_, WorkspaceState>,
    workspace_id: Option<String>,
) -> Result<Vec<InspirationDto>, String> {
    let db = &state.db;
    db.with_conn(|conn| {
        let mut stmt = conn.prepare("SELECT id, workspace_id, content, tags, created_at FROM inspirations ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], row_map)?;
        let mut all: Vec<InspirationDto> = rows.filter_map(|r| r.ok()).collect();
        drop(stmt);
        
        if workspace_id.as_deref() != Some("__all__") {
            all.retain(|i| i.workspace_id.as_deref() == workspace_id.as_deref());
        }
        Ok(all)
    })
    .map_err(|e| e.to_string())
}

fn row_map(row: &rusqlite::Row) -> rusqlite::Result<InspirationDto> {
    Ok(InspirationDto {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        content: row.get(2)?,
        tags: parse_tags_json(&row.get::<_, String>(3)?),
        created_at: row.get(4)?,
    })
}

#[tauri::command]
pub async fn create_inspiration(
    state: tauri::State<'_, WorkspaceState>,
    content: String,
    tags: Vec<String>,
    workspace_id: Option<String>,
) -> Result<InspirationDto, String> {
    let text = content.trim().to_string();
    if text.is_empty() {
        return Err("灵感内容不能为空".into());
    }
    let id = format!("insp_{}_{}", now_ms(), uuid::Uuid::new_v4().simple());
    let created_at = now_ms();
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());
    let db = &state.db;
    db.with_conn_mut(|conn| {
        conn.execute(
            "INSERT INTO inspirations (id, workspace_id, content, tags, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, workspace_id, text, tags_json, created_at],
        )?;
        Ok(())
    })
    .map_err(|e| e.to_string())?;
    tracing::info!(target: "onedesktop.inspiration", inspiration_id = %id, "Inspiration created");
    Ok(InspirationDto {
        id,
        workspace_id,
        content: text,
        tags,
        created_at,
    })
}

#[tauri::command]
pub async fn delete_inspiration(
    state: tauri::State<'_, WorkspaceState>,
    inspiration_id: String,
) -> Result<(), String> {
    let db = &state.db;
    db.with_conn_mut(|conn| {
        conn.execute(
            "DELETE FROM inspirations WHERE id = ?1",
            rusqlite::params![inspiration_id],
        )?;
        Ok(())
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn suggest_inspiration_tags<R: Runtime>(
    app: AppHandle<R>,
    content: String,
) -> Result<Vec<String>, String> {
    let config = load_config();
    if config.api_key.is_empty() {
        return Ok(vec![]);
    }
    let sm = app.state::<SessionState>();
    let provider_name = sm
        .0
        .get_setting("provider")
        .unwrap_or_else(|_| "deepseek".to_string());
    let model = sm
        .0
        .get_setting("model")
        .unwrap_or_else(|_| crate::defaults::DEFAULT_MODEL.to_string());
    let provider = llm::create_provider(&provider_name, config.api_key, model);

    
    let clipped: String = content.chars().take(2000).collect();
    let system = "你是标签生成助手。根据用户输入的灵感笔记内容，生成 1 到 3 个简洁的标签词（中文或英文，每个不超过 6 个字/词），用于后续分类检索。\n规则：\n1. 只输出标签本身，用中文逗号或英文逗号分隔，不要序号、不要解释、不要引号、不要 # 号；\n2. 标签应概括内容的核心主题、领域或类型（如：产品、技术、设计、复盘、灵感）；\n3. 若内容完全无法归纳，输出空字符串。";
    let user = format!("内容：{}", clipped);
    let raw = match llm::client::summarize_text(provider.as_ref(), system, &user, 0.2, 64).await {
        Ok(s) => s,
        Err(_) => return Ok(vec![]),
    };
    let tags: Vec<String> = raw
        .split(|c| c == ',' || c == '，' || c == '\n' || c == '、' || c == ';' || c == '；')
        .map(|s| s.trim().trim_start_matches('#').trim().to_string())
        .filter(|s| {
            let n = s.chars().count();
            !s.is_empty() && n >= 1 && n <= 8
        })
        .take(3)
        .collect();
    Ok(tags)
}
