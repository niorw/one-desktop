




use crate::agent::tool_registry::{ExecutableTool, ToolDef, ToolExecContext};
use async_trait::async_trait;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub struct ReadFileTool;

#[async_trait]
impl ExecutableTool for ReadFileTool {
    async fn execute(&self, args: Value, ctx: &ToolExecContext) -> Result<String, String> {
        let path = args["path"].as_str().ok_or("Missing 'path' argument")?;
        let path = resolve_fs_path(path, &ctx.workspace_root, ctx.enforce_root)?;
        std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))
    }
}

impl From<ReadFileTool> for ToolDef {
    fn from(_: ReadFileTool) -> Self {
        ToolDef {
            name: "read_file".into(),
            description: "Read the contents of a file at the given path".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the file to read"
                    }
                },
                "required": ["path"]
            }),
        }
    }
}

pub struct WriteFileTool;

#[async_trait]
impl ExecutableTool for WriteFileTool {
    async fn execute(&self, args: Value, ctx: &ToolExecContext) -> Result<String, String> {
        let path = args["path"].as_str().ok_or("Missing 'path' argument")?;
        let content = args["content"]
            .as_str()
            .ok_or("Missing 'content' argument")?;
        let path = resolve_fs_path(path, &ctx.workspace_root, ctx.enforce_root)?;

        
        
        
        let gate = ctx.write_gate.clone();
        let holder = ctx.run_id.clone().unwrap_or_else(|| "run:unknown".to_string());
        if let Some(g) = &gate {
            g.begin_write(&path, &holder)?;
        }
        let before_hash = file_sha256(&path);
        
        let before_content = std::fs::read_to_string(&path).ok();
        
        
        
        let old_lines = before_content.as_ref().map(|c| c.lines().count()).unwrap_or(0);

        
        if let Some(parent) = Path::new(&path).parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        let write_res = std::fs::write(&path, content)
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e));

        match write_res {
            Ok(()) => {
                let after_hash = file_sha256(&path);
                if let Some(g) = &gate {
                    
                    g.commit_write(
                        &path,
                        &holder,
                        ctx.run_id.as_deref(),
                        before_hash,
                        after_hash.unwrap_or_default(),
                        before_content,
                        
                        
                        Some(content.to_string()),
                    );
                }
                tracing::info!(
                    target: "onedesktop.agent.tool.fs",
                    path = %path.display(),
                    size = content.len(),
                    "File written"
                );
                
                
                if let Some(wf) = &ctx.written_files {
                    wf.lock()
                        .expect("written_files mutex poisoned")
                        .push(path.display().to_string());
                }
                
                let new_lines = content.lines().count();
                let line_stat = if old_lines > 0 {
                    format!(" (+{} - {} lines)", new_lines, old_lines)
                } else {
                    format!(" (+{} lines, new file)", new_lines)
                };
                Ok(format!(
                    "Successfully wrote {} bytes to {}{}",
                    content.len(),
                    path.display(),
                    line_stat
                ))
            }
            Err(e) => {
                
                if let Some(g) = &gate {
                    g.release_run(&holder);
                }
                Err(e)
            }
        }
    }
}


fn file_sha256(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(format!("len={}:h={}", buf.len(), fold_hash(&buf)))
}


fn fold_hash(buf: &[u8]) -> String {
    let mut acc: u64 = 0xcbf29ce484222325;
    for &b in buf {
        acc = acc.wrapping_mul(0x100000001b3).wrapping_add(b as u64);
    }
    format!("{:016x}", acc)
}

impl From<WriteFileTool> for ToolDef {
    fn from(_: WriteFileTool) -> Self {
        ToolDef {
            name: "write_file".into(),
            description: "Write content to a file. Creates parent directories if needed.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the file to write"
                    },
                    "content": {
                        "type": "string",
                        "description": "Content to write to the file"
                    }
                },
                "required": ["path", "content"]
            }),
        }
    }
}

pub struct ListDirTool;

#[async_trait]
impl ExecutableTool for ListDirTool {
    async fn execute(&self, args: Value, ctx: &ToolExecContext) -> Result<String, String> {
        let path = args["path"].as_str().ok_or("Missing 'path' argument")?;
        let path = resolve_fs_path(path, &ctx.workspace_root, ctx.enforce_root)?;

        let entries: Vec<String> = std::fs::read_dir(&path)
            .map_err(|e| format!("Failed to read directory {}: {}", path.display(), e))?
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let file_type = entry.file_type().ok()?;
                let prefix = if file_type.is_dir() {
                    "[DIR] "
                } else {
                    "[FILE]"
                };
                Some(format!(
                    "{} {}",
                    prefix,
                    entry.file_name().to_string_lossy()
                ))
            })
            .collect();

        Ok(entries.join("\n"))
    }
}

impl From<ListDirTool> for ToolDef {
    fn from(_: ListDirTool) -> Self {
        ToolDef {
            name: "list_dir".into(),
            description: "List files and directories at the given path".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the directory to list"
                    }
                },
                "required": ["path"]
            }),
        }
    }
}













fn resolve_fs_path(raw: &str, root: &Option<PathBuf>, enforce: bool) -> Result<PathBuf, String> {
    match root {
        None => {
            let p = Path::new(raw);
            if p.exists() {
                Ok(p.canonicalize()
                    .map_err(|e| format!("Invalid path: {}", e))?)
            } else if p.components().any(|c| c.as_os_str() == "..") {
                Err("Path traversal not allowed".into())
            } else {
                Ok(p.to_path_buf())
            }
        }
        Some(root) => {
            let raw_p = Path::new(raw);
            if raw_p.is_absolute() {
                
                if !enforce {
                    if raw_p.components().any(|c| c.as_os_str() == "..") {
                        return Err("Path traversal not allowed".into());
                    }
                    let canonical = if raw_p.exists() {
                        raw_p
                            .canonicalize()
                            .map_err(|e| format!("Invalid path: {}", e))?
                    } else {
                        raw_p.to_path_buf()
                    };
                    return Ok(canonical);
                }
            }
            let joined = if raw_p.is_absolute() {
                raw_p.to_path_buf()
            } else {
                root.join(raw_p)
            };
            let canonical = if joined.exists() {
                joined
                    .canonicalize()
                    .map_err(|e| format!("Invalid path: {}", e))?
            } else {
                if joined.components().any(|c| c.as_os_str() == "..") {
                    return Err("Path traversal outside workspace not allowed".into());
                }
                joined
            };
            if !canonical.starts_with(root) {
                return Err(format!(
                    "Path escapes workspace root: {}",
                    canonical.display()
                ));
            }
            Ok(canonical)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tool_registry::ToolExecContext;
    use crate::agent::write_gate::WriteGate;
    use std::sync::Arc;

    fn ctx_with_gate(gate: Option<Arc<WriteGate>>, run_id: Option<&str>) -> ToolExecContext {
        ToolExecContext {
            workspace_root: None,
            tmp_root: None,
            cancel: None,
            enforce_root: false,
            group_sender: None,
            blackboard: None,
            sender_session: None,
            write_gate: gate,
            run_id: run_id.map(|s| s.to_string()),
            workspace_id: None,
            written_files: None,
        }
    }

    #[tokio::test]
    async fn write_file_records_changeset_and_releases_gate() {
        let dir = std::env::temp_dir().join(format!("od_f10_ws_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.txt");

        let gate = Arc::new(WriteGate::new(None));
        let ctx = ctx_with_gate(Some(gate.clone()), Some("run-a"));
        let res = WriteFileTool
            .execute(
                serde_json::json!({"path": path.to_string_lossy(), "content": "hello"}),
                &ctx,
            )
            .await;
        assert!(res.is_ok(), "写盘应成功: {:?}", res.err());
        
        assert_eq!(gate.held_len(), 0);

        
        let res2 = WriteFileTool
            .execute(
                serde_json::json!({"path": path.to_string_lossy(), "content": "world"}),
                &ctx,
            )
            .await;
        assert!(res2.is_ok());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn write_file_pushes_written_path_for_backfill() {
        
        
        let dir = std::env::temp_dir().join(format!("od_wf_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("backfill.html");

        let written = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let ctx = ToolExecContext {
            workspace_root: None,
            tmp_root: None,
            cancel: None,
            enforce_root: false,
            group_sender: None,
            blackboard: None,
            sender_session: None,
            write_gate: None,
            run_id: None,
            workspace_id: None,
            written_files: Some(written.clone()),
        };
        let res = WriteFileTool
            .execute(
                serde_json::json!({"path": path.to_string_lossy(), "content": "<b>hi</b>"}),
                &ctx,
            )
            .await;
        assert!(res.is_ok(), "写盘应成功: {:?}", res.err());

        let got = written.lock().unwrap();
        assert_eq!(got.len(), 1, "应回填 1 个写出文件");
        assert!(
            got[0].ends_with("backfill.html"),
            "回填路径应指向写出文件，实际: {:?}",
            got
        );
        drop(got);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn concurrent_other_run_write_rejected() {
        let dir = std::env::temp_dir().join(format!("od_f10_cw_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("shared.txt");

        let gate = Arc::new(WriteGate::new(None));
        
        let pa = path.to_string_lossy().to_string();
        gate.begin_write(std::path::Path::new(&pa), "run-a").unwrap();

        
        let ctx_b = ctx_with_gate(Some(gate.clone()), Some("run-b"));
        let res = WriteFileTool
            .execute(
                serde_json::json!({"path": pa, "content": "sneaky"}),
                &ctx_b,
            )
            .await;
        assert!(res.is_err(), "并发写冲突应被拒绝: {:?}", res.ok());
        let err = res.unwrap_err();
        assert!(err.contains("并发写冲突"), "错误应说明冲突: {}", err);

        
        gate.release_run("run-a");
        assert!(gate.begin_write(std::path::Path::new(&dir.join("shared.txt")), "run-b").is_ok());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn write_file_reports_line_stats_in_result() {
        
        
        let dir = std::env::temp_dir().join(format!("od_fs_stat_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("stat.txt");

        let ctx = ctx_with_gate(None, None);

        
        let res = WriteFileTool
            .execute(
                serde_json::json!({"path": path.to_string_lossy(), "content": "a\nb\nc\nd\ne"}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(res.contains("(+5 lines, new file)"), "新建应报 +5 行: {res}");

        
        let res2 = WriteFileTool
            .execute(
                serde_json::json!({"path": path.to_string_lossy(), "content": "x\ny\nz"}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(res2.contains("(+3 - 5 lines)"), "覆写应报 +3 -5 行: {res2}");

        std::fs::remove_dir_all(&dir).ok();
    }

    
    

    #[test]
    fn soft_anchor_relative_paths_join_root() {
        let root = std::env::temp_dir().join(format!("od_anchor_rel_{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let p = resolve_fs_path("out/report.md", &Some(root.clone()), false).unwrap();
        assert_eq!(p, root.join("out/report.md"), "相对路径应锚定到 root");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn soft_anchor_allows_absolute_paths_outside_root() {
        let root = std::env::temp_dir().join(format!("od_anchor_soft_{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let outside = std::env::temp_dir().join(format!("od_outside_soft_{}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();
        let f = outside.join("user_specified.txt");
        std::fs::write(&f, "x").unwrap();
        
        let p = resolve_fs_path(&f.to_string_lossy(), &Some(root.clone()), false).unwrap();
        assert_eq!(p, f.canonicalize().unwrap(), "软锚定应放行 root 外的绝对路径");
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn strict_enforce_rejects_absolute_path_outside_root() {
        let root = std::env::temp_dir().join(format!("od_anchor_str_{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let outside = std::env::temp_dir().join(format!("od_outside_str_{}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();
        let f = outside.join("escaped.txt");
        
        let r = resolve_fs_path(&f.to_string_lossy(), &Some(root.clone()), true);
        assert!(r.is_err(), "严格限域应拒绝越界路径");
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
    }
}
