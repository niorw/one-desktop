











use crate::session::model::CreateMessagePayload;
use crate::storage::connection::DbConnection;
use crate::storage::message_repo::{self, MessageRepository};
use rusqlite::{params, Result as SqliteResult};
use serde::{Deserialize, Serialize};


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEventRow {
    pub id: i64,
    pub session_id: String,
    pub run_id: Option<String>,
    pub seq: i64,
    pub kind: String,
    pub call_id: Option<String>,
    pub payload: serde_json::Value,
    pub created_at: i64,
}


fn event_to_payload(row: &SessionEventRow) -> Option<CreateMessagePayload> {
    let p = &row.payload;
    match row.kind.as_str() {
        "user_message" => Some(CreateMessagePayload {
            session_id: row.session_id.clone(),
            role: "user".into(),
            content: p.get("content").and_then(|v| v.as_str()).unwrap_or("").into(),
            tool_name: None,
            tool_args: None,
            tool_result: None,
            token_usage: 0,
            reasoning_content: String::new(),
            call_id: None,
        }),
        "assistant_message" => Some(CreateMessagePayload {
            session_id: row.session_id.clone(),
            role: "assistant".into(),
            content: p.get("content").and_then(|v| v.as_str()).unwrap_or("").into(),
            tool_name: None,
            tool_args: None,
            tool_result: None,
            token_usage: p.get("tokens").and_then(|v| v.as_i64()).unwrap_or(0),
            reasoning_content: p
                .get("reasoning")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .into(),
            call_id: None,
        }),
        "tool_call" => Some(CreateMessagePayload {
            session_id: row.session_id.clone(),
            role: "assistant".into(),
            content: String::new(),
            tool_name: p.get("tool_name").and_then(|v| v.as_str()).map(String::from),
            tool_args: p.get("args").and_then(|v| v.as_str()).map(String::from),
            tool_result: None,
            token_usage: p.get("tokens").and_then(|v| v.as_i64()).unwrap_or(0),
            reasoning_content: p
                .get("reasoning")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .into(),
            call_id: row.call_id.clone(),
        }),
        "tool_result" => Some(CreateMessagePayload {
            session_id: row.session_id.clone(),
            role: "tool".into(),
            content: p.get("content").and_then(|v| v.as_str()).unwrap_or("").into(),
            tool_name: p.get("tool_name").and_then(|v| v.as_str()).map(String::from),
            tool_args: None,
            tool_result: p
                .get("tool_result")
                .and_then(|v| v.as_str())
                .map(String::from),
            token_usage: 0,
            reasoning_content: String::new(),
            call_id: row.call_id.clone(),
        }),
        
        _ => None,
    }
}


pub fn list_by_session(db: &DbConnection, session_id: &str) -> SqliteResult<Vec<SessionEventRow>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, run_id, seq, kind, call_id, payload, created_at \
             FROM session_events WHERE session_id = ?1 ORDER BY seq ASC",
        )?;
        let rows = stmt
            .query_map(params![session_id], |r| {
                let payload_str: String = r.get(6)?;
                Ok(SessionEventRow {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    run_id: r.get(2)?,
                    seq: r.get(3)?,
                    kind: r.get(4)?,
                    call_id: r.get(5)?,
                    payload: serde_json::from_str(&payload_str).unwrap_or_default(),
                    created_at: r.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}




pub fn rebuild_messages(db: &DbConnection, session_id: &str) -> SqliteResult<usize> {
    let events = list_by_session(db, session_id)?;
    db.with_conn_mut(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let body = || -> SqliteResult<usize> {
            conn.execute("DELETE FROM messages WHERE session_id = ?1", params![session_id])?;
            conn.execute("DELETE FROM agent_trace WHERE session_id = ?1", params![session_id])?;
            let mut n = 0usize;
            for ev in &events {
                if let Some(payload) = event_to_payload(ev) {
                    let now = chrono::DateTime::from_timestamp_millis(ev.created_at)
                        .map(|t| t.to_rfc3339())
                        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
                    message_repo::insert_message_and_trace(conn, &payload, &now)?;
                    n += 1;
                }
            }
            Ok(n)
        };
        match body() {
            Ok(n) => {
                conn.execute_batch("COMMIT")?;
                Ok(n)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}










pub fn heal_pending_tool_calls(db: &DbConnection) -> usize {
    
    const PLACEHOLDER: &str = "[interrupted before tool result was persisted]";

    let pending: Vec<(String, String)> = db
        .with_conn(|conn| {
            
            let mut stmt = conn.prepare(
                "SELECT DISTINCT e.session_id, e.call_id FROM session_events e \
                 WHERE e.kind = 'tool_call' AND e.call_id IS NOT NULL \
                 AND NOT EXISTS ( \
                   SELECT 1 FROM session_events r \
                   WHERE r.session_id = e.session_id AND r.kind = 'tool_result' AND r.call_id = e.call_id \
                 )",
            )?;
            let mut rows: Vec<(String, String)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            
            let mut stmt2 = conn.prepare(
                "SELECT DISTINCT m.session_id, m.call_id FROM messages m \
                 WHERE m.role = 'assistant' AND m.call_id IS NOT NULL AND m.call_id != '' \
                 AND NOT EXISTS ( \
                   SELECT 1 FROM messages t \
                   WHERE t.session_id = m.session_id AND t.role = 'tool' AND t.call_id = m.call_id \
                 )",
            )?;
            for row in stmt2.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
                rows.push(row?);
            }
            Ok(rows)
        })
        .unwrap_or_default();

    
    let mut seen = std::collections::HashSet::new();
    let pending: Vec<(String, String)> = pending
        .into_iter()
        .filter(|(sid, cid)| seen.insert((sid.clone(), cid.clone())))
        .collect();

    if pending.is_empty() {
        return 0;
    }

    let repo = MessageRepository::new(db);
    let mut healed = 0usize;
    for (session_id, call_id) in &pending {
        
        let tool_name: Option<String> = db
            .with_conn(|conn| {
                Ok(conn
                    .query_row(
                        "SELECT tool_name FROM messages \
                         WHERE session_id = ?1 AND call_id = ?2 AND tool_name IS NOT NULL LIMIT 1",
                        params![session_id, call_id],
                        |r| r.get(0),
                    )
                    .ok()
                    .flatten())
            })
            .unwrap_or(None);
        let result = repo.create(CreateMessagePayload {
            session_id: session_id.clone(),
            role: "tool".into(),
            content: PLACEHOLDER.into(),
            tool_name: tool_name.clone(),
            tool_args: None,
            tool_result: Some(PLACEHOLDER.into()),
            token_usage: 0,
            reasoning_content: String::new(),
            call_id: Some(call_id.clone()),
        });
        match result {
            Ok(_) => healed += 1,
            Err(e) => tracing::error!(
                target: "onedesktop.storage",
                session = %session_id,
                call_id = %call_id,
                error = %e,
                "heal_pending_tool_calls: 补占位 tool_result 失败"
            ),
        }
    }
    tracing::info!(
        target: "onedesktop.storage",
        pending = pending.len(),
        healed,
        "ADR-023 启动自愈：已补全悬挂 tool_call 的占位结果"
    );
    healed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_db(tag: &str) -> (std::path::PathBuf, DbConnection) {
        let dir = std::env::temp_dir().join(format!("od-adr023s2-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let db = DbConnection::open(&dir).unwrap();
        db.with_conn_mut(|c| {
            c.execute(
                "INSERT INTO sessions (id, created_at, updated_at) VALUES ('s1', '2026-01-01', '2026-01-01')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        (dir, db)
    }

    fn payload(role: &str, call_id: Option<&str>) -> CreateMessagePayload {
        CreateMessagePayload {
            session_id: "s1".into(),
            role: role.into(),
            content: if role == "tool" { "ok".into() } else { "hello".into() },
            tool_name: if role == "tool" { Some("fs_read".into()) } else { None },
            tool_args: None,
            tool_result: None,
            token_usage: 0,
            reasoning_content: String::new(),
            call_id: call_id.map(String::from),
        }
    }

    
    
    #[test]
    fn rebuild_restores_projection() {
        let (dir, db) = fresh_db("rebuild");
        let repo = MessageRepository::new(&db);
        repo.create(payload("user", None)).unwrap();
        repo.create(payload("assistant", Some("c1"))).unwrap();
        repo.create(payload("tool", Some("c1"))).unwrap();
        repo.create(payload("assistant", None)).unwrap();

        
        db.with_conn_mut(|c| {
            c.execute("DELETE FROM messages WHERE call_id IS NOT NULL", [])?;
            Ok(())
        })
        .unwrap();

        let n = rebuild_messages(&db, "s1").unwrap();
        assert_eq!(n, 4, "rebuild 应恢复全部 4 行投影");
        let roles: Vec<(String, Option<String>)> = db
            .with_conn(|c| {
                let mut stmt = c
                    .prepare("SELECT role, NULLIF(call_id,'') FROM messages WHERE session_id='s1' ORDER BY id")
                    .unwrap();
                Ok(stmt
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap())
            })
            .unwrap();
        assert_eq!(
            roles,
            vec![
                ("user".into(), None),
                ("assistant".into(), Some("c1".into())),
                ("tool".into(), Some("c1".into())),
                ("assistant".into(), None),
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    
    #[test]
    fn heal_closes_dangling_tool_calls() {
        let (dir, db) = fresh_db("heal");
        let repo = MessageRepository::new(&db);
        repo.create(payload("user", None)).unwrap();
        
        repo.create(payload("assistant", Some("dangling_1"))).unwrap();

        let healed = heal_pending_tool_calls(&db);
        assert_eq!(healed, 1);

        
        let (m_pending, e_pending): (i64, i64) = db
            .with_conn(|c| {
                Ok((
                    c.query_row(
                        "SELECT COUNT(*) FROM messages m WHERE m.role='assistant' AND m.call_id IS NOT NULL \
                         AND NOT EXISTS (SELECT 1 FROM messages t WHERE t.role='tool' AND t.call_id=m.call_id AND t.session_id=m.session_id)",
                        [], |r| r.get(0),
                    )
                    .unwrap(),
                    c.query_row(
                        "SELECT COUNT(*) FROM session_events e WHERE e.kind='tool_call' \
                         AND NOT EXISTS (SELECT 1 FROM session_events r WHERE r.kind='tool_result' AND r.call_id=e.call_id AND r.session_id=e.session_id)",
                        [], |r| r.get(0),
                    )
                    .unwrap(),
                ))
            })
            .unwrap();
        assert_eq!(m_pending, 0, "messages 侧仍有悬挂");
        assert_eq!(e_pending, 0, "events 侧仍有悬挂");

        
        assert_eq!(heal_pending_tool_calls(&db), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    
    #[test]
    fn heal_covers_legacy_messages_only_dangling() {
        let (dir, db) = fresh_db("legacy");
        db.with_conn_mut(|c| {
            
            c.execute(
                "INSERT INTO messages (session_id, role, content, tool_name, tool_args, tool_result, token_usage, reasoning_content, created_at, call_id, item_kind) \
                 VALUES ('s1','assistant','','fs_read','{}',NULL,0,'','2026-01-02T00:00:00Z','legacy_1','tool')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        assert_eq!(heal_pending_tool_calls(&db), 1);
        
        let has_result_event: i64 = db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT COUNT(*) FROM session_events WHERE kind='tool_result' AND call_id='legacy_1'",
                    [],
                    |r| r.get(0),
                )
                .unwrap())
            })
            .unwrap();
        assert_eq!(has_result_event, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
