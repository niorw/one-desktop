










use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::commands::workspace::WorkspaceState;


#[derive(Debug, Serialize)]
pub struct ArtifactText {
    
    pub content: String,
    
    pub size: u64,
}


#[derive(Debug, Serialize)]
pub struct ArtifactBytes {
    
    pub mime: String,
    
    pub data: String,
    
    pub size: u64,
}



fn allowed_roots(state: &WorkspaceState) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = vec![crate::paths::data_dir().join("workspaces")];
    
    
    
    if let Ok(cwd) = std::env::current_dir() {
        if !roots.contains(&cwd) {
            roots.push(cwd);
        }
    }
    if let Ok(rows) = state.db.with_conn(|conn| -> rusqlite::Result<Vec<String>> {
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




fn recorded_artifact_files(state: &WorkspaceState) -> Vec<PathBuf> {
    state
        .db
        .with_conn(|conn| -> rusqlite::Result<Vec<String>> {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT file FROM changeset WHERE file IS NOT NULL AND file != ''",
            )?;
            let iter = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(iter.filter_map(Result::ok).collect())
        })
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .collect()
}







fn assert_allowed(path: &str, roots: &[PathBuf], recorded_files: &[PathBuf]) -> Result<PathBuf, String> {
    let raw = Path::new(path);
    let candidates: Vec<PathBuf> = if raw.is_absolute() {
        vec![raw.to_path_buf()]
    } else {
        roots.iter().map(|root| root.join(raw)).collect()
    };

    let mut inaccessible = None;
    for raw_candidate in candidates {
        let candidate = match raw_candidate.canonicalize() {
            Ok(candidate) => candidate,
            Err(error) => {
                inaccessible = Some(error);
                continue;
            }
        };
        let cand = candidate.to_string_lossy();
        if recorded_files.iter().any(|recorded| {
            recorded
                .canonicalize()
                .map(|p| p == candidate)
                .unwrap_or(false)
        }) {
            return Ok(candidate);
        }
        for root in roots {
            let root_canon = root.canonicalize().unwrap_or_else(|_| root.clone());
            let root_str = root_canon.to_string_lossy();
            
            let with_sep = format!("{}{}", root_str, std::path::MAIN_SEPARATOR);
            if cand.starts_with(with_sep.as_str()) || cand == root_str {
                return Ok(candidate);
            }
        }
    }

    if let Some(error) = inaccessible {
        return Err(format!("文件不可访问：{}", error));
    }
    Err("拒绝访问：路径不在工作区范围内".into())
}


fn mime_for(p: &Path) -> String {
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    };
    mime.to_string()
}


fn base64_encode(input: &[u8]) -> String {
    const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[((n >> 18) & 63) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

const MAX_BYTES: u64 = 50 * 1024 * 1024;











#[tauri::command]
pub fn artifact_read_text(
    state: State<'_, WorkspaceState>,
    path: String,
    session_id: Option<String>,
) -> Result<ArtifactText, String> {
    let canon = resolve_with_basename_fallback(&state, &path, session_id.as_deref())?;
    let meta = fs::metadata(&canon).map_err(|e| format!("读取失败：{}", e))?;
    let size = meta.len();
    if size > MAX_BYTES {
        return Err(format!("文件过大（{} 字节），请用系统程序打开", size));
    }
    let content = fs::read_to_string(&canon).map_err(|e| format!("读取内容失败：{}", e))?;
    Ok(ArtifactText { content, size })
}







#[tauri::command]
pub fn artifact_read_base64(
    state: State<'_, WorkspaceState>,
    path: String,
    session_id: Option<String>,
) -> Result<ArtifactBytes, String> {
    let canon = resolve_with_basename_fallback(&state, &path, session_id.as_deref())?;
    let meta = fs::metadata(&canon).map_err(|e| format!("读取失败：{}", e))?;
    let size = meta.len();
    if size > MAX_BYTES {
        return Err(format!("文件过大（{} 字节），请用系统程序打开", size));
    }
    let bytes = fs::read(&canon).map_err(|e| format!("读取失败：{}", e))?;
    let mime = mime_for(&canon);
    Ok(ArtifactBytes {
        mime,
        data: base64_encode(&bytes),
        size,
    })
}




fn resolve_with_basename_fallback(
    state: &WorkspaceState,
    path: &str,
    session_id: Option<&str>,
) -> Result<PathBuf, String> {
    let roots = allowed_roots(&state);
    let recorded_files = recorded_artifact_files(&state);
    
    match assert_allowed(path, &roots, &recorded_files) {
        Ok(canon) => return Ok(canon),
        Err(primary_err) => {
            
            let basename = match Path::new(path).file_name().and_then(|s| s.to_str()) {
                Some(name) if !name.is_empty() => name.to_string(),
                _ => return Err(primary_err),
            };
            match lookup_product_by_basename(state, &basename, session_id) {
                Ok(Some(real)) => {
                    tracing::info!(
                        target: "onedesktop.artifact",
                        requested = %path,
                        resolved = %real.display(),
                        session_id = ?session_id,
                        "preview fell back to changeset product by basename"
                    );
                    return Ok(real);
                }
                Ok(None) => return Err(primary_err),
                Err(ambiguous) => return Err(ambiguous),
            }
        }
    }
}



fn lookup_product_by_basename(
    state: &WorkspaceState,
    basename: &str,
    session_id: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let pattern = format!("%/{}", basename);
    let rows: Vec<String> = if let Some(sid) = session_id {
        state
            .db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT DISTINCT cs.file FROM changeset cs \
                     WHERE cs.before_content IS NULL AND cs.file LIKE ?1 \
                       AND cs.run_id IN (SELECT id FROM runs WHERE session_id = ?2) \
                     ORDER BY cs.created_at DESC LIMIT 50",
                )?;
                let iter = stmt.query_map(rusqlite::params![pattern, sid], |r| {
                    r.get::<_, String>(0)
                })?;
                Ok(iter.filter_map(Result::ok).collect())
            })
            .unwrap_or_default()
    } else {
        state
            .db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT DISTINCT cs.file FROM changeset cs \
                     WHERE cs.before_content IS NULL AND cs.file LIKE ?1 \
                     ORDER BY cs.created_at DESC LIMIT 50",
                )?;
                let iter = stmt.query_map(rusqlite::params![pattern], |r| {
                    r.get::<_, String>(0)
                })?;
                Ok(iter.filter_map(Result::ok).collect())
            })
            .unwrap_or_default()
    };

    let existing: Vec<PathBuf> = rows
        .into_iter()
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .collect();

    match existing.len() {
        0 => Ok(None),
        1 => Ok(Some(existing.into_iter().next().unwrap())),
        _ => Err(format!(
            "同名文件有 {} 处匹配，请使用「查看所有产物」入口选择具体文件",
            existing.len()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

    
    struct TempRoot {
        path: PathBuf,
    }
    impl TempRoot {
        fn new(tag: &str) -> Self {
            let serial = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let p = std::env::temp_dir().join(format!(
                "od_art_{}_{}_{}",
                std::process::id(),
                serial,
                tag
            ));
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).unwrap();
            TempRoot { path: p }
        }
    }
    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn assert_allowed_accepts_default_workspace() {
        let r1 = TempRoot::new("ws_default");
        let r2 = TempRoot::new("ws_user");
        let file = r1.path.join("g1/report.md");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "hi").unwrap();
        let res = assert_allowed(file.to_str().unwrap(), &[r1.path.clone(), r2.path.clone()], &[]);
        assert!(res.is_ok(), "默认工作区内的文件应被允许");
    }

    #[test]
    fn assert_allowed_accepts_user_chosen_workspace() {
        let r1 = TempRoot::new("ws_default");
        let r2 = TempRoot::new("ws_user");
        let file = r2.path.join("out.png");
        fs::write(&file, b"bin").unwrap();
        let res = assert_allowed(file.to_str().unwrap(), &[r1.path.clone(), r2.path.clone()], &[]);
        assert!(res.is_ok(), "用户自选工作区内的文件应被允许");
    }

    #[test]
    fn assert_allowed_resolves_relative_path_from_workspace_root() {
        let root = TempRoot::new("ws_relative");
        let file = root.path.join("src/report.md");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "preview").unwrap();

        let res = assert_allowed("src/report.md", &[root.path.clone()], &[]).unwrap();
        assert_eq!(res, file.canonicalize().unwrap());
    }

    #[test]
    fn assert_allowed_accepts_exact_agent_recorded_file_outside_roots() {
        let workspace = TempRoot::new("ws_recorded_root");
        let agent_output = TempRoot::new("ws_recorded_file");
        let file = agent_output.path.join("report.md");
        fs::write(&file, "generated").unwrap();

        let res = assert_allowed(
            file.to_str().unwrap(),
            &[workspace.path.clone()],
            &[file.clone()],
        );
        assert!(res.is_ok(), "Agent 已落账产出的精确文件应允许预览");
    }

    #[test]
    fn assert_allowed_rejects_relative_path_escaping_workspace() {
        let root = TempRoot::new("ws_relative_escape");
        let outside = TempRoot::new("ws_relative_outside");
        let file = outside.path.join("secret.txt");
        fs::write(&file, "nope").unwrap();

        let escape = format!(
            "../{}/secret.txt",
            outside.path.file_name().unwrap().to_string_lossy()
        );
        let res = assert_allowed(&escape, &[root.path.clone()], &[]);
        assert!(res.is_err(), "相对路径不能借 .. 越出工作区");
    }

    #[test]
    fn assert_allowed_rejects_out_of_scope() {
        let r1 = TempRoot::new("ws_default");
        let r2 = TempRoot::new("ws_user");
        let outside = TempRoot::new("ws_outside");
        let file = outside.path.join("secret.txt");
        fs::write(&file, "x").unwrap();
        let res = assert_allowed(file.to_str().unwrap(), &[r1.path.clone(), r2.path.clone()], &[]);
        assert!(res.is_err(), "工作区外的文件必须拒绝");
        let etc = assert_allowed("/etc/passwd", &[r1.path.clone(), r2.path.clone()], &[]);
        assert!(etc.is_err(), "/etc/passwd 必须拒绝");
    }

    #[test]
    fn assert_allowed_accepts_current_dir() {
        
        let cwd = std::env::current_dir().expect("current_dir 必须可用");
        let file = cwd.join("od_art_cwd_probe.txt");
        fs::write(&file, "x").unwrap();
        let res = assert_allowed(file.to_str().unwrap(), &[cwd.clone()], &[]);
        let _ = fs::remove_file(&file);
        assert!(res.is_ok(), "current_dir 下的文件应被允许：{:?}", res.err());
    }

    #[test]
    fn assert_allowed_rejects_prefix_confusion() {
        
        let r = TempRoot::new("workspaces");
        let decoy_parent = std::env::temp_dir()
            .join(format!("od_art_{}_sibling", std::process::id()));
        let _ = fs::remove_dir_all(&decoy_parent);
        fs::create_dir_all(&decoy_parent).unwrap();
        let decoy = decoy_parent.join("workspaces_extra/x.txt");
        fs::create_dir_all(decoy.parent().unwrap()).unwrap();
        fs::write(&decoy, "x").unwrap();
        let res = assert_allowed(decoy.to_str().unwrap(), &[r.path.clone()], &[]);
        assert!(res.is_err(), "形似前缀的越界目录必须拒绝");
        let _ = fs::remove_dir_all(&decoy_parent);
    }

    #[test]
    fn base64_encode_known_vector() {
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(base64_encode(b"Ma"), "TWE=");
        assert_eq!(base64_encode(b"M"), "TQ==");
    }

    #[test]
    fn mime_for_maps_common_types() {
        assert_eq!(mime_for(Path::new("a.png")), "image/png");
        assert_eq!(mime_for(Path::new("a.svg")), "image/svg+xml");
        assert_eq!(mime_for(Path::new("a.unknown")), "application/octet-stream");
    }

    #[test]
    fn fallback_finds_unique_basename_in_session() {
        use crate::storage::connection::DbConnection;
        let ws = TempRoot::new("fallback_ws_unique");
        let real = ws.path.join("鲁迅作品纪实.md");
        std::fs::write(&real, "content").unwrap();
        
        let db_dir = TempRoot::new("fallback_db_unique");
        let db = DbConnection::open(&db_dir.path).expect("open db");
        db.with_conn_mut(|conn| {
            conn.execute(
                "INSERT INTO runs (id, session_id, started_at, kind, status) VALUES ('run-1', 'sess-X', 0, 'test', 'done')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO changeset (file, holder, run_id, before_content, snapshot_type, created_at, after_hash) VALUES (?1, 'test', 'run-1', NULL, 'normal', '2026-08-17T00:00:00Z', 'h')",
                rusqlite::params![real.to_string_lossy()],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
        let rows: Vec<String> = db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT DISTINCT cs.file FROM changeset cs \
                     WHERE cs.before_content IS NULL AND cs.file LIKE ?1 \
                       AND cs.run_id IN (SELECT id FROM runs WHERE session_id = ?2)",
                )?;
                let iter = stmt.query_map(
                    rusqlite::params![format!("%/{}", "鲁迅作品纪实.md"), "sess-X"],
                    |r| r.get::<_, String>(0),
                )?;
                Ok(iter.filter_map(Result::ok).collect())
            })
            .unwrap();
        assert_eq!(rows.len(), 1, "唯一文件应命中");
        assert!(rows[0].contains("鲁迅"));
    }

    #[test]
    fn fallback_ambiguous_when_same_basename_in_two_sessions() {
        use crate::storage::connection::DbConnection;
        let db_dir = TempRoot::new("fallback_db_ambig");
        let db = DbConnection::open(&db_dir.path).expect("open db");
        
        
        db.with_conn_mut(|conn| {
            conn.execute(
                "INSERT INTO runs (id, session_id, started_at, kind, status) VALUES ('r1', 'sx', 0, 'test', 'done')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO runs (id, session_id, started_at, kind, status) VALUES ('r2', 'sx', 0, 'test', 'done')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO changeset (file, holder, run_id, before_content, snapshot_type, created_at, after_hash) VALUES ('/tmp/x/a.md', 'test', 'r1', NULL, 'normal', '2026-08-17T00:00:00Z', 'h')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO changeset (file, holder, run_id, before_content, snapshot_type, created_at, after_hash) VALUES ('/tmp/x/b/a.md', 'test', 'r2', NULL, 'normal', '2026-08-17T00:00:00Z', 'h')",
                [],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
        let rows: Vec<String> = db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT DISTINCT cs.file FROM changeset cs \
                     WHERE cs.before_content IS NULL AND cs.file LIKE ?1 \
                       AND cs.run_id IN (SELECT id FROM runs WHERE session_id = ?2)",
                )?;
                let iter = stmt.query_map(
                    rusqlite::params![format!("%/{}", "a.md"), "sx"],
                    |r| r.get::<_, String>(0),
                )?;
                Ok(iter.filter_map(Result::ok).collect())
            })
            .unwrap();
        assert!(rows.len() >= 2, "歧义场景应至少 2 命中，len={}", rows.len());
    }
}
