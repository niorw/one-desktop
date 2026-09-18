






use crate::storage::connection::DbConnection;
use serde::Serialize;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};


pub const DEFAULT_WORKSPACE_ID: &str = "default";


pub struct WorkspaceState {
    pub db: Arc<DbConnection>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceDto {
    pub id: String,
    pub name: String,
    pub icon: String,
    
    pub path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    
    pub session_count: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn normalize_ws_id(ws: &Option<String>) -> &str {
    ws.as_deref().unwrap_or(DEFAULT_WORKSPACE_ID)
}


const WORKSPACE_RULES_TPL: &str = "\
# 项目规则

> 由 OneDesktop 自动生成，按需补充。改动会随会话注入 AI 的系统约束。

- 不擅自修改 `.env`、密钥与凭证类文件
- 改动核心逻辑前先阅读 README / 现有相关代码
- 提交前确保通过构建与测试
";


const WORKSPACE_MEMORY_TPL: &str = "\
# 项目记忆

> 由 OneDesktop 维护，沉淀该项目的背景、技术栈、约定与常见坑。

## 技术栈

-

## 约定

-

## 常见坑

-
";


const WORKSPACE_AGENTS_TPL: &str = "\
# AGENTS.md

本目录由 OneDesktop 工作区管理。`.one-desktop/` 承载项目知识库：
- `rules.md` 项目规则（AI 会话约束）
- `memory/PROJECT.md` 项目记忆
- `config.json` 工作区元信息

请勿删除 `.one-desktop/` 目录，否则工作区联动将失效。
";




fn init_workspace_dir(ws_id: &str, name: &str, path: &str) {
    let base = Path::new(path);
    if !base.is_dir() {
        tracing::warn!(target: "onedesktop.workspace", path = %path, "workspace path not a dir, skip .one-desktop init");
        return;
    }
    let dot = base.join(".one-desktop");
    if let Err(e) = fs::create_dir_all(dot.join("memory")) {
        tracing::warn!(target: "onedesktop.workspace", error = %e, "create .one-desktop failed, skip init");
        return;
    }
    let created_at = now_rfc3339();
    let config = json!({
        "id": ws_id,
        "name": name,
        "path": path,
        "created_at": created_at,
    });
    if let Ok(s) = serde_json::to_string_pretty(&config) {
        let _ = fs::write(dot.join("config.json"), s);
    }
    
    let _ = write_if_absent(&dot.join("rules.md"), WORKSPACE_RULES_TPL);
    let _ = write_if_absent(&dot.join("memory").join("PROJECT.md"), WORKSPACE_MEMORY_TPL);
    let _ = write_if_absent(&dot.join("AGENTS.md"), WORKSPACE_AGENTS_TPL);
    tracing::info!(target: "onedesktop.workspace", path = %path, "Initialized .one-desktop knowledge base");
}


fn write_if_absent(path: &Path, content: &str) -> std::io::Result<()> {
    if path.exists() {
        return Ok(());
    }
    fs::write(path, content)
}

fn count_sessions(conn: &rusqlite::Connection, ws: Option<&str>) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM sessions WHERE workspace_id IS ?1",
        rusqlite::params![ws.map(str::to_string)],
        |r| r.get(0),
    )
}

fn row_to_dto(
    conn: &rusqlite::Connection,
    r: &rusqlite::Row,
) -> rusqlite::Result<WorkspaceDto> {
    let id: String = r.get(0)?;
    let ws_filter = if id == DEFAULT_WORKSPACE_ID {
        None
    } else {
        Some(id.clone())
    };
    Ok(WorkspaceDto {
        id,
        name: r.get(1)?,
        icon: r.get(2)?,
        path: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
        session_count: count_sessions(conn, ws_filter.as_deref())?,
    })
}

#[tauri::command]
pub async fn list_workspaces(state: tauri::State<'_, WorkspaceState>) -> Result<Vec<WorkspaceDto>, String> {
    let db = &state.db;
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, icon, path, created_at, updated_at FROM workspaces ORDER BY created_at ASC",
        )?;
        let rows = stmt
            .query_map([], |r| row_to_dto(conn, r))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_workspace(
    state: tauri::State<'_, WorkspaceState>,
    name: String,
    icon: Option<String>,
) -> Result<WorkspaceDto, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("工作区名称不能为空".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_rfc3339();
    let db = &state.db;
    let dto = db
        .with_conn_mut(|conn| {
            conn.execute(
                "INSERT INTO workspaces (id, name, icon, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![id, name, icon.unwrap_or_default(), now, now],
            )?;
            conn.query_row(
                "SELECT id, name, icon, path, created_at, updated_at FROM workspaces WHERE id = ?1",
                rusqlite::params![id],
                |r| row_to_dto(conn, r),
            )
        })
        .map_err(|e| e.to_string())?;
    tracing::info!(target: "onedesktop.workspace", workspace_id = %dto.id, name = %dto.name, "Workspace created");
    Ok(dto)
}



#[tauri::command]
pub async fn create_workspace_with_path(
    state: tauri::State<'_, WorkspaceState>,
    name: String,
    path: String,
) -> Result<WorkspaceDto, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("工作区名称不能为空".into());
    }
    if path.trim().is_empty() {
        return Err("工作区目录不能为空".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_rfc3339();
    let db = &state.db;
    let dto = db
        .with_conn_mut(|conn| {
            conn.execute(
                "INSERT INTO workspaces (id, name, icon, path, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![id, name, "", path, now, now],
            )?;
            conn.query_row(
                "SELECT id, name, icon, path, created_at, updated_at FROM workspaces WHERE id = ?1",
                rusqlite::params![id],
                |r| row_to_dto(conn, r),
            )
        })
        .map_err(|e| e.to_string())?;
    
    init_workspace_dir(&dto.id, &dto.name, &path);
    tracing::info!(
        target: "onedesktop.workspace",
        workspace_id = %dto.id, name = %dto.name, path = %path,
        "Workspace created with path"
    );
    Ok(dto)
}

#[tauri::command]
pub async fn rename_workspace(
    state: tauri::State<'_, WorkspaceState>,
    workspace_id: String,
    name: String,
    icon: Option<String>,
) -> Result<WorkspaceDto, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("工作区名称不能为空".into());
    }
    let db = &state.db;
    db.with_conn_mut(|conn| {
        let n = conn.execute(
            "UPDATE workspaces SET name = ?1, icon = COALESCE(?2, icon), updated_at = ?3 WHERE id = ?4",
            rusqlite::params![name, icon, now_rfc3339(), workspace_id],
        )?;
        if n == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        conn.query_row(
            "SELECT id, name, icon, path, created_at, updated_at FROM workspaces WHERE id = ?1",
            rusqlite::params![workspace_id],
            |r| row_to_dto(conn, r),
        )
    })
    .map_err(|e| e.to_string())
}



#[tauri::command]
pub async fn delete_workspace(
    state: tauri::State<'_, WorkspaceState>,
    workspace_id: String,
    move_to_default: bool,
) -> Result<(), String> {
    if workspace_id == DEFAULT_WORKSPACE_ID {
        return Err("默认工作区不可删除".into());
    }
    let db = &state.db;
    db.with_conn_mut(|conn| {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM workspaces WHERE id = ?1",
            rusqlite::params![workspace_id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        if move_to_default {
            conn.execute(
                "UPDATE sessions SET workspace_id = NULL WHERE workspace_id = ?1",
                rusqlite::params![workspace_id],
            )?;
            conn.execute(
                "UPDATE inspirations SET workspace_id = NULL WHERE workspace_id = ?1",
                rusqlite::params![workspace_id],
            )?;
        } else {
            
            conn.execute(
                "DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?1)",
                rusqlite::params![workspace_id],
            )?;
            conn.execute(
                "DELETE FROM session_summaries WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?1)",
                rusqlite::params![workspace_id],
            )?;
            conn.execute(
                "DELETE FROM sessions WHERE workspace_id = ?1",
                rusqlite::params![workspace_id],
            )?;
            conn.execute(
                "DELETE FROM inspirations WHERE workspace_id = ?1",
                rusqlite::params![workspace_id],
            )?;
        }
        conn.execute(
            "DELETE FROM workspaces WHERE id = ?1",
            rusqlite::params![workspace_id],
        )?;
        Ok(())
    })
    .map_err(|e| e.to_string())?;
    tracing::info!(
        target: "onedesktop.workspace",
        workspace_id = %workspace_id,
        move_to_default,
        "Workspace deleted"
    );
    Ok(())
}



#[tauri::command]
pub async fn list_workspace_files(
    state: tauri::State<'_, WorkspaceState>,
    workspace_id: Option<String>,
) -> Result<Vec<WorkspaceFileDto>, String> {
    let db = &state.db;
    
    let path: Option<String> = db.with_conn(|conn| -> rusqlite::Result<Option<String>> {
        if let Some(ref wid) = workspace_id {
            conn.query_row(
                "SELECT path FROM workspaces WHERE id = ?1",
                rusqlite::params![wid],
                |r| r.get::<_, Option<String>>(0),
            )
        } else {
            conn.query_row(
                "SELECT path FROM workspaces WHERE path IS NOT NULL AND path != '' ORDER BY updated_at DESC LIMIT 1",
                [],
                |r| r.get::<_, Option<String>>(0),
            )
        }
    }).ok().flatten();

    let dir: std::path::PathBuf = match path {
        Some(p) if !p.is_empty() => p.into(),
        _ => return Ok(Vec::new()), 
    };

    let mut entries = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.filter_map(Result::ok).take(200) { 
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel_path = entry.path()
                .strip_prefix(&dir)
                .unwrap_or(entry.path().as_path())
                .to_string_lossy()
                .into_owned();
            
            if name.starts_with('.') { continue; }
            entries.push(WorkspaceFileDto { name, is_dir: meta.is_dir(), path: rel_path });
        }
    }
    
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        }
    });
    Ok(entries)
}

#[derive(Clone, serde::Serialize)]
pub struct WorkspaceFileDto {
    pub name: String,
    pub is_dir: bool,
    pub path: String,
}


#[derive(Clone, serde::Serialize)]
pub struct ModelFileDto {
    
    pub path: String,
    
    pub name: String,
    
    pub size: u64,
    
    pub mtime: i64,
    
    pub mime: String,
}


fn model_file_roots(db: &DbConnection) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = vec![crate::paths::data_dir().join("workspaces")];
    if let Ok(rows) = db.with_conn(|conn| -> rusqlite::Result<Vec<String>> {
        let mut stmt = conn.prepare("SELECT path FROM workspaces WHERE path IS NOT NULL AND path != ''")?;
        let iter = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut v = Vec::new();
        for r in iter {
            if let Ok(p) = r {
                v.push(p);
            }
        }
        Ok(v)
    }) {
        for p in rows {
            roots.push(PathBuf::from(p));
        }
    }
    roots
}


fn model_file_mime(p: &Path) -> String {
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "csv" | "tsv" => "text/csv",
        "md" | "markdown" => "text/markdown",
        "html" | "htm" => "text/html",
        "txt" | "log" => "text/plain",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
    .to_string()
}

const MODEL_FILES_MAX: usize = 500;
const MODEL_FILES_MAX_DEPTH: u32 = 6;


fn walk_model_files(dir: &Path, out: &mut Vec<ModelFileDto>, depth: u32) {
    if depth > MODEL_FILES_MAX_DEPTH {
        return;
    }
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            walk_model_files(&path, out, depth + 1);
        } else {
            if name.starts_with('.') {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                out.push(ModelFileDto {
                    path: path.to_string_lossy().into_owned(),
                    name,
                    size: meta.len(),
                    mtime,
                    mime: model_file_mime(&path),
                });
            }
        }
    }
}





#[tauri::command]
pub async fn list_model_files(
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Vec<ModelFileDto>, String> {
    let roots = model_file_roots(&state.db);
    let mut out = Vec::new();
    for root in roots {
        if root.exists() {
            walk_model_files(&root, &mut out, 0);
        }
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out.truncate(MODEL_FILES_MAX);
    Ok(out)
}


#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub mtime: Option<i64>,
    pub mime: Option<String>,
    pub children: Option<Vec<FileTreeNode>>,
}


fn base_name_of(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string_lossy().into_owned())
}


fn workspace_display_name(db: &DbConnection, path: &Path) -> Option<String> {
    let p = path.to_string_lossy().into_owned();
    db.with_conn(|conn| -> rusqlite::Result<Option<String>> {
        let mut stmt = conn.prepare("SELECT name FROM workspaces WHERE path = ?1")?;
        let mut rows = stmt.query_map([p], |r| r.get::<_, String>(0))?;
        Ok(rows.next().transpose()?)
    })
    .ok()
    .flatten()
}



fn build_file_tree(dir: &Path, depth: u32, cap: &mut usize) -> Option<FileTreeNode> {
    if depth > MODEL_FILES_MAX_DEPTH || *cap == 0 {
        return None;
    }
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return None,
    };
    let mut entries: Vec<_> = rd.filter_map(Result::ok).collect();
    entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    let mut dirs: Vec<FileTreeNode> = Vec::new();
    let mut files: Vec<FileTreeNode> = Vec::new();
    for entry in entries {
        if *cap == 0 {
            break;
        }
        let path = entry.path();
        let ename = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if ename.starts_with('.') || ename == "node_modules" {
                continue;
            }
            if let Some(node) = build_file_tree(&path, depth + 1, cap) {
                
                
                *cap = cap.saturating_sub(1);
                dirs.push(node);
            }
        } else {
            if ename.starts_with('.') {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            *cap = cap.saturating_sub(1);
            files.push(FileTreeNode {
                name: ename,
                path: path.to_string_lossy().into_owned(),
                is_dir: false,
                size: Some(meta.len()),
                mtime: Some(mtime),
                mime: Some(model_file_mime(&path)),
                children: None,
            });
        }
    }
    dirs.append(&mut files);
    Some(FileTreeNode {
        name: base_name_of(dir),
        path: dir.to_string_lossy().into_owned(),
        is_dir: true,
        size: None,
        mtime: None,
        mime: None,
        children: if dirs.is_empty() { None } else { Some(dirs) },
    })
}








#[tauri::command]
pub async fn list_workspace_file_tree(
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Vec<FileTreeNode>, String> {
    let roots = model_file_roots(&state.db);
    let workspaces_root = crate::paths::data_dir().join("workspaces");
    let mut out: Vec<FileTreeNode> = Vec::new();
    let mut cap: usize = 1200;

    for root in roots {
        if !root.exists() {
            continue;
        }
        if root == workspaces_root {
            
            if let Ok(rd) = fs::read_dir(&root) {
                let mut subs: Vec<_> = rd.filter_map(Result::ok).collect();
                subs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
                for sub in subs {
                    let p = sub.path();
                    if !p.is_dir() {
                        continue;
                    }
                    let display = workspace_display_name(&state.db, &p)
                        .unwrap_or_else(|| base_name_of(&p));
                    if let Some(mut node) = build_file_tree(&p, 1, &mut cap) {
                        node.name = display;
                        out.push(node);
                    }
                }
            }
        } else {
            let display = workspace_display_name(&state.db, &root)
                .unwrap_or_else(|| base_name_of(&root));
            if let Some(mut node) = build_file_tree(&root, 0, &mut cap) {
                node.name = display;
                out.push(node);
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    
    
    #[test]
    fn init_workspace_dir_creates_one_desktop_and_is_idempotent() {
        let tmp = std::env::temp_dir().join(format!("od_ws_test_{}", now_ms()));
        fs::create_dir_all(&tmp).unwrap();
        let wid = "ws-unit-test-1";
        let path = tmp.to_str().unwrap();

        init_workspace_dir(wid, "Demo", path);

        let dot = tmp.join(".one-desktop");
        assert!(dot.join("config.json").exists(), "config.json 应生成");
        assert!(dot.join("rules.md").exists(), "rules.md 应生成");
        assert!(dot.join("memory").join("PROJECT.md").exists(), "memory/PROJECT.md 应生成");
        assert!(dot.join("AGENTS.md").exists(), "AGENTS.md 应生成");

        let cfg = fs::read_to_string(dot.join("config.json")).unwrap();
        assert!(cfg.contains(wid), "config.json 应含 workspace id");
        assert!(cfg.contains("Demo"), "config.json 应含 name");
        assert!(cfg.contains(path), "config.json 应含 path");

        
        fs::write(dot.join("rules.md"), "# 用户的自定义规则").unwrap();
        init_workspace_dir(wid, "Demo", path);
        let rules = fs::read_to_string(dot.join("rules.md")).unwrap();
        assert_eq!(rules, "# 用户的自定义规则", "已有 rules.md 不应被覆盖");

        
        fs::write(dot.join("memory").join("PROJECT.md"), "# 项目记忆\n- 技术栈：Rust\n").unwrap();
        init_workspace_dir(wid, "Demo", path);
        let mem = fs::read_to_string(dot.join("memory").join("PROJECT.md")).unwrap();
        assert!(mem.contains("Rust"), "已有的 PROJECT.md 不应被清空");

        let _ = fs::remove_dir_all(&tmp);
    }

    
    #[test]
    fn init_workspace_dir_skips_non_dir() {
        let tmp = std::env::temp_dir().join(format!("od_ws_test_file_{}", now_ms()));
        fs::write(&tmp, "not a dir").unwrap();

        init_workspace_dir("ws-unit-x", "X", tmp.to_str().unwrap());
        assert!(!tmp.join(".one-desktop").exists(), "非目录不应生成 .one-desktop");

        let _ = fs::remove_file(&tmp);
    }
}
