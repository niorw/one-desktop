

use crate::session::model::{CreateMessagePayload, Message, MessageQuery};
use crate::storage::connection::DbConnection;
use crate::storage::trace_repo as trace;
use rusqlite::{params, Result as SqliteResult};

pub struct MessageRepository<'a> {
    db: &'a DbConnection,
}

impl<'a> MessageRepository<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }

    
    pub fn create(&self, payload: CreateMessagePayload) -> SqliteResult<Message> {
        let now = chrono::Utc::now().to_rfc3339();
        self.db.with_conn_mut(|conn| {
            
            
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let body = || -> SqliteResult<Message> {
            let (id, item_kind, stored) = insert_message_and_trace(conn, &payload, &now)?;
            
            
            append_session_event(conn, &payload, &stored)?;
            Ok(Message {
                id,
                session_id: payload.session_id,
                role: payload.role,
                content: payload.content,
                tool_name: payload.tool_name,
                tool_args: payload.tool_args,
                tool_result: payload.tool_result,
                token_usage: payload.token_usage,
                reasoning_content: payload.reasoning_content,
                created_at: now,
                
                seq: 0,
                call_id: payload.call_id,
                item_kind: Some(item_kind),
                run_id: None,
                artifacts: None,
            })
            };
            match body() {
                Ok(m) => {
                    conn.execute_batch("COMMIT")?;
                    Ok(m)
                }
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(e)
                }
            }
        })
    }

    
    pub fn find_by_session(&self, session_id: &str) -> SqliteResult<Vec<Message>> {
        let _query = MessageQuery {
            session_id: Some(session_id.to_string()),
            ..Default::default()
        };
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, session_id, role, content, tool_name, tool_args, tool_result, token_usage, \
                 COALESCE(reasoning_content,''), created_at, \
                 COALESCE(call_id,''), COALESCE(item_kind,''), \
                 ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS seq, \
                 run_id, artifacts \
                 FROM messages WHERE session_id = ?1 ORDER BY created_at ASC, id ASC",
            )?;
            let messages = stmt
                .query_map(params![session_id], |row| {
                    let call_id_raw: String = row.get(10)?;
                    let item_kind_raw: String = row.get(11)?;
                    let run_id_raw: Option<String> = row.get(13)?;
                    let artifacts_raw: Option<String> = row.get(14)?;
                    Ok(Message {
                        id: row.get(0)?,
                        session_id: row.get(1)?,
                        role: row.get(2)?,
                        content: row.get(3)?,
                        tool_name: row.get(4)?,
                        tool_args: row.get(5)?,
                        tool_result: row.get(6)?,
                        token_usage: row.get(7)?,
                        reasoning_content: row.get(8)?,
                        created_at: row.get(9)?,
                        call_id: if call_id_raw.is_empty() { None } else { Some(call_id_raw) },
                        item_kind: if item_kind_raw.is_empty() { None } else { Some(item_kind_raw) },
                        seq: row.get(12)?,
                        run_id: run_id_raw,
                        artifacts: artifacts_raw,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();
            Ok(messages)
        })
    }

    
    pub fn touch_session(&self, session_id: &str) -> SqliteResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
                params![now, session_id],
            )?;
            Ok(())
        })
    }

    
    
    pub fn delete_by_session(&self, session_id: &str) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "DELETE FROM messages WHERE session_id = ?1",
                params![session_id],
            )?;
            Ok(())
        })
    }
}













pub(crate) fn insert_message_and_trace(
    conn: &rusqlite::Connection,
    payload: &CreateMessagePayload,
    now: &str,
) -> SqliteResult<(i64, String, Message)> {
    
    let item_kind = if payload.role == "tool" || payload.tool_name.is_some() {
        "tool"
    } else if payload.role == "assistant" {
        "assistant"
    } else {
        "user"
    };
    conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_name, tool_args, tool_result, token_usage, reasoning_content, created_at, call_id, item_kind)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            payload.session_id,
            payload.role,
            payload.content,
            payload.tool_name,
            payload.tool_args,
            payload.tool_result,
            payload.token_usage,
            payload.reasoning_content,
            now,
            payload.call_id,
            item_kind,
        ],
    )?;
    let id = conn.last_insert_rowid();

    
    
    
    
    let scene = {
        let mode: Option<String> = conn
            .query_row(
                "SELECT mode FROM sessions WHERE id = ?1",
                [payload.session_id.clone()],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        if mode.as_deref() == Some("worker") {
            "worker"
        } else {
            "chat"
        }
    };
    let at = if scene == "worker" {
        "worker"
    } else {
        payload.role.as_str()
    };
    let stored = Message {
        id,
        session_id: payload.session_id.clone(),
        role: payload.role.clone(),
        content: payload.content.clone(),
        tool_name: payload.tool_name.clone(),
        tool_args: payload.tool_args.clone(),
        tool_result: payload.tool_result.clone(),
        token_usage: payload.token_usage,
        reasoning_content: payload.reasoning_content.clone(),
        created_at: now.to_string(),
        seq: 0,
        call_id: payload.call_id.clone(),
        item_kind: Some(item_kind.to_string()),
        run_id: None,
        artifacts: None,
    };
    for row in trace::message_to_trace_rows(&stored, scene, at) {
        trace::add_row(conn, &row)?;
    }
    Ok((id, item_kind.to_string(), stored))
}

use crate::session::model::Message as MessageModel;
use rusqlite::Connection;
use serde_json::json;









pub fn derive_event(payload: &CreateMessagePayload) -> Option<(&'static str, serde_json::Value)> {
    match payload.role.as_str() {
        "user" => Some((
            "user_message",
            json!({ "content": payload.content }),
        )),
        "assistant" if payload.call_id.is_some() => Some((
            "tool_call",
            json!({
                "call_id": payload.call_id,
                "tool_name": payload.tool_name,
                "args": payload.tool_args,
                "reasoning": payload.reasoning_content,
                "tokens": payload.token_usage,
            }),
        )),
        "assistant" => Some((
            "assistant_message",
            json!({
                "content": payload.content,
                "reasoning": payload.reasoning_content,
                "tokens": payload.token_usage,
            }),
        )),
        "tool" => Some((
            "tool_result",
            json!({
                "call_id": payload.call_id,
                "tool_name": payload.tool_name,
                "content": payload.content,
                "tool_result": payload.tool_result,
            }),
        )),
        _ => None,
    }
}








fn append_session_event(
    conn: &Connection,
    payload: &CreateMessagePayload,
    stored: &MessageModel,
) -> SqliteResult<()> {
    let Some((kind, event_payload)) = derive_event(payload) else {
        return Ok(());
    };
    
    if kind == "tool_result" {
        if let Some(cid) = stored.call_id.as_deref() {
            if !stored.call_id.as_deref().unwrap_or("").is_empty() {
                let paired: Option<i64> = conn
                    .query_row(
                        "SELECT id FROM session_events \
                         WHERE session_id = ?1 AND kind = 'tool_call' AND call_id = ?2 LIMIT 1",
                        params![stored.session_id, cid],
                        |r| r.get(0),
                    )
                    .ok();
                if paired.is_none() {
                    tracing::warn!(
                        target: "onedesktop.storage",
                        session = %stored.session_id,
                        call_id = cid,
                        "I1 violation (observability): tool_result without matching tool_call event"
                    );
                }
            }
        }
    }
    let next_seq: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM session_events WHERE session_id = ?1",
        [&stored.session_id],
        |r| r.get(0),
    )?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO session_events (session_id, run_id, seq, kind, call_id, payload, created_at) \
         VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6)",
        params![
            stored.session_id,
            next_seq,
            kind,
            stored.call_id,
            event_payload.to_string(),
            now_ms,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod adr023_tests {
    use super::*;
    use crate::storage::connection::DbConnection;
    use crate::session::model::CreateMessagePayload;

    fn seed_sessions(db: &DbConnection, ids: &[&str]) {
        db.with_conn_mut(|c| {
            for id in ids {
                c.execute(
                    "INSERT INTO sessions (id, created_at, updated_at) VALUES (?1, '2026-01-01', '2026-01-01')",
                    [id],
                )?;
            }
            Ok(())
        })
        .unwrap();
    }

    fn payload(session: &str, role: &str, call_id: Option<&str>) -> CreateMessagePayload {
        CreateMessagePayload {
            session_id: session.to_string(),
            role: role.to_string(),
            content: "c".into(),
            tool_name: if role == "tool" { Some("fs_read".into()) } else { None },
            tool_args: None,
            tool_result: None,
            token_usage: 0,
            reasoning_content: String::new(),
            call_id: call_id.map(|s| s.to_string()),
        }
    }

    fn kinds_of(db: &DbConnection, session: &str) -> Vec<String> {
        db.with_conn(|conn| {
            let mut stmt = conn
                .prepare("SELECT kind FROM session_events WHERE session_id = ?1 ORDER BY seq")
                .unwrap();
            let rows = stmt
                .query_map([session], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            Ok(rows)
        })
        .unwrap()
    }

    
    #[test]
    fn seq_strictly_monotonic_per_session() {
        let dir = std::env::temp_dir().join(format!("od-adr023-seq-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let db = DbConnection::open(&dir).unwrap();
        let repo = MessageRepository::new(&db);
        seed_sessions(&db, &["s1", "s2"]);
        repo.create(payload("s1", "user", None)).unwrap();
        repo.create(payload("s1", "assistant", Some("call_1"))).unwrap();
        repo.create(payload("s1", "tool", Some("call_1"))).unwrap();
        
        repo.create(payload("s2", "user", None)).unwrap();
        let seqs: Vec<i64> = db
            .with_conn(|c| {
                Ok(c.prepare("SELECT seq FROM session_events WHERE session_id='s1' ORDER BY seq")
                    .unwrap()
                    .query_map([], |r| r.get(0))
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap())
            })
            .unwrap();
        assert_eq!(seqs, vec![1, 2, 3]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    
    #[test]
    fn event_kinds_derive_from_roles() {
        let dir = std::env::temp_dir().join(format!("od-adr023-kind-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let db = DbConnection::open(&dir).unwrap();
        let repo = MessageRepository::new(&db);
        seed_sessions(&db, &["s1"]);
        repo.create(payload("s1", "user", None)).unwrap();
        repo.create(payload("s1", "assistant", None)).unwrap();
        repo.create(payload("s1", "assistant", Some("call_1"))).unwrap();
        repo.create(payload("s1", "tool", Some("call_1"))).unwrap();
        assert_eq!(
            kinds_of(&db, "s1"),
            vec!["user_message", "assistant_message", "tool_call", "tool_result"]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    
    
    
    
    #[test]
    fn events_and_messages_row_aligned() {
        let dir = std::env::temp_dir().join(format!("od-adr023-align-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let db = DbConnection::open(&dir).unwrap();
        let repo = MessageRepository::new(&db);
        seed_sessions(&db, &["s1"]);
        for (role, cid) in [
            ("user", None),
            ("assistant", Some("c1")),
            ("tool", Some("c1")),
            ("assistant", None),
        ] {
            repo.create(payload("s1", role, cid)).unwrap();
        }
        let (m, e): (i64, i64) = db
            .with_conn(|c| {
                Ok((
                    c.query_row("SELECT COUNT(*) FROM messages WHERE session_id='s1'", [], |r| r.get(0))
                        .unwrap(),
                    c.query_row("SELECT COUNT(*) FROM session_events WHERE session_id='s1'", [], |r| r.get(0))
                        .unwrap(),
                ))
            })
            .unwrap();
        assert_eq!(m, e, "messages 与 session_events 行数失配");
        let _ = std::fs::remove_dir_all(&dir);
    }

    
    #[test]
    fn derive_event_skips_unknown_roles() {
        assert!(derive_event(&payload("s", "system", None)).is_none());
        assert_eq!(derive_event(&payload("s", "user", None)).unwrap().0, "user_message");
    }
}
