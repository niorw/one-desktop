






use crate::agent::write_gate::{ChangesetRecord, ChangesetRecorder};
use crate::error::AgentError;
use crate::storage::connection::DbConnection;
use rusqlite::{params, Result as SqliteResult};
use uuid::Uuid;

pub struct SqliteChangesetRecorder {
    db: std::sync::Arc<DbConnection>,
}

impl SqliteChangesetRecorder {
    pub fn new(db: std::sync::Arc<DbConnection>) -> Self {
        Self { db }
    }

    
    pub fn list_for_run(&self, run_id: &str) -> SqliteResult<Vec<ChangesetRow>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id, file, holder, run_id, before_hash, after_hash, before_content, after_content, snapshot_type, created_at \
                 FROM changeset WHERE run_id = ?1 ORDER BY created_at",
            )?;
            let rows = stmt
                .query_map(params![run_id], row_to_changeset)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        })
    }

    
    pub fn run_changesets(&self, run_id: &str, limit: i64) -> SqliteResult<Vec<ChangesetRow>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id, file, holder, run_id, before_hash, after_hash, before_content, after_content, snapshot_type, created_at \
                 FROM changeset WHERE run_id = ?1 AND snapshot_type != 'auto_snapshot' \
                 ORDER BY created_at DESC LIMIT ?2",
            )?;
            let rows = stmt
                .query_map(params![run_id, limit], row_to_changeset)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        })
    }

    
    pub fn run_changeset_versions(&self, run_id: &str, file: &str) -> SqliteResult<Vec<ChangesetRow>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id, file, holder, run_id, before_hash, after_hash, before_content, after_content, snapshot_type, created_at \
                 FROM changeset WHERE run_id = ?1 AND file = ?2 ORDER BY created_at",
            )?;
            let rows = stmt
                .query_map(params![run_id, file], row_to_changeset)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        })
    }

    
    
    pub fn session_changesets(&self, session_id: &str, limit: i64) -> SqliteResult<Vec<ChangesetRow>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT cs.id, cs.file, cs.holder, cs.run_id, cs.before_hash, cs.after_hash, cs.before_content, cs.after_content, cs.snapshot_type, cs.created_at \
                 FROM changeset cs JOIN runs r ON cs.run_id = r.id \
                 WHERE r.session_id = ?1 AND cs.snapshot_type != 'auto_snapshot' \
                 ORDER BY cs.created_at DESC LIMIT ?2",
            )?;
            let rows = stmt
                .query_map(params![session_id, limit], row_to_changeset)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        })
    }

    
    pub fn list_for_group(&self, group_id: &str, limit: i64) -> SqliteResult<Vec<ChangesetRow>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT cs.id, cs.file, cs.holder, cs.run_id, cs.before_hash, cs.after_hash, cs.before_content, cs.after_content, cs.snapshot_type, cs.created_at \
                 FROM changeset cs JOIN runs r ON cs.run_id = r.id \
                 WHERE r.group_id = ?1 ORDER BY cs.created_at DESC LIMIT ?2",
            )?;
            let rows = stmt
                .query_map(params![group_id, limit], row_to_changeset)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        })
    }

    
    
    
    
    pub fn rollback(&self, change_id: &str) -> Result<String, AgentError> {
        
        let row = self
            .db
            .with_conn(|c| {
                let mut stmt = c.prepare(
                    "SELECT id, file, before_content, after_content, holder, run_id \
                     FROM changeset WHERE id = ?1",
                )?;
                let mut rows = stmt.query_map(params![change_id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, Option<String>>(5)?,
                    ))
                })?;
                match rows.next() {
                    Some(Ok(x)) => Ok(Some(x)),
                    _ => Ok(None),
                }
            })
            .map_err(|e| AgentError::Storage {
                message: format!("读取变更行失败: {e}"),
            })?;
        let (_id, file, before, after, holder, run_id) = row.ok_or_else(|| AgentError::Internal {
            message: "变更记录未找到".to_string(),
        })?;

        
        let current = std::fs::read_to_string(&file).ok();

        
        let needs_archive = match (&current, &after) {
            (Some(cur), Some(af)) => cur != af,
            _ => false,
        };

        if needs_archive {
            
            let cur = current.clone().unwrap_or_default();
            let h = content_hash(&cur);
            self.db
                .with_conn_mut(|c| {
                    c.execute(
                        "INSERT INTO changeset (id, file, holder, run_id, before_hash, after_hash, before_content, after_content, snapshot_type, created_at) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'auto_snapshot', ?9)",
                        params![
                            Uuid::new_v4().to_string(),
                            file,
                            holder,
                            run_id,
                            Some(h.clone()),
                            Some(h),
                            Some(cur),
                            None::<String>,
                            chrono::Utc::now().to_rfc3339(),
                        ],
                    )
                })
                .map_err(|e| AgentError::Internal {
                    message: format!("存档被覆盖的修改失败: {e}"),
                })?;
        }

        
        match before {
            Some(content) => {
                std::fs::write(&file, content).map_err(|e| AgentError::Internal {
                    message: format!("回滚写回失败 {}: {}", file, e),
                })?;
                Ok(format!(
                    "已回滚 {}（恢复为改动前内容）{}",
                    file,
                    if needs_archive {
                        "；已自动保留被覆盖的修改，可在版本历史中查看"
                    } else {
                        ""
                    }
                ))
            }
            None => {
                if std::path::Path::new(&file).exists() {
                    std::fs::remove_file(&file).map_err(|e| AgentError::Internal {
                        message: format!("回滚删除失败 {}: {}", file, e),
                    })?;
                }
                Ok(format!(
                    "已回滚 {}（删除本次新建文件）{}",
                    file,
                    if needs_archive {
                        "；已自动保留被覆盖的修改，可在版本历史中查看"
                    } else {
                        ""
                    }
                ))
            }
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ChangesetRow {
    pub id: String,
    pub file: String,
    pub holder: String,
    pub run_id: Option<String>,
    pub before_hash: Option<String>,
    pub after_hash: String,
    
    pub before_content: Option<String>,
    
    pub after_content: Option<String>,
    
    pub snapshot_type: String,
    pub created_at: String,
}

fn row_to_changeset(row: &rusqlite::Row) -> rusqlite::Result<ChangesetRow> {
    Ok(ChangesetRow {
        id: row.get(0)?,
        file: row.get(1)?,
        holder: row.get(2)?,
        run_id: row.get(3)?,
        before_hash: row.get(4)?,
        after_hash: row.get(5)?,
        before_content: row.get(6)?,
        after_content: row.get(7)?,
        snapshot_type: row.get(8)?,
        created_at: row.get(9)?,
    })
}



fn content_hash(s: &str) -> String {
    let mut acc: u64 = 0xcbf29ce484222325;
    for &b in s.as_bytes() {
        acc = acc.wrapping_mul(0x100000001b3).wrapping_add(b as u64);
    }
    format!("len={}:h={:016x}", s.len(), acc)
}

impl ChangesetRecorder for SqliteChangesetRecorder {
    fn record(&self, rec: ChangesetRecord) {
        let now = chrono::Utc::now().to_rfc3339();
        let id = Uuid::new_v4().to_string();
        let _ = self.db.with_conn_mut(|c| {
            c.execute(
                "INSERT INTO changeset (id, file, holder, run_id, before_hash, after_hash, before_content, after_content, snapshot_type, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'normal', ?9)",
                params![
                    id,
                    rec.file,
                    rec.holder,
                    rec.run_id,
                    rec.before_hash,
                    rec.after_hash,
                    rec.before_content,
                    rec.after_content,
                    now
                ],
            )
            .map(|_| ())
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db(name: &str) -> DbConnection {
        let dir = std::env::temp_dir().join(format!("od_ix10_{}_{}", std::process::id(), name));
        std::fs::create_dir_all(&dir).unwrap();
        DbConnection::open(&dir).unwrap()
    }

    #[test]
    fn record_and_rollback_overwrite_restores_content() {
        let db = tmp_db("rollback");
        let dir = std::env::temp_dir().join(format!("od_ix10_fs_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, "old").unwrap();

        let rec = SqliteChangesetRecorder::new(std::sync::Arc::new(db));
        rec.record(ChangesetRecord {
            file: file.to_string_lossy().to_string(),
            holder: "run-x".into(),
            run_id: Some("run-x".into()),
            before_hash: Some("h1".into()),
            after_hash: "h2".into(),
            before_content: Some("old".into()),
            after_content: Some("new".into()),
        });
        std::fs::write(&file, "new").unwrap();

        
        let rows = rec.list_for_run("run-x").unwrap();
        assert_eq!(rows.len(), 1);
        rec.rollback(&rows[0].id).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "old");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rollback_new_file_deletes_it() {
        let db = tmp_db("newfile");
        let dir = std::env::temp_dir().join(format!("od_ix10_nf_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("b.txt");

        let rec = SqliteChangesetRecorder::new(std::sync::Arc::new(db));
        rec.record(ChangesetRecord {
            file: file.to_string_lossy().to_string(),
            holder: "run-y".into(),
            run_id: Some("run-y".into()),
            before_hash: None,
            after_hash: "h2".into(),
            before_content: None, 
            after_content: Some("brand new".into()),
        });
        std::fs::write(&file, "brand new").unwrap();

        let rows = rec.list_for_run("run-y").unwrap();
        assert_eq!(rows[0].before_content, None);
        rec.rollback(&rows[0].id).unwrap();
        assert!(!file.exists(), "新建文件回滚后应被删除");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rollback_saves_current_content_before_overwrite() {
        let db = tmp_db("archive");
        let dir = std::env::temp_dir().join(format!("od_ix10_arc_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("c.txt");
        std::fs::write(&file, "base").unwrap();

        let rec = SqliteChangesetRecorder::new(std::sync::Arc::new(db));
        
        rec.record(ChangesetRecord {
            file: file.to_string_lossy().to_string(),
            holder: "run-a".into(),
            run_id: Some("run-a".into()),
            before_hash: None,
            after_hash: "ha".into(),
            before_content: Some("base".into()),
            after_content: Some("A".into()),
        });
        
        std::fs::write(&file, "B").unwrap();

        
        let rows = rec.list_for_run("run-a").unwrap();
        let msg = rec.rollback(&rows[0].id).unwrap();
        assert!(msg.contains("已自动保留"), "应提示已存档被覆盖的修改: {msg}");
        
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "base");
        
        let versions = rec.run_changeset_versions("run-a", &file.to_string_lossy()).unwrap();
        let snap = versions.iter().find(|r| r.snapshot_type == "auto_snapshot");
        assert!(snap.is_some(), "应存在 auto_snapshot 留存 B");
        assert_eq!(snap.unwrap().before_content.as_deref(), Some("B"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn run_changesets_filters_auto_snapshot() {
        let db = tmp_db("filter");
        let dir = std::env::temp_dir().join(format!("od_ix10_flt_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("d.txt");
        std::fs::write(&file, "x").unwrap();
        let rec = SqliteChangesetRecorder::new(std::sync::Arc::new(db));
        rec.record(ChangesetRecord {
            file: file.to_string_lossy().to_string(),
            holder: "r".into(),
            run_id: Some("r".into()),
            before_hash: None,
            after_hash: "h".into(),
            before_content: Some("x".into()),
            after_content: Some("x".into()),
        });
        
        std::fs::write(&file, "y").unwrap();
        let rows = rec.list_for_run("r").unwrap();
        rec.rollback(&rows[0].id).unwrap();
        
        let view = rec.run_changesets("r", 100).unwrap();
        assert_eq!(view.len(), 1, "run_changesets 应过滤 auto_snapshot");
        assert_eq!(view[0].snapshot_type, "normal");
        std::fs::remove_dir_all(&dir).ok();
    }
}
