




use crate::session::model::{
    CreateMessagePayload, CreateSessionPayload, Message, Session, SessionQuery,
};
use crate::storage::connection::DbConnection;
use crate::storage::message_repo::MessageRepository;
use crate::storage::repository::Repository;
use crate::storage::session_repo::SessionRepository;
use crate::metrics::metrics::Metrics;
use rusqlite::Result as SqliteResult;
use serde::Serialize;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
pub struct ActiveRunInfo {
    pub run_id: String,
    pub session_id: String,
    pub kind: String,
    pub started_at: i64,
}


pub struct SessionManager {
    db: Arc<DbConnection>,
    metrics: Arc<Metrics>,
}

impl SessionManager {
    pub fn new(db: Arc<DbConnection>, metrics: Arc<Metrics>) -> Self {
        Self { db, metrics }
    }

    

    pub fn create_session(
        &self,
        title: String,
        model: String,
        preamble: String,
        workspace_id: Option<String>,
    ) -> SqliteResult<Session> {
        let repo = SessionRepository::new(&self.db);
        let id = uuid::Uuid::new_v4().to_string();
        let session = repo.create(CreateSessionPayload {
            id,
            title: if title.is_empty() {
                "New Session".into()
            } else {
                title
            },
            model,
            preamble,
            mode: None,
            group_id: None,
            workspace_id,
        })?;
        self.metrics.inc_sessions_created();
        tracing::info!(
            target: "onedesktop.session",
            session_id = %session.id,
            "Session created via manager"
        );
        Ok(session)
    }

    pub fn get_session(&self, session_id: &str) -> SqliteResult<Option<Session>> {
        let repo = SessionRepository::new(&self.db);
        repo.find_by_id(session_id)
    }

    
    
    pub fn create_session_with_id(
        &self,
        id: String,
        title: String,
        model: String,
        preamble: String,
    ) -> SqliteResult<Session> {
        let repo = SessionRepository::new(&self.db);
        repo.create(CreateSessionPayload {
            id,
            title,
            model,
            preamble,
            mode: None,
            group_id: None,
            workspace_id: None,
        })
    }

    
    
    pub fn set_session_mode(
        &self,
        session_id: &str,
        mode: Option<&str>,
        group_id: Option<&str>,
    ) -> SqliteResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE sessions SET mode = ?1, group_id = ?2, updated_at = ?3 WHERE id = ?4",
                rusqlite::params![mode, group_id, now, session_id],
            )?;
            Ok(())
        })
    }

    
    
    
    pub fn set_session_workspace(
        &self,
        session_id: &str,
        workspace_id: &str,
    ) -> SqliteResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE sessions SET workspace_id = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![workspace_id, now, session_id],
            )?;
            Ok(())
        })
    }

    pub fn list_sessions(&self) -> SqliteResult<Vec<Session>> {
        let repo = SessionRepository::new(&self.db);
        repo.find_all(SessionQuery::default())
    }

    pub fn delete_session(&self, session_id: &str) -> SqliteResult<()> {
        let repo = SessionRepository::new(&self.db);
        repo.delete(session_id)?;
        tracing::info!(
            target: "onedesktop.session",
            session_id = %session_id,
            "Session deleted via manager"
        );
        Ok(())
    }

    pub fn update_title(&self, session_id: &str, title: &str) -> SqliteResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE sessions SET title = ?1, updated_at = ?2 WHERE id = ?3 AND title = 'New Session'",
                rusqlite::params![title, now, session_id],
            )?;
            Ok(())
        })
    }

    

    pub fn add_message(&self, payload: CreateMessagePayload) -> SqliteResult<Message> {
        let repo = MessageRepository::new(&self.db);
        let msg = repo.create(payload)?;
        repo.touch_session(&msg.session_id)?;
        self.metrics.inc_messages_persisted();
        Ok(msg)
    }

    pub fn get_messages(&self, session_id: &str) -> SqliteResult<Vec<Message>> {
        let repo = MessageRepository::new(&self.db);
        repo.find_by_session(session_id)
    }

    
    
    
    
    
    
    
    
    pub fn backfill_run_artifacts(
        &self,
        session_id: &str,
        run_id: &str,
        artifacts_json: &str,
    ) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE messages SET run_id = ?2, artifacts = ?3 \
                 WHERE id = (SELECT id FROM messages WHERE session_id = ?1 AND role = 'assistant' \
                            ORDER BY id DESC LIMIT 1)",
                rusqlite::params![session_id, run_id, artifacts_json],
            )?;
            Ok(())
        })
    }

    
    
    
    pub fn has_active_run(&self, session_id: &str) -> SqliteResult<bool> {
        self.db.with_conn(|conn| -> rusqlite::Result<bool> {
            let exists = conn
                .query_row(
                    "SELECT 1 FROM runs WHERE session_id = ?1 AND status = 'running' LIMIT 1",
                    rusqlite::params![session_id],
                    |_| Ok(()),
                )
                .is_ok();
            Ok(exists)
        })
    }

    pub fn list_active_runs(&self) -> SqliteResult<Vec<ActiveRunInfo>> {
        self.db.with_conn(|conn| -> rusqlite::Result<Vec<ActiveRunInfo>> {
            let mut stmt = conn.prepare(
                "SELECT id, session_id, kind, started_at FROM runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 50"
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(ActiveRunInfo {
                    run_id: row.get(0)?,
                    session_id: row.get(1)?,
                    kind: row.get(2)?,
                    started_at: row.get(3)?,
                })
            })?;
            rows.collect()
        })
    }

    
    
    
    
    
    
    pub fn get_trace(&self, session_id: &str) -> SqliteResult<Vec<crate::storage::trace_repo::TraceRow>> {
        use crate::storage::trace_repo as trace;
        let count = trace::count_by_session(&self.db, session_id)?;
        if count == 0 {
            let msgs = self.get_messages(session_id)?;
            if !msgs.is_empty() {
                trace::backfill_from_messages(&self.db, session_id, &msgs)?;
            }
        } else {
            let dirty = self.db.with_conn(|conn| -> rusqlite::Result<bool> {
                let has_tool_result = conn
                    .query_row(
                        "SELECT 1 FROM agent_trace WHERE session_id = ?1 AND kind = 'tool_result' LIMIT 1",
                        rusqlite::params![session_id],
                        |_| Ok(()),
                    )
                    .is_ok();
                if !has_tool_result {
                    return Ok(false);
                }
                let has_tool_call = conn
                    .query_row(
                        "SELECT 1 FROM agent_trace WHERE session_id = ?1 AND kind = 'tool_call' LIMIT 1",
                        rusqlite::params![session_id],
                        |_| Ok(()),
                    )
                    .is_ok();
                Ok(!has_tool_call)
            })?;
            if dirty {
                trace::purge_by_session(&self.db, session_id)?;
                let msgs = self.get_messages(session_id)?;
                if !msgs.is_empty() {
                    trace::backfill_from_messages(&self.db, session_id, &msgs)?;
                }
            }
        }
        trace::find_by_session(&self.db, session_id)
    }

    
    
    pub fn add_observation(&self, session_id: &str, content: String) -> SqliteResult<()> {
        use crate::storage::trace_repo as trace;
        let now = chrono::Utc::now().to_rfc3339();
        self.db.with_conn_mut(|conn| {
            let scene = if let Ok(Some(mode)) =
                conn.query_row("SELECT mode FROM sessions WHERE id = ?1", [session_id], |r| r.get::<_, Option<String>>(0))
            {
                if mode == "worker" { "worker" } else { "chat" }
            } else {
                "chat"
            };
            let row = trace::TraceRow {
                id: 0,
                session_id: session_id.to_string(),
                scene: scene.to_string(),
                agent_type: Some(if scene == "worker" { "worker" } else { "assistant" }.to_string()),
                kind: "observation".to_string(),
                name: None,
                seq: 0,
                call_id: None,
                parent_id: None,
                content: Some(content),
                args: None,
                result: None,
                reasoning: None,
                is_error: None,
                started_at: None,
                ended_at: None,
                created_at: now,
            };
            trace::add_row(conn, &row)
        })
    }


    
    pub fn clear_session_messages(&self, session_id: &str) -> SqliteResult<()> {
        let repo = MessageRepository::new(&self.db);
        repo.delete_by_session(session_id)
    }

    
    pub fn save_summary(
        &self,
        session_id: &str,
        summary: &str,
        msg_count: usize,
    ) -> SqliteResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO session_summaries (session_id, summary, msg_count, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![session_id, summary, msg_count as i64, now],
            )?;
            Ok(())
        })
    }

    
    
    
    
    pub fn get_latest_summary(&self, session_id: &str) -> Option<(String, usize)> {
        self.db
            .with_conn(|conn| -> rusqlite::Result<Option<(String, usize)>> {
                match conn.query_row(
                    "SELECT summary, msg_count FROM session_summaries WHERE session_id = ?1",
                    rusqlite::params![session_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize)),
                ) {
                    Ok(row) => Ok(Some(row)),
                    Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                    Err(e) => Err(e),
                }
            })
            .ok()
            .flatten()
    }

    

    
    pub fn list_tool_permissions(
        &self,
    ) -> SqliteResult<Vec<crate::agent::permission::ToolPermission>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT tool_name, scope, action FROM tool_permissions")?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(crate::agent::permission::ToolPermission {
                        tool_name: row.get(0)?,
                        scope: row.get(1)?,
                        action: serde_json::from_str(&row.get::<_, String>(2)?)
                            .unwrap_or(crate::agent::permission::Permission::Ask),
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        })
    }

    
    pub fn set_tool_permission(
        &self,
        tool_name: &str,
        scope: &str,
        action: &crate::agent::permission::Permission,
    ) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO tool_permissions (tool_name, scope, action) VALUES (?1, ?2, ?3)",
                rusqlite::params![
                    tool_name,
                    scope,
                    serde_json::to_string(action).unwrap_or_else(|_| "\"ask\"".into()),
                ],
            )?;
            Ok(())
        })
    }

    
    pub fn reset_tool_permissions(&self) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute("DELETE FROM tool_permissions", [])?;
            Ok(())
        })
    }

    
    pub fn clear_tool_permission(&self, tool_name: &str, scope: &str) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "DELETE FROM tool_permissions WHERE tool_name = ?1 AND scope = ?2",
                rusqlite::params![tool_name, scope],
            )?;
            Ok(())
        })
    }

    

    pub fn get_setting(&self, key: &str) -> SqliteResult<String> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
            let result: String = stmt.query_row([key], |row| row.get(0))?;
            Ok(result)
        })
    }

    pub fn set_setting(&self, key: &str, value: &str) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                rusqlite::params![key, value],
            )?;
            Ok(())
        })
    }
}




#[cfg(test)]
mod trace_api_tests {
    use super::*;
    use crate::session::model::CreateMessagePayload;
    use crate::storage::connection::DbConnection;
    use crate::storage::message_repo::MessageRepository;
    use rusqlite::params;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("od_trace_{}_{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn setup(tag: &str) -> (Arc<DbConnection>, SessionManager, String) {
        let dir = tmp_dir(tag);
        let db = Arc::new(DbConnection::open(&dir).unwrap());
        let mgr = SessionManager::new(db.clone(), Arc::new(Metrics::new()));
        let sid = format!("sess_{}", tag);
        mgr.create_session_with_id(sid.clone(), "Test".into(), "gpt".into(), "".into())
            .unwrap();
        (db, mgr, sid)
    }

    
    fn seed_round(db: &Arc<DbConnection>, sid: &str) {
        let repo = MessageRepository::new(&**db);
        repo.create(CreateMessagePayload {
            session_id: sid.to_string(),
            role: "user".into(),
            content: "查天气".into(),
            tool_name: None,
            tool_args: None,
            tool_result: None,
            token_usage: 0,
            reasoning_content: "".into(),
            call_id: None,
        })
        .unwrap();
        repo.create(CreateMessagePayload {
            session_id: sid.to_string(),
            role: "assistant".into(),
            content: "我来查".into(),
            tool_name: Some("web_search".into()),
            tool_args: Some(r#"{"q":"天气"}"#.into()),
            tool_result: None,
            token_usage: 0,
            reasoning_content: "先查天气工具".into(),
            call_id: Some("call_1".into()),
        })
        .unwrap();
        repo.create(CreateMessagePayload {
            session_id: sid.to_string(),
            role: "tool".into(),
            content: "晴 25度".into(),
            tool_name: Some("web_search".into()),
            tool_args: None,
            tool_result: Some("晴 25度".into()),
            token_usage: 0,
            reasoning_content: "".into(),
            call_id: Some("call_1".into()),
        })
        .unwrap();
        repo.create(CreateMessagePayload {
            session_id: sid.to_string(),
            role: "assistant".into(),
            content: "今天晴，25度".into(),
            tool_name: None,
            tool_args: None,
            tool_result: None,
            token_usage: 0,
            reasoning_content: "汇总结果".into(),
            call_id: None,
        })
        .unwrap();
    }

    
    fn assert_round(rows: &[crate::storage::trace_repo::TraceRow]) {
        let kinds: Vec<&str> = rows.iter().map(|r| r.kind.as_str()).collect();
        assert_eq!(
            kinds,
            vec!["user", "intent", "tool_call", "tool_result", "thinking", "answer"],
            "trace kind 顺序应为 user→intent→tool_call→tool_result→thinking→answer"
        );
        
        for (i, r) in rows.iter().enumerate() {
            assert_eq!(r.seq, (i + 1) as i64, "seq 应严格递增从 1 开始");
        }
        
        assert_eq!(rows[1].call_id.as_deref(), Some("call_1"));
        assert_eq!(rows[2].call_id.as_deref(), Some("call_1"));
        assert_eq!(rows[3].call_id.as_deref(), Some("call_1"));
        
        assert_eq!(rows[0].content.as_deref(), Some("查天气"));
        assert_eq!(rows[1].reasoning.as_deref(), Some("先查天气工具"));
        assert_eq!(rows[2].name.as_deref(), Some("web_search"));
        assert_eq!(rows[2].args.as_deref(), Some(r#"{"q":"天气"}"#));
        assert_eq!(rows[3].name.as_deref(), Some("web_search"));
        assert_eq!(rows[3].result.as_deref(), Some("晴 25度"));
        assert!(rows[3].is_error == Some(false), "非错误结果 is_error 应为 false");
        assert_eq!(rows[4].reasoning.as_deref(), Some("汇总结果"));
        assert_eq!(rows[5].content.as_deref(), Some("今天晴，25度"));
    }

    #[test]
    fn get_trace_returns_correct_rows_for_full_react_round() {
        let (db, mgr, sid) = setup("e2e");
        
        seed_round(&db, &sid);

        let rows = mgr.get_trace(&sid).unwrap();
        assert_eq!(rows.len(), 6, "完整回合应产出 6 行 trace");
        assert_round(&rows);
    }

    #[test]
    fn get_trace_self_heals_dirty_trace_without_tool_call() {
        let (db, mgr, sid) = setup("dirty");
        seed_round(&db, &sid);
        
        db.with_conn_mut(|conn| {
            conn.execute(
                "DELETE FROM agent_trace WHERE session_id = ?1 AND (kind = 'tool_call' OR kind = 'intent')",
                params![sid],
            )
            .unwrap();
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
        let before = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM agent_trace WHERE session_id = ?1 AND kind = 'tool_call'",
                    params![sid],
                    |r| r.get::<_, i64>(0),
                )
            })
            .unwrap();
        assert_eq!(before, 0, "前置：已制造脏数据（缺失 tool_call）");

        
        let rows = mgr.get_trace(&sid).unwrap();
        assert_eq!(rows.len(), 6, "自愈后应恢复完整 6 行 trace");
        assert_round(&rows);
    }

    #[test]
    fn get_trace_backfills_from_messages_when_trace_empty() {
        
        let (db, mgr, sid) = setup("backfill");
        db.with_conn_mut(|conn| {
            conn.execute(
                "INSERT INTO messages (session_id, role, content, tool_name, tool_args, tool_result, token_usage, reasoning_content, created_at, call_id, item_kind) \
                 VALUES (?1,'user','查天气',NULL,NULL,NULL,0,'',datetime('now'),NULL,'user')",
                params![sid],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO messages (session_id, role, content, tool_name, tool_args, tool_result, token_usage, reasoning_content, created_at, call_id, item_kind) \
                 VALUES (?1,'assistant','我来查','web_search','{\"q\":\"天气\"}',NULL,0,'先查天气工具',datetime('now'),'call_1','tool')",
                params![sid],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO messages (session_id, role, content, tool_name, tool_args, tool_result, token_usage, reasoning_content, created_at, call_id, item_kind) \
                 VALUES (?1,'tool','晴 25度','web_search',NULL,'晴 25度',0,'',datetime('now'),'call_1','tool')",
                params![sid],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO messages (session_id, role, content, tool_name, tool_args, tool_result, token_usage, reasoning_content, created_at, call_id, item_kind) \
                 VALUES (?1,'assistant','今天晴，25度',NULL,NULL,NULL,0,'汇总结果',datetime('now'),NULL,'assistant')",
                params![sid],
            )
            .unwrap();
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();

        let rows = mgr.get_trace(&sid).unwrap();
        assert_eq!(rows.len(), 6, "空 trace 应从 messages 回填出 6 行");
        assert_round(&rows);
    }

    #[test]
    fn has_active_run_reflects_run_status() {
        let (db, mgr, sid) = setup("run");

        assert!(!mgr.has_active_run(&sid).unwrap(), "无 run 应为 false");

        
        db.with_conn_mut(|conn| {
            conn.execute(
                "INSERT INTO runs (id, session_id, kind, started_at, status) VALUES ('r1', ?1, 'chat', 1, 'running')",
                params![sid],
            )
            .unwrap();
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
        assert!(mgr.has_active_run(&sid).unwrap(), "running run 应为 true");

        
        db.with_conn_mut(|conn| {
            conn.execute("UPDATE runs SET status = 'done' WHERE id = 'r1'", [])
                .unwrap();
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
        assert!(!mgr.has_active_run(&sid).unwrap(), "done run 应为 false");
    }
}
