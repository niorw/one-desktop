








use crate::session::model::Message;
use crate::storage::connection::DbConnection;
use rusqlite::{params, Result as SqliteResult};


#[derive(Debug, Clone)]
pub struct TraceRow {
    pub id: i64,
    pub session_id: String,
    pub scene: String,
    pub agent_type: Option<String>,
    pub kind: String,
    pub name: Option<String>,
    
    pub seq: i64,
    pub call_id: Option<String>,
    pub parent_id: Option<i64>,
    pub content: Option<String>,
    pub args: Option<String>,
    pub result: Option<String>,
    pub reasoning: Option<String>,
    pub is_error: Option<bool>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub created_at: String,
}


pub fn add_row(conn: &rusqlite::Connection, row: &TraceRow) -> SqliteResult<()> {
    conn.execute(
        "INSERT INTO agent_trace \
         (session_id, scene, agent_type, kind, name, seq, call_id, parent_id, content, args, result, reasoning, is_error, started_at, ended_at, created_at) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        params![
            row.session_id,
            row.scene,
            row.agent_type,
            row.kind,
            row.name,
            row.seq,
            row.call_id,
            row.parent_id,
            row.content,
            row.args,
            row.result,
            row.reasoning,
            row.is_error.map(|b| if b { 1i64 } else { 0i64 }),
            row.started_at,
            row.ended_at,
            row.created_at,
        ],
    )?;
    Ok(())
}


pub fn count_by_session(db: &DbConnection, session_id: &str) -> SqliteResult<i64> {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM agent_trace WHERE session_id = ?1",
            [session_id],
            |r| r.get(0),
        )
    })
}


pub fn find_by_session(db: &DbConnection, session_id: &str) -> SqliteResult<Vec<TraceRow>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, scene, COALESCE(agent_type,''), kind, COALESCE(name,''), \
             ROW_NUMBER() OVER (ORDER BY id ASC) AS seq, \
             COALESCE(call_id,''), parent_id, content, args, result, reasoning, is_error, \
             started_at, ended_at, created_at \
             FROM agent_trace WHERE session_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt
            .query_map(params![session_id], |r| {
                Ok(TraceRow {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    scene: r.get(2)?,
                    agent_type: opt_str(r.get(3)?),
                    kind: r.get(4)?,
                    name: opt_str(r.get(5)?),
                    seq: r.get(6)?,
                    call_id: opt_str(r.get(7)?),
                    parent_id: r.get(8)?,
                    content: r.get(9)?,
                    args: r.get(10)?,
                    result: r.get(11)?,
                    reasoning: r.get(12)?,
                    is_error: match r.get::<_, Option<i64>>(13)? {
                        Some(1) => Some(true),
                        Some(_) => Some(false),
                        None => None,
                    },
                    started_at: r.get(14)?,
                    ended_at: r.get(15)?,
                    created_at: r.get(16)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    })
}

#[inline]
fn opt_str(v: String) -> Option<String> {
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}


fn scene_of(conn: &rusqlite::Connection, session_id: &str) -> String {
    let mode: Option<String> = conn
        .query_row(
            "SELECT mode FROM sessions WHERE id = ?1",
            [session_id],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    match mode.as_deref() {
        Some("worker") => "worker".to_string(),
        _ => "chat".to_string(),
    }
}






pub fn message_to_trace_rows(msg: &Message, scene: &str, agent_type: &str) -> Vec<TraceRow> {
    let at = if scene == "worker" {
        "worker".to_string()
    } else {
        agent_type.to_string()
    };
    let base = |kind: &str, reasoning: Option<String>, content: Option<String>, call_id: Option<String>| TraceRow {
        id: 0,
        session_id: msg.session_id.clone(),
        scene: scene.to_string(),
        agent_type: Some(at.clone()),
        kind: kind.to_string(),
        name: None,
        seq: 0,
        call_id,
        parent_id: None,
        content,
        args: None,
        result: None,
        reasoning,
        is_error: None,
        started_at: None,
        ended_at: None,
        created_at: msg.created_at.clone(),
    };

    
    
    
    
    
    match msg.role.as_str() {
        "user" => vec![base("user", None, Some(msg.content.clone()), None)],
        "tool" => {
            let is_err = msg
                .tool_result
                .as_deref()
                .map(|r| r.contains("Error"))
                .unwrap_or(false);
            let mut r = base("tool_result", None, Some(msg.content.clone()), msg.call_id.clone());
            r.name = msg.tool_name.clone();
            r.result = msg.tool_result.clone();
            r.is_error = Some(is_err);
            vec![r]
        }
        "assistant" => {
            if msg.tool_name.is_some() {
                
                
                
                let mut rows = Vec::new();
                if !msg.reasoning_content.is_empty() {
                    rows.push(base(
                        "intent",
                        Some(msg.reasoning_content.clone()),
                        None,
                        msg.call_id.clone(),
                    ));
                }
                let mut tc = base("tool_call", None, None, msg.call_id.clone());
                tc.name = msg.tool_name.clone();
                tc.args = msg.tool_args.clone();
                rows.push(tc);
                rows
            } else {
                
                let mut rows = Vec::new();
                if !msg.reasoning_content.is_empty() {
                    rows.push(base(
                        "thinking",
                        Some(msg.reasoning_content.clone()),
                        None,
                        None,
                    ));
                }
                rows.push(base("answer", None, Some(msg.content.clone()), None));
                rows
            }
        }
        _ => Vec::new(),
    }
}



pub fn backfill_from_messages(
    db: &DbConnection,
    session_id: &str,
    msgs: &[Message],
) -> SqliteResult<()> {
    if msgs.is_empty() {
        return Ok(());
    }
    db.with_conn_mut(|conn| {
        let scene = scene_of(conn, session_id);
        for m in msgs {
            let at = if scene == "worker" {
                "worker"
            } else {
                m.role.as_str()
            };
            for row in message_to_trace_rows(m, &scene, at) {
                add_row(conn, &row)?;
            }
        }
        Ok(())
    })
}




pub fn purge_by_session(db: &DbConnection, session_id: &str) -> SqliteResult<()> {
    db.with_conn_mut(|conn| {
        conn.execute(
            "DELETE FROM agent_trace WHERE session_id = ?1",
            [session_id],
        )?;
        Ok(())
    })
}
